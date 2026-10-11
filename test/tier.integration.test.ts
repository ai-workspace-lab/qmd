/**
 * tier.integration.test.ts — three-tier memory engine against real PostgreSQL.
 *
 * Covers PLAN acceptance checks for P2 (schema idempotent; 100 items findable
 * via memory_search; facts supersede), P5 (admission/eviction, compaction
 * never without a committed L3 copy, 91-day-old item recalled back into L1)
 * and write-through/forget. Uses a throwaway database, a deterministic stub
 * embedder and a file-scanning fake L1 so it needs no network or models.
 *
 * Skipped unless QMD_PG_URL is set.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PgClient } from "../src/pg/db-pg.js";
import { resolvePgConfig } from "../src/pg/config.js";
import { bootstrapSchema } from "../src/pg/schema-pg.js";
import { MEM_TABLES } from "../src/pg/schema-mem.js";
import { PgMemoryStore, type Embedder } from "../src/pg/memory-store.js";
import { TierEngine } from "../src/tier/engine.js";
import { DEFAULT_POLICY } from "../src/tier/policy.js";
import { listL1Files, itemIdFromL1Path, type L1Index, type L1Hit } from "../src/tier/l1.js";
import { makeRedactor, sha256Hex } from "../src/tier/l3.js";
import { proposeFact, listFacts, activateEligibleFacts } from "../src/tier/facts.js";

const PG_URL = process.env.QMD_PG_URL ?? process.env.DATABASE_URL;
const DB = `qmd_tier_test_${Date.now()}`;
const DIM = 32;
const sslEnv = process.env.QMD_PG_SSL ? { QMD_PG_SSL: process.env.QMD_PG_SSL } : {};

const stub: Embedder = {
  async embedBatch(texts) {
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % DIM] += 1;
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return { embedding: v.map((x) => x / n), model: "stub" };
    });
  },
};

/** L1 fake: scans the hot dir, scores by matched query terms. */
class FakeL1 implements L1Index {
  syncs = 0;
  constructor(private dir: string) {}
  async search(query: string, limit: number): Promise<L1Hit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: L1Hit[] = [];
    for (const p of listL1Files(this.dir)) {
      const text = readFileSync(p, "utf8").toLowerCase();
      const m = terms.filter((t) => text.includes(t)).length;
      if (m) hits.push({ file: p, itemId: itemIdFromL1Path(p)!, score: m / terms.length, snippet: text.slice(0, 100) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async sync() {
    this.syncs++;
    return { indexed: 0, embedded: 0 };
  }
  async close() {}
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

describe.skipIf(!PG_URL)("TierEngine (integration)", () => {
  let admin: PgClient | undefined;
  let client: PgClient | undefined;
  let engine: TierEngine | undefined;
  let created = false;
  let home = "";
  let clock = new Date("2026-10-11T04:00:00Z");
  const url = () => withDatabase(PG_URL!, DB);

  beforeAll(async () => {
    admin = await PgClient.create(resolvePgConfig({ QMD_PG_URL: PG_URL!, ...sslEnv }));
    try {
      await admin.exec(`CREATE DATABASE ${DB}`);
      created = true;
    } catch {
      return;
    }
    client = await PgClient.create(resolvePgConfig({ QMD_PG_URL: url(), QMD_NAMESPACE: "t", ...sslEnv }));
    await bootstrapSchema(client);
    home = mkdtempSync(join(tmpdir(), "qmd-tier-"));
    engine = new TierEngine({
      client,
      embedder: stub,
      l1: new FakeL1(join(home, "l1")),
      redactor: makeRedactor(),
      now: () => clock,
      config: {
        namespace: "t",
        home,
        l1Dir: join(home, "l1"),
        l3CacheDir: join(home, "l3-cache"),
        quarantineDir: join(home, "quarantine"),
        workspaceRoot: home,
        archiveStateDir: join(home, "archive-state"),
        embedModel: "stub",
        policy: { ...DEFAULT_POLICY },
        partBytes: 2048,
      },
    });
    await engine.bootstrap();
  });

  afterAll(async () => {
    await engine?.close().catch(() => {});
    if (created) await admin?.exec(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await admin?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("schema bootstrap is idempotent and creates every mem_* table", async () => {
    if (!engine) return;
    await engine.bootstrap();
    await engine.bootstrap();
    const rows = await client!.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_name LIKE 'mem\\_%'`,
    );
    const names = rows.map((r) => r.t);
    for (const t of MEM_TABLES) expect(names).toContain(t);
  });

  test("100 items: bulk write, resumable embed, findable via memory_search", async () => {
    if (!engine) return;
    for (let i = 0; i < 100; i++) {
      await engine.upsertItem({
        kind: "note", source: "bulk", sourceRef: `n${i}`, title: `note ${i}`,
        occurredAt: new Date(clock.getTime() - 60 * 86400000),
        body: `Bulk note number ${i}. ${i === 42 ? "The answer involves zebra crossings." : "Nothing special."}`,
        embed: false, materialize: false,
      });
    }
    expect(await engine.pendingEmbeddings()).toBeGreaterThan(0);
    const r1 = await engine.embedPending({ batch: 16, max: 32 });
    expect(r1.embedded).toBeGreaterThanOrEqual(32);
    await engine.embedPending({ batch: 16 }); // resume
    expect(await engine.pendingEmbeddings()).toBe(0);

    const store = await PgMemoryStore.open(resolvePgConfig({ QMD_PG_URL: url(), QMD_NAMESPACE: "t", ...sslEnv }), stub);
    try {
      const res = await store.searchMemory("zebra crossings", { limit: 3 });
      expect(res[0]?.key).toMatch(/^mem\/[0-9a-f-]{36}\/(0|summary)$/);
      expect(res[0]?.body).toContain("zebra");
    } finally {
      await store.close();
    }
    const s = await engine.search("zebra crossings", { noPromote: true });
    expect(s.hits[0]?.title).toBe("note 42");
  });

  test("re-upsert of identical content is a no-op; changed content rewrites parts", async () => {
    if (!engine) return;
    const base = { kind: "note" as const, source: "idem", sourceRef: "x", title: "X", occurredAt: clock };
    const a = await engine.upsertItem({ ...base, body: "first version" });
    const b = await engine.upsertItem({ ...base, body: "first version" });
    expect(b.unchanged).toBe(true);
    expect(b.id).toBe(a.id);
    const c = await engine.upsertItem({ ...base, body: "second version, longer" });
    expect(c.unchanged).toBe(false);
    expect(await engine.itemBody(a.id)).toBe("second version, longer");
    const outbox = await engine.outbox("all", 100000);
    expect(outbox.filter((o: any) => o.item_id === a.id).length).toBe(2); // v1 + v2 originals kept
  });

  test("secrets: parts dropped from L2, remember() refuses, L3 quarantined", async () => {
    if (!engine) return;
    const secret = "ghp_" + "A".repeat(36);
    const r = await engine.upsertItem({
      kind: "note", source: "sec", sourceRef: "s1", title: "S", occurredAt: clock,
      body: `clean paragraph\n\n${"y".repeat(2100)}\n\ntoken ${secret}`,
    });
    expect(r.l3).toBe("quarantined");
    expect(r.droppedParts).toBe(1);
    expect(await engine.itemBody(r.id)).not.toContain(secret);
    expect(readdirSync(join(home, "quarantine")).length).toBeGreaterThan(0);
    await expect(engine.remember({ title: "t", body: `here ${secret}` })).rejects.toThrow(/secret/);
  });

  test("write-through: remember → L3 staged + L2 + L1, search finds it in L1", async () => {
    if (!engine) return;
    const r = await engine.remember({ title: "Deploy note", body: "We deploy the memory MCP on port 8181 with bun.", agent: "test" });
    expect(r.l3).toBe("staged");
    expect(r.l1).toBe("recent");
    const loc = await client!.query<{ tier: string; state: string }>(`SELECT tier, state FROM mem_location WHERE item_id = $1 ORDER BY tier`, [r.id]);
    expect(loc.map((l) => `${l.tier}:${l.state}`)).toEqual(["L1:committed", "L2:committed", "L3:pending", "L3_cache:committed"]);
    const s = await engine.search("deploy memory", { limit: 5 });
    const hit = s.hits.find((h) => h.itemId === r.id);
    expect(hit?.tier).toBe("L1");
  });

  test("search promotes an L2-only hit into L1", async () => {
    if (!engine) return;
    const old = await engine.upsertItem({
      kind: "note", source: "promo", sourceRef: "p1", title: "Old pelican", occurredAt: new Date(clock.getTime() - 45 * 86400000),
      body: "Pelican migration notes from long ago.",
    });
    expect(old.l1).toBeNull();
    const s = await engine.search("pelican migration");
    expect(s.promoted).toContain(old.id);
    const l1 = await client!.queryOne<{ state: string; reason: string }>(`SELECT state, reason FROM mem_location WHERE item_id = $1 AND tier = 'L1'`, [old.id]);
    expect(l1).toEqual({ state: "committed", reason: "promoted" });
  });

  test("facts: auto-activate with 2 evidence, newer fact supersedes older", async () => {
    if (!engine) return;
    const ev = (await client!.query<{ id: string }>(`SELECT id FROM mem_item LIMIT 3`)).map((r) => r.id);
    const f1 = await proposeFact(client!, { subject: { type: "product", name: "XWorkmate" }, predicate: "released", objectText: "v1", statement: "XWorkmate v1 released", confidence: 0.9, evidence: [ev[0]!] });
    expect(f1.status).toBe("proposed");
    const f1b = await proposeFact(client!, { subject: { type: "product", name: "XWorkmate" }, predicate: "released", objectText: "v1", statement: "XWorkmate v1 released", confidence: 0.9, evidence: [ev[1]!] });
    expect(f1b).toMatchObject({ id: f1.id, status: "active" });
    const f2 = await proposeFact(client!, { subject: { type: "product", name: "XWorkmate" }, predicate: "released", objectText: "v2", statement: "XWorkmate v2 released", status: "active", confidence: 1, evidence: [ev[2]!] });
    expect(f2.superseded).toEqual([f1.id]);
    const active = await listFacts(client!, { entity: "xworkmate" });
    expect(active.map((f) => f.statement)).toEqual(["XWorkmate v2 released"]);
    const old = await listFacts(client!, { entity: "XWorkmate", status: "retired" });
    expect(old[0]?.superseded_by).toBe(f2.id);
    expect(await activateEligibleFacts(client!)).toBe(0);
  });

  test("compaction never happens without a committed L3 copy; 91-day item recalls back into L1", async () => {
    if (!engine) return;
    const r = await engine.upsertItem({
      kind: "note", source: "cold", sourceRef: "c1", title: "Cold walrus", occurredAt: new Date(clock.getTime() - 91 * 86400000),
      body: "Walrus archive body that will be compacted.\n\nSecond paragraph about walruses.",
    });
    const t1 = await engine.runTiering();
    expect(t1.compacted).not.toContain(r.id); // L3 still pending
    await expect(engine.compact(r.id)).rejects.toThrow(/no committed L3/);

    // Simulate the .archive run committing l3-cache (manifest keyed relative to the workspace root).
    const outbox = (await engine.outbox("pending", 1000)) as Array<{ local_path: string; sha256: string; bytes: number }>;
    const files: Record<string, unknown> = {};
    for (const o of outbox) files[o.local_path.slice(home.length + 1)] = { sha256: o.sha256, size: o.bytes };
    mkdirSync(join(home, "archive-state"), { recursive: true });
    writeFileSync(join(home, "archive-state", "manifest.json"), JSON.stringify({ run_id: "incr-test", archive_base: "grokbot-test", files }));
    const c = await engine.commitFromArchive();
    expect(c.committed).toBe(outbox.length);

    const t2 = await engine.runTiering();
    expect(t2.compacted).toContain(r.id);
    expect(t2.invariantViolations).toEqual([]);
    const item = await engine.getItem(r.id);
    expect(item?.tier_state).toBe("l2_summary_only");
    expect(await engine.itemBody(r.id)).toBeNull();

    const rec = await engine.recall(r.id);
    expect(rec.tier).toBe("L3_cache");
    expect(rec.body).toContain("Second paragraph about walruses");
    expect((await engine.getItem(r.id))?.tier_state).toBe("l2_full");
    const l1 = await client!.queryOne<{ state: string }>(`SELECT state FROM mem_location WHERE item_id = $1 AND tier = 'L1'`, [r.id]);
    expect(l1?.state).toBe("committed");
  });

  test("summary-only item without local cache queues a fetch", async () => {
    if (!engine) return;
    const r = await engine.upsertItem({
      kind: "note", source: "cold", sourceRef: "c2", title: "Cold yak", occurredAt: new Date(clock.getTime() - 120 * 86400000),
      body: "Yak body.",
    });
    const loc = await client!.queryOne<{ locator: string; sha256: string }>(`SELECT locator, sha256 FROM mem_location WHERE item_id = $1 AND tier = 'L3_cache'`, [r.id]);
    const m = JSON.parse(readFileSync(join(home, "archive-state", "manifest.json"), "utf8"));
    m.files[loc!.locator.slice(home.length + 1)] = { sha256: loc!.sha256, size: 1 };
    writeFileSync(join(home, "archive-state", "manifest.json"), JSON.stringify(m));
    await engine.commitFromArchive();
    await engine.compact(r.id);
    rmSync(loc!.locator); // aged out of l3-cache
    const rec = await engine.recall(r.id);
    expect(rec.pendingFetch).toBe(true);
    expect(rec.summary).toContain("Yak");
    const q = await engine.fetchQueue();
    expect(q.map((x: any) => x.item_id)).toContain(r.id);
  });

  test("time travel: idle L1 items are evicted after 30 days, pinned stay", async () => {
    if (!engine) return;
    const a = await engine.upsertItem({ kind: "note", source: "tt", sourceRef: "a", title: "A", occurredAt: clock, body: "alpha item" });
    const b = await engine.upsertItem({ kind: "note", source: "tt", sourceRef: "b", title: "B", occurredAt: clock, body: "beta item" });
    await engine.setPinned(b.id, true);
    const saved = clock;
    clock = new Date(saved.getTime() + 45 * 86400000);
    try {
      const t = await engine.runTiering();
      expect(t.evicted).toContain(a.id);
      expect(t.evicted).not.toContain(b.id);
      const ids = listL1Files(join(home, "l1")).map((p) => itemIdFromL1Path(p));
      expect(ids).not.toContain(a.id);
      expect(ids).toContain(b.id);
    } finally {
      clock = saved;
    }
  });

  test("forget: tombstone, hidden from search, L3 tombstone appended, re-ingest is a no-op", async () => {
    if (!engine) return;
    const r = await engine.upsertItem({ kind: "note", source: "fg", sourceRef: "f", title: "Forget me", occurredAt: clock, body: "quokka secret-free text" });
    expect(await engine.forget(r.id, "test")).toBe(true);
    const s = await engine.search("quokka", { noPromote: true });
    expect(s.hits.map((h) => h.itemId)).not.toContain(r.id);
    expect((await engine.getItem(r.id))?.tier_state).toBe("tombstoned");
    const t = readFileSync(join(home, "l3-cache", "tombstones", "tombstones.jsonl"), "utf8");
    expect(t).toContain(r.id);
    const again = await engine.upsertItem({ kind: "note", source: "fg", sourceRef: "f", title: "Forget me", occurredAt: clock, body: "quokka secret-free text" });
    expect(again.unchanged).toBe(true);
    expect(await engine.itemBody(r.id)).toBeNull();
  });

  test("summaries, timeline, context and status", async () => {
    if (!engine) return;
    const day = await engine.generatePeriodSummary("day", clock);
    expect(day?.items).toBeGreaterThan(0);
    const again = await engine.generatePeriodSummary("day", clock);
    expect(again?.id).toBe(day?.id);
    const tl = await engine.timeline({ from: new Date(clock.getTime() - 86400000), to: new Date(clock.getTime() + 86400000) });
    expect(tl.items.length).toBeGreaterThan(0);
    const ctx = await engine.context("deploy memory", { budgetTokens: 500 });
    expect(ctx.text.length).toBeLessThanOrEqual(1600);
    expect(ctx.text).toContain("Facts");
    const st = await engine.status();
    expect(st.l2.pendingEmbeddings).toBe(0);
    expect(st.invariantViolations).toBe(0);
    const dry = await engine.nightly({ dryRun: true });
    expect(dry).toHaveProperty("tiering");
    const real = await engine.nightly();
    expect((real.status as any).items).toBeDefined();
    const jobs = await client!.query(`SELECT job, ok FROM mem_job_run`);
    expect(jobs).toContainEqual({ job: "nightly", ok: true });
  });
});
