/**
 * pg-memory.integration.test.ts - End-to-end tests against a live PostgreSQL.
 *
 * Skipped unless QMD_PG_URL is set. Spin up a PG with pgvector (+ optionally
 * pg_jieba) and run:
 *
 *   QMD_PG_URL='postgres://postgres:postgres@localhost:5432/postgres' \
 *     npx vitest run test/pg-memory.integration.test.ts
 *
 * Uses a deterministic stub embedder so the test needs no network or models —
 * it verifies schema bootstrap, namespaced writes, hybrid (FTS+vector) search,
 * RRF fusion, get/list/delete, and namespace isolation.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PgMemoryStore, type Embedder } from "../src/pg/memory-store.js";
import { resolvePgConfig } from "../src/pg/config.js";

const PG_URL = process.env.QMD_PG_URL ?? process.env.DATABASE_URL;

/** Deterministic 16-dim embedder — char-frequency histogram, L2-normalized. */
const stubEmbedder: Embedder = {
  async embedBatch(texts) {
    return texts.map((t) => {
      const v = new Array(16).fill(0);
      for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % 16] += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return { embedding: v.map((x) => x / norm), model: "stub-16" };
    });
  },
};

const NS = `test_${Date.now()}`;

describe.skipIf(!PG_URL)("PgMemoryStore (integration)", () => {
  let store: PgMemoryStore;

  beforeAll(async () => {
    const config = { ...resolvePgConfig({ QMD_PG_URL: PG_URL!, QMD_NAMESPACE: NS }) };
    store = await PgMemoryStore.open(config, stubEmbedder);
  });

  afterAll(async () => {
    if (store) {
      // Best-effort cleanup of the test namespace.
      try {
        for (const m of await store.listMemories({ limit: 1000 })) {
          await store.deleteMemory(m.key);
        }
      } catch {
        /* ignore */
      }
      await store.close();
    }
  });

  test("bootstraps schema with pgvector", async () => {
    expect(store.capabilities.vector).toBe(true);
  });

  test("adds and retrieves a memory", async () => {
    const res = await store.addMemory({
      key: "note/auth",
      title: "Auth design",
      body: "The login flow uses OAuth tokens and a refresh rotation strategy.",
    });
    expect(res.namespace).toBe(NS);
    expect(res.chunks).toBeGreaterThan(0);
    expect(res.embedded).toBe(true);

    const got = await store.getMemory("note/auth");
    expect(got?.body).toContain("OAuth");
    expect(got?.title).toBe("Auth design");
  });

  test("hybrid search finds a memory by keyword", async () => {
    await store.addMemory({ key: "note/cache", body: "Redis caching layer with TTL eviction." });
    const results = await store.searchMemory("redis caching", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.key === "note/cache")).toBe(true);
    // At least one signal contributed.
    expect(results[0]!.lexRank !== null || results[0]!.vecRank !== null).toBe(true);
  });

  test("re-adding the same key updates it", async () => {
    await store.addMemory({ key: "note/dup", body: "first version" });
    await store.addMemory({ key: "note/dup", body: "second version updated" });
    const got = await store.getMemory("note/dup");
    expect(got?.body).toBe("second version updated");
    const all = await store.listMemories({ limit: 1000 });
    expect(all.filter((m) => m.key === "note/dup").length).toBe(1);
  });

  test("delete soft-removes a memory", async () => {
    await store.addMemory({ key: "note/temp", body: "temporary" });
    expect(await store.deleteMemory("note/temp")).toBe(true);
    expect(await store.getMemory("note/temp")).toBeNull();
  });

  test("namespaces isolate memories", async () => {
    const other = `${NS}_other`;
    await store.addMemory({ key: "shared/key", body: "in default test ns" });
    await store.addMemory({ key: "shared/key", body: "in other ns", namespace: other });

    const a = await store.getMemory("shared/key");
    const b = await store.getMemory("shared/key", { namespace: other });
    expect(a?.body).toBe("in default test ns");
    expect(b?.body).toBe("in other ns");

    // cleanup other ns
    await store.deleteMemory("shared/key", { namespace: other });
  });
});
