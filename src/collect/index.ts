/**
 * collect/index.ts - Run local session collectors into the shared context store
 *
 * One pass: for every detected source, read session files changed since the
 * cursor, extract important facts, resolve each to its PR/branch thread and
 * merge. Batches carry a deterministic clientRequestId derived from the file
 * and byte range, so a crashed or repeated run never double-counts.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PgContextStore } from "../pg/context-store.js";
import { findSecret } from "./redact.js";
import { extractSession } from "./extract.js";
import { claudeCodeSource, claudeDesktopSource } from "./claude-code.js";
import { codexSource, readCodexState } from "./codex.js";
import { antigravitySource } from "./antigravity.js";
import { opencodeSource } from "./opencode.js";
import type { SessionSource } from "./types.js";

export const SOURCES: SessionSource[] = [
  claudeCodeSource,
  claudeDesktopSource,
  codexSource,
  antigravitySource,
  opencodeSource,
];

export interface CollectOptions {
  store?: PgContextStore;
  sources?: string[];
  sinceMs: number;
  dryRun?: boolean;
  onFileError?: (path: string, err: Error) => void;
}

export interface CollectThreadReport {
  scope: string;
  headBranch: string | null;
  prNumber: number | null;
  sources: Set<string>;
  sessions: Set<string>;
  items: Record<string, number>;
  merged: { inserted: number; updated: number; touched: number; rejected: number };
}

export interface CollectReport {
  files: number;
  filesSkippedUnchanged: number;
  sessions: number;
  skipped: Record<string, number>;
  secretsDropped: number;
  threads: Map<string, CollectThreadReport>;
  errors: Array<{ path: string; message: string }>;
}

function threadLabel(scope: string, branch?: string, pr?: number): string {
  return pr ? `${scope}#${pr}` : `${scope}@${branch ?? "?"}`;
}

async function syncAppCatalogs(store: PgContextStore): Promise<void> {
  // 1. Codex state (projects & pinned tasks)
  try {
    const codexState = readCodexState();
    if (codexState.projects.length > 0) {
      await store.upsertSharedProjects(
        codexState.projects.map((p) => ({
          id: p.id,
          name: p.name,
          rootPath: p.path,
          source: "codex",
        })),
      );
    }
    if (codexState.pinned.length > 0) {
      await store.upsertPinnedTasks(
        codexState.pinned.map((p) => ({
          id: p.id,
          source: "codex",
          title: p.name,
          cwd: p.cwd,
          projectName: p.projectName,
          gitBranch: p.gitBranch,
          position: p.position,
          updatedAt: p.updatedAt,
        })),
      );
    }
  } catch {
    // Ignore error reading codex state
  }

  // 2. Claude projects from ~/.claude.json
  try {
    const claudeJsonPath = join(homedir(), ".claude.json");
    if (existsSync(claudeJsonPath)) {
      const content = JSON.parse(await readFile(claudeJsonPath, "utf8"));
      if (content.projects && typeof content.projects === "object") {
        const claudeProjects = Object.keys(content.projects).map((rootPath) => ({
          id: `claude:${rootPath.split("/").pop() || "project"}`,
          name: rootPath.split("/").pop() || "project",
          rootPath,
          source: "claude",
        }));
        if (claudeProjects.length > 0) {
          await store.upsertSharedProjects(claudeProjects);
        }
      }
    }
  } catch {
    // Ignore error reading claude json
  }
}

export async function runCollect(opts: CollectOptions): Promise<CollectReport> {
  const report: CollectReport = {
    files: 0,
    filesSkippedUnchanged: 0,
    sessions: 0,
    skipped: {},
    secretsDropped: 0,
    threads: new Map(),
    errors: [],
  };
  const skip = (reason: string) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };

  if (opts.store && !opts.dryRun) {
    await syncAppCatalogs(opts.store);
  }

  const selected = SOURCES.filter(
    (s) => s.implemented && s.detect() && (!opts.sources?.length || opts.sources.includes(s.id)),
  );

  for (const source of selected) {
    const files = await source.files(opts.sinceMs);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of files) {
      try {
        const cursor = opts.store ? await opts.store.getCursor(source.id, file.path) : null;
        if (cursor && cursor.size === file.size && cursor.mtimeMs === Math.floor(file.mtimeMs)) {
          report.filesSkippedUnchanged++;
          continue;
        }
        // A file that shrank was rewritten: start over.
        const fromOffset = cursor && file.size >= cursor.offset ? cursor.offset : 0;
        const meta = cursor && fromOffset > 0 ? cursor.meta : {};
        const parsed = await source.parse(file, fromOffset, meta);
        report.files++;

        const fileKey = createHash("sha1").update(file.path).digest("hex").slice(0, 16);
        let index = 0;
        for (const facts of parsed.facts) {
          index++;
          const outcome = extractSession(facts);
          if (outcome.skipped) {
            skip(outcome.skipped);
            continue;
          }
          for (const s of outcome.sessions) {
            const items = s.items.filter((item) => {
              if (!findSecret(`${item.text} ${item.detail ?? ""}`)) return true;
              report.secretsDropped++;
              return false;
            });
            if (items.length === 0) {
              skip("no_items");
              continue;
            }
            report.sessions++;

            const label = threadLabel(s.scope, s.headBranch, s.prNumber);
            let t = report.threads.get(label);
            if (!t) {
              t = {
                scope: s.scope,
                headBranch: s.headBranch ?? null,
                prNumber: s.prNumber ?? null,
                sources: new Set(),
                sessions: new Set(),
                items: {},
                merged: { inserted: 0, updated: 0, touched: 0, rejected: 0 },
              };
              report.threads.set(label, t);
            }
            t.sources.add(source.id);
            t.sessions.add(`${facts.source}:${facts.sessionId}`);
            for (const item of items) t.items[item.kind] = (t.items[item.kind] ?? 0) + 1;

            if (opts.dryRun || !opts.store) continue;

            const resolved = await opts.store.resolveThread({
              scope: s.scope,
              ...(s.headBranch ? { headBranch: s.headBranch } : {}),
              ...(s.prNumber ? { prNumber: s.prNumber } : {}),
              ...(s.prState ? { prState: s.prState } : {}),
              ...(s.headSha ? { headSha: s.headSha } : {}),
            });
            if (!resolved.ok) {
              skip("default_branch_needs_explicit_thread");
              continue;
            }
            const sessionId = await opts.store.attachSession(resolved.thread.id, {
              source: facts.source,
              sourceSessionId: facts.sessionId,
              agentKind: facts.agentKind,
              ...(facts.title ? { title: facts.title } : {}),
              ...(s.headSha ? { headSha: s.headSha } : {}),
            });
            const merged = await opts.store.mergeItems(resolved.thread.id, sessionId, items, {
              clientRequestId: `collect:${source.id}:${fileKey}:${fromOffset}-${parsed.nextOffset}:${index}:${s.scope}`,
            });
            t.merged.inserted += merged.inserted;
            t.merged.updated += merged.updated;
            t.merged.touched += merged.touched;
            t.merged.rejected += merged.rejected.length;
          }
        }

        if (!opts.dryRun && opts.store) {
          await opts.store.setCursor(source.id, file.path, {
            size: file.size,
            mtimeMs: Math.floor(file.mtimeMs),
            offset: parsed.nextOffset,
            meta: parsed.meta,
          });
        }
      } catch (err) {
        report.errors.push({ path: file.path, message: (err as Error).message });
        opts.onFileError?.(file.path, err as Error);
      }
    }
  }
  return report;
}
