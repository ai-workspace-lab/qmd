#!/usr/bin/env node
/**
 * Local smoke test for the shared agent task context stack:
 *   xworkmate-bridge (BRIDGE_URL, default :8787) → QMD HTTP (QMD_URL, default :8181) → PostgreSQL
 *
 * Needs AI_WORKSPACE_AUTH_TOKEN (bridge caller token) and QMD_MCP_TOKEN in the
 * environment. Writes only under a unique `test/e2e-*` scope; delete it after
 * with: DELETE FROM qmd_ctx_thread WHERE scope LIKE 'test/%'.
 */
const B = process.env.BRIDGE_URL ?? "http://127.0.0.1:8787";
const Q = process.env.QMD_URL ?? "http://127.0.0.1:8181";
const auth = { Authorization: `Bearer ${process.env.AI_WORKSPACE_AUTH_TOKEN}` };
const RUN = Date.now();
const SCOPE = `test/e2e-${RUN}`;
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`); };
const get = async (p, h = auth) => { const r = await fetch(B + p, { headers: h }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };

let r = await get("/api/v1/agent/catalog?limit=200");
const cat = r.j?.catalog;
check("catalog via bridge", r.s === 200, `pinned ${cat?.page?.pinnedTotal} · projects ${cat?.page?.projectsTotal}`);
check("catalog has no absolute paths", !/\/Users\/|"cwd"|"rootPath"/.test(JSON.stringify(cat)));
r = await get("/api/v1/agent/catalog?limit=5&offset=10&token=leak");
check("catalog paging", r.j?.catalog?.pinnedTasks?.length <= 5 && r.j?.catalog?.page?.offset === 10);
r = await get("/api/v1/agent/threads?limit=3&state=all");
check("threads paged", r.s === 200 && r.j.threads.length <= 3, `total ${r.j?.page?.total}`);
const anyThread = r.j?.threads?.[0];
if (anyThread) {
  r = await get(`/api/v1/agent/threads/${anyThread.id}/briefing?events=5`);
  check("briefing via bridge", r.s === 200 && Array.isArray(r.j?.briefing?.items), `items ${r.j?.briefing?.items?.length}`);
}
r = await get(`/api/v1/agent/memory?q=${encodeURIComponent("bridge")}&limit=5`);
check("memory search via bridge", r.s === 200 && Array.isArray(r.j?.hits), `hits ${r.j?.hits?.length}`);

let cursor;
for (;;) { r = await get(`/api/v1/agent/sync?limit=200${cursor ? `&cursor=${cursor}` : ""}`); cursor = r.j.nextCursor; if (!r.j.hasMore) break; }
check("sync drained", r.s === 200);
const ing = await fetch(B + "/api/v1/agent/ingest", {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ source: "chatgpt-web", sourceSessionId: `e2e-${RUN}`, scope: SCOPE, headBranch: "feat/e2e", clientRequestId: `e2e-${RUN}-1`,
    items: [{ kind: "decision", text: `e2e decision ${RUN}` }, { kind: "pitfall", text: `e2e pitfall ${RUN}` }, { kind: "path", text: "/Users/x/abs.ts" }] }),
});
const ingJ = await ing.json();
check("ingest via bridge (abs path rejected)", ing.status === 202 && ingJ.result.inserted === 2 && ingJ.result.rejected.length === 1);
const seen = [];
for (let i = 0; i < 10; i++) { r = await get(`/api/v1/agent/sync?limit=2&cursor=${cursor}`); seen.push(...r.j.changes); cursor = r.j.nextCursor; if (!r.j.hasMore) break; }
const texts = seen.filter((c) => c.type === "item").map((c) => c.item.text);
check("sync sees ingested items (page size 2)", texts.includes(`e2e decision ${RUN}`) && texts.includes(`e2e pitfall ${RUN}`));
check("sync has no duplicate seqs", new Set(seen.map((c) => c.seq)).size === seen.length);
r = await get(`/api/v1/agent/memory?q=${encodeURIComponent(`e2e decision ${RUN}`)}`);
check("memory finds ingested decision", r.j?.hits?.[0]?.scope === SCOPE);

const mcpHeaders = { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let res = await fetch(B + "/api/v1/agent/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-remote", version: "0" } } }) });
const sid = res.headers.get("mcp-session-id");
check("MCP initialize via bridge", res.status === 200 && !!sid);
const mcp = async (id, method, params) => (await fetch(B + "/api/v1/agent/mcp", { method: "POST", headers: { ...mcpHeaders, "Mcp-Session-Id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json();
await fetch(B + "/api/v1/agent/mcp", { method: "POST", headers: { ...mcpHeaders, "Mcp-Session-Id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const tools = (await mcp(2, "tools/list", {})).result.tools.map((t) => t.name);
check("MCP tools/list via bridge", ["task_catalog", "task_resume", "task_note", "task_handoff"].every((t) => tools.includes(t)), `${tools.length} tools`);
let call = await mcp(3, "tools/call", { name: "task_resume", arguments: { cwd: "/Users/remote-client/missing", client: "e2e" } });
check("remote task_resume without scope → explicit error", call.result.isError === true && /remote mode/.test(call.result.content[0].text));
call = await mcp(4, "tools/call", { name: "task_resume", arguments: { scope: SCOPE, branch: "feat/e2e", client: "e2e", session_id: `remote-${RUN}` } });
check("remote task_resume lands on the ingest thread", call.result.structuredContent?.threadId === ingJ.threadId);
res = await fetch(B + "/api/v1/agent/mcp", { method: "DELETE", headers: { ...auth, "Mcp-Session-Id": sid } });
check("MCP session DELETE", res.status === 200);

res = await fetch(Q + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
check("QMD /mcp without token → 401", res.status === 401);
res = await fetch(B + "/api/v1/agent/mcp", { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${process.env.QMD_MCP_TOKEN}` }, body: "{}" });
check("bridge rejects QMD token as caller → 401", res.status === 401);
r = await get("/api/v1/agent/catalog", {});
check("bridge read without bearer → 401", r.s === 401);

console.log(`\n${pass} passed, ${fail} failed · scope ${SCOPE}`);
process.exit(fail ? 1 : 0);
