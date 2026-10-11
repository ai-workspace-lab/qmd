/**
 * pg/schema-mem.ts - Tiered-memory registry tables (prefix `mem_`).
 *
 * Additive to the fork's `qmd_*` schema (schema-pg.ts): the tier engine keeps
 * item metadata, per-tier locations, heat, facts and L3 hand-off state here,
 * while chunk bodies and vectors stay in `qmd_memory*` under keys
 * `mem/<item_id>/<seq>` (and `mem/<item_id>/summary`).
 *
 * Every statement is idempotent so bootstrap can run on each start.
 */

import type { PgClient } from "./db-pg.js";

export const MEM_ITEM_KINDS = [
  "session",
  "message_batch",
  "inbox_file",
  "journal",
  "article",
  "knowledge_doc",
  "x_post",
  "ctx_thread",
  "note",
] as const;
export type MemItemKind = (typeof MEM_ITEM_KINDS)[number];

export const MEM_TIERS = ["L1", "L2", "L3", "L3_cache"] as const;
export type MemTier = (typeof MEM_TIERS)[number];

const kindList = MEM_ITEM_KINDS.map((k) => `'${k}'`).join(",");

export const MEM_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS mem_item (
     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     kind          text NOT NULL CHECK (kind IN (${kindList})),
     source        text NOT NULL,
     source_ref    text NOT NULL,
     scope         text,
     title         text,
     summary       text,
     occurred_at   timestamptz NOT NULL,
     sha256        text NOT NULL,
     bytes         integer,
     parts         integer NOT NULL DEFAULT 0,
     tier_state    text NOT NULL DEFAULT 'l2_full'
                   CHECK (tier_state IN ('l2_full','l2_summary_only','tombstoned')),
     pinned        boolean NOT NULL DEFAULT false,
     promoted_at   timestamptz,
     compacted_at  timestamptz,
     sensitivity   text NOT NULL DEFAULT 'private'
                   CHECK (sensitivity IN ('public','private','restricted')),
     redaction     jsonb NOT NULL DEFAULT '{}',
     created_at    timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now(),
     UNIQUE (source, source_ref)
   )`,
  `CREATE INDEX IF NOT EXISTS mem_item_occurred_idx ON mem_item (occurred_at)`,
  `CREATE INDEX IF NOT EXISTS mem_item_kind_scope_idx ON mem_item (kind, scope)`,
  `CREATE TABLE IF NOT EXISTS mem_location (
     item_id     uuid REFERENCES mem_item(id) ON DELETE CASCADE,
     tier        text NOT NULL CHECK (tier IN ('L1','L2','L3','L3_cache')),
     locator     text NOT NULL,
     state       text NOT NULL CHECK (state IN ('pending','committed','evicted','missing')),
     reason      text,
     sha256      text,
     bytes       integer,
     updated_at  timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (item_id, tier)
   )`,
  `CREATE TABLE IF NOT EXISTS mem_access_log (
     id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     at         timestamptz NOT NULL DEFAULT now(),
     item_id    uuid NOT NULL,
     hit_tier   text NOT NULL,
     op         text NOT NULL,
     agent      text,
     query_hash text
   )`,
  `CREATE INDEX IF NOT EXISTS mem_access_log_item_at_idx ON mem_access_log (item_id, at)`,
  `CREATE TABLE IF NOT EXISTS mem_heat (
     item_id     uuid PRIMARY KEY REFERENCES mem_item(id) ON DELETE CASCADE,
     hits_7d     integer NOT NULL DEFAULT 0,
     hits_30d    integer NOT NULL DEFAULT 0,
     hits_90d    integer NOT NULL DEFAULT 0,
     hits_total  integer NOT NULL DEFAULT 0,
     last_hit_at timestamptz,
     score       real NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS mem_heat_score_idx ON mem_heat (score DESC)`,
  `CREATE TABLE IF NOT EXISTS mem_session (
     item_id           uuid PRIMARY KEY REFERENCES mem_item(id) ON DELETE CASCADE,
     source            text NOT NULL,
     source_session_id text NOT NULL,
     ctx_session_id    bigint,
     project text, cwd_rel text,
     started_at timestamptz, ended_at timestamptz,
     turns int, tokens_in bigint, tokens_out bigint, tokens_total bigint,
     models text[], primary_model text, model_family text,
     reasoning_effort text, thinking text, mode text,
     role text, role_level smallint CHECK (role_level BETWEEN 0 AND 5),
     role_rationale text, routing_fit text, kind text,
     extra jsonb NOT NULL DEFAULT '{}',
     UNIQUE (source, source_session_id)
   )`,
  `CREATE TABLE IF NOT EXISTS mem_entity (
     id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     type      text NOT NULL CHECK (type IN ('product','repo','person','decision','project','article','service')),
     name      text NOT NULL,
     aliases   text[] NOT NULL DEFAULT '{}',
     attrs     jsonb NOT NULL DEFAULT '{}',
     UNIQUE (type, name)
   )`,
  `CREATE TABLE IF NOT EXISTS mem_edge (
     src uuid REFERENCES mem_entity(id) ON DELETE CASCADE,
     dst uuid REFERENCES mem_entity(id) ON DELETE CASCADE,
     rel text NOT NULL,
     weight real NOT NULL DEFAULT 1,
     evidence uuid[] NOT NULL DEFAULT '{}',
     first_seen timestamptz, last_seen timestamptz,
     PRIMARY KEY (src, dst, rel)
   )`,
  `CREATE INDEX IF NOT EXISTS mem_edge_dst_rel_idx ON mem_edge (dst, rel)`,
  `CREATE TABLE IF NOT EXISTS mem_fact (
     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     subject_id    uuid REFERENCES mem_entity(id),
     predicate     text NOT NULL,
     object_text   text,
     object_id     uuid REFERENCES mem_entity(id),
     statement     text NOT NULL,
     confidence    real NOT NULL DEFAULT 0.7,
     valid_from    timestamptz, valid_to timestamptz,
     superseded_by uuid REFERENCES mem_fact(id),
     status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed','retired')),
     evidence      uuid[] NOT NULL,
     created_at    timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mem_fact_subject_status_idx ON mem_fact (subject_id, status)`,
  `CREATE TABLE IF NOT EXISTS mem_summary (
     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     period       text NOT NULL CHECK (period IN ('day','week','month')),
     period_start date NOT NULL,
     scope        text NOT NULL DEFAULT '*',
     body         text NOT NULL,
     item_ids     uuid[] NOT NULL,
     model        text,
     created_at   timestamptz NOT NULL DEFAULT now(),
     UNIQUE (period, period_start, scope)
   )`,
  `CREATE TABLE IF NOT EXISTS mem_l3_outbox (
     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     item_id uuid REFERENCES mem_item(id) ON DELETE CASCADE,
     local_path text NOT NULL,
     target_path text NOT NULL,
     sha256 text NOT NULL,
     bytes integer NOT NULL,
     status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','committed','failed')),
     drive_file_id text,
     attempts int NOT NULL DEFAULT 0,
     updated_at timestamptz DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mem_l3_outbox_path_sha_idx ON mem_l3_outbox (local_path, sha256)`,
  `CREATE TABLE IF NOT EXISTS mem_l3_fetch (
     item_id uuid PRIMARY KEY REFERENCES mem_item(id) ON DELETE CASCADE,
     requested_at timestamptz NOT NULL DEFAULT now(),
     requested_by text,
     status text NOT NULL DEFAULT 'queued'
   )`,
  `CREATE TABLE IF NOT EXISTS mem_job_run (
     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     job text NOT NULL,
     started_at timestamptz DEFAULT now(),
     finished_at timestamptz,
     ok boolean,
     stats jsonb NOT NULL DEFAULT '{}',
     error text
   )`,
];

/** Create (or verify) every `mem_*` table. Safe to call repeatedly. */
export async function bootstrapMemSchema(client: PgClient): Promise<void> {
  for (const sql of MEM_SCHEMA_STATEMENTS) {
    await client.exec(sql);
  }
}

export const MEM_TABLES = [
  "mem_item",
  "mem_location",
  "mem_access_log",
  "mem_heat",
  "mem_session",
  "mem_entity",
  "mem_edge",
  "mem_fact",
  "mem_summary",
  "mem_l3_outbox",
  "mem_l3_fetch",
  "mem_job_run",
] as const;
