/**
 * mcp/agent-ingest.ts - One-way ingest endpoint for remote clients
 *
 * ChatGPT / Claude web and mobile extensions cannot read local session
 * directories; they submit extracted session facts to xworkmate-bridge, which
 * forwards them here. The endpoint is write-only on purpose: nothing about
 * stored context is readable through it.
 *
 *   POST /api/v1/agent/ingest
 *   Authorization: Bearer $QMD_INGEST_TOKEN
 *   { source, sourceSessionId, scope, headBranch?, prNumber?, prState?, headSha?,
 *     title?, clientRequestId?, items: [{ kind, text, status?, key?, detail?, at? }] }
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ITEM_KINDS, type ContextBridge, type IncomingItem } from "../pg/index.js";

export const INGEST_PATH = "/api/v1/agent/ingest";
const MAX_BODY_BYTES = 128 * 1024;

const ingestSchema = z.object({
  source: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "source must be a lowercase slug"),
  sourceSessionId: z.string().min(1).max(200),
  scope: z.string().min(1).max(200),
  headBranch: z.string().min(1).max(250).optional(),
  prNumber: z.number().int().positive().optional(),
  prState: z.enum(["open", "merged", "closed"]).optional(),
  headSha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  title: z.string().max(300).optional(),
  clientRequestId: z.string().min(8).max(200).optional(),
  items: z
    .array(
      z.object({
        kind: z.enum(ITEM_KINDS),
        text: z.string().min(1).max(2000),
        status: z.string().max(20).optional(),
        key: z.string().max(200).optional(),
        detail: z.string().max(1000).optional(),
        at: z.string().max(40).optional(),
      }),
    )
    .max(100),
});

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

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleAgentIngest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ContextBridge | undefined,
  token: string | undefined,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return error(res, 405, "method_not_allowed", "ingest is write-only: POST");
  }
  // Fail closed: without a configured token the endpoint does not exist in practice.
  if (!token) return error(res, 503, "ingest_disabled", "QMD_INGEST_TOKEN is not configured");
  if (!ctx) return error(res, 503, "context_unavailable", "shared context store is not available");
  if (!tokenMatches(req.headers.authorization, token)) return error(res, 401, "unauthorized", "invalid bearer token");
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    return error(res, 415, "unsupported_media_type", "Content-Type must be application/json");
  }

  const raw = await readBody(req);
  if (raw === null) return error(res, 413, "payload_too_large", "request body exceeds 128 KiB");
  let parsed: z.infer<typeof ingestSchema>;
  try {
    const result = ingestSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      return error(res, 400, "invalid_request", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    parsed = result.data;
  } catch {
    return error(res, 400, "invalid_json", "body is not valid JSON");
  }

  const store = ctx.store;
  const resolved = await store.resolveThread({
    scope: parsed.scope,
    ...(parsed.headBranch ? { headBranch: parsed.headBranch } : {}),
    ...(parsed.prNumber ? { prNumber: parsed.prNumber } : {}),
    ...(parsed.prState ? { prState: parsed.prState } : {}),
    ...(parsed.headSha ? { headSha: parsed.headSha } : {}),
    ...(parsed.title ? { title: parsed.title } : {}),
  });
  if (!resolved.ok) {
    return error(res, 422, "thread_unresolvable", "a PR number or a non-default branch is required");
  }
  const sessionId = await store.attachSession(resolved.thread.id, {
    source: parsed.source,
    sourceSessionId: parsed.sourceSessionId,
    agentKind: parsed.source,
    ...(parsed.title ? { title: parsed.title } : {}),
  });
  const items: IncomingItem[] = parsed.items.map((i) => ({
    kind: i.kind,
    text: i.text,
    ...(i.status ? { status: i.status } : {}),
    ...(i.key ? { key: i.key } : {}),
    ...(i.detail ? { detail: i.detail } : {}),
    ...(i.at ? { at: i.at } : {}),
    ...(parsed.headSha ? { gitHead: parsed.headSha } : {}),
  }));
  if (parsed.title) items.unshift({ kind: "goal", text: parsed.title });

  // Remote contributors are never the driver: direction items become proposals.
  const result = await store.mergeItems(resolved.thread.id, sessionId, items, {
    ...(parsed.clientRequestId ? { clientRequestId: `ingest:${parsed.source}:${parsed.clientRequestId}` } : {}),
  });
  send(res, result.duplicate ? 200 : 202, { threadId: resolved.thread.id, created: resolved.created, result });
}
