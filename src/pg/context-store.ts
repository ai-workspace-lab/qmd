/**
 * pg/context-store.ts - Shared task context across agent clients
 *
 * A *thread* is one unit of work keyed by PR number, else by branch. Sessions
 * from any client (Claude Code, Codex, Antigravity, a web plugin via the bridge)
 * attach to it and contribute keyed *items*; context-merge.ts decides how each
 * item combines with what is stored. The result is one merged handoff view per
 * PR/branch instead of one transcript per client.
 *
 * Only important session facts are stored — never file contents, diffs, tool
 * output or attachments (docs/plan/multi-agent-shared-context.md §2).
 */

import { PgClient, PgTxClient } from "./db-pg.js";
import type { PgConnectionConfig } from "./config.js";
import { bootstrapContextSchema } from "./schema-pg.js";
import {
  mergeItem,
  itemKey,
  type IncomingItem,
  type ItemKind,
  type StoredItem,
  type ItemBody,
} from "./context-merge.js";
import { findSecret } from "../collect/redact.js";

export type ThreadState = "open" | "paused" | "handed_off" | "done" | "abandoned";

export interface ContextThread {
  id: string;
  scope: string;
  headBranch: string | null;
  prNumber: number | null;
  prState: string | null;
  title: string;
  state: ThreadState;
  mergedInto: string | null;
  headSha: string | null;
  driverSessionId: string | null;
  leaseExpiresAt: string | null;
  fence: number;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResolveInput {
  scope: string;
  headBranch?: string;
  prNumber?: number;
  prState?: "open" | "merged" | "closed";
  headSha?: string;
  title?: string;
}

export type ResolveResult =
  | { ok: true; thread: ContextThread; created: boolean; mergedFrom: string[] }
  | { ok: false; reason: "requires_explicit_thread" };

export interface AttachInput {
  source: string;
  sourceSessionId: string;
  agentKind?: string;
  title?: string;
  headSha?: string;
}

export interface MergeResult {
  threadId: string;
  duplicate: boolean;
  inserted: number;
  updated: number;
  touched: number;
  proposed: number;
  rejected: Array<{ kind: string; reason: string }>;
}

export interface BriefingItem {
  kind: ItemKind;
  key: string;
  status: string;
  ord: number | null;
  text: string;
  detail: string | null;
  at: string;
  gitHead: string | null;
  sources: string[];
}

export interface Briefing {
  thread: ContextThread;
  items: BriefingItem[];
  contributors: Array<{ source: string; sessions: number; lastSeenAt: string }>;
  events: Array<{ seq: number; type: string; createdAt: string; payload: Record<string, unknown> }>;
}

export interface SharedProject {
  id: string;
  name: string;
  rootPath: string;
  sources: string[];
  updatedAt: string;
}

export interface PinnedTask {
  id: string;
  source: string;
  title: string;
  cwd?: string;
  projectName?: string;
  gitBranch?: string;
  position: number;
  updatedAt: string;
}

export interface TaskCatalog {
  [key: string]: unknown;
  pinnedTasks: PinnedTask[];
  sharedProjects: SharedProject[];
  activeClaims: Array<{
    resource: string;
    agentId: string;
    agentKind: string;
    intent: string;
    expiresAt: string;
    threadId?: string;
  }>;
  recentThreads: ContextThread[];
}

/** Branch names too broad to identify a piece of work on their own. */
const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "HEAD"]);

const LIVE_STATES = `('open', 'paused', 'handed_off')`;

const THREAD_COLUMNS = `id, scope, head_branch, pr_number, pr_state, title, state, merged_into,
  head_sha, driver_session_id, lease_expires_at, fence, last_event_seq, created_at, updated_at`;

type Querier = PgClient | PgTxClient;

