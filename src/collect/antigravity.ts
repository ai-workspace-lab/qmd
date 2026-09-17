/**
 * collect/antigravity.ts - Antigravity conversations
 *
 *  ~/.gemini/antigravity/conversation_summaries.db   title / status per conversation (read-only)
 *  ~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *    PLANNER_RESPONSE records carry tool_calls; run_command args include Cwd and
 *    CommandLine, file-writing tools carry an absolute target path.
 *
 * The transcript does not record command exit codes, so Antigravity commands
 * only anchor the session to a checkout; they never become verification items.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isoOr, readJsonlFrom, type SessionFacts, type SessionFile, type SessionSource } from "./types.js";

export function antigravityDir(home = homedir()): string {
  return join(home, ".gemini", "antigravity");
}

const WRITE_TOOL = /write|edit|replace|create_file|apply/i;
const PATH_ARGS = ["TargetFile", "AbsolutePath", "FilePath", "Path"];

/** Parse Antigravity transcript records. Exported for fixture tests. */
export function parseAntigravityRecords(
  conversationId: string,
  records: any[],
  meta: Record<string, unknown>,
  title?: string,
): { facts: SessionFacts[]; meta: Record<string, unknown> } {
  let updatedAt = (meta.updatedAt as string | undefined) ?? new Date(0).toISOString();
  const paths: SessionFacts["paths"] = [];

  for (const r of records) {
    const at = isoOr(r?.created_at, updatedAt);
    if (at > updatedAt) updatedAt = at;
    if (!Array.isArray(r?.tool_calls)) continue;
    for (const call of r.tool_calls) {
      const args = call?.args ?? call?.arguments;
      if (!args || typeof args !== "object") continue;
      if (typeof args.Cwd === "string" && args.Cwd.startsWith("/")) meta.cwd = args.Cwd;
      if (typeof call.name === "string" && WRITE_TOOL.test(call.name)) {
        const p = PATH_ARGS.map((k) => args[k]).find((v) => typeof v === "string" && v.startsWith("/"));
        if (p) paths.push({ absPath: p, action: "modified", at });
      }
    }
  }
  meta.updatedAt = updatedAt;
  // Without a cwd we cannot tell which repository this conversation belongs to.
  const cwd = meta.cwd as string | undefined;
  if (!cwd) return { facts: [], meta };
  return {
    facts: [{
      source: "antigravity",
      agentKind: "antigravity",
      sessionId: conversationId,
      cwd,
      ...(title ? { title } : {}),
      updatedAt,
      paths,
      commands: [],
    }],
    meta,
  };
}

async function loadTitles(): Promise<Map<string, string>> {
  const db = join(antigravityDir(), "conversation_summaries.db");
  const titles = new Map<string, string>();
  if (!existsSync(db)) return titles;
  const { default: Database } = await import("better-sqlite3");
  const conn = new Database(db, { readonly: true, fileMustExist: true });
  try {
    for (const row of conn.prepare("SELECT conversation_id, title FROM conversation_summaries").all() as any[]) {
      if (row.title) titles.set(row.conversation_id, row.title);
    }
  } finally {
    conn.close();
  }
  return titles;
}

let titleCache: { at: number; titles: Map<string, string> } | undefined;

export const antigravitySource: SessionSource = {
  id: "antigravity",
  label: "Antigravity (~/.gemini/antigravity)",
  agentKind: "antigravity",
  implemented: true,
  detect: () => existsSync(join(antigravityDir(), "brain")),
  async files(sinceMs) {
    const brain = join(antigravityDir(), "brain");
    if (!existsSync(brain)) return [];
    const out: SessionFile[] = [];
    for (const e of await readdir(brain, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const path = join(brain, e.name, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(path)) continue;
      const s = await stat(path);
      if (s.mtimeMs >= sinceMs) out.push({ path, size: s.size, mtimeMs: s.mtimeMs });
    }
    return out;
  },
  async parse(file, offset, meta) {
    if (!titleCache || Date.now() - titleCache.at > 60_000) {
      titleCache = { at: Date.now(), titles: await loadTitles() };
    }
    const conversationId = basename(dirname(dirname(dirname(file.path))));
    const records: any[] = [];
    const nextOffset = await readJsonlFrom(file.path, offset, (r) => records.push(r));
    const parsed = parseAntigravityRecords(conversationId, records, { ...meta }, titleCache.titles.get(conversationId));
    return { facts: parsed.facts, nextOffset, meta: parsed.meta };
  },
};
