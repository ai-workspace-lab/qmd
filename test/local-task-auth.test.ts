import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

let handle: HttpServerHandle;
let dir: string;
const keys = ["QMD_LOCAL_NO_AUTH", "QMD_MCP_TOKEN", "QMD_INGEST_TOKEN", "QMD_MCP_HOST", "QMD_BACKEND", "QMD_CONFIG_DIR", "INDEX_PATH"];
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "qmd-local-auth-"));
  process.env.QMD_LOCAL_NO_AUTH = "1";
  process.env.QMD_MCP_TOKEN = "ignored-local-test-token";
  process.env.QMD_INGEST_TOKEN = "ignored-local-test-token";
  delete process.env.QMD_BACKEND;
  process.env.QMD_CONFIG_DIR = dir;
  process.env.INDEX_PATH = join(dir, "index.sqlite");
  handle = await startMcpHttpServer(0, { quiet: true, host: "127.0.0.1" });
});
afterAll(async () => {
  await handle?.stop();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

test("loopback MCP accepts initialization without Authorization", async () => {
  const r = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-test", version: "1" } } }),
  });
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('"serverInfo"');
});

test("task API passes auth and reports absent store rather than demanding credentials", async () => {
  for (const [path, init] of [["catalog", {}], ["ingest", { method: "POST" }]] as const) {
    const r = await fetch(`http://127.0.0.1:${handle.port}/api/v1/agent/${path}`, init);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("context_unavailable");
  }
});

test("local no-auth cannot bind to all interfaces even with a remote token", async () => {
  await expect(startMcpHttpServer(0, { quiet: true, host: "0.0.0.0" })).rejects.toThrow(/requires a loopback/);
});
