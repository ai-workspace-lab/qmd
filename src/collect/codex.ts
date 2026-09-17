/**
 * collect/codex.ts - Codex CLI / Codex Desktop rollouts
 *
 *  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (and archived_sessions/)
 *    session_meta.payload   { id, cwd, originator, git? }
 *    turn_context.payload   { cwd }
 *    event_msg item_completed.item
 *      CommandExecution { command: string[], exit_code, status }
 *      FileChange       { changes: { "<abs path>": {...} } }
 *
 * Rollouts can be tens of MB, so parsing is strictly incremental.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isoOr, readJsonlFrom, type SessionFacts, type SessionFile, type SessionSource } from "./types.js";
import Database from "better-sqlite3";

export interface CodexPinnedTask {
  id: string;
  name: string;
  title: string;
  cwd: string;
  gitBranch?: string;
  updatedAt: string;
  position: number;
  projectName?: string;
}

export interface CodexProject {
  id: string;
  name: string;
  path: string;
}

export function readCodexState(home = homedir()): { pinned: CodexPinnedTask[]; projects: CodexProject[] } {
  const dbPath = join(home, ".codex", "state_5.sqlite");
  if (!existsSync(dbPath)) return { pinned: [], projects: [] };

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const projects: CodexProject[] = db.prepare(`
        SELECT p.id, p.name, pr.path
        FROM projects p
        JOIN project_roots pr ON p.id = pr.project_id
        ORDER BY LENGTH(pr.path) DESC
      `).all() as any;

      const pinnedRows = db.prepare(`
        SELECT t.id, t.name, t.title, t.cwd, t.git_branch, t.updated_at_ms, t.section_position
        FROM threads t
        JOIN thread_sections s ON t.thread_section_id = s.id
        WHERE s.name = 'Pinned' OR t.is_pinned = 1
        ORDER BY t.section_position ASC
      `).all() as any[];

      const pinned: CodexPinnedTask[] = pinnedRows.map((t, idx) => {
        const match = projects.find(
          (p) =>
            t.cwd === p.path ||
            t.cwd?.startsWith(p.path + "/") ||
            t.cwd?.endsWith("/" + p.name) ||
            t.cwd?.includes("/" + p.name + "/"),
        );
        return {
          id: t.id,
          name: t.name || (t.title ? t.title.slice(0, 60) : "Untitled"),
          title: t.title || t.name || "",
          cwd: t.cwd,
          gitBranch: t.git_branch || undefined,
          updatedAt: new Date(t.updated_at_ms || Date.now()).toISOString(),
          position: typeof t.section_position === "number" ? t.section_position : idx,
          projectName: match ? match.name : undefined,
        };
      });

      return { pinned, projects };
    } finally {
      db.close();
    }
  } catch {
    return { pinned: [], projects: [] };
  }
}

export function codexDirs(home = homedir()): string[] {
  return [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
}

function commandText(command: unknown): string | undefined {
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || command.length === 0) return undefined;
  const parts = command.map(String);
  // ["bash", "-lc", "<script>"] → the script is what the agent actually ran.
  if (parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]!) && /^-l?c$/.test(parts[1]!)) return parts.slice(2).join(" ");
  return parts.join(" ");
}

/** Parse Codex rollout records. Exported for fixture tests. */
export function parseCodexRecords(
  records: any[],
  meta: Record<string, unknown>,
): { facts: SessionFacts[]; meta: Record<string, unknown> } {
  let facts: SessionFacts | undefined;
  const ensure = (at: string): SessionFacts | undefined => {
    const sessionId = meta.sessionId as string | undefined;
    if (!sessionId) return undefined;
    if (!facts) {
      facts = {
        source: "codex",
        agentKind: "codex",
        sessionId,
        ...(meta.cwd ? { cwd: meta.cwd as string } : {}),
        ...(meta.branch ? { gitBranch: meta.branch as string } : {}),
        updatedAt: at,
        paths: [],
        commands: [],
      };
    }
    if (at > facts.updatedAt) facts.updatedAt = at;
    return facts;
  };

  for (const r of records) {
    const at = isoOr(r?.timestamp, new Date().toISOString());
    const p = r?.payload;
    if (!p || typeof p !== "object") continue;

    if (r.type === "session_meta") {
      const id = p.id ?? p.session_id;
      if (typeof id === "string") meta.sessionId = id;
      if (typeof p.cwd === "string") meta.cwd = p.cwd;
      if (p.git && typeof p.git.branch === "string") meta.branch = p.git.branch;
      ensure(at);
    } else if (r.type === "turn_context") {
      if (typeof p.cwd === "string" && p.cwd.startsWith("/")) {
        meta.cwd = p.cwd;
        if (facts) facts.cwd = p.cwd;
      }
    } else if (r.type === "event_msg" && p.type === "item_completed" && p.item) {
      const item = p.item;
      const f = ensure(at);
      if (!f) continue;
      if (item.type === "CommandExecution") {
        const command = commandText(item.command);
        if (!command) continue;
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
        f.commands.push({
          command,
          exitCode,
          ...(typeof item.cwd === "string" && item.cwd.startsWith("/") ? { cwd: item.cwd } : {}),
          at,
        });
      } else if (item.type === "FileChange" && item.changes && typeof item.changes === "object") {
        const paths = Array.isArray(item.changes)
          ? item.changes.map((c: any) => c?.path).filter((x: unknown) => typeof x === "string")
          : Object.keys(item.changes);
        for (const path of paths) f.paths.push({ absPath: path, action: "modified", at });
      }
    }
  }
  return { facts: facts ? [facts] : [], meta };
}

async function walk(dir: string, sinceMs: number): Promise<SessionFile[]> {
  if (!existsSync(dir)) return [];
  const out: SessionFile[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.startsWith("rollout-") || !e.name.endsWith(".jsonl")) continue;
    const path = join(e.parentPath ?? (e as any).path, e.name);
    const s = await stat(path);
    if (s.mtimeMs >= sinceMs) out.push({ path, size: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}

export const codexSource: SessionSource = {
  id: "codex",
  label: "Codex CLI / Desktop (~/.codex/sessions)",
  agentKind: "codex",
  implemented: true,
  detect: () => codexDirs().some((d) => existsSync(d)),
  async files(sinceMs) {
    return (await Promise.all(codexDirs().map((d) => walk(d, sinceMs)))).flat();
  },
  async parse(file, offset, meta) {
    const records: any[] = [];
    const nextOffset = await readJsonlFrom(file.path, offset, (r) => records.push(r));
    const parsed = parseCodexRecords(records, { ...meta });
    return { facts: parsed.facts, nextOffset, meta: parsed.meta };
  },
};
