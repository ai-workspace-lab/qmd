/**
 * tier/engine.ts - Three-tier memory engine (L1 QMD SQLite · L2 PostgreSQL · L3 Drive via .archive).
 *
 * L2 is authoritative: `mem_item` (+ `mem_*` tables) holds metadata and the
 * item body is stored as ≤2 KiB parts in the fork's `qmd_memory*` tables under
 * keys `mem/<item_id>/<seq>` (summary: `mem/<item_id>/summary`). L1 is a
 * rebuildable set of Markdown files indexed by the QMD collection `hot`. L3 is
 * staged in `l3-cache/` and committed once the `.archive` run that carried it
 * has been uploaded and verified.
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PgClient } from "../pg/db-pg.js";
import { toVectorLiteral } from "../pg/db-pg.js";
import { embeddingColumnType, ensureVectorIndex, type VectorColumnType } from "../pg/schema-pg.js";
import { bootstrapMemSchema, type MemItemKind } from "../pg/schema-mem.js";
import type { Embedder } from "../pg/memory-store.js";
import { hashContent, chunkDocument } from "../store.js";
import { formatDocForEmbedding, formatQueryForEmbedding } from "../llm.js";
import { findSecret } from "../collect/redact.js";
import {
  canCompact,
  capacityEvictions,
  heatScore,
  l1AdmissionReason,
  relativizePath,
  rrf,
  shouldEvictL1,
  splitParts,
  type TierItemState,
  type TierPolicy,
} from "./policy.js";
import { removeL1Item, writeL1Item, l1Usage, type L1Index } from "./l1.js";
import {
  archiveKey,
  l3TargetPath,
  makeRedactor,
  quarantine,
  readArchiveManifest,
  sha256Hex,
  writeL3Cache,
  type L3Redactor,
} from "./l3.js";
import { ExtractiveSummarizer, stripFrontmatter, type Summarizer } from "./summarize.js";
import { activateEligibleFacts, listFacts, type FactRow } from "./facts.js";
import type { TierConfig, SessionMeta, UpsertItemInput, UpsertItemResult, MemSearchHit, MemSearchOptions, MemSearchResult, ItemRow } from "./types.js";

export type { TierConfig, SessionMeta, UpsertItemInput, UpsertItemResult, MemSearchHit, MemSearchOptions, MemSearchResult, ItemRow } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function queryHash(q: string): string {
  return sha256Hex(q.trim().toLowerCase()).slice(0, 16);
}

/** CJK bigrams + latin words (≥2 chars) for the lexical fallback over L2. */
export function lexicalTerms(q: string): string[] {
  const terms = new Set<string>();
  for (const run of q.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  }
  for (const w of q.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) ?? []) {
    if (w.length >= 2) terms.add(w);
  }
  return [...terms].slice(0, 24);
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

export class TierEngine {
  readonly config: TierConfig;
  readonly client: PgClient;
  private embedder: Embedder | null;
  private l1: L1Index | null;
  private summarizer: Summarizer;
  private redactor: L3Redactor;
  private now: () => Date;
  private vecType?: VectorColumnType;

  constructor(deps: {
    client: PgClient;
    config: TierConfig;
    embedder?: Embedder | null;
    l1?: L1Index | null;
    summarizer?: Summarizer;
    redactor?: L3Redactor;
    now?: () => Date;
  }) {
    this.client = deps.client;
    this.config = deps.config;
    this.embedder = deps.embedder ?? null;
    this.l1 = deps.l1 ?? null;
    this.summarizer = deps.summarizer ?? new ExtractiveSummarizer();
    this.redactor = deps.redactor ?? makeRedactor();
    this.now = deps.now ?? (() => new Date());
  }

  async bootstrap(): Promise<void> {
    await bootstrapMemSchema(this.client);
  }

  get policy(): TierPolicy {
    return this.config.policy;
  }

  /** Override the clock (tests / time-travel simulations). */
  setClock(now: () => Date): void {
    this.now = now;
  }

  private key(id: string, seq: number | "summary"): string {
    return `mem/${id}/${seq}`;
  }

  // ── Write path ──────────────────────────────────────────────────────────

