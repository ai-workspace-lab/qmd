/**
 * mcp-remote-auth.test.ts - HTTP MCP in remote mode (behind xworkmate-bridge).
 *
 * With QMD_MCP_TOKEN set, /mcp and /query require the bearer; a daemon bound
 * beyond loopback refuses to start without it.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

const TOKEN = "mcp-remote-token-0123456789";
const saved: Record<string, string | undefined> = {};
const setEnv = (key: string, value: string | undefined) => {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

describe.skipIf(!!process.env.CI)("HTTP MCP remote-mode auth", () => {
  let dir: string;
  let handle: HttpServerHandle;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "qmd-mcp-remote-"));
    setEnv("INDEX_PATH", join(dir, "index.sqlite"));
    setEnv("QMD_CONFIG_DIR", dir);
    setEnv("QMD_BACKEND", undefined);
    setEnv("QMD_MCP_HOST", undefined);
    setEnv("QMD_MCP_TOKEN", TOKEN);
    handle = await startMcpHttpServer(0, { quiet: true });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle?.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const initialize = (headers: Record<string, string>) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "remote-auth-test", version: "0" } },
      }),
    });

  test("/mcp without the bearer is 401", async () => {
    expect((await initialize({})).status).toBe(401);
    expect((await initialize({ Authorization: "Bearer wrong" })).status).toBe(401);
  });

  test("/mcp with the bearer initializes a session", async () => {
    const res = await initialize({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  test("/query without the bearer is 401; /health stays open", async () => {
    const q = await fetch(`${base}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(q.status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  test("binding beyond loopback without a token refuses to start", async () => {
    setEnv("QMD_MCP_TOKEN", undefined);
    setEnv("QMD_MCP_HOST", "0.0.0.0");
    await expect(startMcpHttpServer(0, { quiet: true })).rejects.toThrow(/QMD_MCP_TOKEN/);
    setEnv("QMD_MCP_HOST", undefined);
    setEnv("QMD_MCP_TOKEN", TOKEN);
  });
});
