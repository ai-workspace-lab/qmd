/**
 * mcp/agent-read.ts - Read routes for shared tasks, lists and memory
 *
 * Every client — web/mobile extensions and CLI/APP plugins — reaches these
 * through xworkmate-bridge (docs/plan/multi-agent-shared-context.md §7). All
 * routes are GET, bearer-authenticated with QMD_INGEST_TOKEN, paged, and carry
 * no absolute paths.
 *
 *   GET /api/v1/agent/catalog?scope=&limit=&offset=
 *   GET /api/v1/agent/threads?scope=&state=live|all&limit=&offset=
 *   GET /api/v1/agent/threads/{id}/briefing?events=
 *   GET /api/v1/agent/memory?q=&scope=&kind=decision,pitfall&limit=&offset=
 *   GET /api/v1/agent/sync?cursor=&limit=
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clampPage, decodeSyncCursor, type ContextBridge } from "../pg/index.js";

export const AGENT_READ_PREFIX = "/api/v1/agent/";
const READ_ROUTES = /^\/api\/v1\/agent\/(catalog|threads|memory|sync|threads\/([0-9a-f-]{36})\/briefing)$/;

export function isAgentReadPath(pathname: string): boolean {
  return READ_ROUTES.test(pathname);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

/** Constant-time bearer check shared by the agent HTTP routes. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

export async function handleAgentRead(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ContextBridge | undefined,
  token: string | undefined,
): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return error(res, 405, "method_not_allowed", "agent read routes accept GET only");
  }
  if (!token) return error(res, 503, "endpoint_disabled", "QMD_INGEST_TOKEN is not configured");
  if (!bearerMatches(req.headers.authorization, token)) {
    return error(res, 401, "unauthorized", "missing or invalid bearer token");
  }
  if (!ctx) return error(res, 503, "context_unavailable", "shared context store is not available");

  const url = new URL(req.url ?? "/", "http://qmd.local");
  const match = READ_ROUTES.exec(url.pathname);
  if (!match) return error(res, 404, "route_not_found", "agent route not found");

  const limit = intParam(url, "limit");
  const offset = intParam(url, "offset");
  if (Number.isNaN(limit) || Number.isNaN(offset)) {
    return error(res, 400, "invalid_request", "limit and offset must be non-negative integers");
  }
  const page = clampPage(limit, offset);
  const scope = url.searchParams.get("scope")?.trim() || undefined;
  const store = ctx.store;

  try {
    if (match[2]) {
      const events = intParam(url, "events");
      if (Number.isNaN(events)) return error(res, 400, "invalid_request", "events must be a non-negative integer");
      const briefing = await store.briefing(match[2], { events: Math.min(events ?? 20, 200) });
      if (!briefing) return error(res, 404, "thread_not_found", "thread not found");
      return send(res, 200, { ok: true, briefing });
    }
    switch (match[1]) {
      case "catalog": {
        const catalog = await store.getCatalog({ ...(scope ? { scope } : {}), page });
        return send(res, 200, { ok: true, catalog });
      }
      case "threads": {
        const state = url.searchParams.get("state") ?? "live";
        if (state !== "live" && state !== "all") {
          return error(res, 400, "invalid_request", "state must be live or all");
        }
        const { rows, total } = await store.listThreads({ ...(scope ? { scope } : {}), all: state === "all", page });
        return send(res, 200, { ok: true, threads: rows, page: { ...page, total } });
      }
      case "memory": {
        const kinds = url.searchParams.get("kind")?.split(",").map((k) => k.trim()).filter(Boolean);
        const q = url.searchParams.get("q") ?? undefined;
        const result = await store.searchMemory({
          ...(q ? { query: q } : {}),
          ...(scope ? { scope } : {}),
          ...(kinds?.length ? { kinds } : {}),
          page,
        });
        return send(res, 200, { ok: true, hits: result.hits, page: { ...page, hasMore: result.hasMore } });
      }
      case "sync": {
        const cursor = url.searchParams.get("cursor") ?? undefined;
        try {
          decodeSyncCursor(cursor);
        } catch {
          return error(res, 400, "invalid_cursor", "cursor is not a value returned by this endpoint");
        }
        const result = await store.changesSince(cursor, limit ?? undefined);
        return send(res, 200, { ok: true, ...result });
      }
    }
    return error(res, 404, "route_not_found", "agent route not found");
  } catch (err) {
    console.error(`[qmd:agent-read] ${url.pathname} failed: ${(err as Error).message}`);
    return error(res, 500, "internal_error", "agent read failed");
  }
}
