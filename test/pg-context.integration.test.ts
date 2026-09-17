/**
 * pg-context.integration.test.ts - Shared task context against a live PostgreSQL.
 *
 * Skipped unless QMD_PG_URL is set:
 *
 *   QMD_PG_URL='postgres://qmd:…@127.0.0.1:15432/qmd' QMD_PG_SSL=disable \
 *     npx vitest run test/pg-context.integration.test.ts
 *
 * Every run uses a unique scope, so repeated runs never collide.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgContextStore } from "../src/pg/context-store.js";
import { resolvePgConfig } from "../src/pg/config.js";
import { handleAgentIngest, INGEST_PATH } from "../src/mcp/agent-ingest.js";

const PG_URL = process.env.QMD_PG_URL ?? process.env.DATABASE_URL;
const SCOPE = `test/ctx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!PG_URL)("PgContextStore (integration)", () => {
  let store: PgContextStore;

  beforeAll(async () => {
    store = await PgContextStore.open(resolvePgConfig({ ...process.env, QMD_BACKEND: "pg" }));
  });

  afterAll(async () => {
    if (store) await store.close();
  });

  test("N agents starting on one branch at once land on a single thread", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.resolveThread({ scope: SCOPE, headBranch: "feat/race" })),
    );
    const ids = new Set(results.map((r) => (r.ok ? r.thread.id : "fail")));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
  });

  test("default branches need an explicit thread", async () => {
    expect(await store.resolveThread({ scope: SCOPE, headBranch: "main" })).toEqual({
      ok: false,
      reason: "requires_explicit_thread",
    });
  });

  test("sessions from different clients merge into one view with attribution", async () => {
    const r = await store.resolveThread({ scope: SCOPE, headBranch: "feat/merge", headSha: "a".repeat(40) });
    if (!r.ok) throw new Error("resolve failed");
    const claude = await store.attachSession(r.thread.id, { source: "claude-code", sourceSessionId: "c1" });
    const codex = await store.attachSession(r.thread.id, { source: "codex", sourceSessionId: "x1" });

    await store.mergeItems(r.thread.id, claude, [
      { kind: "pitfall", text: "bridge repo is checked out on a docs branch" },
      { kind: "path", text: "src/pg/context-store.ts", detail: "modified" },
      { kind: "verification", text: "npx vitest run", status: "fail", gitHead: "a".repeat(40), at: "2026-09-17T10:00:00Z" },
    ]);
    const second = await store.mergeItems(r.thread.id, codex, [
      { kind: "pitfall", text: "Bridge repo is checked out on a  docs branch" },
      { kind: "path", text: "src/pg/context-store.ts", detail: "modified" },
      { kind: "path", text: "/Users/someone/abs.ts" },
      { kind: "verification", text: "npx vitest run", status: "pass", gitHead: "a".repeat(40), at: "2026-09-17T11:00:00Z" },
      { kind: "decision", text: `export ${["QMD", "INGEST", "TOKEN"].join("_")}=${["0123456789", "abcdef0123"].join("")}` },
    ]);
    expect(second).toMatchObject({ inserted: 0, touched: 2, updated: 1 });
    expect(second.rejected.map((x) => x.reason)).toEqual([
      "path must be repo-relative",
      expect.stringContaining("secret"),
    ]);

    const b = (await store.briefing(r.thread.id))!;
    const pitfalls = b.items.filter((i) => i.kind === "pitfall");
    expect(pitfalls).toHaveLength(1);
    expect(pitfalls[0]!.sources.sort()).toEqual(["claude-code", "codex"]);
    expect(b.items.find((i) => i.kind === "verification")).toMatchObject({ status: "pass" });
    expect(b.contributors.map((c) => c.source).sort()).toEqual(["claude-code", "codex"]);
  });

  test("replaying a batch with the same clientRequestId is a no-op", async () => {
    const r = await store.resolveThread({ scope: SCOPE, headBranch: "feat/idempotent" });
    if (!r.ok) throw new Error("resolve failed");
    const s = await store.attachSession(r.thread.id, { source: "codex", sourceSessionId: "x2" });
    const items = [{ kind: "pitfall" as const, text: "one" }];
    const first = await store.mergeItems(r.thread.id, s, items, { clientRequestId: `${SCOPE}:batch-1` });
    const again = await store.mergeItems(r.thread.id, s, items, { clientRequestId: `${SCOPE}:batch-1` });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    const events = (await store.briefing(r.thread.id, { events: 50 }))!.events.filter((e) => e.type === "context.merged");
    expect(events).toHaveLength(1);
  });

  test("a stale driver's direction becomes a proposal while its facts still merge", async () => {
    const r = await store.resolveThread({ scope: SCOPE, headBranch: "feat/lease" });
    if (!r.ok) throw new Error("resolve failed");
    const a = await store.attachSession(r.thread.id, { source: "claude-code", sourceSessionId: "lease-a" });
    const b = await store.attachSession(r.thread.id, { source: "codex", sourceSessionId: "lease-b" });

    const leadA = await store.lead(r.thread.id, a);
    if (!leadA.ok) throw new Error("lead failed");
    await store.mergeItems(r.thread.id, a, [{ kind: "next_action", text: "write the resolver" }], { fence: leadA.fence });

    expect((await store.lead(r.thread.id, b)).ok).toBe(false); // A's lease is live
    const handoff = await store.handoff(r.thread.id, a, leadA.fence, "add the bridge route");
    expect(handoff.ok).toBe(true);

    const leadB = await store.lead(r.thread.id, b, { takeover: true });
    if (!leadB.ok) throw new Error("takeover failed");
    expect(leadB.fence).toBe(leadA.fence + 1);

    // A comes back with its old fence.
    const late = await store.mergeItems(
      r.thread.id,
      a,
      [{ kind: "next_action", text: "revert everything" }, { kind: "pitfall", text: "handoff raced" }],
      { fence: leadA.fence },
    );
    expect(late).toMatchObject({ inserted: 2, proposed: 1 });

    const view = (await store.briefing(r.thread.id))!;
    const next = view.items.filter((i) => i.kind === "next_action");
    expect(next.find((i) => i.status === "current")!.text).toBe("add the bridge route");
    expect(next.find((i) => i.status === "proposed")!.text).toBe("revert everything");
    expect(view.items.some((i) => i.kind === "pitfall" && i.text === "handoff raced")).toBe(true);
  });

  test("a branch thread folds into the PR thread once both exist", async () => {
    const pr = 4200 + Math.floor(Math.random() * 1000);
    const prThread = await store.resolveThread({ scope: SCOPE, prNumber: pr });
    const branchThread = await store.resolveThread({ scope: SCOPE, headBranch: "feat/pr-fold" });
    if (!prThread.ok || !branchThread.ok) throw new Error("resolve failed");
    const s1 = await store.attachSession(prThread.thread.id, { source: "mcp:web", sourceSessionId: "w1" });
    const s2 = await store.attachSession(branchThread.thread.id, { source: "codex", sourceSessionId: "x3" });
    await store.mergeItems(prThread.thread.id, s1, [{ kind: "question", text: "which token?" }]);
    await store.mergeItems(branchThread.thread.id, s2, [
      { kind: "question", text: "Which token?" },
      { kind: "path", text: "internal/acp/agent_ingest_http.go" },
    ]);

    const folded = await store.resolveThread({ scope: SCOPE, prNumber: pr, headBranch: "feat/pr-fold" });
    if (!folded.ok) throw new Error("resolve failed");
    expect(folded.thread.id).toBe(prThread.thread.id);
    expect(folded.mergedFrom).toEqual([branchThread.thread.id]);
    expect(folded.thread.headBranch).toBe("feat/pr-fold");

    const view = (await store.briefing(prThread.thread.id))!;
    expect(view.items.filter((i) => i.kind === "question")).toHaveLength(1);
    expect(view.items.find((i) => i.kind === "question")!.sources.sort()).toEqual(["codex", "mcp:web"]);
    expect(view.items.some((i) => i.kind === "path")).toBe(true);
    expect((await store.getThread(branchThread.thread.id))!.id).toBe(prThread.thread.id);
  });

  describe("one-way ingest endpoint", () => {
    let server: Server;
    let url: string;
    const token = "test-ingest-token-0123456789";

    beforeAll(async () => {
      const bridge = { store, config: resolvePgConfig({ ...process.env, QMD_BACKEND: "pg" }), dispose: async () => {} };
      server = createServer((req, res) => void handleAgentIngest(req, res, bridge, token));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INGEST_PATH}`;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify(body),
      });

    test("accepts a web contribution and treats its direction as a proposal", async () => {
      const res = await post({
        source: "chatgpt-web",
        sourceSessionId: "conv-1",
        scope: SCOPE,
        headBranch: "feat/web",
        title: "Design the ingest plugin",
        clientRequestId: `${SCOPE}-web-1`,
        items: [
          { kind: "decision", text: "plugins only write; they never read shared context" },
          { kind: "next_action", text: "draft the extension manifest" },
        ],
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.result).toMatchObject({ inserted: 3, proposed: 2 });

      const replay = await post({
        source: "chatgpt-web", sourceSessionId: "conv-1", scope: SCOPE, headBranch: "feat/web",
        clientRequestId: `${SCOPE}-web-1`, items: [],
      });
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as any).result.duplicate).toBe(true);
    });

    test("rejects bad tokens, reads, and default-branch submissions", async () => {
      expect((await post({}, { authorization: "Bearer nope" })).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
      const main = await post({ source: "claude-web", sourceSessionId: "c", scope: SCOPE, headBranch: "main", items: [] });
      expect(main.status).toBe(422);
      const bad = await post({ source: "Bad Source", sourceSessionId: "c", scope: SCOPE, items: [] });
      expect(bad.status).toBe(400);
    });
  });
});
