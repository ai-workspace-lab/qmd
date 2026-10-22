#!/usr/bin/env node
/**
 * Launch QMD's stdio MCP server exactly as each installed client configures it
 * (Claude Code ~/.claude.json, Antigravity ~/.gemini/config/mcp_config.json,
 * Codex ~/.codex/config.toml), check the catalog each one sees, then hand a task
 * from Claude Code to Antigravity and confirm a stale driver cannot redirect it.
 * Writes only under a unique `test/handoff-*` scope.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const home = process.env.HOME;
const specs = {
  claude: () => JSON.parse(readFileSync(`${home}/.claude.json`, "utf8")).mcpServers?.qmd,
  antigravity: () => JSON.parse(readFileSync(`${home}/.gemini/config/mcp_config.json`, "utf8")).mcpServers?.qmd,
  codex: () => {
    const toml = readFileSync(`${home}/.codex/config.toml`, "utf8");
    const head = /\[mcp_servers\.qmd\]\n([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? "";
    const command = /command\s*=\s*"([^"]+)"/.exec(head)?.[1];
    const args = JSON.parse(/args\s*=\s*(\[[^\]]*\])/.exec(head)?.[1] ?? "[]");
    const env = {};
    const block = toml.split("[mcp_servers.qmd.env]")[1]?.split(/\n\[/)[0] ?? "";
    for (const m of block.matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)) env[m[1]] = m[2];
    return command ? { command, args, env } : undefined;
  },
};
function client(name) {
  const spec = specs[name]();
  if (!spec) throw new Error(`${name}: qmd MCP server not configured`);
  const child = spawn(spec.command, spec.args, { env: { PATH: process.env.PATH, HOME: home, ...spec.env }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; const pending = new Map(); let id = 0;
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch {} } });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  return {
    async init() { await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "0" } }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); },
    tools: async () => (await rpc("tools/list", {})).result?.tools?.map((t) => t.name) ?? [],
    call: async (tool, args) => (await rpc("tools/call", { name: tool, arguments: args })).result,
    close: () => child.kill(),
  };
}
let pass = 0, fail = 0;
const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${n}${x ? " — " + x : ""}`); };
const timer = setTimeout(() => { console.log("❌ timed out"); process.exit(1); }, 90000);

for (const name of ["claude", "antigravity", "codex"]) {
  if (name === "codex" && !existsSync(`${home}/.codex/config.toml`)) continue;
  const c = client(name); await c.init();
  const tools = await c.tools();
  const cat = await c.call("task_catalog", {});
  const text = cat.content[0].text;
  const pinned = /置顶任务 - (\d+)/.exec(text)?.[1], projects = /共享项目 - (\d+)/.exec(text)?.[1];
  check(`${name}: task tools + catalog`, tools.includes("task_resume") && tools.includes("task_catalog") && !/\/Users\//.test(text), `pinned ${pinned} · projects ${projects}`);
  c.close();
}

const RUN = Date.now(); const scope = `test/handoff-${RUN}`; const branch = "feat/handoff";
const claude = client("claude"), ag = client("antigravity");
await claude.init(); await ag.init();
let r = await claude.call("task_resume", { scope, branch, lead: true, client: "claude-code", session_id: `cc-${RUN}` });
const { threadId, sessionId: cc, fence } = r.structuredContent;
check("claude-code leads the task", !r.isError && fence > 0);
r = await claude.call("task_note", { session_id: cc, thread_id: threadId, fence, items: [
  { kind: "goal", text: "ship the shared task catalog" },
  { kind: "decision", text: "sync cursor uses xid8 below pg_snapshot_xmin" },
  { kind: "pitfall", text: "portal repo is public; rotate leaked tokens" },
] });
check("claude-code notes merged", !r.isError && r.structuredContent.result.inserted === 3);
r = await claude.call("task_handoff", { thread_id: threadId, session_id: cc, fence, next_action: "restart dev services and run the smoke tests" });
check("claude-code hands off", !r.isError);
r = await ag.call("task_resume", { scope, branch, lead: true, takeover: true, client: "antigravity", session_id: `ag-${RUN}` });
const brief = r.content[0].text;
check("antigravity resumes with next action, decision, pitfall", brief.includes("restart dev services") && brief.includes("xid8") && brief.includes("rotate leaked tokens"));
check("antigravity takes the lead with a higher fence", r.structuredContent.fence === fence + 1);
r = await claude.call("task_note", { session_id: cc, thread_id: threadId, fence, items: [{ kind: "next_action", text: "revert everything" }] });
check("stale claude-code direction becomes a proposal", r.structuredContent.result.proposed === 1);
r = await ag.call("task_resume", { scope, branch, client: "antigravity", session_id: `ag-${RUN}` });
check("current next action unchanged", r.content[0].text.includes("next: restart dev services"));
claude.close(); ag.close(); clearTimeout(timer);
console.log(`\n${pass} passed, ${fail} failed · scope ${scope}`);
process.exit(fail ? 1 : 0);
