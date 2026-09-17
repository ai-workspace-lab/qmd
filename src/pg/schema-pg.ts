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

// ─────────────────────────────────────────────────────────────────────────────
// Shared task context (threads keyed by PR / branch, mergeable items)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the shared-context tables. Like the claim table this needs neither
 * pgvector nor pg_jieba: it stores structured session facts (goal, plan, next
 * action, decisions, pitfalls, verification, repo-relative paths), never
 * artifacts. Idempotent. See docs/plan/multi-agent-shared-context.md.
 */
export async function bootstrapContextSchema(client: PgClient): Promise<void> {
  await bootstrapTaskSchema(client);

  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_ctx_thread (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scope              text NOT NULL,
      head_branch        text,
      pr_number          integer,
      pr_state           text,
      title              text NOT NULL DEFAULT '',
      state              text NOT NULL DEFAULT 'open',
      merged_into        uuid REFERENCES qmd_ctx_thread(id),
      head_sha           text,
      driver_session_id  uuid,
      lease_expires_at   timestamptz,
      fence              bigint NOT NULL DEFAULT 0,
      last_event_seq     bigint NOT NULL DEFAULT 0,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      CHECK (state IN ('open', 'paused', 'handed_off', 'done', 'abandoned')),
      CHECK (pr_state IS NULL OR pr_state IN ('open', 'merged', 'closed')),
      CHECK (merged_into IS NULL OR merged_into <> id)
    )
  `);
  // One live thread per PR and per branch. A merged-away thread no longer
  // counts; a finished branch thread frees its name for the next piece of work.
  await client.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS qmd_ctx_thread_pr_uniq
       ON qmd_ctx_thread (scope, pr_number)
       WHERE pr_number IS NOT NULL AND merged_into IS NULL`,
  );
  await client.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS qmd_ctx_thread_branch_uniq
       ON qmd_ctx_thread (scope, head_branch)
       WHERE head_branch IS NOT NULL AND merged_into IS NULL
         AND state IN ('open', 'paused', 'handed_off')`,
  );
  await tryExec(
    client,
    `CREATE INDEX IF NOT EXISTS qmd_ctx_thread_scope_idx
       ON qmd_ctx_thread (scope, state, updated_at DESC)`,
  );

  // One row per (source session, thread): a transcript that switched branches
  // contributes to more than one thread.
  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_ctx_session (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id          uuid NOT NULL REFERENCES qmd_ctx_thread(id) ON DELETE CASCADE,
      source             text NOT NULL,
      source_session_id  text NOT NULL,
      agent_kind         text NOT NULL DEFAULT 'unknown',
      title              text NOT NULL DEFAULT '',
      head_sha           text,
      first_seen_at      timestamptz NOT NULL DEFAULT now(),
      last_seen_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source, source_session_id, thread_id)
    )
  `);

  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_ctx_item (
      id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      thread_id           uuid NOT NULL REFERENCES qmd_ctx_thread(id) ON DELETE CASCADE,
      kind                text NOT NULL,
      item_key            text NOT NULL,
      status              text NOT NULL,
      ord                 integer,
      body                jsonb NOT NULL,
      git_head            text,
      created_session_id  uuid REFERENCES qmd_ctx_session(id) ON DELETE SET NULL,
      updated_session_id  uuid REFERENCES qmd_ctx_session(id) ON DELETE SET NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (thread_id, kind, item_key),
      CHECK (kind IN ('goal', 'next_action', 'plan_step', 'decision', 'pitfall',
                      'verification', 'path', 'question', 'blocker')),
      CHECK (jsonb_typeof(body) = 'object'),
      CHECK (octet_length(body::text) <= 4096)
    )
  `);

  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_ctx_item_source (
      item_id        bigint NOT NULL REFERENCES qmd_ctx_item(id) ON DELETE CASCADE,
      session_id     uuid NOT NULL REFERENCES qmd_ctx_session(id) ON DELETE CASCADE,
      first_seen_at  timestamptz NOT NULL DEFAULT now(),
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, session_id)
    )
  `);

  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_ctx_event (
      thread_id          uuid NOT NULL REFERENCES qmd_ctx_thread(id) ON DELETE CASCADE,
      seq                bigint NOT NULL,
      event_type         text NOT NULL,
      session_id         uuid,
      payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
      client_request_id  text NOT NULL DEFAULT '',
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, seq),
      CHECK (jsonb_typeof(payload) = 'object'),
      CHECK (octet_length(payload::text) <= 16384)
    )
  `);
  await client.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS qmd_ctx_event_request_uniq
       ON qmd_ctx_event (client_request_id) WHERE client_request_id <> ''`,
  );

  // Incremental collection state for local session directories. `meta` carries
  // what a later chunk of the same file still needs (session id, cwd, branch,
  // pending tool calls) without re-reading from byte 0.
  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_ctx_ingest_cursor (
      source       text NOT NULL,
      path         text NOT NULL,
      size         bigint NOT NULL DEFAULT 0,
      mtime_ms     bigint NOT NULL DEFAULT 0,
      byte_offset  bigint NOT NULL DEFAULT 0,
      meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, path)
    )
  `);

  await client.exec(`ALTER TABLE qmd_task_claim ADD COLUMN IF NOT EXISTS thread_id uuid`);

  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_shared_project (
      id           text PRIMARY KEY,
      name         text NOT NULL,
      root_path    text NOT NULL UNIQUE,
      sources      text[] NOT NULL DEFAULT '{}',
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.exec(`
    CREATE TABLE IF NOT EXISTS qmd_pinned_task (
      id           text PRIMARY KEY,
      source       text NOT NULL,
      title        text NOT NULL,
      cwd          text,
      project_name text,
      git_branch   text,
      position     integer NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `);
  await tryExec(client, `CREATE INDEX IF NOT EXISTS qmd_pinned_task_pos ON qmd_pinned_task (position ASC, updated_at DESC)`);

  await bootstrapShareableCatalog(client);
  await bootstrapChangeFeed(client);
}

/**
 * Catalog rows carry no absolute paths (docs/plan/multi-agent-shared-context.md
 * §2): a location is a git scope + repo-relative path, a cloud project ref, or
 * a directory name. Rows written before this migration held absolute paths and
 * are dropped; the next `qmd ctx collect` recreates them in the new shape.
 * Removed pins/projects are tombstoned (removed_at) so sync consumers see them go.
 */
async function bootstrapShareableCatalog(client: PgClient): Promise<void> {
  await client.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('qmd_ctx_catalog_migration'))`);
    await tx.exec(`
      ALTER TABLE qmd_shared_project
        ADD COLUMN IF NOT EXISTS project_key text,
        ADD COLUMN IF NOT EXISTS kind text,
        ADD COLUMN IF NOT EXISTS scope text,
        ADD COLUMN IF NOT EXISTS location text,
        ADD COLUMN IF NOT EXISTS removed_at timestamptz
    `);
    await tx.exec(`ALTER TABLE qmd_shared_project ALTER COLUMN root_path DROP NOT NULL`);
    await tx.exec(`DELETE FROM qmd_shared_project WHERE project_key IS NULL`);
    await tx.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS qmd_shared_project_key_uniq ON qmd_shared_project (project_key)`,
    );
    await tx.exec(`
      ALTER TABLE qmd_pinned_task
        ADD COLUMN IF NOT EXISTS scope text,
        ADD COLUMN IF NOT EXISTS location text,
        ADD COLUMN IF NOT EXISTS removed_at timestamptz
    `);
    await tx.exec(`DELETE FROM qmd_pinned_task WHERE location IS NULL`);
    await tx.exec(`UPDATE qmd_pinned_task SET cwd = NULL WHERE cwd IS NOT NULL`);
  });
}

/** Tables whose changes are published through GET /api/v1/agent/sync. */
export const CHANGE_FEED_TABLES = ["qmd_ctx_thread", "qmd_ctx_item", "qmd_pinned_task", "qmd_shared_project"] as const;

/**
 * Global change feed for two-way sync. Every insert/update stamps the row with
 * the writing transaction id (xid8) and a sequence number. Readers page by
 * (change_xid, change_seq) and only past pg_snapshot_xmin: every transaction
 * below xmin has finished, so no row can later appear behind the cursor.
 */
async function bootstrapChangeFeed(client: PgClient): Promise<void> {
  await client.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('qmd_ctx_change_feed_migration'))`);
    await tx.exec(`CREATE SEQUENCE IF NOT EXISTS qmd_ctx_change_seq`);
    await tx.exec(`
      CREATE OR REPLACE FUNCTION qmd_ctx_stamp_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        NEW.change_seq := nextval('qmd_ctx_change_seq');
        NEW.change_xid := pg_current_xact_id();
        RETURN NEW;
      END
      $fn$
    `);
    for (const table of CHANGE_FEED_TABLES) {
      await tx.exec(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS change_seq bigint, ADD COLUMN IF NOT EXISTS change_xid xid8`,
      );
      await tx.exec(`DROP TRIGGER IF EXISTS qmd_ctx_change ON ${table}`);
      await tx.exec(
        `CREATE TRIGGER qmd_ctx_change BEFORE INSERT OR UPDATE ON ${table}
           FOR EACH ROW EXECUTE FUNCTION qmd_ctx_stamp_change()`,
      );
      await tx.exec(`UPDATE ${table} SET change_seq = change_seq WHERE change_seq IS NULL`);
      await tx.exec(`CREATE INDEX IF NOT EXISTS ${table}_change_idx ON ${table} (change_xid, change_seq)`);
    }
  });
}
