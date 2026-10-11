/**
 * pg-halfvec.integration.test.ts — >2000-dim embeddings on the PG memory bridge.
 *
 * pgvector's HNSW index caps `vector` at 2000 dims; the default embedder
 * (nvidia/nemotron-3-embed-1b) is 2048-d, so ensureVectorIndex() must switch the
 * column to halfvec(N). Runs in a throwaway database (needs CREATEDB) because
 * the embedding column type is shared by every namespace in a database.
 *
 * Skipped unless QMD_PG_URL is set.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PgMemoryStore, type Embedder } from "../src/pg/memory-store.js";
import { PgClient } from "../src/pg/db-pg.js";
import { resolvePgConfig } from "../src/pg/config.js";
import { vectorTypeForDims, embeddingColumnType, HNSW_VECTOR_MAX_DIMS } from "../src/pg/schema-pg.js";

const PG_URL = process.env.QMD_PG_URL ?? process.env.DATABASE_URL;
const DIM = 2048;
const DB = `qmd_halfvec_test_${Date.now()}`;

/** Deterministic 2048-dim char-histogram embedder, L2-normalized. */
const stub2048: Embedder = {
  async embedBatch(texts) {
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % DIM] += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return { embedding: v.map((x) => x / norm), model: "stub-2048" };
    });
  },
};

const sslEnv = process.env.QMD_PG_SSL ? { QMD_PG_SSL: process.env.QMD_PG_SSL } : {};

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

describe("vectorTypeForDims", () => {
  test("uses vector up to the HNSW limit and halfvec above it", () => {
    expect(HNSW_VECTOR_MAX_DIMS).toBe(2000);
    expect(vectorTypeForDims(1536)).toBe("vector");
    expect(vectorTypeForDims(2000)).toBe("vector");
    expect(vectorTypeForDims(2048)).toBe("halfvec");
  });
});

describe.skipIf(!PG_URL)("PgMemoryStore with 2048-d embeddings (integration)", () => {
  let admin: PgClient | undefined;
  let store: PgMemoryStore | undefined;
  let created = false;

  beforeAll(async () => {
    admin = await PgClient.create(resolvePgConfig({ QMD_PG_URL: PG_URL!, ...sslEnv }));
    try {
      await admin.exec(`CREATE DATABASE ${DB}`);
      created = true;
    } catch {
      return; // no CREATEDB privilege: tests below no-op
    }
    const config = resolvePgConfig({ QMD_PG_URL: withDatabase(PG_URL!, DB), QMD_NAMESPACE: "halfvec", ...sslEnv });
    store = await PgMemoryStore.open(config, stub2048);
  });

  afterAll(async () => {
    await store?.close();
    if (created) await admin?.exec(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.close();
  });

  test("promotes the column to halfvec(2048), builds HNSW, and searches", async () => {
    if (!store) return;
    await store.addMemory({ key: "a", body: "postgres halfvec hnsw index for long embeddings" });
    await store.addMemory({ key: "b", body: "完全不同的中文内容：公众号 行者深蓝" });

    const client = (store as any).client as PgClient;
    expect(await embeddingColumnType(client)).toBe("halfvec");
    const col = await client.queryOne<{ t: string }>(
      `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
        WHERE attrelid = 'qmd_memory_vectors'::regclass AND attname = 'embedding'`,
    );
    expect(col?.t).toBe("halfvec(2048)");
    const idx = await client.queryOne<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'qmd_memory_vectors_hnsw_idx'`,
    );
    expect(idx?.def).toContain("halfvec_cosine_ops");

    // Re-adding after promotion must still insert (cast follows the column).
    await store.addMemory({ key: "a", body: "postgres halfvec hnsw index for long embeddings, updated" });
    const hits = await store.searchMemory("halfvec hnsw postgres", { limit: 2 });
    expect(hits[0]?.key).toBe("a");
  });
});
