/**
 * P6: `qmd tier …` CLI and the mem_* MCP tools, end to end against a throwaway
 * PostgreSQL database (lexical-only: MEM_NO_EMBED=1, MEM_NO_L1=1).
 *
 *   CI=true QMD_PG_URL=postgres://box@127.0.0.1:5432/postgres QMD_PG_SSL=disable \
 *     npx vitest run test/tier-cli-mcp.integration.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgClient } from "../src/pg/db-pg.js";
import { resolvePgConfig } from "../src/pg/config.js";

const PG_URL = process.env.QMD_PG_URL;
const DB = `qmd_tier_cli_${process.pid}`;
const sslEnv = process.env.QMD_PG_SSL ? { QMD_PG_SSL: process.env.QMD_PG_SSL } : {};
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const qmdScript = join(root, "src", "cli", "qmd.ts");
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const runner = isBun
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [join(root, "node_modules", "tsx", "dist", "cli.mjs"), qmdScript] };

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

describe.skipIf(!PG_URL)("qmd tier CLI + mem_* MCP tools", () => {
  let admin: PgClient | undefined;
  let created = false;
  let home = "";
  let env: Record<string, string> = {};

  const run = (args: string[], input?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(runner.command, [...runner.args, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      if (input !== undefined) p.stdin.end(input);
      else p.stdin.end();
      p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

  beforeAll(async () => {
    admin = await PgClient.create(resolvePgConfig({ QMD_PG_URL: PG_URL!, ...sslEnv }));
    try {
      await admin.exec(`CREATE DATABASE ${DB}`);
      created = true;
    } catch {
      return;
    }
    home = mkdtempSync(join(tmpdir(), "qmd-tier-cli-"));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "index.yml"), "collections: {}\n");
    const base: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[k]) base[k] = process.env[k]!;
    env = {
      ...base,
      ...sslEnv,
      QMD_BACKEND: "pg",
      QMD_PG_URL: withDatabase(PG_URL!, DB),
      QMD_NAMESPACE: "clitest",
      QMD_CONFIG_DIR: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      INDEX_PATH: join(home, "index.sqlite"),
      MEM_HOME: home,
      MEM_ARCHIVE_STATE_DIR: join(home, "archive-state"),
      MEM_WORKSPACE_ROOT: home,
      MEM_NO_EMBED: "1",
      MEM_NO_L1: "1",
      QMD_EMBED_MODEL: "nvidia/nemotron-3-embed-1b",
    };
  }, 30000);

  afterAll(async () => {
    if (created) await admin?.exec(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await admin?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  let noteId = "";

  test("remember (stdin) → search → recall → status", async () => {
    if (!created) return;
    const r = await run(["tier", "remember", "--title", "Kestrel deploy decision", "--kind", "note", "--json"],
      "We chose blue-green deploys for the kestrel service because rollbacks must take under a minute.");
    expect(r.code, r.stderr).toBe(0);
    noteId = JSON.parse(r.stdout).id;
    expect(noteId).toMatch(/^[0-9a-f-]{36}$/);

    const s = await run(["tier", "search", "kestrel rollbacks", "--json"]);
    expect(s.code, s.stderr).toBe(0);
    const hits = JSON.parse(s.stdout).hits;
    expect(hits[0].itemId).toBe(noteId);

    const zh = await run(["tier", "remember", "--title", "部署决定", "--json", "灰度发布用于支付网关，回滚必须在一分钟内完成。"]);
    expect(zh.code, zh.stderr).toBe(0);
    const zs = await run(["tier", "search", "支付网关", "--json"]);
    expect(JSON.parse(zs.stdout).hits[0].itemId).toBe(JSON.parse(zh.stdout).id);

    const g = await run(["tier", "recall", noteId]);
    expect(g.code, g.stderr).toBe(0);
    expect(g.stdout).toContain("blue-green");

    const st = await run(["tier", "status", "--json"]);
    expect(st.code, st.stderr).toBe(0);
    const status = JSON.parse(st.stdout);
    expect(status.invariantViolations).toBe(0);
    expect(status.items.l2_full).toBeGreaterThanOrEqual(2);
  }, 60000);

  test("remember refuses secrets; forget needs a reason", async () => {
    if (!created) return;
    const bad = await run(["tier", "remember", "--title", "oops", `token ${"ghp_" + "A".repeat(36)}`]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/secret|credential|github-token/i);
    const noReason = await run(["tier", "forget", noteId]);
    expect(noReason.code).toBe(1);
  }, 60000);

  test("ingest a directory, facts add/list, summary --generate, timeline, context", async () => {
    if (!created) return;
    const dir = join(home, "docs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "# Ledger runbook\n\nRestart the ledger worker with make restart-ledger.\n");
    writeFileSync(join(dir, "b.md"), "# Ledger alerts\n\nPage the on-call when ledger lag exceeds five minutes.\n");
    const ing = await run(["tier", "ingest", dir, "--kind", "knowledge_doc", "--json"]);
    expect(ing.code, ing.stderr).toBe(0);
    const files = JSON.parse(ing.stdout);
    expect(files).toHaveLength(2);

    const fa = await run(["tier", "facts", "add", "Ledger uses Postgres 18", "--entity", "ledger", "--type", "product",
      "--predicate", "uses_db", "--evidence", files[0].id, "--json"]);
    expect(fa.code, fa.stderr).toBe(0);
    const fl = await run(["tier", "facts", "--entity", "ledger", "--json"]);
    expect(JSON.parse(fl.stdout).map((f: { statement: string }) => f.statement)).toContain("Ledger uses Postgres 18");

    const sm = await run(["tier", "summary", "day", "--generate", "--json"]);
    expect(sm.code, sm.stderr).toBe(0);
    const tl = await run(["tier", "timeline", "--since", "1d", "--json"]);
    expect(JSON.parse(tl.stdout).items.length).toBeGreaterThanOrEqual(3);
    const cx = await run(["tier", "context", "restart the ledger", "--budget", "500"]);
    expect(cx.code, cx.stderr).toBe(0);
    expect(cx.stdout).toContain("Ledger");
  }, 90000);

  test("MCP HTTP: mem_* tools listed and callable", async () => {
    if (!created) return;
    const port = 20000 + Math.floor(Math.random() * 30000);
    const p = spawn(runner.command, [...runner.args, "mcp", "--http", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    p.stderr.on("data", (d) => (log += d));
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "tier-test", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const rpc = async (method: string, params: Record<string, unknown> = {}, name?: string) => {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(name ? { "Mcp-Name": name } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      });
      return res.json() as Promise<any>;
    };
    try {
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        try { ready = (await fetch(`http://localhost:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      expect(ready, log).toBe(true);
      const list = await rpc("tools/list");
      const names = list.result.tools.map((t: { name: string }) => t.name);
      for (const n of ["mem_search", "mem_recall", "mem_remember", "mem_facts", "mem_timeline", "mem_context"]) expect(names).toContain(n);
      expect(names).toContain("memory_search"); // fork bridge tools still there

      const rem = await rpc("tools/call", { name: "mem_remember", arguments: { title: "Heron cache note", body: "The heron cache TTL is ninety seconds." } }, "mem_remember");
      expect(rem.result.isError ?? false).toBe(false);
      const id = rem.result.structuredContent.id;
      const s = await rpc("tools/call", { name: "mem_search", arguments: { query: "heron cache TTL" } }, "mem_search");
      expect(s.result.structuredContent.hits[0].itemId).toBe(id);
      const g = await rpc("tools/call", { name: "mem_recall", arguments: { id } }, "mem_recall");
      expect(g.result.content[0].text).toContain("ninety seconds");
      const f = await rpc("tools/call", { name: "mem_facts", arguments: { entity: "ledger" } }, "mem_facts");
      expect(f.result.content[0].text).toContain("Postgres 18");
      const t = await rpc("tools/call", { name: "mem_timeline", arguments: { since: "1d" } }, "mem_timeline");
      expect(t.result.content[0].text).toContain("Heron cache note");
      const c = await rpc("tools/call", { name: "mem_context", arguments: { task: "heron cache" } }, "mem_context");
      expect(c.result.content[0].text.length).toBeGreaterThan(0);
    } finally {
      const closed = new Promise((r) => p.once("close", r));
      p.kill("SIGTERM");
      await closed;
    }
  }, 120000);
});
