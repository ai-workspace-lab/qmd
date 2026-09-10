/**
 * pg/task-store.ts - Task coordination layer (advisory claims)
 *
 * Sits beside PgMemoryStore on the same PostgreSQL instance but is a different
 * kind of thing: memory is content-addressed, semantic and permanent; a claim is
 * structured, exact and expires. Search would be the wrong primitive here —
 * "is anyone editing this file right now" has to be answered authoritatively,
 * and a reranked hybrid query that misses once has failed to coordinate.
 *
 * The locks are ADVISORY by design. Only half the agent clients (Claude Code,
 * Antigravity) can enforce a pre-write hook; OpenCode and Codex will inevitably
 * skip the call. Missing a claim must therefore cost coordination benefit only —
 * never correctness, never a blocked developer. See
 * docs/plan/agent-task-coordination.md §8.3.
 */

import { PgClient } from "./db-pg.js";
import type { PgConnectionConfig } from "./config.js";
import { bootstrapTaskSchema } from "./schema-pg.js";

/** Lifecycle of a claim row. Only `active` participates in the unique index. */
export type ClaimStatus = "active" | "done" | "abandoned";

export interface TaskClaim {
  id: number;
  scope: string;
  resource: string;
  agentId: string;
  agentKind: string;
  intent: string;
  branch: string | null;
  worktree: string | null;
  prNumber: number | null;
  baseSha: string | null;
  status: ClaimStatus;
  claimedAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
  releasedAt: string | null;
  note: string | null;
  /** True when the TTL has lapsed — the row is active but no longer live. */
  stale?: boolean;
}

export interface ClaimInput {
  scope: string;
  resource: string;
  agentId: string;
  agentKind?: string;
  intent?: string;
  branch?: string;
  worktree?: string;
  prNumber?: number;
  baseSha?: string;
  ttlSeconds?: number;
  /** Take the claim even if another live agent holds it. */
  force?: boolean;
}

export type ClaimResult =
  | { ok: true; claim: TaskClaim; reclaimed: boolean; stolen: boolean }
  | { ok: false; holder: TaskClaim };

const COLUMNS = `id, scope, resource, agent_id, agent_kind, intent, branch, worktree,
  pr_number, base_sha, status, claimed_at, heartbeat_at, ttl_seconds, released_at, note`;

/** A claim is only binding while its heartbeat is inside its TTL. */
const LIVE = `status = 'active' AND heartbeat_at > now() - make_interval(secs => ttl_seconds)`;

/**
 * Resource matching. An exact hit always counts; additionally a stored glob
 * (`.github/workflows/*`) covers the resource being asked about.
 *
 * The translation is just `*` → `%`, so a literal `_` in a path behaves as a
 * single-character wildcard. That can only ever produce a false *positive* —
 * one extra "someone may be working here" warning — which is the safe direction
 * for an advisory lock.
 */
const MATCHES = `(resource = $2 OR (resource LIKE '%*%' AND $2 LIKE replace(resource, '*', '%')))`;

function toClaim(row: any): TaskClaim {
  return {
    id: Number(row.id),
    scope: row.scope,
    resource: row.resource,
    agentId: row.agent_id,
    agentKind: row.agent_kind,
    intent: row.intent ?? "",
    branch: row.branch ?? null,
    worktree: row.worktree ?? null,
    prNumber: row.pr_number ?? null,
    baseSha: row.base_sha ?? null,
    status: row.status,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    ttlSeconds: Number(row.ttl_seconds),
    releasedAt: row.released_at ?? null,
    note: row.note ?? null,
    ...(row.stale === undefined ? {} : { stale: !!row.stale }),
  };
}

export class PgTaskStore {
  private constructor(
    private client: PgClient,
    private defaultScope: string,
  ) {}

