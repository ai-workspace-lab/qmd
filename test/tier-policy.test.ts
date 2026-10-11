/**
 * tier-policy.test.ts — pure tiering rules (PLAN §6), no I/O.
 */
import { describe, test, expect } from "vitest";
import {
  DEFAULT_POLICY,
  heatScore,
  l1AdmissionReason,
  shouldEvictL1,
  capacityEvictions,
  canCompact,
  factShouldAutoActivate,
  rrf,
  relativizePath,
  splitParts,
  type TierItemState,
} from "../src/tier/policy.js";
import { itemIdFromL1Path, renderL1Files, L1_MAX_FILE_BYTES } from "../src/tier/l1.js";
import { lexicalTerms } from "../src/tier/engine.js";
import { ExtractiveSummarizer, stripFrontmatter } from "../src/tier/summarize.js";
import { l3TargetPath, makeRedactor } from "../src/tier/l3.js";

const NOW = new Date("2026-10-11T04:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);
const item = (o: Partial<TierItemState> = {}): TierItemState => ({
  occurredAt: daysAgo(1),
  pinned: false,
  score: 0,
  lastHitAt: null,
  promotedAt: null,
  tierState: "l2_full",
  ...o,
});

describe("heat", () => {
  test("formula 1.0·h7 + 0.3·h30 + 0.05·ln(1+total)", () => {
    expect(heatScore({ hits7d: 0, hits30d: 0, hitsTotal: 0 })).toBe(0);
    expect(heatScore({ hits7d: 2, hits30d: 5, hitsTotal: 9 })).toBeCloseTo(2 + 1.5 + 0.05 * Math.log(10), 6);
  });
});

describe("L1 admission / eviction (§6.2)", () => {
  test("recent, hot, promoted and pinned are admitted; tombstoned never", () => {
    expect(l1AdmissionReason(item({ occurredAt: daysAgo(3) }), NOW)).toBe("recent");
    expect(l1AdmissionReason(item({ occurredAt: daysAgo(60), score: 3 }), NOW)).toBe("hot");
    expect(l1AdmissionReason(item({ occurredAt: daysAgo(60), promotedAt: daysAgo(5) }), NOW)).toBe("promoted");
    expect(l1AdmissionReason(item({ occurredAt: daysAgo(400), pinned: true }), NOW)).toBe("pinned");
    expect(l1AdmissionReason(item({ occurredAt: daysAgo(60) }), NOW)).toBeNull();
    expect(l1AdmissionReason(item({ tierState: "tombstoned", pinned: true }), NOW)).toBeNull();
  });

  test("eviction needs old + idle + unprotected + unpinned", () => {
    expect(shouldEvictL1(item({ occurredAt: daysAgo(31) }), NOW)).toBe(true);
    expect(shouldEvictL1(item({ occurredAt: daysAgo(10) }), NOW)).toBe(false);
    expect(shouldEvictL1(item({ occurredAt: daysAgo(31), lastHitAt: daysAgo(5) }), NOW)).toBe(false);
    expect(shouldEvictL1(item({ occurredAt: daysAgo(31), promotedAt: daysAgo(13) }), NOW)).toBe(false);
    expect(shouldEvictL1(item({ occurredAt: daysAgo(31), promotedAt: daysAgo(15) }), NOW)).toBe(true);
    expect(shouldEvictL1(item({ occurredAt: daysAgo(300), pinned: true }), NOW)).toBe(false);
    expect(shouldEvictL1(item({ tierState: "tombstoned" }), NOW)).toBe(true);
  });

  test("time travel: an item ages out of L1 after 30 idle days", () => {
    const it = item({ occurredAt: NOW });
    const at = (d: number) => new Date(NOW.getTime() + d * 86400000);
    expect(shouldEvictL1(it, at(29))).toBe(false);
    expect(shouldEvictL1(it, at(31))).toBe(true);
    expect(shouldEvictL1({ ...it, lastHitAt: at(20) }, at(31))).toBe(false);
    expect(shouldEvictL1({ ...it, lastHitAt: at(20) }, at(51))).toBe(true);
  });

  test("capacity eviction drops coldest unpinned files down to 90%", () => {
    const p = { ...DEFAULT_POLICY, l1MaxFiles: 10 };
    const files = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, bytes: 10, score: i, pinned: i === 0 }));
    const out = capacityEvictions(files, NOW, p);
    expect(out).toEqual(["i1", "i2", "i3"]); // 12 → 9 (= floor(10*0.9)); i0 pinned is skipped
    expect(capacityEvictions(files.slice(0, 10), NOW, p)).toEqual([]);
  });
});

