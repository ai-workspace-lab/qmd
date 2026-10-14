/**
 * tier/types.ts - Shared types for the tier engine.
 */

import type { MemItemKind } from "../pg/schema-mem.js";
import type { TierPolicy } from "./policy.js";
import type { FactRow } from "./facts.js";

export interface TierConfig {
  namespace: string;
  home: string;
  l1Dir: string;
  l3CacheDir: string;
  quarantineDir: string;
  /** Workspace root used for .archive manifest keys (default /workspace). */
  workspaceRoot: string;
  /** .archive state dir holding the committed manifest.json. */
  archiveStateDir: string;
  embedModel: string;
  policy: TierPolicy;
  /** Max bytes per L2 part (default 2048). */
  partBytes: number;
}

export interface SessionMeta {
  sourceSessionId: string;
  ctxSessionId?: number | null;
  project?: string | null;
  cwd?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  turns?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensTotal?: number | null;
  models?: string[] | null;
  primaryModel?: string | null;
  modelFamily?: string | null;
  reasoningEffort?: string | null;
  thinking?: string | null;
  mode?: string | null;
  role?: string | null;
  roleLevel?: number | null;
  roleRationale?: string | null;
  routingFit?: string | null;
  kind?: string | null;
  extra?: Record<string, unknown>;
}

export interface UpsertItemInput {
  kind: MemItemKind;
  source: string;
  sourceRef: string;
  scope?: string | null;
  title?: string | null;
  occurredAt: Date;
  /** Text indexed in L2/L1 (frontmatter is stripped). */
  body: string;
  /** Original stored in L3 (defaults to body). Redacted before staging. */
  raw?: string;
  /** File name for the L3 original (default <source_ref>.md). */
  rawName?: string;
  sensitivity?: "public" | "private" | "restricted";
  summary?: string | null;
  pinned?: boolean;
  session?: SessionMeta;
  /** Embed new parts immediately (default true). Bulk loads pass false and run embedPending(). */
  embed?: boolean;
  /** Materialize to L1 when admission rules allow (default true). */
  materialize?: boolean;
  /** Skip L3 staging. */
  skipL3?: boolean;
  /** Rewrite parts even when the sha256 is unchanged. */
  force?: boolean;
}

export interface UpsertItemResult {
  id: string;
  created: boolean;
  unchanged: boolean;
  parts: number;
  droppedParts: number;
  l3: "staged" | "quarantined" | "skipped" | "unchanged";
  l1: string | null;
}

export interface MemSearchHit {
  itemId: string;
  tier: "L1" | "L2";
  score: number;
  kind: string;
  source: string;
  scope: string | null;
  title: string | null;
  occurredAt: string;
  tierState: string;
  snippet: string;
  promoted?: boolean;
}

export interface MemSearchOptions {
  limit?: number;
  scope?: string;
  kind?: string;
  since?: Date;
  agent?: string;
  /** Skip promotion side effects (benchmarks / read-only callers). */
  noPromote?: boolean;
  /** Allow answering from L1 alone when it is confident (skips L2). Default off. */
  fast?: boolean;
  /** Exclude restricted items (used by mem_context and posting). */
  excludeRestricted?: boolean;
}

export interface MemSearchResult {
  query: string;
  hits: MemSearchHit[];
  facts: FactRow[];
  tiers: { l1: number; l2: number };
  shortCircuit: boolean;
  promoted: string[];
}

export interface ItemRow {
  id: string;
  kind: string;
  source: string;
  source_ref: string;
  scope: string | null;
  title: string | null;
  summary: string | null;
  occurred_at: Date;
  sha256: string;
  bytes: number | null;
  parts: number;
  tier_state: "l2_full" | "l2_summary_only" | "tombstoned";
  pinned: boolean;
  promoted_at: Date | null;
  sensitivity: string;
}
