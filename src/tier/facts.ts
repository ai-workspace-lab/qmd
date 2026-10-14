/**
 * tier/facts.ts - Entities, edges and long-lived facts (PLAN 2.4 / §6.6 step 4).
 *
 * Facts are append-only: a conflicting newer fact supersedes the old one
 * (`superseded_by`, status `retired`, `valid_to` set) instead of deleting it.
 */

import type { PgClient } from "../pg/db-pg.js";
import { DEFAULT_POLICY, factShouldAutoActivate, type TierPolicy } from "./policy.js";

export const ENTITY_TYPES = ["product", "repo", "person", "decision", "project", "article", "service"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface EntityRef {
  type: EntityType;
  name: string;
}

export interface FactRow {
  id: string;
  subject: string | null;
  subject_type: string | null;
  predicate: string;
  object_text: string | null;
  statement: string;
  confidence: number;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  evidence: string[];
  created_at: string;
}

export async function upsertEntity(
  client: PgClient,
  ref: EntityRef,
  opts: { aliases?: string[]; attrs?: Record<string, unknown> } = {},
): Promise<string> {
  const row = await client.queryOne<{ id: string }>(
    `INSERT INTO mem_entity (type, name, aliases, attrs)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (type, name) DO UPDATE
       SET aliases = COALESCE((SELECT array_agg(DISTINCT a) FROM unnest(mem_entity.aliases || EXCLUDED.aliases) a), '{}'),
           attrs = mem_entity.attrs || EXCLUDED.attrs
     RETURNING id`,
    [ref.type, ref.name, opts.aliases ?? [], JSON.stringify(opts.attrs ?? {})],
  );
  return row!.id;
}

export async function findEntity(client: PgClient, name: string): Promise<{ id: string; type: string; name: string } | null> {
  return client.queryOne(
    `SELECT id, type, name FROM mem_entity
     WHERE lower(name) = lower($1) OR lower($1) = ANY (SELECT lower(a) FROM unnest(aliases) a)
     ORDER BY type LIMIT 1`,
    [name],
  );
}

export async function addEdge(
  client: PgClient,
  src: string,
  dst: string,
  rel: string,
  evidence: string[] = [],
  at: Date = new Date(),
): Promise<void> {
  await client.exec(
    `INSERT INTO mem_edge (src, dst, rel, weight, evidence, first_seen, last_seen)
     VALUES ($1, $2, $3, 1, $4::uuid[], $5, $5)
     ON CONFLICT (src, dst, rel) DO UPDATE
       SET weight = mem_edge.weight + 1,
           evidence = COALESCE((SELECT array_agg(DISTINCT e) FROM unnest(mem_edge.evidence || EXCLUDED.evidence) e), '{}'),
           last_seen = GREATEST(mem_edge.last_seen, EXCLUDED.last_seen)`,
    [src, dst, rel, evidence, at.toISOString()],
  );
}

export interface ProposeFactInput {
  subject?: EntityRef;
  subjectId?: string;
  predicate: string;
  objectText?: string;
  objectId?: string;
  statement: string;
  confidence?: number;
  evidence: string[];
  /** Force a status (e.g. 'active' for manual entry). Otherwise the auto rule decides. */
  status?: "active" | "proposed";
  validFrom?: Date;
}

export interface ProposeFactResult {
  id: string;
  status: "active" | "proposed";
  superseded: string[];
}

/**
 * Record a fact. Proposed facts auto-activate with confidence ≥ 0.8 and ≥ 2
 * evidence items. Activating a fact retires any active fact with the same
 * subject + predicate but a different object (superseded, never deleted).
 */
export async function proposeFact(
  client: PgClient,
  input: ProposeFactInput,
  policy: TierPolicy = DEFAULT_POLICY,
): Promise<ProposeFactResult> {
  if (!input.statement.trim()) throw new Error("fact statement is required");
  if (!input.evidence.length) throw new Error("fact evidence (mem_item ids) is required");
  const subjectId = input.subjectId ?? (input.subject ? await upsertEntity(client, input.subject) : null);
  const confidence = input.confidence ?? 0.7;
  const status = input.status ?? (factShouldAutoActivate(confidence, input.evidence.length, policy) ? "active" : "proposed");

  return client.tx(async (tx) => {
    // Same statement already recorded for this subject → merge evidence instead of duplicating.
    const dup = await tx.queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM mem_fact
       WHERE subject_id IS NOT DISTINCT FROM $1 AND predicate = $2 AND statement = $3 AND status <> 'retired'
       LIMIT 1`,
      [subjectId, input.predicate, input.statement],
    );
    if (dup) {
      const merged = await tx.queryOne<{ n: number; confidence: number; status: string }>(
        `UPDATE mem_fact
           SET evidence = (SELECT array_agg(DISTINCT e) FROM unnest(evidence || $2::uuid[]) e),
               confidence = GREATEST(confidence, $3)
         WHERE id = $1
         RETURNING cardinality(evidence) AS n, confidence, status`,
        [dup.id, input.evidence, confidence],
      );
      let st = merged!.status as "active" | "proposed";
      const superseded: string[] = [];
      if (st === "proposed" && factShouldAutoActivate(merged!.confidence, merged!.n, policy)) {
        st = "active";
        await tx.exec(`UPDATE mem_fact SET status = 'active' WHERE id = $1`, [dup.id]);
        superseded.push(...(await supersede(tx, dup.id, subjectId, input.predicate, input.objectText ?? null)));
      }
      return { id: dup.id, status: st, superseded };
    }

    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO mem_fact (subject_id, predicate, object_text, object_id, statement, confidence,
                             valid_from, status, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[])
       RETURNING id`,
      [
        subjectId,
        input.predicate,
        input.objectText ?? null,
        input.objectId ?? null,
        input.statement,
        confidence,
        (input.validFrom ?? new Date()).toISOString(),
        status,
        input.evidence,
      ],
    );
    const id = row!.id;
    const superseded = status === "active"
      ? await supersede(tx, id, subjectId, input.predicate, input.objectText ?? null)
      : [];
    return { id, status, superseded };
  });
}

