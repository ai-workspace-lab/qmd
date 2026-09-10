/**
 * pg-task.integration.test.ts - Claim protocol against a live PostgreSQL.
 *
 * Skipped unless QMD_PG_URL is set. The mutual-exclusion guarantee is enforced
 * by a partial unique index inside PostgreSQL, so it can only be verified
 * against a real server — an in-memory fake would be testing the fake.
 *
 *   docker compose -f test/pg-compose.yml up -d
 *   QMD_PG_URL='postgres://postgres:postgres@localhost:5432/postgres' \
 *     npx vitest run test/pg-task.integration.test.ts
 *   docker compose -f test/pg-compose.yml down -v
 *
 * Unlike the memory bridge this needs no pgvector and no embedder — plain
 * PostgreSQL is enough.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PgTaskStore } from "../src/pg/task-store.js";
import { resolvePgConfig } from "../src/pg/config.js";

const PG_URL = process.env.QMD_PG_URL ?? process.env.DATABASE_URL;

/** Unique per run so repeated runs never collide on the partial unique index. */
const SCOPE = `test/task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!PG_URL)("PgTaskStore claim protocol (integration)", () => {
  let store: PgTaskStore;

  beforeAll(async () => {
    const config = resolvePgConfig({ ...process.env, QMD_BACKEND: "pg" });
    store = await PgTaskStore.open(config, SCOPE);
  });

  afterAll(async () => {
    if (store) await store.close();
  });

  test("claims a free resource", async () => {
    const res = await store.claim({
      scope: SCOPE,
      resource: "src/a.ts",
      agentId: "agent-1",
      agentKind: "claude",
      intent: "refactor",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reclaimed).toBe(false);
      expect(res.claim.resource).toBe("src/a.ts");
      expect(res.claim.status).toBe("active");
    }
  });

  test("a second agent is blocked and told who holds it", async () => {
    const res = await store.claim({
      scope: SCOPE,
      resource: "src/a.ts",
      agentId: "agent-2",
      agentKind: "codex",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.holder.agentId).toBe("agent-1");
      expect(res.holder.intent).toBe("refactor");
    }
  });

  test("the same agent re-claiming refreshes instead of colliding", async () => {
    const res = await store.claim({
      scope: SCOPE,
      resource: "src/a.ts",
      agentId: "agent-1",
      intent: "refactor harder",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reclaimed).toBe(true);
      expect(res.claim.intent).toBe("refactor harder");
    }
  });

  // ── The P1 acceptance criterion ──────────────────────────────────────────
  test("under concurrency exactly one of N agents wins", async () => {
    const resource = "src/contended.ts";
    const agents = Array.from({ length: 8 }, (_, i) => `racer-${i}`);

    const results = await Promise.all(
      agents.map((agentId) =>
        store.claim({ scope: SCOPE, resource, agentId, intent: `work by ${agentId}` }),
      ),
    );

    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    // Every loser must be told the same, real winner — never a phantom.
    const winnerId = winners[0]!.ok ? winners[0]!.claim.agentId : "";
    for (const r of results) {
      if (!r.ok) expect(r.holder.agentId).toBe(winnerId);
    }

    const holders = await store.who(SCOPE, resource);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.agentId).toBe(winnerId);
  });

  test("a lapsed TTL frees the resource for someone else", async () => {
    const resource = "src/expiring.ts";
    const first = await store.claim({
      scope: SCOPE,
      resource,
      agentId: "sleepy",
      ttlSeconds: 1,
    });
    expect(first.ok).toBe(true);

    // who() must stop reporting it as live once the heartbeat falls outside TTL.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store.who(SCOPE, resource)).toHaveLength(0);

    const second = await store.claim({ scope: SCOPE, resource, agentId: "awake" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.claim.agentId).toBe("awake");
  });

  test("force takes over a live claim", async () => {
    const resource = "src/stolen.ts";
    await store.claim({ scope: SCOPE, resource, agentId: "holder" });

    const blocked = await store.claim({ scope: SCOPE, resource, agentId: "thief" });
    expect(blocked.ok).toBe(false);

    const forced = await store.claim({ scope: SCOPE, resource, agentId: "thief", force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.stolen).toBe(true);

    const holders = await store.who(SCOPE, resource);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.agentId).toBe("thief");
  });

  test("only the owner may release, unless forced", async () => {
    const resource = "src/owned.ts";
    await store.claim({ scope: SCOPE, resource, agentId: "owner" });

    expect(await store.release(SCOPE, resource, { agentId: "stranger" })).toBeNull();
    expect(await store.who(SCOPE, resource)).toHaveLength(1);

    const released = await store.release(SCOPE, resource, {
      agentId: "owner",
      status: "done",
      note: "finished",
    });
    expect(released?.status).toBe("done");
    expect(released?.note).toBe("finished");
    expect(await store.who(SCOPE, resource)).toHaveLength(0);
  });

  test("a glob claim covers the files under it", async () => {
    await store.claim({
      scope: SCOPE,
      resource: ".github/workflows/*",
      agentId: "area-owner",
      intent: "CI overhaul",
    });

    const holders = await store.who(SCOPE, ".github/workflows/deploy.yml");
    expect(holders.map((h) => h.agentId)).toContain("area-owner");

    // A path outside the glob must stay free.
    expect(await store.who(SCOPE, "src/unrelated.ts")).toHaveLength(0);
  });

  test("heartbeat extends only your own live claim", async () => {
    const resource = "src/beating.ts";
    await store.claim({ scope: SCOPE, resource, agentId: "beater", ttlSeconds: 60 });
    expect(await store.heartbeat(SCOPE, resource, "beater")).toBe(true);
    expect(await store.heartbeat(SCOPE, resource, "impostor")).toBe(false);
  });

  test("list and history separate live work from finished work", async () => {
    const live = await store.list(SCOPE);
    expect(live.every((c) => c.status === "active")).toBe(true);
    expect(live.length).toBeGreaterThan(0);

    const past = await store.history(SCOPE);
    expect(past.every((c) => c.status !== "active")).toBe(true);
    expect(past.some((c) => c.resource === "src/owned.ts")).toBe(true);
  });

  test("claims are isolated per scope", async () => {
    const other = `${SCOPE}-other`;
    const res = await store.claim({ scope: other, resource: "src/a.ts", agentId: "elsewhere" });
    // src/a.ts is held by agent-1 in SCOPE but free in a different project.
    expect(res.ok).toBe(true);
    await store.release(other, "src/a.ts", { agentId: "elsewhere" });
  });

  test("health reports the live claim count for the scope", async () => {
    const health = await store.health(SCOPE);
    expect(health.scope).toBe(SCOPE);
    expect(health.active).toBeGreaterThan(0);
    expect(health.server).toContain("PostgreSQL");
  });
});