function toThread(row: any): ContextThread {
  return {
    id: row.id,
    scope: row.scope,
    headBranch: row.head_branch ?? null,
    prNumber: row.pr_number ?? null,
    prState: row.pr_state ?? null,
    title: row.title ?? "",
    state: row.state,
    mergedInto: row.merged_into ?? null,
    headSha: row.head_sha ?? null,
    driverSessionId: row.driver_session_id ?? null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    fence: Number(row.fence),
    lastEventSeq: Number(row.last_event_seq),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toStored(row: any): StoredItem {
  return {
    kind: row.kind,
    key: row.item_key,
    status: row.status,
    ord: row.ord ?? null,
    body: row.body as ItemBody,
    gitHead: row.git_head ?? null,
  };
}

async function appendEvent(
  tx: PgTxClient,
  threadId: string,
  type: string,
  payload: Record<string, unknown>,
  opts: { sessionId?: string | null; clientRequestId?: string } = {},
): Promise<number> {
  const row = await tx.queryOne<{ last_event_seq: string }>(
    `UPDATE qmd_ctx_thread SET last_event_seq = last_event_seq + 1, updated_at = now()
      WHERE id = $1 RETURNING last_event_seq`,
    [threadId],
  );
  const seq = Number(row!.last_event_seq);
  await tx.exec(
    `INSERT INTO qmd_ctx_event (thread_id, seq, event_type, session_id, payload, client_request_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [threadId, seq, type, opts.sessionId ?? null, JSON.stringify(payload), opts.clientRequestId ?? ""],
  );
  return seq;
}

/** Lock a thread row, following one `merged_into` hop to the live root. */
async function lockRoot(tx: PgTxClient, threadId: string): Promise<ContextThread> {
  let row = await tx.queryOne<any>(`SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread WHERE id = $1 FOR UPDATE`, [
    threadId,
  ]);
  if (!row) throw new Error(`thread ${threadId} not found`);
  if (row.merged_into) {
    row = await tx.queryOne<any>(`SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread WHERE id = $1 FOR UPDATE`, [
      row.merged_into,
    ]);
    if (!row) throw new Error(`thread ${threadId} was merged into a missing thread`);
  }
  return toThread(row);
}

export class PgContextStore {
  private constructor(private client: PgClient) {}

  static async open(config: PgConnectionConfig): Promise<PgContextStore> {
    const client = await PgClient.create(config);
    await bootstrapContextSchema(client);
    return new PgContextStore(client);
  }

  // ── Threads ─────────────────────────────────────────────────────────────

  /**
   * Find or create the thread for a PR / branch (plan §4.1). Serialised per
   * scope with a transaction-scoped advisory lock so two agents starting on the
   * same branch at the same moment end up on one thread; the partial unique
   * indexes are the backstop.
   */
  async resolveThread(input: ResolveInput): Promise<ResolveResult> {
    const branch = input.headBranch?.trim() || undefined;
    const usableBranch = branch && !DEFAULT_BRANCHES.has(branch) ? branch : undefined;
    const pr = input.prNumber ?? undefined;
    if (!pr && !usableBranch) return { ok: false, reason: "requires_explicit_thread" };

    return this.client.tx(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`qmd_ctx:${input.scope}`]);

      const prRow = pr
        ? await tx.queryOne<any>(
            `SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread
              WHERE scope = $1 AND pr_number = $2 AND merged_into IS NULL FOR UPDATE`,
            [input.scope, pr],
          )
        : null;
      const branchRow = usableBranch
        ? await tx.queryOne<any>(
            `SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread
              WHERE scope = $1 AND head_branch = $2 AND merged_into IS NULL
                AND state IN ${LIVE_STATES} FOR UPDATE`,
            [input.scope, usableBranch],
          )
        : null;

      const mergedFrom: string[] = [];
      if (prRow && branchRow && prRow.id !== branchRow.id) {
        await this.mergeThreadsTx(tx, branchRow.id, prRow.id);
        mergedFrom.push(branchRow.id);
      }

      const target = prRow ?? branchRow;
      const finished = input.prState === "merged" || input.prState === "closed";

      if (target) {
        const row = await tx.queryOne<any>(
          `UPDATE qmd_ctx_thread
              SET pr_number   = coalesce(pr_number, $2),
                  head_branch = coalesce(head_branch, $3),
                  pr_state    = coalesce($4, pr_state),
                  head_sha    = coalesce($5, head_sha),
                  title       = CASE WHEN title = '' THEN coalesce($6, '') ELSE title END,
                  state       = CASE WHEN $7 AND state IN ${LIVE_STATES} THEN 'done' ELSE state END,
                  updated_at  = now()
            WHERE id = $1 RETURNING ${THREAD_COLUMNS}`,
          [target.id, pr ?? null, usableBranch ?? null, input.prState ?? null, input.headSha ?? null,
            input.title ?? null, finished],
        );
        return { ok: true, thread: toThread(row), created: false, mergedFrom };
      }

      const row = await tx.queryOne<any>(
        `INSERT INTO qmd_ctx_thread (scope, head_branch, pr_number, pr_state, head_sha, title, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${THREAD_COLUMNS}`,
        [input.scope, usableBranch ?? null, pr ?? null, input.prState ?? null, input.headSha ?? null,
          input.title ?? "", finished ? "done" : "open"],
      );
      await appendEvent(tx, row.id, "thread.created", {
        headBranch: usableBranch ?? null,
        prNumber: pr ?? null,
      });
      return { ok: true, thread: toThread(row), created: true, mergedFrom };
    });
  }

  /** Explicit thread for work that has no usable branch (e.g. directly on main). */
  async createThread(scope: string, title: string, headSha?: string): Promise<ContextThread> {
    return this.client.tx(async (tx) => {
      const row = await tx.queryOne<any>(
        `INSERT INTO qmd_ctx_thread (scope, title, head_sha) VALUES ($1, $2, $3) RETURNING ${THREAD_COLUMNS}`,
        [scope, title, headSha ?? null],
      );
      await appendEvent(tx, row.id, "thread.created", { explicit: true });
      return toThread(row);
    });
  }

  /** Read-only lookup: the live thread for a PR, else a branch. Never creates. */
  async findThread(scope: string, headBranch?: string, prNumber?: number): Promise<ContextThread | null> {
    if (prNumber) {
      const row = await this.client.queryOne<any>(
        `SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread WHERE scope = $1 AND pr_number = $2 AND merged_into IS NULL`,
        [scope, prNumber],
      );
      if (row) return toThread(row);
    }
    if (!headBranch || DEFAULT_BRANCHES.has(headBranch)) return null;
    const row = await this.client.queryOne<any>(
      `SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread
        WHERE scope = $1 AND head_branch = $2 AND merged_into IS NULL
        ORDER BY (state IN ${LIVE_STATES}) DESC, updated_at DESC LIMIT 1`,
      [scope, headBranch],
    );
    return row ? toThread(row) : null;
  }

  async getThread(threadId: string): Promise<ContextThread | null> {
    const row = await this.client.queryOne<any>(`SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread WHERE id = $1`, [
      threadId,
    ]);
    if (!row) return null;
    if (row.merged_into) return this.getThread(row.merged_into);
    return toThread(row);
  }

  async threads(scope: string, opts: { all?: boolean; limit?: number } = {}): Promise<
    Array<ContextThread & { items: number; sessions: number }>
  > {
    const stateClause = opts.all ? "" : `AND t.state IN ${LIVE_STATES}`;
    const rows = await this.client.query<any>(
      `SELECT ${THREAD_COLUMNS.split(",").map((c) => `t.${c.trim()}`).join(", ")},
              (SELECT count(*) FROM qmd_ctx_item i WHERE i.thread_id = t.id) AS items,
              (SELECT count(*) FROM qmd_ctx_session s WHERE s.thread_id = t.id) AS sessions
         FROM qmd_ctx_thread t
        WHERE t.scope = $1 AND t.merged_into IS NULL ${stateClause}
        ORDER BY t.updated_at DESC
        LIMIT $2`,
      [scope, opts.limit ?? 50],
    );
    return rows.map((r) => ({ ...toThread(r), items: Number(r.items), sessions: Number(r.sessions) }));
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async attachSession(threadId: string, input: AttachInput): Promise<string> {
    const root = await this.getThread(threadId);
    if (!root) throw new Error(`thread ${threadId} not found`);
    const row = await this.client.queryOne<{ id: string }>(
      `INSERT INTO qmd_ctx_session (thread_id, source, source_session_id, agent_kind, title, head_sha)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source, source_session_id, thread_id) DO UPDATE
         SET last_seen_at = now(),
             title = CASE WHEN EXCLUDED.title = '' THEN qmd_ctx_session.title ELSE EXCLUDED.title END,
             head_sha = coalesce(EXCLUDED.head_sha, qmd_ctx_session.head_sha)
       RETURNING id`,
      [root.id, input.source, input.sourceSessionId, input.agentKind ?? "unknown", input.title ?? "",
        input.headSha ?? null],
    );
    return row!.id;
  }

  // ── Lease (who drives direction) ────────────────────────────────────────

  /**
   * Become the thread's driver. Renewing your own lease keeps the fence; taking
   * the thread from someone else bumps it, so their later direction writes are
   * demoted to proposals.
   */
  async lead(
    threadId: string,
    sessionId: string,
    opts: { ttlSeconds?: number; takeover?: boolean } = {},
  ): Promise<{ ok: true; fence: number; thread: ContextThread } | { ok: false; holder: string; leaseExpiresAt: string }> {
    const ttl = opts.ttlSeconds ?? 1800;
    return this.client.tx(async (tx) => {
      const t = await lockRoot(tx, threadId);
      const live = !!t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() > Date.now();
      const heldByOther = !!t.driverSessionId && t.driverSessionId !== sessionId && live;
      if (heldByOther && !(opts.takeover && (t.state === "handed_off" || t.state === "paused"))) {
        return { ok: false, holder: t.driverSessionId!, leaseExpiresAt: t.leaseExpiresAt! };
      }
      const sameDriver = t.driverSessionId === sessionId;
      const row = await tx.queryOne<any>(
        `UPDATE qmd_ctx_thread
            SET driver_session_id = $2,
                lease_expires_at = now() + make_interval(secs => $3),
                fence = CASE WHEN $4 THEN fence ELSE fence + 1 END,
                state = CASE WHEN state IN ('handed_off', 'paused') THEN 'open' ELSE state END,
                updated_at = now()
          WHERE id = $1 RETURNING ${THREAD_COLUMNS}`,
        [t.id, sessionId, ttl, sameDriver],
      );
      if (!sameDriver) {
        await appendEvent(tx, t.id, "lease.acquired", { fence: Number(row.fence) }, { sessionId });
      }
      return { ok: true, fence: Number(row.fence), thread: toThread(row) };
    });
  }

  // ── Items ───────────────────────────────────────────────────────────────

  /**
   * Merge a batch of items from one session. Idempotent per `clientRequestId`:
   * a replay (collector restart, outbox retry, bridge retry) is a no-op.
   */
  async mergeItems(
    threadId: string,
    sessionId: string,
    items: IncomingItem[],
    opts: { clientRequestId?: string; fence?: number } = {},
  ): Promise<MergeResult> {
    return this.client.tx(async (tx) => {
      if (opts.clientRequestId) {
        const seen = await tx.queryOne<{ thread_id: string }>(
          `SELECT thread_id FROM qmd_ctx_event WHERE client_request_id = $1`,
          [opts.clientRequestId],
        );
        if (seen) {
          return {
            threadId: seen.thread_id, duplicate: true, inserted: 0, updated: 0, touched: 0, proposed: 0, rejected: [],
          };
        }
      }

      const t = await lockRoot(tx, threadId);
      const leaseLive = !!t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() > Date.now();
      const isDriver =
        t.driverSessionId === sessionId && leaseLive && (opts.fence === undefined || opts.fence === t.fence);
      const ctx = { sessionId, isDriver, threadHead: t.headSha };

      const result: MergeResult = {
        threadId: t.id, duplicate: false, inserted: 0, updated: 0, touched: 0, proposed: 0, rejected: [],
      };
      const revisions: string[] = [];

      for (const item of items) {
        const secret = findSecret(`${item.text ?? ""} ${item.detail ?? ""} ${item.key ?? ""}`);
        if (secret) {
          result.rejected.push({ kind: String(item.kind), reason: `looks like a secret (${secret})` });
          continue;
        }
        const key = itemKey(item, ctx);
        const existingRow = await tx.queryOne<any>(
          `SELECT id, kind, item_key, status, ord, body, git_head FROM qmd_ctx_item
            WHERE thread_id = $1 AND kind = $2 AND item_key = $3 FOR UPDATE`,
          [t.id, item.kind, key],
        );
        const verdict = mergeItem(existingRow ? toStored(existingRow) : null, item, ctx);

        let itemId: number | null = existingRow ? Number(existingRow.id) : null;
        switch (verdict.action) {
          case "reject":
            result.rejected.push({ kind: String(item.kind), reason: verdict.reason });
            continue;
          case "insert": {
            const row = await tx.queryOne<{ id: string }>(
              `INSERT INTO qmd_ctx_item
                 (thread_id, kind, item_key, status, ord, body, git_head, created_session_id, updated_session_id)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8) RETURNING id`,
              [t.id, verdict.next.kind, verdict.next.key, verdict.next.status, verdict.next.ord,
                JSON.stringify(verdict.next.body), verdict.next.gitHead, sessionId],
            );
            itemId = Number(row!.id);
            result.inserted++;
            if (verdict.next.status === "proposed") result.proposed++;
            break;
          }
          case "update":
            await tx.exec(
              `UPDATE qmd_ctx_item
                  SET status = $2, ord = $3, body = $4::jsonb, git_head = $5,
                      updated_session_id = $6, updated_at = now()
                WHERE id = $1`,
              [itemId, verdict.next.status, verdict.next.ord, JSON.stringify(verdict.next.body),
                verdict.next.gitHead, sessionId],
            );
            result.updated++;
            if (verdict.next.status === "proposed") result.proposed++;
            if (verdict.event) revisions.push(`${verdict.event}:${verdict.next.key}`);
            break;
          case "touch":
            result.touched++;
            break;
        }

        await tx.exec(
          `INSERT INTO qmd_ctx_item_source (item_id, session_id) VALUES ($1, $2)
           ON CONFLICT (item_id, session_id) DO UPDATE SET last_seen_at = now()`,
          [itemId, sessionId],
        );
      }

      await appendEvent(
        tx,
        t.id,
        "context.merged",
        {
          inserted: result.inserted,
          updated: result.updated,
          touched: result.touched,
          proposed: result.proposed,
          rejected: result.rejected.slice(0, 20),
          ...(revisions.length ? { revisions: revisions.slice(0, 20) } : {}),
        },
        { sessionId, ...(opts.clientRequestId ? { clientRequestId: opts.clientRequestId } : {}) },
      );
      await tx.exec(`UPDATE qmd_ctx_session SET last_seen_at = now() WHERE id = $1`, [sessionId]);
      return result;
    });
  }

  /**
   * Hand the thread over: merge the final items (next_action required), then
   * clear the lease and mark it handed off. Only the current driver may do this.
   */
  async handoff(
    threadId: string,
    sessionId: string,
    fence: number,
    nextAction: string,
    items: IncomingItem[] = [],
  ): Promise<{ ok: true; merge: MergeResult } | { ok: false; reason: string }> {
    if (!nextAction.trim()) return { ok: false, reason: "next_action is required for a handoff" };
    const t = await this.getThread(threadId);
    if (!t) return { ok: false, reason: `thread ${threadId} not found` };
    const leaseLive = !!t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() > Date.now();
    if (t.driverSessionId !== sessionId || t.fence !== fence || !leaseLive) {
      return { ok: false, reason: "only the current driver can hand off (lease lost or fence changed)" };
    }
    const merge = await this.mergeItems(t.id, sessionId, [...items, { kind: "next_action", text: nextAction }], {
      fence,
    });
    await this.client.tx(async (tx) => {
      await lockRoot(tx, t.id);
      await tx.exec(
        `UPDATE qmd_ctx_thread
            SET state = 'handed_off', driver_session_id = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND driver_session_id = $2 AND fence = $3`,
        [t.id, sessionId, fence],
      );
      await appendEvent(tx, t.id, "handoff.created", { fence }, { sessionId });
    });
    return { ok: true, merge };
  }

  // ── Merge threads ───────────────────────────────────────────────────────

  async mergeThreads(fromId: string, intoId: string): Promise<void> {
    await this.client.tx((tx) => this.mergeThreadsTx(tx, fromId, intoId));
  }

  /** Fold `from` into `into` (plan §4.4). Caller holds the transaction. */
  private async mergeThreadsTx(tx: PgTxClient, fromId: string, intoId: string): Promise<void> {
    if (fromId === intoId) return;
    // Lock in id order so concurrent merges cannot deadlock.
    const [a, b] = [fromId, intoId].sort();
    await tx.query(`SELECT id FROM qmd_ctx_thread WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`, [a, b]);
    const into = await tx.queryOne<any>(`SELECT ${THREAD_COLUMNS} FROM qmd_ctx_thread WHERE id = $1`, [intoId]);

    // 1. Mark `from` merged first, so it drops out of the live-branch/PR indexes.
    const from = await tx.queryOne<any>(
      `UPDATE qmd_ctx_thread SET merged_into = $2, updated_at = now() WHERE id = $1 RETURNING ${THREAD_COLUMNS}`,
      [fromId, intoId],
    );

    // 2. Re-home sessions; collapse duplicates of the same source session.
    const sessions = await tx.query<any>(
      `SELECT id, source, source_session_id FROM qmd_ctx_session WHERE thread_id = $1`,
      [fromId],
    );
    for (const s of sessions) {
      const dup = await tx.queryOne<{ id: string }>(
        `SELECT id FROM qmd_ctx_session WHERE thread_id = $1 AND source = $2 AND source_session_id = $3`,
        [intoId, s.source, s.source_session_id],
      );
      if (dup) {
        await tx.exec(
          `INSERT INTO qmd_ctx_item_source (item_id, session_id, first_seen_at, last_seen_at)
           SELECT item_id, $2, first_seen_at, last_seen_at FROM qmd_ctx_item_source WHERE session_id = $1
           ON CONFLICT (item_id, session_id) DO NOTHING`,
          [s.id, dup.id],
        );
        await tx.exec(`DELETE FROM qmd_ctx_session WHERE id = $1`, [s.id]);
      } else {
        await tx.exec(`UPDATE qmd_ctx_session SET thread_id = $2 WHERE id = $1`, [s.id, intoId]);
      }
    }

    // 3. Re-merge every item through the normal rules.
    const intoHasCurrent = async (kind: string) =>
      !!(await tx.queryOne(
        `SELECT 1 FROM qmd_ctx_item WHERE thread_id = $1 AND kind = $2 AND item_key = 'current'`,
        [intoId, kind],
      ));
    const items = await tx.query<any>(`SELECT * FROM qmd_ctx_item WHERE thread_id = $1 ORDER BY id`, [fromId]);
    for (const row of items) {
      const stored = toStored(row);
      const direction = stored.kind === "goal" || stored.kind === "next_action";
      const writer = stored.key.startsWith("proposed:")
        ? stored.key.slice("proposed:".length)
        : (row.updated_session_id ?? fromId);
      const ctx = {
        sessionId: writer,
        isDriver: direction && stored.key === "current" && !(await intoHasCurrent(stored.kind)),
        threadHead: into.head_sha,
      };
      const incoming: IncomingItem = {
        kind: stored.kind,
        text: stored.body.text,
        status: stored.status === "current" || stored.status === "proposed" || stored.status === "active"
          ? undefined
          : stored.status,
        at: stored.body.at,
        ...(stored.body.detail ? { detail: stored.body.detail } : {}),
        ...(stored.gitHead ? { gitHead: stored.gitHead } : {}),
        ...(stored.ord !== null ? { ord: stored.ord } : {}),
        ...(stored.kind === "plan_step" || stored.kind === "decision" ? { key: stored.key } : {}),
      };
      const key = itemKey(incoming, ctx);
      const existing = await tx.queryOne<any>(
        `SELECT id, kind, item_key, status, ord, body, git_head FROM qmd_ctx_item
          WHERE thread_id = $1 AND kind = $2 AND item_key = $3 FOR UPDATE`,
        [intoId, incoming.kind, key],
      );
      const verdict = mergeItem(existing ? toStored(existing) : null, incoming, ctx);
      let targetId: number | null = existing ? Number(existing.id) : null;
      if (verdict.action === "insert") {
        const ins = await tx.queryOne<{ id: string }>(
          `INSERT INTO qmd_ctx_item
             (thread_id, kind, item_key, status, ord, body, git_head, created_session_id, updated_session_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) RETURNING id`,
          [intoId, verdict.next.kind, verdict.next.key, verdict.next.status, verdict.next.ord,
            JSON.stringify(verdict.next.body), verdict.next.gitHead, row.created_session_id,
            row.updated_session_id, row.created_at],
        );
        targetId = Number(ins!.id);
      } else if (verdict.action === "update") {
        await tx.exec(
          `UPDATE qmd_ctx_item SET status = $2, ord = $3, body = $4::jsonb, git_head = $5, updated_at = now()
            WHERE id = $1`,
          [targetId, verdict.next.status, verdict.next.ord, JSON.stringify(verdict.next.body), verdict.next.gitHead],
        );
      }
      if (targetId !== null) {
        await tx.exec(
          `INSERT INTO qmd_ctx_item_source (item_id, session_id, first_seen_at, last_seen_at)
           SELECT $2, session_id, first_seen_at, last_seen_at FROM qmd_ctx_item_source WHERE item_id = $1
           ON CONFLICT (item_id, session_id) DO NOTHING`,
          [row.id, targetId],
        );
      }
    }
    await tx.exec(`DELETE FROM qmd_ctx_item WHERE thread_id = $1`, [fromId]);

    // 4. Claims follow; both drivers must re-acquire direction.
    await tx.exec(`UPDATE qmd_task_claim SET thread_id = $2 WHERE thread_id = $1`, [fromId, intoId]);
    await tx.exec(
      `UPDATE qmd_ctx_thread
          SET head_branch = coalesce(head_branch, $2),
              pr_number = coalesce(pr_number, $3),
              title = CASE WHEN title = '' THEN $4 ELSE title END,
              driver_session_id = NULL, lease_expires_at = NULL, fence = fence + 1, updated_at = now()
        WHERE id = $1`,
      [intoId, from.head_branch, from.pr_number, from.title ?? ""],
    );
    await appendEvent(tx, intoId, "thread.merged", { from: fromId });
    await appendEvent(tx, fromId, "thread.merged", { into: intoId });
  }

  // ── Read ────────────────────────────────────────────────────────────────

  async briefing(threadId: string, opts: { events?: number } = {}): Promise<Briefing | null> {
    const thread = await this.getThread(threadId);
    if (!thread) return null;

    const items = await this.client.query<any>(
      `SELECT i.kind, i.item_key, i.status, i.ord, i.body, i.git_head,
              coalesce(array_agg(DISTINCT s.source) FILTER (WHERE s.source IS NOT NULL), '{}') AS sources
         FROM qmd_ctx_item i
         LEFT JOIN qmd_ctx_item_source x ON x.item_id = i.id
         LEFT JOIN qmd_ctx_session s ON s.id = x.session_id
        WHERE i.thread_id = $1
        GROUP BY i.id
        ORDER BY i.kind, i.ord NULLS LAST, i.created_at`,
      [thread.id],
    );
    const contributors = await this.client.query<any>(
      `SELECT source, count(*) AS sessions, max(last_seen_at) AS last_seen_at
         FROM qmd_ctx_session WHERE thread_id = $1 GROUP BY source ORDER BY max(last_seen_at) DESC`,
      [thread.id],
    );
    const events = await this.client.query<any>(
      `SELECT seq, event_type, created_at, payload FROM qmd_ctx_event
        WHERE thread_id = $1 OR thread_id IN (SELECT id FROM qmd_ctx_thread WHERE merged_into = $1)
        ORDER BY created_at DESC LIMIT $2`,
      [thread.id, opts.events ?? 10],
    );

    return {
      thread,
      items: items.map((r) => ({
        kind: r.kind,
        key: r.item_key,
        status: r.status,
        ord: r.ord ?? null,
        text: r.body.text,
        detail: r.body.detail ?? null,
        at: r.body.at,
        gitHead: r.git_head ?? null,
        sources: r.sources ?? [],
      })),
      contributors: contributors.map((c) => ({
        source: c.source,
        sessions: Number(c.sessions),
        lastSeenAt: new Date(c.last_seen_at).toISOString(),
      })),
      events: events.map((e) => ({
        seq: Number(e.seq),
        type: e.event_type,
        createdAt: new Date(e.created_at).toISOString(),
        payload: e.payload,
      })),
    };
  }

  // ── Pinned tasks & Shared projects catalog ─────────────────────────────

  async upsertSharedProjects(
    projects: Array<{ id: string; name: string; rootPath: string; source: string }>,
  ): Promise<void> {
    for (const p of projects) {
      await this.client.exec(
        `INSERT INTO qmd_shared_project (id, name, root_path, sources, updated_at)
         VALUES ($1, $2, $3, ARRAY[$4]::text[], now())
         ON CONFLICT (root_path) DO UPDATE
           SET name = EXCLUDED.name,
               sources = ARRAY(SELECT DISTINCT UNNEST(qmd_shared_project.sources || EXCLUDED.sources)),
               updated_at = now()`,
        [p.id, p.name, p.rootPath, p.source],
      );
    }
  }

  async upsertPinnedTasks(tasks: PinnedTask[]): Promise<void> {
    for (const t of tasks) {
      await this.client.exec(
        `INSERT INTO qmd_pinned_task (id, source, title, cwd, project_name, git_branch, position, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
           SET source = EXCLUDED.source,
               title = EXCLUDED.title,
               cwd = EXCLUDED.cwd,
               project_name = EXCLUDED.project_name,
               git_branch = EXCLUDED.git_branch,
               position = EXCLUDED.position,
               updated_at = EXCLUDED.updated_at`,
        [
          t.id,
          t.source,
          t.title,
          t.cwd ?? null,
          t.projectName ?? null,
          t.gitBranch ?? null,
          t.position ?? 0,
          t.updatedAt ?? new Date().toISOString(),
        ],
      );
    }
  }

  async listSharedProjects(): Promise<SharedProject[]> {
    const rows = await this.client.query<any>(
      `SELECT id, name, root_path, sources, updated_at FROM qmd_shared_project ORDER BY name ASC`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      rootPath: r.root_path,
      sources: r.sources ?? [],
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  async listPinnedTasks(source?: string): Promise<PinnedTask[]> {
    const sql = source
      ? `SELECT id, source, title, cwd, project_name, git_branch, position, updated_at
         FROM qmd_pinned_task WHERE source = $1 ORDER BY position ASC, updated_at DESC`
      : `SELECT id, source, title, cwd, project_name, git_branch, position, updated_at
         FROM qmd_pinned_task ORDER BY position ASC, updated_at DESC`;
    const rows = await this.client.query<any>(sql, source ? [source] : []);
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      cwd: r.cwd ?? undefined,
      projectName: r.project_name ?? undefined,
      gitBranch: r.git_branch ?? undefined,
      position: Number(r.position),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  async getCatalog(_cwd?: string): Promise<TaskCatalog> {
    const pinnedTasks = await this.listPinnedTasks();
    const sharedProjects = await this.listSharedProjects();

    const activeClaimsRaw = await this.client.query<any>(
      `SELECT resource, agent_id, agent_kind, intent, thread_id,
              (heartbeat_at + make_interval(secs => ttl_seconds)) AS expires_at
       FROM qmd_task_claim
       WHERE status = 'active' AND heartbeat_at > now() - make_interval(secs => ttl_seconds)
       ORDER BY claimed_at DESC`,
    );
    const activeClaims = activeClaimsRaw.map((c) => ({
      resource: c.resource,
      agentId: c.agent_id,
      agentKind: c.agent_kind,
      intent: c.intent,
      expiresAt: new Date(c.expires_at).toISOString(),
      threadId: c.thread_id ?? undefined,
    }));

    const recentRows = await this.client.query<any>(
      `SELECT ${THREAD_COLUMNS}
       FROM qmd_ctx_thread
       WHERE state IN ${LIVE_STATES}
       ORDER BY updated_at DESC LIMIT 20`,
    );
    const recentThreads = recentRows.map(toThread);

    return {
      pinnedTasks,
      sharedProjects,
      activeClaims,
      recentThreads,
    };
  }

  // ── Collector cursors ───────────────────────────────────────────────────

  async getCursor(source: string, path: string): Promise<IngestCursor | null> {
    const row = await this.client.queryOne<any>(
      `SELECT size, mtime_ms, byte_offset, meta FROM qmd_ctx_ingest_cursor WHERE source = $1 AND path = $2`,
      [source, path],
    );
    return row
      ? { size: Number(row.size), mtimeMs: Number(row.mtime_ms), offset: Number(row.byte_offset), meta: row.meta }
      : null;
  }

  async setCursor(source: string, path: string, cursor: IngestCursor): Promise<void> {
    await this.client.exec(
      `INSERT INTO qmd_ctx_ingest_cursor (source, path, size, mtime_ms, byte_offset, meta, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
       ON CONFLICT (source, path) DO UPDATE
         SET size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms, byte_offset = EXCLUDED.byte_offset,
             meta = EXCLUDED.meta, updated_at = now()`,
      [source, path, cursor.size, cursor.mtimeMs, cursor.offset, JSON.stringify(cursor.meta ?? {})],
    );
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export interface IngestCursor {
  size: number;
  mtimeMs: number;
  offset: number;
  meta: Record<string, unknown>;
}

export type { Querier };