  /**
   * Open a coordination handle. Unlike the memory bridge this needs no embedder
   * and no LLM — just a connection pool — so hook-path commands stay cheap.
   */
  static async open(config: PgConnectionConfig, defaultScope = ""): Promise<PgTaskStore> {
    const client = await PgClient.create(config);
    await bootstrapTaskSchema(client);
    return new PgTaskStore(client, defaultScope);
  }

  // ── Write ──────────────────────────────────────────────────────────────

  /**
   * Atomically take a claim.
   *
   * Runs as an explicit transaction rather than one clever data-modifying CTE:
   * expiry and insertion must observe each other, and PostgreSQL's WITH
   * sub-statements deliberately do not see each other's effects. Two racing
   * agents serialise on the partial unique index — the loser's
   * `ON CONFLICT DO NOTHING` yields zero rows and it re-reads the winner.
   */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    const {
      scope,
      resource,
      agentId,
      agentKind = "unknown",
      intent = "",
      branch,
      worktree,
      prNumber,
      baseSha,
      ttlSeconds = 1800,
      force = false,
    } = input;

    return this.client.tx(async (tx) => {
      // 1. Retire anything whose TTL lapsed. Lazy expiry keeps pg_cron optional.
      await tx.exec(
        `UPDATE qmd_task_claim
            SET status = 'abandoned', released_at = now(),
                note = coalesce(note, '') || ' [expired]'
          WHERE scope = $1 AND resource = $2 AND status = 'active'
            AND heartbeat_at <= now() - make_interval(secs => ttl_seconds)`,
        [scope, resource],
      );

      // 2. Is a live claim still standing on this exact resource?
      const holderRow = await tx.queryOne<any>(
        `SELECT ${COLUMNS} FROM qmd_task_claim
          WHERE scope = $1 AND resource = $2 AND ${LIVE} LIMIT 1`,
        [scope, resource],
      );

      if (holderRow) {
        const holder = toClaim(holderRow);

        // Re-claiming our own work is idempotent: refresh rather than collide.
        if (holder.agentId === agentId) {
          const updated = await tx.queryOne<any>(
            `UPDATE qmd_task_claim
                SET heartbeat_at = now(),
                    intent = CASE WHEN $1 = '' THEN intent ELSE $1 END,
                    ttl_seconds = $2
              WHERE id = $3 RETURNING ${COLUMNS}`,
            [intent, ttlSeconds, holder.id],
          );
          return { ok: true, claim: toClaim(updated), reclaimed: true, stolen: false };
        }

        if (!force) return { ok: false, holder };

        await tx.exec(
          `UPDATE qmd_task_claim
              SET status = 'abandoned', released_at = now(),
                  note = coalesce(note, '') || ' [forced by ' || $2 || ']'
            WHERE id = $1`,
          [holder.id, agentId],
        );
      }

      // 3. Insert. DO NOTHING rather than an error: losing a race is an
      //    expected outcome that the caller reports, not an exception.
      const inserted = await tx.queryOne<any>(
        `INSERT INTO qmd_task_claim
           (scope, resource, agent_id, agent_kind, intent, branch, worktree,
            pr_number, base_sha, ttl_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          scope,
          resource,
          agentId,
          agentKind,
          intent,
          branch ?? null,
          worktree ?? null,
          prNumber ?? null,
          baseSha ?? null,
          ttlSeconds,
        ],
      );

      if (inserted) {
        return { ok: true, claim: toClaim(inserted), reclaimed: false, stolen: !!holderRow };
      }

      // Lost the race between step 2 and step 3 — report the actual winner.
      const winner = await tx.queryOne<any>(
        `SELECT ${COLUMNS} FROM qmd_task_claim
          WHERE scope = $1 AND resource = $2 AND status = 'active' LIMIT 1`,
        [scope, resource],
      );
      if (!winner) {
        throw new Error(
          `claim on ${resource} was rejected but no holder is visible; retry`,
        );
      }
      return { ok: false, holder: toClaim(winner) };
    });
  }

  /** Extend a live claim. Returns false when the claim is gone or not ours. */
  async heartbeat(scope: string, resource: string, agentId: string): Promise<boolean> {
    const n = await this.client.exec(
      `UPDATE qmd_task_claim SET heartbeat_at = now()
        WHERE scope = $1 AND resource = $2 AND agent_id = $3 AND status = 'active'`,
      [scope, resource, agentId],
    );
    return n > 0;
  }

  /**
   * Finish a claim. Without `force`, only the owning agent may release — a
   * stray agent must not silently close someone else's work.
   */
  async release(
    scope: string,
    resource: string,
    opts: {
      agentId: string;
      status?: Exclude<ClaimStatus, "active">;
      note?: string;
      force?: boolean;
    },
  ): Promise<TaskClaim | null> {
    const status = opts.status ?? "done";
    const params: unknown[] = [scope, resource, status, opts.note ?? null];
    let ownerClause = "";
    if (!opts.force) {
      params.push(opts.agentId);
      ownerClause = ` AND agent_id = $5`;
    }
    const row = await this.client.queryOne<any>(
      `UPDATE qmd_task_claim
          SET status = $3, released_at = now(), note = coalesce($4, note)
        WHERE scope = $1 AND resource = $2 AND status = 'active'${ownerClause}
        RETURNING ${COLUMNS}`,
      params,
    );
    return row ? toClaim(row) : null;
  }

  // ── Read ───────────────────────────────────────────────────────────────

  /**
   * Who currently holds this resource — exact claims plus any glob claim that
   * covers it. Never blocks; returns [] when nobody does.
   */
  async who(scope: string, resource: string): Promise<TaskClaim[]> {
    const rows = await this.client.query<any>(
      `SELECT ${COLUMNS} FROM qmd_task_claim
        WHERE scope = $1 AND ${MATCHES} AND ${LIVE}
        ORDER BY claimed_at`,
      [scope, resource],
    );
    return rows.map(toClaim);
  }

  /**
   * All claims in a scope. `includeStale` also surfaces active rows whose TTL
   * has lapsed but which no `claim` call has retired yet.
   */
  async list(
    scope: string,
    opts?: { includeStale?: boolean; limit?: number },
  ): Promise<TaskClaim[]> {
    const staleClause = opts?.includeStale
      ? `status = 'active'`
      : LIVE;
    const rows = await this.client.query<any>(
      `SELECT ${COLUMNS},
              (heartbeat_at <= now() - make_interval(secs => ttl_seconds)) AS stale
         FROM qmd_task_claim
        WHERE scope = $1 AND ${staleClause}
        ORDER BY stale, claimed_at
        LIMIT $2`,
      [scope, opts?.limit ?? 200],
    );
    return rows.map(toClaim);
  }

  /** Recently finished claims — the "what just happened here" view. */
  async history(scope: string, limit = 20): Promise<TaskClaim[]> {
    const rows = await this.client.query<any>(
      `SELECT ${COLUMNS} FROM qmd_task_claim
        WHERE scope = $1 AND status <> 'active'
        ORDER BY released_at DESC NULLS LAST
        LIMIT $2`,
      [scope, limit],
    );
    return rows.map(toClaim);
  }

  /** Every scope that has live claims — a cross-project overview. */
  async scopes(): Promise<Array<{ scope: string; active: number }>> {
    const rows = await this.client.query<{ scope: string; active: string }>(
      `SELECT scope, count(*)::text AS active FROM qmd_task_claim
        WHERE ${LIVE} GROUP BY scope ORDER BY scope`,
    );
    return rows.map((r) => ({ scope: r.scope, active: Number.parseInt(r.active, 10) }));
  }

  async health(scope?: string): Promise<{ server: string; scope: string; active: number }> {
    const server = await this.client.ping();
    const target = scope || this.defaultScope;
    const row = await this.client.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM qmd_task_claim WHERE scope = $1 AND ${LIVE}`,
      [target],
    );
    return { server, scope: target, active: Number.parseInt(row?.count ?? "0", 10) };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
