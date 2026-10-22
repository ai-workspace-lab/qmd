#!/usr/bin/env node
/**
 * Regression check: a client that launches QMD's stdio MCP before PostgreSQL is
 * reachable must still get the task tools, and they must start working once PG
 * comes up — without restarting the client.
 *
 * Starts QMD with QMD_PG_URL pointing at a local port that is closed, calls
 * task_catalog (expects an explicit error), then opens that port as a TCP proxy
 * to the real PG from QMD_PG_URL and calls again (expects the catalog).
 */
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const realUrl = new URL(process.env.QMD_PG_URL);
const lateUrl = new URL(realUrl); lateUrl.port = "15999";
const qmd = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli", "qmd.js");
const child = spawn(process.execPath, [qmd, "mcp"], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, QMD_BACKEND: "pg", QMD_PG_URL: lateUrl.toString(), QMD_PG_SSL: "disable" },
  stdio: ["pipe", "pipe", "ignore"],
});
let buf = ""; const pending = new Map(); let id = 0;
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch {} } });
const rpc = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
let pass = 0, fail = 0; const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${n}${x ? " — " + x : ""}`); };
const timer = setTimeout(() => { console.log("❌ timed out"); child.kill(); process.exit(1); }, 60000);

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "late-pg", version: "0" } });
child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
check("task tools registered while PG is down", ["task_catalog", "task_resume", "task_claim"].every((t) => tools.includes(t)), `${tools.length} tools`);
let r = (await rpc("tools/call", { name: "task_catalog", arguments: {} })).result;
check("call while PG is down returns an explicit error", r.isError === true && /unavailable/.test(r.content[0].text));

const proxy = createServer((sock) => { const up = connect(Number(realUrl.port), realUrl.hostname); sock.pipe(up).pipe(sock); up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy()); });
await new Promise((res) => proxy.listen(15999, "127.0.0.1", res));
await new Promise((res) => setTimeout(res, 5500)); // past the retry interval
r = (await rpc("tools/call", { name: "task_catalog", arguments: {} })).result;
const text = r.content?.[0]?.text ?? "";
check("after PG comes up the same session works", !r.isError && /置顶任务 - \d+/.test(text), (/置顶任务 - (\d+)/.exec(text) || [])[0] ?? text.slice(0, 80));

clearTimeout(timer); child.kill(); proxy.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
