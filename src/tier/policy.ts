/**
 * tier/policy.ts - Pure tiering rules (PLAN §6). No I/O, fully unit-testable.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface TierPolicy {
  /** Items newer than this stay in L1 (days). */
  l1RecentDays: number;
  /** Heat score at or above this keeps/admits an item in L1. */
  l1HotScore: number;
  /** Protection window for promoted items (days). */
  promoteProtectDays: number;
  /** Eviction requires no hit within this many days. */
  l1IdleDays: number;
  /** L1 capacity limits. */
  l1MaxFiles: number;
  l1MaxBytes: number;
  /** When over capacity, evict down to this fraction. */
  l1TargetFraction: number;
  /** L2 compaction: item age and idle window (days). */
  compactAfterDays: number;
  compactIdleDays: number;
  /** mem_search: L1 is "good enough" when top score >= this and >= l1MinHits results. */
  l1ShortCircuitScore: number;
  l1MinHits: number;
  /** Fact auto-activation thresholds. */
  factAutoConfidence: number;
  factAutoEvidence: number;
}

export const DEFAULT_POLICY: TierPolicy = {
  l1RecentDays: 30,
  l1HotScore: 3,
  promoteProtectDays: 14,
  l1IdleDays: 30,
  l1MaxFiles: 5000,
  l1MaxBytes: 300 * 1024 * 1024,
  l1TargetFraction: 0.9,
  compactAfterDays: 90,
  compactIdleDays: 90,
  l1ShortCircuitScore: 0.55,
  l1MinHits: 3,
  factAutoConfidence: 0.8,
  factAutoEvidence: 2,
};

export interface HeatCounts {
  hits7d: number;
  hits30d: number;
  hitsTotal: number;
}

/** score = 1.0 × hits_7d + 0.3 × hits_30d + 0.05 × ln(1 + hits_total)  (§6.1) */
export function heatScore(h: HeatCounts): number {
  return 1.0 * h.hits7d + 0.3 * h.hits30d + 0.05 * Math.log(1 + Math.max(0, h.hitsTotal));
}

export interface TierItemState {
  occurredAt: Date;
  pinned: boolean;
  score: number;
  lastHitAt: Date | null;
  promotedAt: Date | null;
  tierState: "l2_full" | "l2_summary_only" | "tombstoned";
}

function ageDays(d: Date | null, now: Date): number {
  if (!d) return Number.POSITIVE_INFINITY;
  return (now.getTime() - d.getTime()) / DAY_MS;
}

export type L1Reason = "recent" | "hot" | "promoted" | "pinned";

/** Why an item belongs in L1, or null if it does not qualify (§6.2 admission). */
export function l1AdmissionReason(item: TierItemState, now: Date, p: TierPolicy = DEFAULT_POLICY): L1Reason | null {
  if (item.tierState === "tombstoned") return null;
  if (item.pinned) return "pinned";
  if (item.promotedAt && ageDays(item.promotedAt, now) <= p.promoteProtectDays) return "promoted";
  if (ageDays(item.occurredAt, now) <= p.l1RecentDays) return "recent";
  if (item.score >= p.l1HotScore) return "hot";
  return null;
}

/** §6.2 eviction: old, idle, not protected, not pinned. Tombstoned items always go. */
export function shouldEvictL1(item: TierItemState, now: Date, p: TierPolicy = DEFAULT_POLICY): boolean {
  if (item.tierState === "tombstoned") return true;
  if (item.pinned) return false;
  if (item.promotedAt && ageDays(item.promotedAt, now) <= p.promoteProtectDays) return false;
  if (ageDays(item.occurredAt, now) < p.l1RecentDays) return false;
  if (ageDays(item.lastHitAt, now) < p.l1IdleDays) return false;
  if (item.score >= p.l1HotScore) return false;
  return true;
}

export interface L1File {
  id: string;
  bytes: number;
  score: number;
  pinned: boolean;
  protectedUntil?: Date | null;
}

/**
 * Capacity eviction: when L1 exceeds its file/byte caps, evict the lowest
 * score (unpinned, unprotected) items until both are at or below the target
 * fraction. Returns the ids to evict, coldest first.
 */
