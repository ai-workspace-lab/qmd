/**
 * collect/claude-code.ts - Claude Code CLI and Claude Desktop (Code) sessions
 *
 *  ~/.claude/projects/<slug>/<sessionId>.jsonl
 *    every record carries sessionId, cwd, gitBranch, timestamp; assistant
 *    tool_use blocks name edited files (Edit/Write/MultiEdit/NotebookEdit) and
 *    Bash commands; the matching user tool_result says whether a command failed.
 *
 *  ~/Library/Application Support/Claude/claude-code-sessions/**\/local_*.json
 *    Desktop session metadata: title, cwd and linked PRs, keyed to the CLI
 *    transcript by cliSessionId — so both land on the same session.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isoOr, readJsonlFrom, type SessionFacts, type SessionFile, type SessionSource } from "./types.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_PENDING = 200;

export function claudeProjectsDir(home = homedir()): string {
  return join(home, ".claude", "projects");
}

export function claudeDesktopDir(home = homedir()): string {
  return join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
}

async function walk(dir: string, match: (name: string) => boolean, sinceMs: number): Promise<SessionFile[]> {
  if (!existsSync(dir)) return [];
  const out: SessionFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const e of entries) {
    if (!e.isFile() || !match(e.name)) continue;
    const path = join(e.parentPath ?? (e as any).path, e.name);
    const s = await stat(path);
    if (s.mtimeMs >= sinceMs) out.push({ path, size: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}

/** Parse Claude Code transcript records. Exported for fixture tests. */
export function parseClaudeRecords(
  records: any[],
  meta: Record<string, unknown>,
): { facts: SessionFacts[]; meta: Record<string, unknown> } {
  const pending: Record<string, { command: string; at: string; cwd?: string; branch?: string }> = {
    ...((meta.pending as any) ?? {}),
  };
  let title = meta.title as string | undefined;
  const bySegment = new Map<string, SessionFacts>();

  const factsFor = (sessionId: string, cwd: string | undefined, branch: string | undefined, at: string) => {
    const key = `${sessionId}|${cwd ?? ""}|${branch ?? ""}`;
    let f = bySegment.get(key);
    if (!f) {
      f = {
        source: "claude-code",
        agentKind: "claude",
        sessionId,
        ...(cwd ? { cwd } : {}),
        ...(branch ? { gitBranch: branch } : {}),
        updatedAt: at,
        paths: [],
        commands: [],
      };
      bySegment.set(key, f);
    }
    if (at > f.updatedAt) f.updatedAt = at;
    return f;
  };

  for (const r of records) {
    if (r?.type === "custom-title" && typeof r.customTitle === "string") {
      title = r.customTitle;
      continue;
    }
    const sessionId = typeof r?.sessionId === "string" ? r.sessionId : (meta.sessionId as string | undefined);
    if (!sessionId) continue;
    meta.sessionId = sessionId;
    const at = isoOr(r.timestamp, new Date().toISOString());
    const cwd = typeof r.cwd === "string" ? r.cwd : undefined;
    const branch = typeof r.gitBranch === "string" && r.gitBranch ? r.gitBranch : undefined;
    const content = Array.isArray(r.message?.content) ? r.message.content : [];

    if (r.type === "assistant") {
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const input = block.input ?? {};
        if (EDIT_TOOLS.has(block.name)) {
          const p = input.file_path ?? input.notebook_path;
          if (typeof p === "string") factsFor(sessionId, cwd, branch, at).paths.push({ absPath: p, action: "modified", at });
        } else if (block.name === "Bash" && typeof input.command === "string" && typeof block.id === "string") {
          pending[block.id] = { command: input.command, at, ...(cwd ? { cwd } : {}), ...(branch ? { branch } : {}) };
        }
      }
    } else if (r.type === "user") {
      for (const block of content) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const call = pending[block.tool_use_id];
        if (!call) continue;
        delete pending[block.tool_use_id];
        const interrupted = r.toolUseResult && typeof r.toolUseResult === "object" && r.toolUseResult.interrupted;
        factsFor(sessionId, call.cwd, call.branch, at).commands.push({
          command: call.command,
          exitCode: interrupted ? null : block.is_error ? 1 : 0,
          at: call.at,
        });
      }
    }
  }

  if (title) {
    for (const f of bySegment.values()) f.title = title;
    meta.title = title;
  }
  const ids = Object.keys(pending);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PENDING))) delete pending[id];
  meta.pending = pending;
  return { facts: [...bySegment.values()], meta };
}

export const claudeCodeSource: SessionSource = {
  id: "claude-code",
  label: "Claude Code CLI (~/.claude/projects)",
  agentKind: "claude",
  implemented: true,
  detect: () => existsSync(claudeProjectsDir()),
  files: (sinceMs) => walk(claudeProjectsDir(), (n) => n.endsWith(".jsonl"), sinceMs),
  async parse(file, offset, meta) {
    const records: any[] = [];
    const nextOffset = await readJsonlFrom(file.path, offset, (r) => records.push(r));
    const parsed = parseClaudeRecords(records, { ...meta });
    return { facts: parsed.facts, nextOffset, meta: parsed.meta };
  },
};

const PR_STATES: Record<string, "open" | "merged" | "closed"> = { open: "open", merged: "merged", closed: "closed" };

/** Parse one Claude Desktop session metadata document. Exported for fixture tests. */
export function parseClaudeDesktopSession(doc: any, mtimeMs: number): SessionFacts[] {
  const sessionId = typeof doc?.cliSessionId === "string" ? doc.cliSessionId : undefined;
  const cwd = typeof doc?.cwd === "string" ? doc.cwd : typeof doc?.originCwd === "string" ? doc.originCwd : undefined;
  if (!sessionId || !cwd) return [];
  const updatedAt = isoOr(doc.lastActivityAt, new Date(mtimeMs).toISOString());
  const base = {
    source: "claude-code",
    agentKind: "claude" as const,
    sessionId,
    cwd,
    ...(typeof doc.title === "string" && doc.title ? { title: doc.title } : {}),
    updatedAt,
    paths: [],
    commands: [],
  };
  const prs = Array.isArray(doc.prs) ? doc.prs.filter((p: any) => p && !p.dismissed && Number.isInteger(p.prNumber)) : [];
  if (prs.length === 0) return [base];
  return prs.map((p: any) => ({
    ...base,
    prNumber: p.prNumber,
    ...(typeof p.branch === "string" && p.branch ? { gitBranch: p.branch } : {}),
    ...(PR_STATES[String(p.state ?? "").toLowerCase()] ? { prState: PR_STATES[String(p.state).toLowerCase()] } : {}),
  }));
}

export const claudeDesktopSource: SessionSource = {
  id: "claude-desktop",
  label: "Claude Desktop Code sessions (title, PRs)",
  agentKind: "claude",
  implemented: true,
  detect: () => existsSync(claudeDesktopDir()),
  files: (sinceMs) => walk(claudeDesktopDir(), (n) => n.startsWith("local_") && n.endsWith(".json"), sinceMs),
  async parse(file, _offset, meta) {
    const doc = JSON.parse(await readFile(file.path, "utf8"));
    return { facts: parseClaudeDesktopSession(doc, file.mtimeMs), nextOffset: file.size, meta };
  },
};
