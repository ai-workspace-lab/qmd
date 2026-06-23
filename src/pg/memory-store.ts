/**
 * pg/memory-store.ts - PostgreSQL-backed memory store (the OpenClaw/Hermes bridge)
 *
 * A focused, namespace-isolated memory layer over PostgreSQL. It reuses qmd's
 * pure helpers (content hashing, chunking, docid, embedding formatting) so PG
 * search behaves consistently with the SQLite engine, then fuses lexical
 * (pg_jieba/tsvector) and semantic (pgvector) results with Reciprocal Rank
 * Fusion — the same idea qmd uses for hybrid search.
 *
 * The existing SQLite document workflow is untouched; this is an additive,
 * opt-in backend selected via QMD_BACKEND=pg.
 */

import { PgClient, toVectorLiteral } from "./db-pg.js";
import type { PgConnectionConfig } from "./config.js";
import { bootstrapSchema, ensureVectorIndex, type FtsCapabilities } from "./schema-pg.js";
import { hashContent, chunkDocument, getDocid } from "../store.js";
import {
  DEFAULT_EMBED_MODEL_URI,
  formatDocForEmbedding,
  formatQueryForEmbedding,
} from "../llm.js";

/** Minimal embedder contract — satisfied by LlamaCpp from llm.ts. */
export interface Embedder {
  embedBatch(
    texts: string[],
    options?: { isQuery?: boolean; model?: string },
  ): Promise<({ embedding: number[]; model: string } | null)[]>;
}

export interface AddMemoryInput {
  /** Logical id within the namespace (like a path). Re-adding the same key updates it. */
  key: string;
  /** The memory body to store and index. */
  body: string;
  /** Optional human title (also surfaced in results). */
  title?: string;
  /** Arbitrary JSON metadata (agent, tags, source, ...). */
  metadata?: Record<string, unknown>;
  /** Override the default namespace for this call. */
  namespace?: string;
  /** Embedding model URI (defaults to the configured embed model). */
  model?: string;
}

export interface AddMemoryResult {
  namespace: string;
  key: string;
  hash: string;
  docid: string;
  chunks: number;
  embedded: boolean;
}

export interface MemorySearchResult {
  namespace: string;
  key: string;
  title: string;
  docid: string;
  hash: string;
  /** Fused RRF score (higher = better). */
  score: number;
  /** Best lexical rank (1-indexed) or null if not matched lexically. */
  lexRank: number | null;
  /** Best vector rank (1-indexed) or null if not matched semantically. */
  vecRank: number | null;
  /** Snippet/body (truncated unless full requested). */
  body: string;
  metadata: Record<string, unknown>;
}