export function capacityEvictions(files: L1File[], now: Date, p: TierPolicy = DEFAULT_POLICY): string[] {
  let count = files.length;
  let bytes = files.reduce((s, f) => s + f.bytes, 0);
  if (count <= p.l1MaxFiles && bytes <= p.l1MaxBytes) return [];
  const targetCount = Math.floor(p.l1MaxFiles * p.l1TargetFraction);
  const targetBytes = Math.floor(p.l1MaxBytes * p.l1TargetFraction);
  const candidates = files
    .filter((f) => !f.pinned && !(f.protectedUntil && f.protectedUntil.getTime() > now.getTime()))
    .sort((a, b) => a.score - b.score || b.bytes - a.bytes);
  const out: string[] = [];
  for (const f of candidates) {
    if (count <= targetCount && bytes <= targetBytes) break;
    out.push(f.id);
    count--;
    bytes -= f.bytes;
  }
  return out;
}

export interface CompactionInput {
  occurredAt: Date;
  pinned: boolean;
  tierState: TierItemState["tierState"];
  /** Hits in the last `compactIdleDays` days. */
  recentHits: number;
  /** L3 location committed and its sha256 matches the item. */
  l3Committed: boolean;
  l3ShaMatches: boolean;
}

/** §6.3: all conditions must hold. Never compact without a verified L3 copy. */
export function canCompact(i: CompactionInput, now: Date, p: TierPolicy = DEFAULT_POLICY): boolean {
  if (i.tierState !== "l2_full") return false;
  if (i.pinned) return false;
  if (ageDays(i.occurredAt, now) < p.compactAfterDays) return false;
  if (i.recentHits > 0) return false;
  return i.l3Committed && i.l3ShaMatches;
}

/** §6.6 step 4: proposed facts become active with confidence >= 0.8 and >= 2 evidence items. */
export function factShouldAutoActivate(confidence: number, evidenceCount: number, p: TierPolicy = DEFAULT_POLICY): boolean {
  return confidence >= p.factAutoConfidence && evidenceCount >= p.factAutoEvidence;
}

/** Reciprocal Rank Fusion over ranked id lists (k = 60). */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return scores;
}

/** Repo-relative path: strip home/user prefixes so absolute paths are never stored (§7.6). */
export function relativizePath(p: string | null | undefined): string | null {
  if (!p) return null;
  let s = p.replace(/\\/g, "/");
  s = s.replace(/^\/(?:Users|home)\/[^/]+\/?/, "~/");
  s = s.replace(/^[A-Za-z]:\/Users\/[^/]+\/?/, "~/");
  return s;
}

/**
 * Split a body into parts of at most `maxBytes` UTF-8 bytes, preferring
 * paragraph, then line, then sentence boundaries. Parts are never empty.
 */
export function splitParts(body: string, maxBytes = 2048): string[] {
  const enc = new TextEncoder();
  const size = (s: string) => enc.encode(s).length;
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  if (size(text) <= maxBytes) return [text];

  const hardSplit = (s: string): string[] => {
    // Character-level split when a single sentence is still too large.
    const out: string[] = [];
    let cur = "";
    for (const ch of s) {
      if (cur && size(cur + ch) > maxBytes) {
        out.push(cur);
        cur = ch;
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  const units = text.split(/\n{2,}/);
  const expanded: string[] = [];
  for (const u of units) {
    if (size(u) <= maxBytes) expanded.push(u);
    else {
      for (const line of u.split("\n")) {
        if (size(line) <= maxBytes) expanded.push(line);
        else {
          for (const sent of line.split(/(?<=[。！？.!?])\s*/)) {
            if (size(sent) <= maxBytes) expanded.push(sent);
            else expanded.push(...hardSplit(sent));
          }
        }
      }
    }
  }
  const out: string[] = [];
  let cur = "";
  for (const u of expanded) {
    if (!u.trim()) continue;
    const next = cur ? `${cur}\n\n${u}` : u;
    if (size(next) <= maxBytes) cur = next;
    else {
      if (cur) out.push(cur);
      cur = u;
    }
  }
  if (cur) out.push(cur);
  return out;
}