async function supersede(
  tx: { query<T>(sql: string, params?: unknown[]): Promise<T[]> },
  newId: string,
  subjectId: string | null,
  predicate: string,
  objectText: string | null,
): Promise<string[]> {
  if (!subjectId) return [];
  const rows = await tx.query<{ id: string }>(
    `UPDATE mem_fact
       SET status = 'retired', superseded_by = $1, valid_to = now()
     WHERE subject_id = $2 AND predicate = $3 AND status = 'active' AND id <> $1
       AND object_text IS DISTINCT FROM $4
     RETURNING id`,
    [newId, subjectId, predicate, objectText],
  );
  return rows.map((r) => r.id);
}

/** Promote proposed facts that now satisfy the auto rule (nightly sweep). */
export async function activateEligibleFacts(client: PgClient, policy: TierPolicy = DEFAULT_POLICY): Promise<number> {
  const rows = await client.query<{ id: string; subject_id: string | null; predicate: string; object_text: string | null }>(
    `SELECT id, subject_id, predicate, object_text FROM mem_fact
     WHERE status = 'proposed' AND confidence >= $1 AND cardinality(evidence) >= $2
     ORDER BY created_at`,
    [policy.factAutoConfidence, policy.factAutoEvidence],
  );
  for (const r of rows) {
    await client.tx(async (tx) => {
      await tx.exec(`UPDATE mem_fact SET status = 'active' WHERE id = $1`, [r.id]);
      await supersede(tx, r.id, r.subject_id, r.predicate, r.object_text);
    });
  }
  return rows.length;
}

export async function listFacts(
  client: PgClient,
  opts: { entity?: string; predicate?: string; status?: string; query?: string; limit?: number } = {},
): Promise<FactRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const status = opts.status ?? "active";
  if (status !== "all") {
    params.push(status);
    where.push(`f.status = $${params.length}`);
  }
  if (opts.entity) {
    params.push(opts.entity);
    where.push(`(lower(e.name) = lower($${params.length}) OR lower($${params.length}) = ANY (SELECT lower(a) FROM unnest(e.aliases) a))`);
  }
  if (opts.predicate) {
    params.push(opts.predicate);
    where.push(`f.predicate = $${params.length}`);
  }
  if (opts.query) {
    params.push(`%${opts.query}%`);
    where.push(`(f.statement ILIKE $${params.length} OR e.name ILIKE $${params.length})`);
  }
  params.push(opts.limit ?? 50);
  return client.query<FactRow>(
    `SELECT f.id, e.name AS subject, e.type AS subject_type, f.predicate, f.object_text, f.statement,
            f.confidence, f.status, f.valid_from, f.valid_to, f.superseded_by, f.evidence::text[] AS evidence,
            f.created_at
     FROM mem_fact f LEFT JOIN mem_entity e ON e.id = f.subject_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY f.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
}