describe("L2 compaction (§6.3)", () => {
  const base = {
    occurredAt: daysAgo(100),
    pinned: false,
    tierState: "l2_full" as const,
    recentHits: 0,
    l3Committed: true,
    l3ShaMatches: true,
  };
  test("requires age, idleness and a verified L3 copy", () => {
    expect(canCompact(base, NOW)).toBe(true);
    expect(canCompact({ ...base, l3Committed: false }, NOW)).toBe(false);
    expect(canCompact({ ...base, l3ShaMatches: false }, NOW)).toBe(false);
    expect(canCompact({ ...base, occurredAt: daysAgo(80) }, NOW)).toBe(false);
    expect(canCompact({ ...base, recentHits: 1 }, NOW)).toBe(false);
    expect(canCompact({ ...base, pinned: true }, NOW)).toBe(false);
    expect(canCompact({ ...base, tierState: "l2_summary_only" }, NOW)).toBe(false);
  });
});

describe("helpers", () => {
  test("fact auto-activation", () => {
    expect(factShouldAutoActivate(0.8, 2)).toBe(true);
    expect(factShouldAutoActivate(0.79, 5)).toBe(false);
    expect(factShouldAutoActivate(0.95, 1)).toBe(false);
  });

  test("rrf favours items ranked in several lists", () => {
    const s = rrf([["a", "b"], ["b", "c"]]);
    expect([...s.entries()].sort((x, y) => y[1] - x[1])[0]![0]).toBe("b");
  });

  test("relativizePath strips user home prefixes", () => {
    expect(relativizePath("/Users/shenlan/Documents/x")).toBe("~/Documents/x");
    expect(relativizePath("/home/box/proj")).toBe("~/proj");
    expect(relativizePath("repo/src")).toBe("repo/src");
    expect(relativizePath(null)).toBeNull();
  });

  test("splitParts keeps every part ≤ maxBytes and loses no text", () => {
    const para = "这是一个比较长的中文段落，用来测试分块。".repeat(40);
    const body = [para, "short line", "x".repeat(5000), para].join("\n\n");
    const parts = splitParts(body, 2048);
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(2048);
    expect(parts.join("").replace(/\s+/g, "")).toBe(body.replace(/\s+/g, ""));
    expect(splitParts("tiny")).toEqual(["tiny"]);
    expect(splitParts("   ")).toEqual([]);
  });

  test("lexicalTerms makes CJK bigrams and latin words", () => {
    expect(lexicalTerms("数据库备份 pg_dump")).toEqual(["数据", "据库", "库备", "备份", "pg_dump"]);
  });

  test("L1 files: id round-trip and 64 KiB split", () => {
    const id = "0b5c3f0e-1111-4222-8333-944445555666";
    expect(itemIdFromL1Path(`qmd://hot/2026/10/${id}.md`)).toBe(id);
    expect(itemIdFromL1Path(`/x/${id}-p2.md`)).toBe(id);
    expect(itemIdFromL1Path("/x/readme.md")).toBeNull();
    const files = renderL1Files({
      id, kind: "note", source: "t", scope: null, title: "T", occurredAt: NOW, sha256: "s", reason: "recent",
      summary: "sum", body: ("段落内容 ".repeat(800) + "\n\n").repeat(12),
    });
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) expect(Buffer.byteLength(f.content)).toBeLessThanOrEqual(L1_MAX_FILE_BYTES);
    expect(files[0]!.content).toContain(`item_id: ${id}`);
    expect(files[1]!.name).toBe(`${id}-p2.md`);
  });

  test("extractive summary is deterministic and capped", async () => {
    const s = new ExtractiveSummarizer();
    const body = "---\nsource: x\n---\n\n# Title\n\n- 来源: codex\n\nFirst line.\n\nSecond line.";
    const a = await s.summarize({ title: "Title", body, kind: "session" });
    expect(a).toBe("Title：First line. Second line.");
    expect(await s.summarize({ title: "Title", body, kind: "session" })).toBe(a);
    expect((await s.summarize({ title: null, body: "x ".repeat(5000), kind: "note" })).length).toBeLessThanOrEqual(1200);
    expect(stripFrontmatter("---\na: 1\n---\nbody")).toBe("body");
  });

  test("L3 target path is bucketed by Asia/Shanghai month", () => {
    expect(l3TargetPath("session", "codex", new Date("2026-09-30T17:00:00Z"), "abc.md")).toBe("raw/2026/10/session/codex/abc.md");
  });

  test("fallback redactor flags secrets as residual (forces quarantine)", () => {
    const r = makeRedactor();
    expect(r("hello").residual).toEqual([]);
    expect(r("key ghp_" + "a".repeat(36)).residual).toEqual(["github-token"]);
  });
});