export interface MemoryRecord {
  namespace: string;
  key: string;
  title: string;
  docid: string;
  hash: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchOptions {
  namespace?: string;
  limit?: number;
  /** Candidate pool per signal before fusion (default 50). */
  candidateLimit?: number;
  /** Return full body instead of a snippet. */
  full?: boolean;
  /** Embedding model URI for the query. */
  model?: string;
}

const RRF_K = 60;
const SNIPPET_CHARS = 400;

/** Reciprocal Rank Fusion across signal-specific ranked key lists. */
function rrfFuse(rankings: Array<Map<string, number>>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [key, rank] of ranking) {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  return scores;
}

function snippet(body: string, full: boolean): string {
  if (full || body.length <= SNIPPET_CHARS) return body;
  return body.slice(0, SNIPPET_CHARS) + "…";
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export class PgMemoryStore {
  private constructor(
    private client: PgClient,
    private embedder: Embedder,
    private fts: FtsCapabilities,
    private defaultNamespace: string,
    private defaultModel: string,
  ) {}

  static async open(
    config: PgConnectionConfig,
    embedder: Embedder,
    opts?: { model?: string },
  ): Promise<PgMemoryStore> {
    const client = await PgClient.create(config);
    const fts = await bootstrapSchema(client);
    return new PgMemoryStore(
      client,
      embedder,
      fts,
      config.namespace,
      opts?.model ?? DEFAULT_EMBED_MODEL_URI,
    );
  }

  get capabilities(): FtsCapabilities {
    return this.fts;
  }

  private ns(override?: string): string {
    return (override ?? "").trim() || this.defaultNamespace;
  }

  // ── Write ──────────────────────────────────────────────────────────────

  async addMemory(input: AddMemoryInput): Promise<AddMemoryResult> {
    const namespace = this.ns(input.namespace);
    const body = input.body;
    const title = input.title ?? "";
    const model = input.model ?? this.defaultModel;
    const hash = await hashContent(body);
    const docid = getDocid(hash);

    // Chunk + embed up front (network/LLM bound) before opening the transaction.
    const chunks = chunkDocument(body);
    const texts = chunks.map((c) => formatDocForEmbedding(c.text, title, model));
    const embeddings = await this.embedder.embedBatch(texts, { isQuery: false, model });

    await this.client.tx(async (tx) => {
      await tx.exec(
        `INSERT INTO qmd_memory_content (namespace, hash, body)
         VALUES ($1, $2, $3)
         ON CONFLICT (namespace, hash) DO NOTHING`,
        [namespace, hash, body],
      );
      await tx.exec(
        `INSERT INTO qmd_memory (namespace, key, title, hash, metadata, updated_at, active)
         VALUES ($1, $2, $3, $4, $5::jsonb, now(), true)
         ON CONFLICT (namespace, key)
         DO UPDATE SET title = EXCLUDED.title,
                       hash = EXCLUDED.hash,
                       metadata = EXCLUDED.metadata,
                       updated_at = now(),
                       active = true`,
        [namespace, input.key, title, hash, JSON.stringify(input.metadata ?? {})],
      );
      // Refresh embeddings for this content hash.
      await tx.exec(`DELETE FROM qmd_memory_vectors WHERE namespace = $1 AND hash = $2`, [
        namespace,
        hash,
      ]);
      for (let i = 0; i < chunks.length; i++) {
        const emb = embeddings[i];
        const chunk = chunks[i];
        if (!emb || !chunk) continue;
        await tx.exec(
          `INSERT INTO qmd_memory_vectors (namespace, hash, seq, pos, embedding, model)
           VALUES ($1, $2, $3, $4, $5::vector, $6)`,
          [namespace, hash, i, chunk.pos, toVectorLiteral(emb.embedding), emb.model ?? model],
        );
      }
    });

    const embeddedCount = embeddings.filter(Boolean).length;
    // Lazily build the ANN index once we know the embedding dimension.
    if (embeddedCount > 0) {
      const dim = embeddings.find(Boolean)?.embedding.length;
      if (dim) await this.ensureIndexOnce(dim);
    }

    return {
      namespace,
      key: input.key,
      hash,
      docid,
      chunks: chunks.length,
      embedded: embeddedCount > 0,
    };
  }

  private async ensureIndexOnce(dim: number): Promise<void> {
    const ns = this.defaultNamespace;
    const existing = await this.client.queryOne<{ value: string }>(
      `SELECT value FROM qmd_memory_config WHERE namespace = $1 AND key = 'vector_dim'`,
      [ns],
    );
    if (existing?.value === String(dim)) return;
    await ensureVectorIndex(this.client, dim);
    await this.client.exec(
      `INSERT INTO qmd_memory_config (namespace, key, value)
       VALUES ($1, 'vector_dim', $2)
       ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
      [ns, String(dim)],
    );
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async searchMemory(query: string, opts: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const namespace = this.ns(opts.namespace);
    const limit = opts.limit ?? 10;
    const candidateLimit = opts.candidateLimit ?? 50;
    const model = opts.model ?? this.defaultModel;

    // Signal 1 — lexical (pg_jieba/tsvector + ts_rank).
    const lexRows = await this.client.query<{ key: string }>(
      `SELECT m.key AS key
       FROM qmd_memory_content c
       JOIN qmd_memory m ON m.namespace = c.namespace AND m.hash = c.hash AND m.active
       WHERE c.namespace = $1 AND c.tsv @@ websearch_to_tsquery($2::regconfig, $3)
       ORDER BY ts_rank_cd(c.tsv, websearch_to_tsquery($2::regconfig, $3)) DESC
       LIMIT $4`,
      [namespace, this.fts.config, query, candidateLimit],
    );
    const lexRank = new Map<string, number>();
    lexRows.forEach((r, i) => {
      if (!lexRank.has(r.key)) lexRank.set(r.key, i + 1);
    });

    // Signal 2 — semantic (pgvector cosine distance).
    const vecRank = new Map<string, number>();
    const qEmb = (await this.embedder.embedBatch([formatQueryForEmbedding(query, model)], {
      isQuery: true,
      model,
    }))[0];
    if (qEmb) {
      const vecRows = await this.client.query<{ key: string }>(
        `SELECT m.key AS key
         FROM qmd_memory_vectors v
         JOIN qmd_memory m ON m.namespace = v.namespace AND m.hash = v.hash AND m.active
         WHERE v.namespace = $1
         ORDER BY v.embedding <=> $2::vector
         LIMIT $3`,
        [namespace, toVectorLiteral(qEmb.embedding), candidateLimit],
      );
      vecRows.forEach((r) => {
        if (!vecRank.has(r.key)) vecRank.set(r.key, vecRank.size + 1);
      });
    }

    const fused = rrfFuse([lexRank, vecRank]);
    if (fused.size === 0) return [];

    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const keys = ranked.map(([key]) => key);

    // Hydrate the winning keys with title/body/metadata.
    const rows = await this.client.query<{
      key: string;
      title: string;
      hash: string;
      body: string;
      metadata: unknown;
    }>(
      `SELECT m.key, m.title, m.hash, c.body, m.metadata
       FROM qmd_memory m
       JOIN qmd_memory_content c ON c.namespace = m.namespace AND c.hash = m.hash
       WHERE m.namespace = $1 AND m.key = ANY($2) AND m.active`,
      [namespace, keys],
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const results: MemorySearchResult[] = [];
    for (const [key, score] of ranked) {
      const row = byKey.get(key);
      if (!row) continue;
      results.push({
        namespace,
        key,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        score,
        lexRank: lexRank.get(key) ?? null,
        vecRank: vecRank.get(key) ?? null,
        body: snippet(row.body, opts.full ?? false),
        metadata: parseMetadata(row.metadata),
      });
    }
    return results;
  }

  // ── Read / manage ──────────────────────────────────────────────────────

  async getMemory(key: string, opts?: { namespace?: string }): Promise<MemoryRecord | null> {
    const namespace = this.ns(opts?.namespace);
    const row = await this.client.queryOne<{
      key: string;
      title: string;
      hash: string;
      body: string;
      metadata: unknown;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT m.key, m.title, m.hash, c.body, m.metadata, m.created_at, m.updated_at
       FROM qmd_memory m
       JOIN qmd_memory_content c ON c.namespace = m.namespace AND c.hash = m.hash
       WHERE m.namespace = $1 AND m.key = $2 AND m.active`,
      [namespace, key],
    );
    if (!row) return null;
    return {
      namespace,
      key: row.key,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      body: row.body,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async deleteMemory(key: string, opts?: { namespace?: string }): Promise<boolean> {
    const namespace = this.ns(opts?.namespace);
    const n = await this.client.exec(
      `UPDATE qmd_memory SET active = false, updated_at = now()
       WHERE namespace = $1 AND key = $2 AND active`,
      [namespace, key],
    );
    return n > 0;
  }

  async listMemories(
    opts?: { namespace?: string; limit?: number },
  ): Promise<Array<{ key: string; title: string; docid: string; updatedAt: string }>> {
    const namespace = this.ns(opts?.namespace);
    const rows = await this.client.query<{
      key: string;
      title: string;
      hash: string;
      updated_at: string;
    }>(
      `SELECT key, title, hash, updated_at FROM qmd_memory
       WHERE namespace = $1 AND active ORDER BY updated_at DESC LIMIT $2`,
      [namespace, opts?.limit ?? 100],
    );
    return rows.map((r) => ({
      key: r.key,
      title: r.title,
      docid: getDocid(r.hash),
      updatedAt: r.updated_at,
    }));
  }

  async listNamespaces(): Promise<Array<{ namespace: string; count: number }>> {
    const rows = await this.client.query<{ namespace: string; count: string }>(
      `SELECT namespace, count(*)::text AS count FROM qmd_memory
       WHERE active GROUP BY namespace ORDER BY namespace`,
    );
    return rows.map((r) => ({ namespace: r.namespace, count: Number.parseInt(r.count, 10) }));
  }

  async health(): Promise<{
    server: string;
    namespace: string;
    fts: FtsCapabilities;
    memories: number;
  }> {
    const server = await this.client.ping();
    const row = await this.client.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM qmd_memory WHERE namespace = $1 AND active`,
      [this.defaultNamespace],
    );
    return {
      server,
      namespace: this.defaultNamespace,
      fts: this.fts,
      memories: Number.parseInt(row?.count ?? "0", 10),
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
