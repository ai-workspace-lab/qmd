/**
 * mcp/agent-catalog.ts - Read-only catalog endpoint for remote and web clients
 *
 * Exposes the shared task catalog:
 * - Pinned tasks (置顶任务)
 * - Shared project roots
 * - Active claims/leases
 * - Recent threads
 *
 * GET /api/v1/agent/catalog
 * Authorization: Bearer $QMD_INGEST_TOKEN
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContextBridge } from "../pg/index.js";

export const CATALOG_PATH = "/api/v1/agent/catalog";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleAgentCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ContextBridge | undefined,
  token: string | undefined,
): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return error(res, 405, "method_not_allowed", "catalog is read-only: GET");
  }

  if (!token) {
    return error(res, 503, "endpoint_disabled", "catalog requires QMD_INGEST_TOKEN to be set");
  }
  if (!tokenMatches(req.headers.authorization, token)) {
    return error(res, 401, "unauthorized", "missing or invalid Bearer token");
  }

  if (!ctx) {
    return error(res, 503, "pg_disabled", "shared context catalog requires PostgreSQL backend");
  }

  try {
    const catalog = await ctx.store.getCatalog();
    send(res, 200, { ok: true, catalog });
  } catch (err) {
    error(res, 500, "internal_error", (err as Error).message);
  }
}
