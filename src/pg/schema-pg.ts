/**
 * pg/schema-pg.ts - PostgreSQL schema for the qmd memory bridge
 *
 * Mirrors qmd's SQLite model (content-addressable storage + documents + vectors
 * + FTS) but adapted to PostgreSQL extensions and made multi-tenant via a
 * `namespace` column so OpenClaw, Hermes, ... can share one instance safely.
 *
 *   SQLite                       →  PostgreSQL
 *   content (hash → doc)         →  qmd_memory_content   (namespace, hash, body, tsv)
 *   documents                    →  qmd_memory           (namespace, key, hash, ...)
 *   content_vectors + vec0       →  qmd_memory_vectors   (pgvector `vector`)
 *   documents_fts (FTS5/BM25)    →  tsvector + GIN (pg_jieba 中文 / english)
 *                                   + pg_trgm for fuzzy matching
 */

import type { PgClient } from "./db-pg.js";

/** Text-search configuration chosen at bootstrap time. */
export interface FtsCapabilities {
  /** ts config used for indexing/search: "jiebacfg" (中文) when available, else "english". */
  config: string;
  /** Whether pg_trgm is available for fuzzy matching. */
  trigram: boolean;
  /** Whether pgvector is available. */
  vector: boolean;
}

/** Try a statement, swallow failure, report success. */
async function tryExec(client: PgClient, sql: string): Promise<boolean> {
  try {
    await client.exec(sql);
    return true;
  } catch {
    return false;
  }
}

async function hasExtension(client: PgClient, name: string): Promise<boolean> {
  const row = await client.queryOne<{ one: number }>(
    "SELECT 1 AS one FROM pg_extension WHERE extname = $1",
    [name],
  );
  return !!row;
}

async function hasTsConfig(client: PgClient, name: string): Promise<boolean> {
  const row = await client.queryOne<{ one: number }>(
    "SELECT 1 AS one FROM pg_ts_config WHERE cfgname = $1",
    [name],
  );
  return !!row;
}

/**
 * Create extensions + tables + indexes. Idempotent. Degrades gracefully when an
 * extension is unavailable (e.g. pg_jieba missing → falls back to `english`).
 */
export async function bootstrapSchema(client: PgClient): Promise<FtsCapabilities> {
  // Extensions — best-effort. A non-superuser may lack CREATE EXTENSION, in
  // which case we detect what's already installed.
  await tryExec(client, "CREATE EXTENSION IF NOT EXISTS vector");
  await tryExec(client, "CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await tryExec(client, "CREATE EXTENSION IF NOT EXISTS pg_jieba");

  const vector = await hasExtension(client, "vector");
  const trigram = await hasExtension(client, "pg_trgm");
  const jieba = await hasTsConfig(client, "jiebacfg");
  const config = jieba ? "jiebacfg" : "english";

  if (!vector) {
    throw new Error(
      "pgvector ('vector') extension is not available on this PostgreSQL server. " +
        "It is required for the qmd memory backend (semantic search). " +
        "Install it (postgresql.svc.plus ships it) or enable it: CREATE EXTENSION vector;",
    );
  }

  // ── content-addressable storage (+ FTS) ──────────────────────────────────
  // tsv is a generated column over the body using the detected ts config.
  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_memory_content (
      namespace   text NOT NULL,
      hash        text NOT NULL,
      body        text NOT NULL,
      tsv         tsvector GENERATED ALWAYS AS (to_tsvector('${config}', body)) STORED,
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (namespace, hash)
    )
  `);
  await tryExec(
    client,
    "CREATE INDEX IF NOT EXISTS qmd_memory_content_tsv_idx ON qmd_memory_content USING gin (tsv)",
  );
  if (trigram) {
    await tryExec(
      client,
      "CREATE INDEX IF NOT EXISTS qmd_memory_content_trgm_idx ON qmd_memory_content USING gin (body gin_trgm_ops)",
    );
  }

  // ── memory records (documents layer) ─────────────────────────────────────
  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_memory (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      namespace   text NOT NULL,
      key         text NOT NULL,
      title       text NOT NULL DEFAULT '',
      hash        text NOT NULL,
      metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      active      boolean NOT NULL DEFAULT true,
      UNIQUE (namespace, key)
    )
  `);
  await tryExec(
    client,
    "CREATE INDEX IF NOT EXISTS qmd_memory_ns_active_idx ON qmd_memory (namespace, active)",
  );
  await tryExec(
    client,
    "CREATE INDEX IF NOT EXISTS qmd_memory_hash_idx ON qmd_memory (namespace, hash)",
  );

  // ── per-chunk vector embeddings ──────────────────────────────────────────
  // Column is unconstrained `vector` so any embedding dimension works without a
  // rebuild; an HNSW index is added later via ensureVectorIndex() once the
  // dimension is known. Exact (<=>) search works without the index.
  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_memory_vectors (
      namespace   text NOT NULL,
      hash        text NOT NULL,
      seq         integer NOT NULL DEFAULT 0,
      pos         integer NOT NULL DEFAULT 0,
      embedding   vector NOT NULL,
      model       text NOT NULL,
      embedded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (namespace, hash, seq)
    )
  `);

  // ── key/value config (mirrors store_config) ──────────────────────────────
  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_memory_config (
      namespace text NOT NULL,
      key       text NOT NULL,
      value     text,
      PRIMARY KEY (namespace, key)
    )
  `);

  return { config, trigram, vector };
}

