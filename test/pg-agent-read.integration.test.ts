/**
 * pg-agent-read.integration.test.ts - Read routes and the sync change feed
 * against a live PostgreSQL. Skipped unless QMD_PG_URL is set.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgContextStore } from "../src/pg/context-store.js";
import { resolvePgConfig } from "../src/pg/config.js";
import { handleAgentRead, isAgentReadPath } from "../src/mcp/agent-read.js";

const PG_URL = process.env.QMD_PG_URL ?? process.env.DATABASE_URL;
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SCOPE = `test/read-${RUN}`;
const SOURCE = `test-src-${RUN}`;
const TOKEN = "read-token-0123456789abcdef";

describe.skipIf(!PG_URL)("agent read routes (integration)", () => {
  let store: PgContextStore;
  let server: Server;
  let base: string;
  let threadId: string;

  const get = (path: string, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    const config = resolvePgConfig({ ...process.env, QMD_BACKEND: "pg" });
    store = await PgContextStore.open(config);
    const bridge = { store, config, dispose: async () => {} };
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (isAgentReadPath(path)) void handleAgentRead(req, res, bridge, TOKEN);
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const r = await store.resolveThread({ scope: SCOPE, headBranch: "feat/read", headSha: "b".repeat(40) });
    if (!r.ok) throw new Error("resolve failed");
    threadId = r.thread.id;
    const s = await store.attachSession(threadId, { source: "codex", sourceSessionId: `x-${RUN}` });
    await store.mergeItems(threadId, s, [
      { kind: "decision", text: `use xid8 cursors for sync ${RUN}` },
      { kind: "pitfall", text: `bridge caps upstream responses ${RUN}` },
      { kind: "path", text: "src/mcp/agent-read.ts" },
    ]);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const { PgClient } = await import("../src/pg/db-pg.js");
    const admin = await PgClient.create(resolvePgConfig({ ...process.env, QMD_BACKEND: "pg" }));
    try {
      await admin.exec(`DELETE FROM qmd_ctx_thread WHERE scope = $1`, [SCOPE]);
      await admin.exec(`DELETE FROM qmd_pinned_task WHERE source = $1`, [SOURCE]);
      await admin.exec(`DELETE FROM qmd_shared_project WHERE $1 = ANY(sources) OR project_key LIKE $2`, [SOURCE, `${SCOPE}%`]);
    } finally {
      await admin.close();
    }
    await store.close();
  });

  test("auth and method rules", async () => {
    expect((await get("/api/v1/agent/threads", null)).status).toBe(401);
    expect((await get("/api/v1/agent/threads", "wrong")).status).toBe(401);
    expect((await fetch(`${base}/api/v1/agent/threads`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await get("/api/v1/agent/threads?limit=-1")).status).toBe(400);
    expect((await get("/api/v1/agent/sync?cursor=not-a-cursor")).status).toBe(400);
    expect(isAgentReadPath("/api/v1/agent/threads/../catalog")).toBe(false);
  });

  test("threads are paged and filterable by scope", async () => {
    const res = await get(`/api/v1/agent/threads?scope=${encodeURIComponent(SCOPE)}&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({ id: threadId, scope: SCOPE, headBranch: "feat/read", items: 3 });
    expect(body.page).toMatchObject({ limit: 1, offset: 0, total: 1 });
  });

  test("briefing returns merged items with sources", async () => {
    const body = (await (await get(`/api/v1/agent/threads/${threadId}/briefing`)).json()) as any;
    expect(body.briefing.items.map((i: any) => i.kind).sort()).toEqual(["decision", "path", "pitfall"]);
    expect(body.briefing.items[0].sources).toEqual(["codex"]);
    expect((await get("/api/v1/agent/threads/00000000-0000-0000-0000-000000000000/briefing")).status).toBe(404);
  });

  test("memory search finds decisions and pitfalls by text", async () => {
    const body = (await (await get(`/api/v1/agent/memory?q=${encodeURIComponent(`xid8 cursors for sync ${RUN}`)}`)).json()) as any;
    expect(body.hits).toEqual([expect.objectContaining({ type: "context_item", kind: "decision", scope: SCOPE, threadId })]);
    const scoped = (await (await get(`/api/v1/agent/memory?scope=${encodeURIComponent(SCOPE)}&kind=pitfall`)).json()) as any;
    expect(scoped.hits.map((h: any) => h.kind)).toEqual(["pitfall"]);
    const wildcard = (await (await get(`/api/v1/agent/memory?scope=${encodeURIComponent(SCOPE)}&q=%25`)).json()) as any;
    expect(wildcard.hits).toEqual([]); // "%" is matched literally, not as a wildcard
  });

  test("catalog carries locations, tombstones unpinned tasks, and pages", async () => {
    await store.syncSharedProjects(SOURCE, [
      { key: `${SCOPE}/proj`, name: `proj-${RUN}`, kind: "repo", scope: SCOPE, location: ".", source: SOURCE },
    ]);
    await store.syncPinnedTasks(SOURCE, [
      { id: `pin-a-${RUN}`, source: SOURCE, title: "A", scope: SCOPE, location: ".", position: 0, updatedAt: new Date().toISOString() },
      { id: `pin-b-${RUN}`, source: SOURCE, title: "B", scope: null, location: "dir:elsewhere", position: 1, updatedAt: new Date().toISOString() },
    ]);
    const body = (await (await get(`/api/v1/agent/catalog?limit=200`)).json()) as any;
    const mine = body.catalog.pinnedTasks.filter((t: any) => t.source === SOURCE);
    expect(mine.map((t: any) => t.id)).toEqual([`pin-a-${RUN}`, `pin-b-${RUN}`]);
    expect(JSON.stringify(body.catalog)).not.toMatch(/"(cwd|rootPath)"|\/Users\//);
    expect(body.catalog.page.pinnedTotal).toBeGreaterThanOrEqual(2);

    await store.syncPinnedTasks(SOURCE, [
      { id: `pin-a-${RUN}`, source: SOURCE, title: "A", scope: SCOPE, location: ".", position: 0, updatedAt: new Date().toISOString() },
    ]);
    const after = (await (await get(`/api/v1/agent/catalog?limit=200`)).json()) as any;
    expect(after.catalog.pinnedTasks.filter((t: any) => t.source === SOURCE).map((t: any) => t.id)).toEqual([`pin-a-${RUN}`]);
  });

  test("sync pages through every change exactly once and resumes from the cursor", async () => {
    // Drain the feed to its current end.
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const body = (await (await get(`/api/v1/agent/sync?limit=200${cursor ? `&cursor=${cursor}` : ""}`)).json()) as any;
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }

    const s = await store.attachSession(threadId, { source: "claude-code", sourceSessionId: `c-${RUN}` });
    await store.mergeItems(threadId, s, [
      { kind: "question", text: `q1 ${RUN}` },
      { kind: "question", text: `q2 ${RUN}` },
      { kind: "question", text: `q3 ${RUN}` },
    ]);
    await store.syncPinnedTasks(SOURCE, []); // tombstones pin-a

    const seen: any[] = [];
    for (let i = 0; i < 20; i++) {
      const body = (await (await get(`/api/v1/agent/sync?limit=2&cursor=${cursor}`)).json()) as any;
      seen.push(...body.changes);
      expect(body.changes.length).toBeLessThanOrEqual(2);
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    const questions = seen.filter((c) => c.type === "item" && c.item.kind === "question").map((c) => c.item.text);
    expect(questions.sort()).toEqual([`q1 ${RUN}`, `q2 ${RUN}`, `q3 ${RUN}`]);
    expect(seen.some((c) => c.type === "thread" && c.thread.id === threadId)).toBe(true);
    expect(seen.find((c) => c.type === "pinned_task" && c.pinnedTask.id === `pin-a-${RUN}`)?.pinnedTask.removedAt).toBeTruthy();
    const seqs = seen.map((c) => c.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates across pages

    const idle = (await (await get(`/api/v1/agent/sync?cursor=${cursor}`)).json()) as any;
    expect(idle.changes.filter((c: any) => c.type === "item" && String(c.item.text).endsWith(RUN))).toEqual([]);
  });

  test("a write committed after a slow concurrent writer is not skipped", async () => {
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const body = (await (await get(`/api/v1/agent/sync?limit=200${cursor ? `&cursor=${cursor}` : ""}`)).json()) as any;
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    const config = resolvePgConfig({ ...process.env, QMD_BACKEND: "pg" });
    const { PgClient } = await import("../src/pg/db-pg.js");
    const slow = await PgClient.create(config);
    try {
      // Slow writer takes an xid and a sequence first, then commits last.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slowTx = slow.tx(async (tx) => {
        await tx.exec(`UPDATE qmd_ctx_thread SET title = $2 WHERE id = $1`, [threadId, `slow ${RUN}`]);
        await gate;
      });
      const fast = await store.attachSession(threadId, { source: "codex", sourceSessionId: `fast-${RUN}` });
      // The fast writer waits on the thread row lock held by the slow writer, so
      // release it after polling once while the slow transaction is still open.
      const fastWrite = store.mergeItems(threadId, fast, [{ kind: "pitfall", text: `fast ${RUN}` }]);
      const during = (await (await get(`/api/v1/agent/sync?cursor=${cursor}`)).json()) as any;
      cursor = during.nextCursor;
      release();
      await slowTx;
      await fastWrite;

      const seen: any[] = [...during.changes];
      for (let i = 0; i < 20; i++) {
        const body = (await (await get(`/api/v1/agent/sync?limit=200&cursor=${cursor}`)).json()) as any;
        seen.push(...body.changes);
        cursor = body.nextCursor;
        if (!body.hasMore) break;
      }
      expect(seen.some((c) => c.type === "thread" && c.thread.title === `slow ${RUN}`)).toBe(true);
      expect(seen.some((c) => c.type === "item" && c.item.text === `fast ${RUN}`)).toBe(true);
    } finally {
      await slow.close();
    }
  });
});