  async upsertItem(input: UpsertItemInput): Promise<UpsertItemResult> {
    const ns = this.config.namespace;
    const body = stripFrontmatter(input.body).trim();
    const rawText = input.raw ?? input.body;

    // L3 redaction first: its hash identifies the original.
    let l3: UpsertItemResult["l3"] = "skipped";
    let redacted: string | null = null;
    let redactionCounts: Record<string, number> = {};
    if (!input.skipL3) {
      const r = this.redactor(rawText);
      if (r.residual.length) {
        quarantine(this.config.quarantineDir, `${input.source}-${input.sourceRef}`, r.residual);
        l3 = "quarantined";
      } else {
        redacted = r.text;
        redactionCounts = r.counts;
      }
    }
    const sha = sha256Hex(redacted ?? body);

    // Index the redacted text too, so a pasted token costs a masked value
    // rather than a whole dropped part. Parts that still match findSecret
    // after redaction are dropped in writeParts.
    let indexBody = body;
    if (redacted !== null && input.raw === undefined) {
      indexBody = stripFrontmatter(redacted).trim();
    } else if (!input.skipL3) {
      const rb = this.redactor(body);
      if (!rb.residual.length) indexBody = rb.text.trim();
    }

    const existing = await this.client.queryOne<{ id: string; sha256: string; parts: number; tier_state: string }>(
      `SELECT id, sha256, parts, tier_state FROM mem_item WHERE source = $1 AND source_ref = $2`,
      [input.source, input.sourceRef],
    );
    if (existing?.tier_state === "tombstoned") {
      // A forgotten item stays forgotten: re-ingesting the same source is a no-op.
      return { id: existing.id, created: false, unchanged: true, parts: 0, droppedParts: 0, l3: "skipped", l1: null };
    }
    const unchanged = !!existing && existing.sha256 === sha && existing.tier_state === "l2_full" && !input.force;

    const row = await this.client.queryOne<{ id: string; inserted: boolean }>(
      `INSERT INTO mem_item (kind, source, source_ref, scope, title, occurred_at, sha256, bytes,
                             sensitivity, pinned, redaction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (source, source_ref) DO UPDATE SET
         kind = EXCLUDED.kind, scope = EXCLUDED.scope, title = EXCLUDED.title,
         occurred_at = EXCLUDED.occurred_at, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
         sensitivity = EXCLUDED.sensitivity,
         pinned = mem_item.pinned OR EXCLUDED.pinned,
         redaction = EXCLUDED.redaction,
         updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        input.kind,
        input.source,
        input.sourceRef,
        input.scope ?? null,
        input.title ?? null,
        input.occurredAt.toISOString(),
        sha,
        Buffer.byteLength(body),
        input.sensitivity ?? "private",
        input.pinned ?? false,
        JSON.stringify(redactionCounts),
      ],
    );
    const id = row!.id;

    if (input.session) await this.upsertSession(id, input.source, input.session);

    let parts = existing?.parts ?? 0;
    let dropped = 0;
    if (!unchanged) {
      const res = await this.writeParts(id, input.title ?? null, indexBody, {
        kind: input.kind,
        source: input.source,
        scope: input.scope ?? null,
      });
      parts = res.parts;
      dropped = res.dropped;
      const summary = input.summary ?? (await this.summarizer.summarize({ title: input.title ?? null, body: indexBody, kind: input.kind }));
      await this.writeSummary(id, input.title ?? null, summary);
      await this.client.exec(
        `UPDATE mem_item SET parts = $2, summary = $3, tier_state = 'l2_full', compacted_at = NULL, updated_at = now() WHERE id = $1`,
        [id, parts, summary],
      );
      await this.setLocation(id, "L2", `qmd_memory:${ns}:mem/${id}/`, "committed", { sha, bytes: Buffer.byteLength(body) });
    }

    if (redacted !== null) {
      l3 = await this.stageL3(id, input, redacted, unchanged);
    }

    if (input.embed !== false && !unchanged) await this.embedPending({ itemIds: [id] });

    let l1: string | null = null;
    if (input.materialize !== false) {
      const st = await this.itemState(id);
      if (st) {
        const reason = l1AdmissionReason(st, this.now(), this.policy);
        if (reason) {
          await this.materialize(id, reason);
          l1 = reason;
        }
      }
    }

    return { id, created: !!row!.inserted, unchanged, parts, droppedParts: dropped, l3, l1 };
  }

  private async upsertSession(id: string, source: string, s: SessionMeta): Promise<void> {
    await this.client.exec(
      `INSERT INTO mem_session (item_id, source, source_session_id, ctx_session_id, project, cwd_rel,
         started_at, ended_at, turns, tokens_in, tokens_out, tokens_total, models, primary_model, model_family,
         reasoning_effort, thinking, mode, role, role_level, role_rationale, routing_fit, kind, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb)
       ON CONFLICT (item_id) DO UPDATE SET
         ctx_session_id = COALESCE(EXCLUDED.ctx_session_id, mem_session.ctx_session_id),
         project = EXCLUDED.project, cwd_rel = EXCLUDED.cwd_rel, started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at, turns = EXCLUDED.turns, tokens_in = EXCLUDED.tokens_in,
         tokens_out = EXCLUDED.tokens_out, tokens_total = EXCLUDED.tokens_total, models = EXCLUDED.models,
         primary_model = EXCLUDED.primary_model, model_family = EXCLUDED.model_family,
         reasoning_effort = EXCLUDED.reasoning_effort, thinking = EXCLUDED.thinking, mode = EXCLUDED.mode,
         role = EXCLUDED.role, role_level = EXCLUDED.role_level, role_rationale = EXCLUDED.role_rationale,
         routing_fit = EXCLUDED.routing_fit, kind = EXCLUDED.kind,
         extra = mem_session.extra || EXCLUDED.extra`,
      [
        id, source, s.sourceSessionId, s.ctxSessionId ?? null, s.project ?? null, relativizePath(s.cwd),
        s.startedAt?.toISOString() ?? null, s.endedAt?.toISOString() ?? null, s.turns ?? null,
        s.tokensIn ?? null, s.tokensOut ?? null, s.tokensTotal ?? null, s.models ?? null,
        s.primaryModel ?? null, s.modelFamily ?? null, s.reasoningEffort ?? null, s.thinking ?? null,
        s.mode ?? null, s.role ?? null, s.roleLevel ?? null, s.roleRationale ?? null, s.routingFit ?? null,
        s.kind ?? null, JSON.stringify(s.extra ?? {}),
      ],
    );
  }

  /** Split + secret-filter + write parts as qmd_memory rows (no vectors yet). */
  private async writeParts(
    id: string,
    title: string | null,
    body: string,
    meta: { kind: string; source: string; scope: string | null },
  ): Promise<{ parts: number; dropped: number }> {
    const ns = this.config.namespace;
    const raw = splitParts(body, this.config.partBytes);
    const parts: string[] = [];
    let dropped = 0;
    for (const p of raw) {
      if (findSecret(p)) dropped++;
      else parts.push(p);
    }
    const hashes = await Promise.all(parts.map((p) => hashContent(p)));
    await this.client.tx(async (tx) => {
      for (let i = 0; i < parts.length; i++) {
        await tx.exec(
          `INSERT INTO qmd_memory_content (namespace, hash, body) VALUES ($1, $2, $3)
           ON CONFLICT (namespace, hash) DO NOTHING`,
          [ns, hashes[i], parts[i]],
        );
        await tx.exec(
          `INSERT INTO qmd_memory (namespace, key, title, hash, metadata, updated_at, active)
           VALUES ($1, $2, $3, $4, $5::jsonb, now(), true)
           ON CONFLICT (namespace, key) DO UPDATE SET title = EXCLUDED.title, hash = EXCLUDED.hash,
             metadata = EXCLUDED.metadata, updated_at = now(), active = true`,
          [ns, this.key(id, i), title ?? "", hashes[i],
           JSON.stringify({ item_id: id, seq: i, kind: meta.kind, source: meta.source, scope: meta.scope })],
        );
      }
      // Retire parts beyond the new count (body shrank).
      await tx.exec(
        `UPDATE qmd_memory SET active = false, updated_at = now()
         WHERE namespace = $1 AND key LIKE $2 AND active
           AND split_part(key, '/', 3) ~ '^[0-9]+$' AND split_part(key, '/', 3)::int >= $3`,
        [ns, `mem/${id}/%`, parts.length],
      );
    });
    return { parts: parts.length, dropped };
  }

  private async writeSummary(id: string, title: string | null, summary: string): Promise<void> {
    const ns = this.config.namespace;
    if (!summary.trim() || findSecret(summary)) return;
    const hash = await hashContent(summary);
    await this.client.tx(async (tx) => {
      await tx.exec(
        `INSERT INTO qmd_memory_content (namespace, hash, body) VALUES ($1, $2, $3)
         ON CONFLICT (namespace, hash) DO NOTHING`,
        [ns, hash, summary],
      );
      await tx.exec(
        `INSERT INTO qmd_memory (namespace, key, title, hash, metadata, updated_at, active)
         VALUES ($1, $2, $3, $4, $5::jsonb, now(), true)
         ON CONFLICT (namespace, key) DO UPDATE SET title = EXCLUDED.title, hash = EXCLUDED.hash,
           metadata = EXCLUDED.metadata, updated_at = now(), active = true`,
        [ns, this.key(id, "summary"), title ?? "", hash, JSON.stringify({ item_id: id, summary: true })],
      );
    });
  }

  async setLocation(
    id: string,
    tier: "L1" | "L2" | "L3" | "L3_cache",
    locator: string,
    state: "pending" | "committed" | "evicted" | "missing",
    extra: { sha?: string; bytes?: number; reason?: string } = {},
  ): Promise<void> {
    await this.client.exec(
      `INSERT INTO mem_location (item_id, tier, locator, state, reason, sha256, bytes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (item_id, tier) DO UPDATE SET locator = EXCLUDED.locator, state = EXCLUDED.state,
         reason = COALESCE(EXCLUDED.reason, mem_location.reason),
         sha256 = COALESCE(EXCLUDED.sha256, mem_location.sha256),
         bytes = COALESCE(EXCLUDED.bytes, mem_location.bytes), updated_at = now()`,
      [id, tier, locator, state, extra.reason ?? null, extra.sha ?? null, extra.bytes ?? null],
    );
  }

  private async stageL3(id: string, input: UpsertItemInput, redacted: string, unchanged: boolean): Promise<UpsertItemResult["l3"]> {
    const sha = sha256Hex(redacted);
    const loc = await this.client.queryOne<{ state: string; sha256: string | null }>(
      `SELECT state, sha256 FROM mem_location WHERE item_id = $1 AND tier = 'L3'`,
      [id],
    );
    if (unchanged && loc && loc.sha256 === sha) return "unchanged";
    const name = input.rawName ?? `${input.sourceRef}.md`;
    const target = l3TargetPath(input.kind, input.source, input.occurredAt, name);
    const staged = writeL3Cache(this.config.l3CacheDir, target, redacted);
    await this.client.exec(
      `INSERT INTO mem_l3_outbox (item_id, local_path, target_path, sha256, bytes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (local_path, sha256) DO NOTHING`,
      [id, staged.localPath, staged.targetPath, staged.sha256, staged.bytes],
    );
    await this.setLocation(id, "L3_cache", staged.localPath, "committed", { sha: staged.sha256, bytes: staged.bytes });
    if (!loc || loc.sha256 !== sha || loc.state !== "committed") {
      await this.setLocation(id, "L3", `pending:${staged.targetPath}`, "pending", { sha: staged.sha256, bytes: staged.bytes });
    }
    return "staged";
  }

  // ── Embeddings ──────────────────────────────────────────────────────────

  private async vectorCast(): Promise<VectorColumnType> {
    if (!this.vecType) this.vecType = await embeddingColumnType(this.client);
    return this.vecType;
  }

  private async ensureIndex(dim: number): Promise<void> {
    const ns = this.config.namespace;
    const existing = await this.client.queryOne<{ value: string }>(
      `SELECT value FROM qmd_memory_config WHERE namespace = $1 AND key = 'vector_dim'`,
      [ns],
    );
    const colType = await embeddingColumnType(this.client);
    const wantType = dim > 2000 ? "halfvec" : "vector";
    if (existing?.value === String(dim) && colType === wantType) return;
    await ensureVectorIndex(this.client, dim);
    this.vecType = undefined;
    await this.client.exec(
      `INSERT INTO qmd_memory_config (namespace, key, value) VALUES ($1, 'vector_dim', $2)
       ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
      [ns, String(dim)],
    );
  }

  /** Count distinct active mem contents (parts + summaries) with no vector yet. */
  async pendingEmbeddings(): Promise<number> {
    const row = await this.client.queryOne<{ n: string }>(
      `SELECT count(DISTINCT m.hash)::text AS n FROM qmd_memory m
       WHERE m.namespace = $1 AND m.active AND m.key LIKE 'mem/%'
         AND NOT EXISTS (SELECT 1 FROM qmd_memory_vectors v WHERE v.namespace = m.namespace AND v.hash = m.hash)`,
      [this.config.namespace],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Embed active mem contents that have no vectors. Resumable: re-running
   * continues where it stopped. The embedder batches and retries 429s;
   * `delayMs` adds spacing between batches for strict rate limits.
   */
  async embedPending(opts: {
    itemIds?: string[];
    batch?: number;
    max?: number;
    delayMs?: number;
    onProgress?: (done: number, total: number) => void;
  } = {}): Promise<{ embedded: number; failed: number; requests: number }> {
    if (!this.embedder) return { embedded: 0, failed: 0, requests: 0 };
    const ns = this.config.namespace;
    const model = this.config.embedModel;
    const batch = Math.max(1, opts.batch ?? 64);
    const total = opts.itemIds ? 0 : await this.pendingEmbeddings();
    let embedded = 0;
    let failed = 0;
    let requests = 0;
    const failedHashes = new Set<string>();
    for (;;) {
      if (opts.max !== undefined && embedded + failed >= opts.max) break;
      const params: unknown[] = [ns, batch, [...failedHashes]];
      let filter = "";
      if (opts.itemIds?.length) {
        params.push(opts.itemIds.map((i) => `mem/${i}/%`));
        filter = `AND m.key LIKE ANY ($4::text[])`;
      }
      const rows = await this.client.query<{ hash: string; body: string; title: string }>(
        `SELECT DISTINCT ON (m.hash) m.hash, c.body, m.title
         FROM qmd_memory m JOIN qmd_memory_content c ON c.namespace = m.namespace AND c.hash = m.hash
         WHERE m.namespace = $1 AND m.active AND m.key LIKE 'mem/%' ${filter}
           AND NOT (m.hash = ANY ($3::text[]))
           AND NOT EXISTS (SELECT 1 FROM qmd_memory_vectors v WHERE v.namespace = m.namespace AND v.hash = m.hash)
         ORDER BY m.hash
         LIMIT $2`,
        params,
      );
      if (rows.length === 0) break;
      const units: Array<{ hash: string; seq: number; pos: number; text: string }> = [];
      for (const r of rows) {
        chunkDocument(r.body).forEach((c, i) =>
          units.push({ hash: r.hash, seq: i, pos: c.pos, text: formatDocForEmbedding(c.text, r.title, model) }),
        );
      }
      let results: ({ embedding: number[]; model: string } | null)[];
      try {
        results = await this.embedder.embedBatch(units.map((u) => u.text), { isQuery: false, model });
        requests++;
      } catch (err) {
        for (const r of rows) failedHashes.add(r.hash);
        failed += rows.length;
        if (failedHashes.size >= 3 * batch) throw err; // persistent outage: stop, resume later
        continue;
      }
      const dim = results.find(Boolean)?.embedding.length;
      if (dim) await this.ensureIndex(dim);
      const cast = await this.vectorCast();
      const okHashes = new Set<string>();
      await this.client.tx(async (tx) => {
        for (let i = 0; i < units.length; i++) {
          const u = units[i]!;
          const e = results[i];
          if (!e) {
            failedHashes.add(u.hash);
            continue;
          }
          await tx.exec(
            `INSERT INTO qmd_memory_vectors (namespace, hash, seq, pos, embedding, model)
             VALUES ($1, $2, $3, $4, $5::${cast}, $6)
             ON CONFLICT DO NOTHING`,
            [ns, u.hash, u.seq, u.pos, toVectorLiteral(e.embedding), e.model ?? model],
          );
          okHashes.add(u.hash);
        }
      });
      embedded += okHashes.size;
      failed += rows.filter((r) => !okHashes.has(r.hash)).length;
      opts.onProgress?.(embedded, total);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    return { embedded, failed, requests };
  }

  // ── Read path ───────────────────────────────────────────────────────────

  private async loadItems(ids: string[]): Promise<Map<string, ItemRow>> {
    if (!ids.length) return new Map();
    const rows = await this.client.query<ItemRow>(
      `SELECT id, kind, source, source_ref, scope, title, summary, occurred_at, sha256, bytes, parts,
              tier_state, pinned, promoted_at, sensitivity
       FROM mem_item WHERE id = ANY ($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  async getItem(id: string): Promise<ItemRow | null> {
    if (!isUuid(id)) return null;
    return (await this.loadItems([id])).get(id) ?? null;
  }

  private async itemState(id: string): Promise<TierItemState | null> {
    const r = await this.client.queryOne<{
      occurred_at: Date; pinned: boolean; promoted_at: Date | null;
      tier_state: TierItemState["tierState"]; score: number | null; last_hit_at: Date | null;
    }>(
      `SELECT i.occurred_at, i.pinned, i.promoted_at, i.tier_state, h.score, h.last_hit_at
       FROM mem_item i LEFT JOIN mem_heat h ON h.item_id = i.id WHERE i.id = $1`,
      [id],
    );
    if (!r) return null;
    return {
      occurredAt: new Date(r.occurred_at),
      pinned: r.pinned,
      promotedAt: r.promoted_at ? new Date(r.promoted_at) : null,
      tierState: r.tier_state,
      score: Number(r.score ?? 0),
      lastHitAt: r.last_hit_at ? new Date(r.last_hit_at) : null,
    };
  }

  /** Full body from active L2 parts (ordered). */
  async itemBody(id: string): Promise<string | null> {
    const rows = await this.client.query<{ body: string }>(
      `SELECT c.body FROM qmd_memory m
       JOIN qmd_memory_content c ON c.namespace = m.namespace AND c.hash = m.hash
       WHERE m.namespace = $1 AND m.key LIKE $2 AND m.active AND split_part(m.key, '/', 3) ~ '^[0-9]+$'
       ORDER BY split_part(m.key, '/', 3)::int`,
      [this.config.namespace, `mem/${id}/%`],
    );
    if (!rows.length) return null;
    return rows.map((r) => r.body).join("\n\n");
  }

  private ftsConfig?: string;

  private async l2Search(query: string, limit: number): Promise<{ lex: string[]; vec: string[]; cjk: string[] }> {
    const ns = this.config.namespace;
    const pool = Math.max(limit * 5, 50);
    const uniq = (keys: string[]) => {
      const out: string[] = [];
      for (const k of keys) {
        const id = k.split("/")[1]!;
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };

    if (!this.ftsConfig) {
      this.ftsConfig = (await this.client.queryOne<{ cfg: string }>(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'jiebacfg') THEN 'jiebacfg' ELSE 'english' END AS cfg`,
      ))!.cfg;
    }
    const lexRows = await this.client
      .query<{ key: string }>(
        `SELECT m.key FROM qmd_memory_content c
         JOIN qmd_memory m ON m.namespace = c.namespace AND m.hash = c.hash AND m.active
         WHERE c.namespace = $1 AND m.key LIKE 'mem/%' AND c.tsv @@ websearch_to_tsquery($2::regconfig, $3)
         ORDER BY ts_rank_cd(c.tsv, websearch_to_tsquery($2::regconfig, $3)) DESC
         LIMIT $4`,
        [ns, this.ftsConfig, query, pool],
      )
      .catch(() => [] as { key: string }[]);

    // CJK / substring fallback: rank by matched bigrams/words (box PG has no jieba, D-004).
    let cjkRows: Array<{ key: string; hits: string | number }> = [];
    const terms = lexicalTerms(query);
    if (terms.length && (CJK_RE.test(query) || lexRows.length === 0)) {
      const pats = terms.map((t) => `%${likeEscape(t)}%`);
      cjkRows = await this.client.query(
        `SELECT m.key, (SELECT count(*) FROM unnest($2::text[]) p WHERE c.body ILIKE p) AS hits
         FROM qmd_memory_content c
         JOIN qmd_memory m ON m.namespace = c.namespace AND m.hash = c.hash AND m.active
         WHERE c.namespace = $1 AND m.key LIKE 'mem/%' AND c.body ILIKE ANY ($2::text[])
         ORDER BY hits DESC, length(c.body) ASC
         LIMIT $3`,
        [ns, pats, pool],
      );
      const minHits = Math.max(1, Math.ceil(terms.length * 0.3));
      cjkRows = cjkRows.filter((r) => Number(r.hits) >= minHits);
    }

    let vecRows: { key: string }[] = [];
    if (this.embedder) {
      try {
        const model = this.config.embedModel;
        const q = (await this.embedder.embedBatch([formatQueryForEmbedding(query, model)], { isQuery: true, model }))[0];
        if (q) {
          const cast = await this.vectorCast();
          vecRows = await this.client.query<{ key: string }>(
            `SELECT m.key FROM qmd_memory_vectors v
             JOIN qmd_memory m ON m.namespace = v.namespace AND m.hash = v.hash AND m.active
             WHERE v.namespace = $1 AND m.key LIKE 'mem/%'
             ORDER BY v.embedding <=> $2::${cast}
             LIMIT $3`,
            [ns, toVectorLiteral(q.embedding), pool],
          );
        }
      } catch {
        vecRows = []; // embedding outage: degrade to lexical only
      }
    }
    return { lex: uniq(lexRows.map((r) => r.key)), vec: uniq(vecRows.map((r) => r.key)), cjk: uniq(cjkRows.map((r) => r.key)) };
  }

  async search(query: string, opts: MemSearchOptions = {}): Promise<MemSearchResult> {
    const limit = opts.limit ?? 10;
    const now = this.now();
    const q = query.trim();
    if (!q) return { query, hits: [], facts: [], tiers: { l1: 0, l2: 0 }, shortCircuit: false, promoted: [] };

    const passes = (it: ItemRow | undefined): it is ItemRow => {
      if (!it || it.tier_state === "tombstoned") return false;
      if (opts.kind && it.kind !== opts.kind) return false;
      if (opts.scope && !(it.scope ?? "").toLowerCase().includes(opts.scope.toLowerCase())) return false;
      if (opts.since && new Date(it.occurred_at) < opts.since) return false;
      if (opts.excludeRestricted && it.sensitivity === "restricted") return false;
      return true;
    };

    // 1) L1 (QMD SQLite hot collection)
    let l1Hits: Array<{ itemId: string; score: number; snippet: string }> = [];
    if (this.l1) {
      try {
        l1Hits = await this.l1.search(q, limit);
      } catch {
        l1Hits = [];
      }
    }
    const l1Items = await this.loadItems(l1Hits.map((h) => h.itemId));
    l1Hits = l1Hits.filter((h) => passes(l1Items.get(h.itemId)));
    const shortCircuit =
      l1Hits.length >= Math.min(this.policy.l1MinHits, limit) &&
      (l1Hits[0]?.score ?? 0) >= this.policy.l1ShortCircuitScore;

    // 2) L2 (PG) unless L1 is confident
    let l2 = { lex: [] as string[], vec: [] as string[], cjk: [] as string[] };
    if (!shortCircuit) l2 = await this.l2Search(q, limit);

    const fused = rrf([l1Hits.map((h) => h.itemId), l2.vec, l2.lex, l2.cjk]);
    const items = await this.loadItems([...fused.keys()]);
    const l1Set = new Set(l1Hits.map((h) => h.itemId));
    const ranked = [...fused.entries()]
      .filter(([id]) => passes(items.get(id)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    const hits: MemSearchHit[] = [];
    for (const [id, score] of ranked) {
      const it = items.get(id)!;
      let snippet = l1Hits.find((h) => h.itemId === id)?.snippet ?? "";
      if (!snippet) snippet = (await this.bestPart(id, q)) ?? it.summary ?? "";
      hits.push({
        itemId: id,
        tier: l1Set.has(id) ? "L1" : "L2",
        score: Number(score.toFixed(5)),
        kind: it.kind,
        source: it.source,
        scope: it.scope,
        title: it.title,
        occurredAt: new Date(it.occurred_at).toISOString(),
        tierState: it.tier_state,
        snippet: snippet.slice(0, 400),
      });
    }

    // 3) access log (query hash only, never the text)
    const qh = queryHash(q);
    if (hits.length) {
      await this.client.exec(
        `INSERT INTO mem_access_log (item_id, hit_tier, op, agent, query_hash)
         SELECT unnest($1::uuid[]), unnest($2::text[]), 'search_hit', $3, $4`,
        [hits.map((h) => h.itemId), hits.map((h) => h.tier), opts.agent ?? null, qh],
      );
    }

    // 4) promote L2-only full items into L1 (§6.4)
    const promoted: string[] = [];
    if (!opts.noPromote && this.l1) {
      for (const h of hits.slice(0, Math.min(limit, 5))) {
        if (h.tier !== "L2" || h.tierState !== "l2_full") continue;
        await this.client.exec(`UPDATE mem_item SET promoted_at = $2 WHERE id = $1`, [h.itemId, now.toISOString()]);
        await this.materialize(h.itemId, "promoted");
        await this.client.exec(
          `INSERT INTO mem_access_log (item_id, hit_tier, op, agent, query_hash) VALUES ($1, 'L2', 'promote', $2, $3)`,
          [h.itemId, opts.agent ?? null, qh],
        );
        h.promoted = true;
        promoted.push(h.itemId);
      }
      if (promoted.length) await this.syncL1().catch(() => null);
    }

    const facts = await listFacts(this.client, { query: q.slice(0, 64), limit: 5 }).catch(() => [] as FactRow[]);
    return {
      query,
      hits,
      facts,
      tiers: { l1: hits.filter((h) => h.tier === "L1").length, l2: hits.filter((h) => h.tier === "L2").length },
      shortCircuit,
      promoted,
    };
  }

  private async bestPart(id: string, q: string): Promise<string | null> {
    const terms = lexicalTerms(q);
    const rows = await this.client.query<{ body: string }>(
      `SELECT c.body FROM qmd_memory m
       JOIN qmd_memory_content c ON c.namespace = m.namespace AND c.hash = m.hash
       WHERE m.namespace = $1 AND m.key LIKE $2 AND m.active
       ORDER BY (SELECT count(*) FROM unnest($3::text[]) p WHERE c.body ILIKE p) DESC, m.key
       LIMIT 1`,
      [this.config.namespace, `mem/${id}/%`, terms.map((t) => `%${likeEscape(t)}%`)],
    );
    return rows[0]?.body ?? null;
  }

  async recall(
    idOrQuery: string,
    opts: { agent?: string } = {},
  ): Promise<{
    item: ItemRow | null;
    body: string | null;
    summary: string | null;
    tier: "L1" | "L2" | "L3_cache" | null;
    pendingFetch: boolean;
    tombstoned?: boolean;
  }> {
    let id = idOrQuery.trim();
    if (!isUuid(id)) {
      const r = await this.search(id, { limit: 1, agent: opts.agent, noPromote: true });
      if (!r.hits.length) return { item: null, body: null, summary: null, tier: null, pendingFetch: false };
      id = r.hits[0]!.itemId;
    }
    const item = await this.getItem(id);
    if (!item) return { item: null, body: null, summary: null, tier: null, pendingFetch: false };
    if (item.tier_state === "tombstoned") {
      return { item, body: null, summary: null, tier: null, pendingFetch: false, tombstoned: true };
    }
    const logRecall = (tier: string) =>
      this.client.exec(`INSERT INTO mem_access_log (item_id, hit_tier, op, agent) VALUES ($1, $2, 'recall', $3)`, [
        id,
        tier,
        opts.agent ?? null,
      ]);

    if (item.tier_state === "l2_full") {
      const l1 = await this.client.queryOne<{ state: string }>(
        `SELECT state FROM mem_location WHERE item_id = $1 AND tier = 'L1'`,
        [id],
      );
      const tier = l1?.state === "committed" ? "L1" : "L2";
      await logRecall(tier);
      return { item, body: await this.itemBody(id), summary: item.summary, tier, pendingFetch: false };
    }

    // Summary-only: rehydrate from the local L3 cache, else queue a Drive fetch.
    if (await this.rehydrate(id)) {
      await logRecall("L3");
      const fresh = await this.getItem(id);
      return { item: fresh, body: await this.itemBody(id), summary: fresh?.summary ?? null, tier: "L3_cache", pendingFetch: false };
    }
    await this.client.exec(
      `INSERT INTO mem_l3_fetch (item_id, requested_by) VALUES ($1, $2)
       ON CONFLICT (item_id) DO UPDATE SET requested_at = now(), status = 'queued'`,
      [id, opts.agent ?? null],
    );
    await logRecall("L3");
    return { item, body: null, summary: item.summary, tier: null, pendingFetch: true };
  }

  /** Restore L2 parts from the L3 cache copy (sha must match), then promote to L1. */
  async rehydrate(id: string, fromPath?: string): Promise<boolean> {
    const item = await this.getItem(id);
    if (!item) return false;
    const loc = await this.client.queryOne<{ locator: string; sha256: string | null }>(
      `SELECT locator, sha256 FROM mem_location WHERE item_id = $1 AND tier = 'L3_cache'`,
      [id],
    );
    const path = fromPath ?? loc?.locator;
    if (!path || !existsSync(path)) return false;
    const text = readFileSync(path, "utf8");
    const expected = loc?.sha256 ?? (await this.client.queryOne<{ sha256: string }>(
      `SELECT sha256 FROM mem_location WHERE item_id = $1 AND tier = 'L3'`, [id]))?.sha256;
    if (expected && sha256Hex(text) !== expected) return false;
    const body = stripFrontmatter(text).trim();
    const res = await this.writeParts(id, item.title, body, { kind: item.kind, source: item.source, scope: item.scope });
    await this.client.exec(
      `UPDATE mem_item SET tier_state = 'l2_full', parts = $2, compacted_at = NULL, promoted_at = $3, updated_at = now() WHERE id = $1`,
      [id, res.parts, this.now().toISOString()],
    );
    await this.client.exec(`UPDATE mem_l3_fetch SET status = 'done' WHERE item_id = $1`, [id]);
    await this.embedPending({ itemIds: [id] });
    await this.materialize(id, "promoted");
    await this.syncL1().catch(() => null);
    return true;
  }

  // ── L1 ──────────────────────────────────────────────────────────────────

  async materialize(id: string, reason: string): Promise<{ bytes: number } | null> {
    const item = await this.getItem(id);
    if (!item || item.tier_state === "tombstoned") return null;
    const body = item.tier_state === "l2_full" ? await this.itemBody(id) : null;
    const res = writeL1Item(this.config.l1Dir, {
      id,
      kind: item.kind,
      source: item.source,
      scope: item.scope,
      title: item.title,
      occurredAt: new Date(item.occurred_at),
      sha256: item.sha256,
      reason,
      summary: item.summary,
      body: body ?? item.summary ?? "",
    });
    await this.setLocation(id, "L1", `qmd://hot/${id}`, "committed", { bytes: res.bytes, reason, sha: item.sha256 });
    return { bytes: res.bytes };
  }

  async evictL1(id: string): Promise<void> {
    removeL1Item(this.config.l1Dir, id);
    await this.client.exec(`UPDATE mem_location SET state = 'evicted', updated_at = now() WHERE item_id = $1 AND tier = 'L1'`, [id]);
  }

  async syncL1(opts: { embed?: boolean } = {}): Promise<{ indexed: number; embedded: number } | null> {
    if (!this.l1) return null;
    return this.l1.sync(opts);
  }

  /** Rebuild L1 from L2 according to the admission rules. */
  async rebuildL1(opts: { sync?: boolean } = {}): Promise<{ materialized: number; evicted: number }> {
    const rows = await this.client.query<{ id: string }>(`SELECT id FROM mem_item WHERE tier_state <> 'tombstoned'`);
    let n = 0;
    let e = 0;
    for (const r of rows) {
      const st = await this.itemState(r.id);
      const reason = st ? l1AdmissionReason(st, this.now(), this.policy) : null;
      if (reason) {
        await this.materialize(r.id, reason);
        n++;
      } else {
        await this.evictL1(r.id);
        e++;
      }
    }
    if (opts.sync !== false) await this.syncL1();
    return { materialized: n, evicted: e };
  }

  // ── Heat & tiering ──────────────────────────────────────────────────────

  async recomputeHeat(): Promise<{ items: number; prunedLog: number }> {
    const now = this.now().toISOString();
    const prunedLog = await this.client.exec(
      `DELETE FROM mem_access_log WHERE at < $1::timestamptz - interval '180 days'`,
      [now],
    );
    const rows = await this.client.query<{ item_id: string; h7: string; h30: string; h90: string; total: string; last: Date | null }>(
      `SELECT a.item_id,
              count(*) FILTER (WHERE a.at >= $1::timestamptz - interval '7 days')::text AS h7,
              count(*) FILTER (WHERE a.at >= $1::timestamptz - interval '30 days')::text AS h30,
              count(*) FILTER (WHERE a.at >= $1::timestamptz - interval '90 days')::text AS h90,
              count(*)::text AS total, max(a.at) AS last
       FROM mem_access_log a JOIN mem_item i ON i.id = a.item_id
       WHERE a.at <= $1::timestamptz
       GROUP BY a.item_id`,
      [now],
    );
    await this.client.tx(async (tx) => {
      await tx.exec(`UPDATE mem_heat SET hits_7d = 0, hits_30d = 0, hits_90d = 0, score = 0`);
      for (const r of rows) {
        const h7 = Number(r.h7), h30 = Number(r.h30), h90 = Number(r.h90), total = Number(r.total);
        const score = heatScore({ hits7d: h7, hits30d: h30, hitsTotal: total });
        await tx.exec(
          `INSERT INTO mem_heat (item_id, hits_7d, hits_30d, hits_90d, hits_total, last_hit_at, score)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (item_id) DO UPDATE SET hits_7d = EXCLUDED.hits_7d, hits_30d = EXCLUDED.hits_30d,
             hits_90d = EXCLUDED.hits_90d, hits_total = GREATEST(mem_heat.hits_total, EXCLUDED.hits_total),
             last_hit_at = GREATEST(mem_heat.last_hit_at, EXCLUDED.last_hit_at), score = EXCLUDED.score`,
          [r.item_id, h7, h30, h90, total, r.last, score],
        );
      }
    });
    return { items: rows.length, prunedLog };
  }

  /**
   * Nightly tiering (§6.2 + §6.3): admit/evict L1, enforce capacity, compact
   * L2 items whose L3 copy is committed. Compaction is skipped entirely when
   * the invariant check finds a summary-only item without committed L3.
   */
  async runTiering(opts: { dryRun?: boolean; sync?: boolean } = {}): Promise<{
    admitted: string[];
    evicted: string[];
    capacityEvicted: string[];
    compacted: string[];
    invariantViolations: string[];
    dryRun: boolean;
  }> {
    const now = this.now();
    const dry = !!opts.dryRun;
    if (!dry) await this.recomputeHeat();
    const rows = await this.client.query<{
      id: string; occurred_at: Date; pinned: boolean; promoted_at: Date | null;
      tier_state: TierItemState["tierState"]; score: number | null; last_hit_at: Date | null;
      hits_90d: number | null; l1_state: string | null; l3_state: string | null;
      l3_sha: string | null; cache_sha: string | null;
    }>(
      `SELECT i.id, i.occurred_at, i.pinned, i.promoted_at, i.tier_state, h.score, h.last_hit_at, h.hits_90d,
              l1.state AS l1_state, l3.state AS l3_state, l3.sha256 AS l3_sha, c.sha256 AS cache_sha
       FROM mem_item i
       LEFT JOIN mem_heat h ON h.item_id = i.id
       LEFT JOIN mem_location l1 ON l1.item_id = i.id AND l1.tier = 'L1'
       LEFT JOIN mem_location l3 ON l3.item_id = i.id AND l3.tier = 'L3'
       LEFT JOIN mem_location c ON c.item_id = i.id AND c.tier = 'L3_cache'`,
    );

    const admitted: string[] = [];
    const evicted: string[] = [];
    const compacted: string[] = [];
    const violations: string[] = [];

    for (const r of rows) {
      const st: TierItemState = {
        occurredAt: new Date(r.occurred_at),
        pinned: r.pinned,
        promotedAt: r.promoted_at ? new Date(r.promoted_at) : null,
        tierState: r.tier_state,
        score: Number(r.score ?? 0),
        lastHitAt: r.last_hit_at ? new Date(r.last_hit_at) : null,
      };
      const inL1 = r.l1_state === "committed";
      if (inL1 && shouldEvictL1(st, now, this.policy)) {
        evicted.push(r.id);
        if (!dry) await this.evictL1(r.id);
      } else if (!inL1) {
        const reason = l1AdmissionReason(st, now, this.policy);
        if (reason) {
          admitted.push(r.id);
          if (!dry) await this.materialize(r.id, reason);
        }
      }
      if (r.tier_state === "l2_summary_only" && r.l3_state !== "committed") violations.push(r.id);
    }

    const usage = l1Usage(this.config.l1Dir);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const capacity = capacityEvictions(
      [...usage.items.entries()].map(([id, bytes]) => {
        const r = byId.get(id);
        const protectedUntil = r?.promoted_at
          ? new Date(new Date(r.promoted_at).getTime() + this.policy.promoteProtectDays * 86400000)
          : null;
        return { id, bytes, score: Number(r?.score ?? 0), pinned: !!r?.pinned, protectedUntil };
      }),
      now,
      this.policy,
    );
    if (!dry) for (const id of capacity) await this.evictL1(id);

    if (violations.length === 0) {
      for (const r of rows) {
        const ok = canCompact(
          {
            occurredAt: new Date(r.occurred_at),
            pinned: r.pinned,
            tierState: r.tier_state,
            recentHits: Number(r.hits_90d ?? 0),
            l3Committed: r.l3_state === "committed",
            l3ShaMatches: !!r.l3_sha && r.l3_sha === r.cache_sha,
          },
          now,
          this.policy,
        );
        if (!ok) continue;
        compacted.push(r.id);
        if (!dry) await this.compact(r.id);
      }
    }
    if (!dry && opts.sync !== false && (admitted.length || evicted.length || capacity.length || compacted.length)) {
      await this.syncL1().catch(() => null);
    }
    return { admitted, evicted, capacityEvicted: capacity, compacted, invariantViolations: violations, dryRun: dry };
  }

  /** Deactivate an item's parts and drop their vectors; keep summary + metadata (§6.3). */
  async compact(id: string): Promise<void> {
    const ns = this.config.namespace;
    const l3 = await this.client.queryOne<{ state: string }>(
      `SELECT state FROM mem_location WHERE item_id = $1 AND tier = 'L3'`,
      [id],
    );
    if (l3?.state !== "committed") throw new Error(`refusing to compact ${id}: no committed L3 copy`);
    await this.client.tx(async (tx) => {
      const rows = await tx.query<{ hash: string }>(
        `UPDATE qmd_memory SET active = false, updated_at = now()
         WHERE namespace = $1 AND key LIKE $2 AND key <> $3 AND active RETURNING hash`,
        [ns, `mem/${id}/%`, this.key(id, "summary")],
      );
      const hashes = rows.map((r) => r.hash);
      if (hashes.length) {
        await tx.exec(
          `DELETE FROM qmd_memory_vectors v WHERE v.namespace = $1 AND v.hash = ANY ($2::text[])
             AND NOT EXISTS (SELECT 1 FROM qmd_memory m WHERE m.namespace = v.namespace AND m.hash = v.hash AND m.active)`,
          [ns, hashes],
        );
      }
      await tx.exec(
        `UPDATE mem_item SET tier_state = 'l2_summary_only', compacted_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
    });
  }

  /** Undo a compaction within the rollback window (parts still exist, inactive). */
  async uncompact(id: string): Promise<boolean> {
    const n = await this.client.exec(
      `UPDATE qmd_memory SET active = true, updated_at = now() WHERE namespace = $1 AND key LIKE $2 AND NOT active`,
      [this.config.namespace, `mem/${id}/%`],
    );
    if (n === 0) return false;
    await this.client.exec(`UPDATE mem_item SET tier_state = 'l2_full', compacted_at = NULL WHERE id = $1`, [id]);
    await this.embedPending({ itemIds: [id] });
    return true;
  }

  // ── Agent-facing writes ─────────────────────────────────────────────────

  async remember(input: {
    title: string;
    body: string;
    kind?: MemItemKind;
    scope?: string | null;
    agent?: string;
    sensitivity?: "public" | "private" | "restricted";
    occurredAt?: Date;
    maxBytes?: number;
  }): Promise<UpsertItemResult> {
    const hit = findSecret(`${input.title}\n${input.body}`);
    if (hit) throw new Error(`refused: content matches secret pattern "${hit}"`);
    const max = input.maxBytes ?? 64 * 1024;
    if (Buffer.byteLength(input.body) > max) throw new Error(`body too large (max ${max} bytes)`);
    const ref = `note:${sha256Hex(`${input.title}\n${input.body}`).slice(0, 24)}`;
    const res = await this.upsertItem({
      kind: input.kind ?? "note",
      source: input.agent ? `agent:${input.agent}` : "agent",
      sourceRef: ref,
      scope: input.scope ?? null,
      title: input.title,
      occurredAt: input.occurredAt ?? this.now(),
      body: input.body,
      raw: `# ${input.title}\n\n${input.body}\n`,
      rawName: `${ref.replace(":", "-")}.md`,
      sensitivity: input.sensitivity,
    });
    if (res.l1) await this.syncL1().catch(() => null);
    return res;
  }

  async forget(id: string, reason: string): Promise<boolean> {
    const item = await this.getItem(id);
    if (!item) return false;
    const ns = this.config.namespace;
    removeL1Item(this.config.l1Dir, id);
    await this.client.tx(async (tx) => {
      const rows = await tx.query<{ hash: string }>(
        `DELETE FROM qmd_memory WHERE namespace = $1 AND key LIKE $2 RETURNING hash`,
        [ns, `mem/${id}/%`],
      );
      const hashes = rows.map((r) => r.hash);
      if (hashes.length) {
        await tx.exec(
          `DELETE FROM qmd_memory_vectors v WHERE v.namespace = $1 AND v.hash = ANY ($2::text[])
             AND NOT EXISTS (SELECT 1 FROM qmd_memory m WHERE m.namespace = v.namespace AND m.hash = v.hash)`,
          [ns, hashes],
        );
        await tx.exec(
          `DELETE FROM qmd_memory_content c WHERE c.namespace = $1 AND c.hash = ANY ($2::text[])
             AND NOT EXISTS (SELECT 1 FROM qmd_memory m WHERE m.namespace = c.namespace AND m.hash = c.hash)`,
          [ns, hashes],
        );
      }
      await tx.exec(`UPDATE mem_item SET tier_state = 'tombstoned', summary = NULL, updated_at = now() WHERE id = $1`, [id]);
      await tx.exec(
        `UPDATE mem_location SET state = 'evicted', updated_at = now() WHERE item_id = $1 AND tier IN ('L1','L2')`,
        [id],
      );
    });
    // L3 is append-only: record a tombstone. Deleting Drive copies needs the user's approval.
    const tdir = join(this.config.l3CacheDir, "tombstones");
    mkdirSync(tdir, { recursive: true });
    appendFileSync(
      join(tdir, "tombstones.jsonl"),
      JSON.stringify({ item_id: id, source: item.source, source_ref: item.source_ref, reason, at: this.now().toISOString() }) + "\n",
    );
    await this.syncL1({ embed: false }).catch(() => null);
    return true;
  }

  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const n = await this.client.exec(
      `UPDATE mem_item SET pinned = $2, updated_at = now() WHERE id = $1 AND tier_state <> 'tombstoned'`,
      [id, pinned],
    );
    if (n && pinned) {
      await this.materialize(id, "pinned");
      await this.syncL1().catch(() => null);
    }
    return n > 0;
  }

  // ── L3 hand-off (.archive flow) ─────────────────────────────────────────

  /** Mark outbox rows committed when the committed .archive manifest carries the same file + sha256. */
  async commitFromArchive(): Promise<{ committed: number; pending: number; mismatched: number; run: string | null }> {
    const manifest = readArchiveManifest(this.config.archiveStateDir);
    if (!manifest) return { committed: 0, pending: 0, mismatched: 0, run: null };
    const rows = await this.client.query<{ id: string; item_id: string; local_path: string; sha256: string }>(
      `SELECT id, item_id, local_path, sha256 FROM mem_l3_outbox WHERE status IN ('pending','uploaded','failed')`,
    );
    let committed = 0;
    let mismatched = 0;
    for (const r of rows) {
      const key = archiveKey(this.config.workspaceRoot, r.local_path);
      const entry = manifest.files.get(key);
      if (!entry) continue;
      if (entry.sha256 !== r.sha256) {
        mismatched++;
        await this.client.exec(
          `UPDATE mem_l3_outbox SET attempts = attempts + 1, status = 'failed', updated_at = now() WHERE id = $1`,
          [r.id],
        );
        continue;
      }
      await this.client.exec(
        `UPDATE mem_l3_outbox SET status = 'committed', drive_file_id = $2, updated_at = now() WHERE id = $1`,
        [r.id, `archive:${manifest.runId}`],
      );
      await this.client.exec(
        `UPDATE mem_location SET state = 'committed', locator = $3, updated_at = now()
         WHERE item_id = $1 AND tier = 'L3' AND sha256 = $2`,
        [r.item_id, r.sha256, `archive:${manifest.archiveBase}:workspace/${key}`],
      );
      committed++;
    }
    return { committed, pending: rows.length - committed - mismatched, mismatched, run: manifest.runId };
  }

  async outbox(status = "pending", limit = 100) {
    return this.client.query(
      `SELECT id, item_id, local_path, target_path, sha256, bytes, status, attempts, updated_at
       FROM mem_l3_outbox WHERE ($1 = 'all' OR status = $1) ORDER BY id LIMIT $2`,
      [status, limit],
    );
  }

  async fetchQueue() {
    return this.client.query(
      `SELECT f.item_id, f.requested_at, f.requested_by, f.status, l.locator AS l3_locator, c.locator AS cache_path
       FROM mem_l3_fetch f
       LEFT JOIN mem_location l ON l.item_id = f.item_id AND l.tier = 'L3'
       LEFT JOIN mem_location c ON c.item_id = f.item_id AND c.tier = 'L3_cache'
       WHERE f.status = 'queued' ORDER BY f.requested_at`,
    );
  }

  // ── Summaries, timeline, context ────────────────────────────────────────

  async generatePeriodSummary(
    period: "day" | "week" | "month",
    date: Date,
    scope = "*",
  ): Promise<{ id: string; items: number; periodStart: string } | null> {
    // Period boundaries in Asia/Shanghai.
    const local = new Date(date.getTime() + 8 * 3600 * 1000);
    let start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
    if (period === "week") start = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 86400000);
    if (period === "month") start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
    const end =
      period === "day" ? new Date(start.getTime() + 86400000)
      : period === "week" ? new Date(start.getTime() + 7 * 86400000)
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const params: unknown[] = [
      new Date(start.getTime() - 8 * 3600 * 1000).toISOString(),
      new Date(end.getTime() - 8 * 3600 * 1000).toISOString(),
    ];
    let scopeFilter = "";
    if (scope !== "*") {
      params.push(scope);
      scopeFilter = `AND scope = $3`;
    }
    const items = await this.client.query<{ id: string; kind: string; scope: string | null; title: string | null; summary: string | null }>(
      `SELECT id, kind, scope, title, summary FROM mem_item
       WHERE occurred_at >= $1 AND occurred_at < $2 AND tier_state <> 'tombstoned' AND sensitivity <> 'restricted' ${scopeFilter}
       ORDER BY occurred_at`,
      params,
    );
    if (!items.length) return null;
    const byScope = new Map<string, typeof items>();
    for (const it of items) {
      const k = it.scope || "(no scope)";
      if (!byScope.has(k)) byScope.set(k, []);
      byScope.get(k)!.push(it);
    }
    const label = start.toISOString().slice(0, 10);
    const lines = [`# ${period} summary ${label}${scope !== "*" ? ` · ${scope}` : ""}`, "", `${items.length} items.`, ""];
    for (const [s, list] of [...byScope.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`## ${s} (${list.length})`);
      for (const it of list.slice(0, 20)) {
        const sum = (it.summary ?? "").replace(/\s+/g, " ").slice(0, 160);
        lines.push(`- [${it.kind}] ${it.title ?? it.id}${sum ? ` — ${sum}` : ""}`);
      }
      if (list.length > 20) lines.push(`- … +${list.length - 20} more`);
      lines.push("");
    }
    const row = await this.client.queryOne<{ id: string }>(
      `INSERT INTO mem_summary (period, period_start, scope, body, item_ids, model)
       VALUES ($1, $2::date, $3, $4, $5::uuid[], $6)
       ON CONFLICT (period, period_start, scope) DO UPDATE SET body = EXCLUDED.body, item_ids = EXCLUDED.item_ids,
         model = EXCLUDED.model, created_at = now()
       RETURNING id`,
      [period, label, scope, lines.join("\n"), items.map((i) => i.id), this.summarizer.name],
    );
    return { id: row!.id, items: items.length, periodStart: label };
  }

  async getSummary(period: "day" | "week" | "month", periodStart?: string, scope = "*") {
    return this.client.queryOne<{ period: string; period_start: string; scope: string; body: string; item_ids: string[] }>(
      `SELECT period, period_start::text, scope, body, item_ids::text[] FROM mem_summary
       WHERE period = $1 AND scope = $2 ${periodStart ? "AND period_start = $3::date" : ""}
       ORDER BY period_start DESC LIMIT 1`,
      periodStart ? [period, scope, periodStart] : [period, scope],
    );
  }

  async timeline(opts: { scope?: string; from: Date; to: Date; limit?: number }) {
    const base: unknown[] = [opts.from.toISOString(), opts.to.toISOString(), opts.limit ?? 100];
    const withScope = opts.scope ? [...base, `%${opts.scope}%`] : base;
    const items = await this.client.query(
      `SELECT id, kind, source, scope, title, occurred_at, tier_state FROM mem_item
       WHERE occurred_at >= $1 AND occurred_at < $2 AND tier_state <> 'tombstoned' AND sensitivity <> 'restricted'
         ${opts.scope ? "AND scope ILIKE $4" : ""}
       ORDER BY occurred_at LIMIT $3`,
      withScope,
    );
    const summaries = await this.client.query(
      `SELECT period, period_start::text, scope, body FROM mem_summary
       WHERE period_start >= ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date - 6
         AND period_start < ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date + 1
         ${opts.scope ? "AND (scope = '*' OR scope ILIKE $4)" : ""}
       ORDER BY period_start, period LIMIT $3`,
      withScope,
    );
    const facts = await this.client.query(
      `SELECT f.id, f.statement, f.predicate, f.valid_from, f.status, e.name AS subject FROM mem_fact f
       LEFT JOIN mem_entity e ON e.id = f.subject_id
       WHERE f.status = 'active' AND (f.valid_from IS NULL OR f.valid_from < $2)
         AND (f.valid_to IS NULL OR f.valid_to >= $1)
       ORDER BY f.valid_from NULLS FIRST LIMIT $3`,
      base,
    );
    return { items, summaries, facts };
  }

  /** Assemble injectable context for a task (§5.2 mem_context). Never includes restricted items. */
  async context(
    task: string,
    opts: { scope?: string; budgetTokens?: number; agent?: string } = {},
  ): Promise<{ text: string; itemIds: string[]; facts: number }> {
    const budgetChars = Math.max(400, (opts.budgetTokens ?? 2000) * 3);
    const out: string[] = [];
    const facts = await listFacts(this.client, { query: opts.scope, limit: 15 });
    if (facts.length) {
      out.push("## Facts");
      for (const f of facts) out.push(`- ${f.statement}${f.subject ? ` (${f.subject})` : ""}`);
      out.push("");
    }
    const sums = await this.client.query<{ body: string }>(
      `SELECT body FROM mem_summary WHERE scope = '*' AND period = 'day' ORDER BY period_start DESC LIMIT 2`,
    );
    for (const s of sums) out.push(s.body.slice(0, Math.floor(budgetChars / 4)), "");
    const r = await this.search(task, { limit: 8, scope: opts.scope, agent: opts.agent, excludeRestricted: true, noPromote: true });
    if (r.hits.length) {
      out.push("## Relevant memory");
      for (const h of r.hits) {
        out.push(`- [${h.kind} · ${h.occurredAt.slice(0, 10)} · ${h.itemId}] ${h.title ?? ""}\n  ${h.snippet.replace(/\s+/g, " ").slice(0, 300)}`);
      }
    }
    let text = out.join("\n");
    if (text.length > budgetChars) text = text.slice(0, budgetChars) + "\n…";
    return { text, itemIds: r.hits.map((h) => h.itemId), facts: facts.length };
  }

  // ── Status & nightly ────────────────────────────────────────────────────

  async status() {
    const c = this.client;
    const n = (rows: Array<Record<string, unknown>>, k: string) => Object.fromEntries(rows.map((r) => [String(r[k]), Number(r.n)]));
    const byState = await c.query(`SELECT tier_state, count(*)::text n FROM mem_item GROUP BY 1`);
    const byKind = await c.query(`SELECT kind, count(*)::text n FROM mem_item WHERE tier_state <> 'tombstoned' GROUP BY 1 ORDER BY 2 DESC`);
    const locs = await c.query<{ tier: string; state: string; n: string }>(
      `SELECT tier, state, count(*)::text n FROM mem_location GROUP BY 1,2 ORDER BY 1,2`,
    );
    const outbox = await c.query<{ status: string; n: string; oldest: string | null }>(
      `SELECT status, count(*)::text n, min(updated_at)::text oldest FROM mem_l3_outbox GROUP BY 1`,
    );
    const fetchQ = await c.queryOne<{ n: string }>(`SELECT count(*)::text n FROM mem_l3_fetch WHERE status = 'queued'`);
    const parts = await c.queryOne<{ n: string; v: string }>(
      `SELECT (SELECT count(*) FROM qmd_memory WHERE namespace = $1 AND key LIKE 'mem/%' AND active)::text n,
              (SELECT count(*) FROM qmd_memory_vectors WHERE namespace = $1)::text v`,
      [this.config.namespace],
    );
    const hits = await c.query<{ tier: string; n: string }>(
      `SELECT hit_tier tier, count(*)::text n FROM mem_access_log
       WHERE op = 'search_hit' AND at > $1::timestamptz - interval '7 days' GROUP BY 1`,
      [this.now().toISOString()],
    );
    const jobs = await c.query(
      `SELECT DISTINCT ON (job) job, started_at::text, finished_at::text, ok, error FROM mem_job_run ORDER BY job, started_at DESC`,
    );
    const violations = await c.queryOne<{ n: string }>(
      `SELECT count(*)::text n FROM mem_item i WHERE i.tier_state = 'l2_summary_only'
         AND NOT EXISTS (SELECT 1 FROM mem_location l WHERE l.item_id = i.id AND l.tier = 'L3' AND l.state = 'committed')`,
    );
    const usage = l1Usage(this.config.l1Dir);
    const l1h = Number(hits.find((h) => h.tier === "L1")?.n ?? 0);
    const allh = hits.reduce((s, h) => s + Number(h.n), 0);
    return {
      namespace: this.config.namespace,
      embedModel: this.config.embedModel,
      items: n(byState, "tier_state"),
      kinds: n(byKind, "kind"),
      locations: locs.map((l) => ({ tier: l.tier, state: l.state, n: Number(l.n) })),
      l1: { files: usage.files, bytes: usage.bytes, items: usage.items.size, dir: this.config.l1Dir },
      l2: { parts: Number(parts?.n ?? 0), vectors: Number(parts?.v ?? 0), pendingEmbeddings: await this.pendingEmbeddings() },
      l3: {
        outbox: Object.fromEntries(outbox.map((o) => [o.status, { n: Number(o.n), oldest: o.oldest }])),
        fetchQueued: Number(fetchQ?.n ?? 0),
      },
      hitRate7d: { l1: l1h, total: allh, l1Rate: allh ? Number((l1h / allh).toFixed(3)) : null },
      invariantViolations: Number(violations?.n ?? 0),
      lastJobs: jobs,
    };
  }

  async recordJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
    const row = await this.client.queryOne<{ id: string }>(`INSERT INTO mem_job_run (job) VALUES ($1) RETURNING id`, [job]);
    try {
      const res = await fn();
      await this.client.exec(`UPDATE mem_job_run SET finished_at = now(), ok = true, stats = $2::jsonb WHERE id = $1`, [
        row!.id,
        JSON.stringify(res ?? {}),
      ]);
      return res;
    } catch (err) {
      await this.client.exec(`UPDATE mem_job_run SET finished_at = now(), ok = false, error = $2 WHERE id = $1`, [
        row!.id,
        String((err as Error).message ?? err).slice(0, 2000),
      ]);
      throw err;
    }
  }

  /**
   * Nightly consolidation (§6.6) with per-step isolation. Source collection
   * (step 1) is done by the routine via `ingest` beforehand; Drive uploads go
   * through the .archive flow, whose committed manifest step "l3" consumes.
   */
  async nightly(opts: { dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
    const dry = !!opts.dryRun;
    const now = this.now();
    const report: Record<string, unknown> = { dryRun: dry, at: now.toISOString() };
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        report[name] = await fn();
      } catch (err) {
        report[name] = { error: (err as Error).message };
      }
    };
    const run = async () => {
      await step("embed", async () => (dry ? { pending: await this.pendingEmbeddings() } : this.embedPending()));
      await step("summaries", async () => {
        const local = new Date(now.getTime() + 8 * 3600 * 1000);
        const todo: Array<["day" | "week" | "month", Date]> = [["day", now], ["day", new Date(now.getTime() - 86400000)]];
        if (local.getUTCDay() === 0) todo.push(["week", now]);
        if (local.getUTCDate() === 1) todo.push(["month", new Date(now.getTime() - 86400000)]);
        if (dry) return todo.map(([p, d]) => `${p}:${new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)}`);
        const out: unknown[] = [];
        for (const [p, d] of todo) out.push({ period: p, result: await this.generatePeriodSummary(p, d) });
        return out;
      });
      await step("facts", async () =>
        dry ? { rule: "activate proposed facts with confidence>=0.8 and >=2 evidence" } : { activated: await activateEligibleFacts(this.client, this.policy) },
      );
      await step("l3", async () => (dry ? { pendingOutbox: (await this.outbox("pending", 100000)).length } : this.commitFromArchive()));
      await step("tiering", async () => {
        const r = await this.runTiering({ dryRun: dry });
        return {
          dryRun: r.dryRun,
          admitted: r.admitted.length,
          evicted: r.evicted.length,
          capacityEvicted: r.capacityEvicted.length,
          compacted: r.compacted.length,
          invariantViolations: r.invariantViolations.length,
        };
      });
      await step("status", async () => this.status());
      return report;
    };
    return dry ? run() : this.recordJob("nightly", run);
  }

  async close(): Promise<void> {
    if (this.l1) await this.l1.close();
    await this.client.close();
  }
}