/**
 * Promote the embedding column to a fixed dimension and build an HNSW cosine
 * index. Best-effort: if dimensions are mixed or the operation fails, exact
 * search still works without the index.
 */
export async function ensureVectorIndex(client: PgClient, dimensions: number): Promise<boolean> {
  if (!Number.isInteger(dimensions) || dimensions <= 0) return false;
  // Fix the column dimension (no-op if already that dimension).
  const typed = await tryExec(
    client,
    `ALTER TABLE qmd_memory_vectors ALTER COLUMN embedding TYPE vector(${dimensions})`,
  );
  if (!typed) return false;
  return tryExec(
    client,
    "CREATE INDEX IF NOT EXISTS qmd_memory_vectors_hnsw_idx " +
      "ON qmd_memory_vectors USING hnsw (embedding vector_cosine_ops)",
  );
}

/** Detect the ts config currently in use (jiebacfg when pg_jieba is present). */
export async function detectFtsConfig(client: PgClient): Promise<string> {
  return (await hasTsConfig(client, "jiebacfg")) ? "jiebacfg" : "english";
}

// ─────────────────────────────────────────────────────────────────────────────
// Task coordination layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the task-claim table. Deliberately separate from `bootstrapSchema`:
 * coordination needs neither pgvector nor pg_jieba, and `qmd task who` must stay
 * fast and dependency-light enough to run from an editor hook on every write.
 * Idempotent.
 */
export async function bootstrapTaskSchema(client: PgClient): Promise<void> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_task_claim (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope         text NOT NULL,
      resource      text NOT NULL,
      agent_id      text NOT NULL,
      agent_kind    text NOT NULL DEFAULT 'unknown',
      intent        text NOT NULL DEFAULT '',
      branch        text,
      worktree      text,
      pr_number     integer,
      base_sha      text,
      status        text NOT NULL DEFAULT 'active',
      claimed_at    timestamptz NOT NULL DEFAULT now(),
      heartbeat_at  timestamptz NOT NULL DEFAULT now(),
      ttl_seconds   integer NOT NULL DEFAULT 1800,
      released_at   timestamptz,
      note          text
    )
  `);

  // The pivot of the whole design: "one active claim per resource" is a
  // database constraint, not an application-level gentlemen's agreement.
  // Partial, so released/abandoned history rows accumulate freely.
  await tryExec(
    client,
    `CREATE UNIQUE INDEX IF NOT EXISTS qmd_task_claim_active_uniq
       ON qmd_task_claim (scope, resource) WHERE status = 'active'`,
  );
  await tryExec(
    client,
    `CREATE INDEX IF NOT EXISTS qmd_task_claim_scope_idx
       ON qmd_task_claim (scope, status, heartbeat_at DESC)`,
  );
  await tryExec(
    client,
    `CREATE INDEX IF NOT EXISTS qmd_task_claim_agent_idx
       ON qmd_task_claim (agent_id, status)`,
  );
}
