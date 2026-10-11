/**
 * mcp/mem-tools.ts - MCP tools for the three-tier memory (L1 hot / L2 PG / L3 archive).
 *
 * mem_search · mem_recall · mem_remember · mem_facts · mem_timeline · mem_context.
 * Registered only when QMD_BACKEND=pg and the tier engine opens. The older
 * memory_* tools (fork key/value bridge) stay untouched alongside these.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TierEngine } from "../tier/index.js";
import { listFacts } from "../tier/index.js";
import { MEM_ITEM_KINDS, type MemItemKind } from "../pg/schema-mem.js";

const WRITABLE_KINDS = ["note", "journal", "knowledge_doc"] as const;

function sinceDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([dh])$/.exec(v.trim());
  if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === "d" ? 86400000 : 3600000));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function registerMemTools(server: McpServer, engine: TierEngine): void {
  const agentOf = (agent?: string): string => {
    const name = agent?.trim() || server.server.getClientVersion()?.name || "mcp";
    return `mcp:${name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
  };

  server.registerTool(
    "mem_search",
    {
      title: "Search tiered memory",
      description:
        "Search long-term memory across tiers: L1 hot set first, then L2 PostgreSQL (lexical + CJK + vector, RRF). " +
        "Returns item ids for mem_recall, plus related active facts. Hits from L2 are promoted to L1.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        query: z.string().describe("Natural language or keywords (中文 ok)"),
        limit: z.number().int().min(1).max(50).optional().default(10),
        scope: z.string().optional().describe("Project scope, e.g. github.com/org/repo"),
        kind: z.enum(MEM_ITEM_KINDS).optional(),
        since: z.string().optional().describe("7d, 12h or an ISO date"),
        agent: z.string().optional(),
      }),
    },
    async ({ query, limit, scope, kind, since, agent }) => {
      const r = await engine.search(query, { limit, scope, kind, since: sinceDate(since), agent: agentOf(agent) });
      const lines = r.hits.map(
        (h, i) =>
          `${i + 1}. ${h.title ?? "(untitled)"} [${h.tier}] ${h.kind} · ${h.source} · ${new Date(h.occurredAt).toISOString().slice(0, 10)} · id=${h.itemId}\n   ${h.snippet.replace(/\s+/g, " ").slice(0, 300)}`,
      );
      if (r.facts.length) lines.push("", "Facts:", ...r.facts.map((f) => `- ${f.statement}`));
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : `No memory matches for: ${query}` }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "mem_recall",
    {
      title: "Recall a memory item",
      description:
        "Full content of one item by id (or the best match for a query). If only a summary is local, " +
        "the original is rehydrated from the L3 cache or queued (pending_fetch) for the nightly routine.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.string().describe("item id from mem_search, or a query"),
        max_chars: z.number().int().min(200).max(200000).optional().default(20000),
      }),
    },
    async ({ id, max_chars }) => {
      const r = await engine.recall(id);
      if (!r.item) return { content: [{ type: "text", text: `not found: ${id}` }], isError: true };
      if (r.tombstoned) return { content: [{ type: "text", text: `forgotten: ${r.item.id}` }] };
      const head = `# ${r.item.title ?? r.item.id}\n${r.item.kind} · ${r.item.source} · ${new Date(r.item.occurred_at).toISOString()} · tier ${r.tier ?? "L3"} · id=${r.item.id}\n\n`;
      const body = r.body ?? `${r.summary ?? ""}${r.pendingFetch ? "\n\n[pending_fetch: original only in L3; queued]" : ""}`;
      const text = head + (body.length > max_chars ? `${body.slice(0, max_chars)}\n…[truncated]` : body);
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          id: r.item.id, tier: r.tier, pendingFetch: !!r.pendingFetch, truncated: body.length > max_chars,
          title: r.item.title, kind: r.item.kind, source: r.item.source,
        },
      };
    },
  );

  server.registerTool(
    "mem_remember",
    {
      title: "Remember",
      description:
        "Write-through a note/decision into memory (L2 now, L1 hot, L3 via the nightly archive). " +
        "Content containing secrets is refused. Re-sending the same title+scope updates it.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        title: z.string().min(1),
        body: z.string().min(1).max(65536),
        kind: z.enum(WRITABLE_KINDS).optional().default("note"),
        scope: z.string().optional(),
        agent: z.string().optional(),
      }),
    },
    async ({ title, body, kind, scope, agent }) => {
      try {
        const r = await engine.remember({ title, body, kind: kind as MemItemKind, scope: scope ?? null, agent: agentOf(agent) });
        return {
          content: [{ type: "text", text: `${r.created ? "Stored" : r.unchanged ? "Unchanged" : "Updated"} ${r.id} (${r.parts} part(s))` }],
          structuredContent: { ...r } as Record<string, unknown>,
        };
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  );

  server.registerTool(
    "mem_facts",
    {
      title: "Facts",
      description: "Structured facts (entity · predicate · statement) with evidence. Active only by default.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        entity: z.string().optional(),
        predicate: z.string().optional(),
        query: z.string().optional(),
        status: z.enum(["active", "proposed", "retired", "all"]).optional().default("active"),
      }),
    },
    async ({ entity, predicate, query, status }) => {
      const rows = await listFacts(engine.client, { entity, predicate, query, status });
      const text = rows.length
        ? rows.map((f) => `- ${f.statement} [${f.status} · ${f.subject ?? "-"} · ${f.predicate}]`).join("\n")
        : "No facts.";
      return { content: [{ type: "text", text }], structuredContent: { facts: rows } as Record<string, unknown> };
    },
  );

  server.registerTool(
    "mem_timeline",
    {
      title: "Timeline",
      description: "Items, period summaries and facts in a time window (default last 7 days).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        since: z.string().optional().default("7d"),
        until: z.string().optional(),
        scope: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(100),
      }),
    },
    async ({ since, until, scope, limit }) => {
      const from = sinceDate(since) ?? new Date(Date.now() - 7 * 86400000);
      const to = until ? new Date(until) : new Date();
      const r = await engine.timeline({ from, to, scope, limit });
      const items = r.items as Array<{ occurred_at: string; kind: string; title: string | null; id: string }>;
      const text = [
        ...items.map((it) => `${new Date(it.occurred_at).toISOString().slice(0, 10)} [${it.kind}] ${it.title ?? it.id} (id=${it.id})`),
        `— ${items.length} items · ${r.summaries.length} summaries · ${r.facts.length} facts`,
      ].join("\n");
      return { content: [{ type: "text", text }], structuredContent: r as unknown as Record<string, unknown> };
    },
  );

  server.registerTool(
    "mem_context",
    {
      title: "Context for a task",
      description:
        "Compact, injectable context for a task: active facts, recent day summaries and the top memory snippets, " +
        "within a token budget. Restricted items are excluded.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        task: z.string().min(1),
        scope: z.string().optional(),
        budget_tokens: z.number().int().min(200).max(20000).optional().default(2000),
      }),
    },
    async ({ task, scope, budget_tokens }) => {
      const r = await engine.context(task, { scope, budgetTokens: budget_tokens, agent: agentOf() });
      return { content: [{ type: "text", text: r.text }], structuredContent: r as unknown as Record<string, unknown> };
    },
  );
}
