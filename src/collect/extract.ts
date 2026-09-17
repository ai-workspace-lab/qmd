/**
 * collect/extract.ts - Rule-based extraction of important session facts
 *
 * Deterministic only. What a transcript reveals with certainty — which repo and
 * branch, which files were changed, which test commands ran and whether they
 * passed, the session title — becomes context items. Anything needing judgement
 * (goals beyond the title, decisions, pitfalls) is left to agents writing
 * through the MCP tools, or a later optional LLM pass.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { resolveBaseSha, resolveBranch, resolveScope, resolveWorktree } from "../pg/task-scope.js";
import { isRepoRelativePath, normalizeText, type IncomingItem } from "../pg/context-merge.js";
import type { SessionFacts } from "./types.js";

/** Commands whose result is worth sharing as a verification record. */
export const VERIFY_COMMAND =
  /\b(go (test|vet)|vitest|bun test|(npm|pnpm|yarn)( run)? test|npx vitest|pytest|make (test|check|lint)|cargo (test|clippy)|tsc --noEmit|golangci-lint|terraform validate|helm lint)\b/;

const MAX_COMMAND_CHARS = 300;
/** Sessions this recent may borrow the checkout's current branch/HEAD. */
const LIVE_CHECKOUT_MS = 24 * 60 * 60 * 1000;

export interface ExtractedSession {
  facts: SessionFacts;
  scope: string;
  headBranch?: string;
  headSha?: string;
  prNumber?: number;
  prState?: "open" | "merged" | "closed";
  items: IncomingItem[];
}

export type SkipReason = "no_cwd" | "cwd_missing" | "not_a_repo";

export interface ExtractOutcome {
  /** One entry per repository the session touched. */
  sessions: ExtractedSession[];
  /** Set when nothing in the session could be attributed to a repository. */
  skipped?: SkipReason;
}

/** Replace machine-specific prefixes so shared command text carries no home or repo paths. */
export function scrubCommand(command: string, repoRoot: string, home = homedir()): string {
  let text = command;
  if (repoRoot) text = text.split(repoRoot).join(".");
  if (home) text = text.split(home).join("~");
  return normalizeText(text);
}

/** Pick the segment of a compound shell command that actually ran the check. */
export function verificationSegment(command: string): string | undefined {
  if (!VERIFY_COMMAND.test(command)) return undefined;
  const segments = command.split(/\s*(?:&&|\|\||;|\n)\s*/);
  const hit = segments.find((s) => VERIFY_COMMAND.test(s)) ?? command;
  const text = normalizeText(hit.replace(/\s*\|.*$/, "").replace(/\s*2>&1.*$/, ""));
  return text.length > MAX_COMMAND_CHARS ? text.slice(0, MAX_COMMAND_CHARS) : text;
}

export function toRepoRelative(absPath: string, repoRoot: string): string | undefined {
  if (!isAbsolute(absPath)) return isRepoRelativePath(absPath) ? normalizeText(absPath) : undefined;
  const rel = relative(repoRoot, absPath);
  return rel && isRepoRelativePath(rel) ? rel : undefined;
}

/** `cd <dir> && …` at the start of a command moves where it ran. */
function leadingCd(command: string, base: string): string | undefined {
  const m = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/.exec(command);
  const dir = m?.[2] ?? m?.[3] ?? m?.[4];
  if (!dir || dir.includes("$")) return undefined;
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return isAbsolute(dir) ? dir : resolvePath(base, dir);
}

/**
 * Turn one session's raw facts into per-repository context. Sessions are often
 * started from a directory holding several checkouts, so every path and command
 * is attributed to the repository it actually lives in, not the launch cwd.
 */
export function extractSession(facts: SessionFacts, now = Date.now()): ExtractOutcome {
  if (!facts.cwd) return { sessions: [], skipped: "no_cwd" };
  if (!existsSync(facts.cwd)) return { sessions: [], skipped: "cwd_missing" };

  const rootCache = new Map<string, string | undefined>();
  const repoOf = (dir: string): string | undefined => {
    if (!rootCache.has(dir)) rootCache.set(dir, existsSync(dir) ? resolveWorktree(dir) : undefined);
    return rootCache.get(dir);
  };

  const launchRoot = repoOf(facts.cwd);
  const recent = now - new Date(facts.updatedAt).getTime() < LIVE_CHECKOUT_MS;
  // "HEAD" is what clients record when launched outside a repo or detached.
  const recordedBranch = facts.gitBranch && facts.gitBranch !== "HEAD" ? facts.gitBranch : undefined;

  const byRoot = new Map<string, { paths: SessionFacts["paths"]; commands: Array<SessionFacts["commands"][number] & { root: string }> }>();
  const bucket = (root: string) => {
    let b = byRoot.get(root);
    if (!b) byRoot.set(root, (b = { paths: [], commands: [] }));
    return b;
  };
  if (launchRoot) bucket(launchRoot);

  for (const p of facts.paths) {
    const abs = isAbsolute(p.absPath) ? p.absPath : resolvePath(facts.cwd, p.absPath);
    let dir = dirname(abs);
    while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir); // file may have been deleted
    const root = repoOf(dir);
    if (root) bucket(root).paths.push({ ...p, absPath: abs });
  }
  for (const c of facts.commands) {
    const base = c.cwd && isAbsolute(c.cwd) ? c.cwd : facts.cwd;
    const dir = leadingCd(c.command, base) ?? base;
    const root = repoOf(dir);
    if (root) bucket(root).commands.push({ ...c, root });
  }

  if (byRoot.size === 0) return { sessions: [], skipped: "not_a_repo" };

  const sessions: ExtractedSession[] = [];
  for (const [root, b] of byRoot) {
    const scope = resolveScope(undefined, {}, root);
    const liveBranch = resolveBranch(root);
    const isLaunchRepo = root === launchRoot;
    const headBranch = (isLaunchRepo ? recordedBranch : undefined) ?? (recent ? liveBranch : undefined);
    const headSha = recent && headBranch && headBranch === liveBranch ? resolveBaseSha(root) : undefined;

    const items: IncomingItem[] = [];
    if (facts.title && (isLaunchRepo || !launchRoot)) items.push({ kind: "goal", text: facts.title, at: facts.updatedAt });

    const seenPaths = new Set<string>();
    for (const p of b.paths) {
      const rel = toRepoRelative(p.absPath, root);
      if (!rel || seenPaths.has(rel)) continue;
      seenPaths.add(rel);
      items.push({ kind: "path", text: rel, detail: p.action, at: p.at, ...(headSha ? { gitHead: headSha } : {}) });
    }

    // Last result per command wins within one batch; the merge rules rank across batches.
    const verifications = new Map<string, IncomingItem>();
    for (const c of b.commands) {
      if (c.exitCode === null) continue;
      const segment = verificationSegment(c.command);
      if (!segment) continue;
      const text = scrubCommand(segment, root);
      verifications.set(text, {
        kind: "verification",
        text,
        status: c.exitCode === 0 ? "pass" : "fail",
        at: c.at,
        ...(headSha ? { gitHead: headSha } : {}),
      });
    }
    items.push(...verifications.values());

    sessions.push({
      facts,
      scope,
      ...(headBranch ? { headBranch } : {}),
      ...(headSha ? { headSha } : {}),
      ...(isLaunchRepo && facts.prNumber ? { prNumber: facts.prNumber } : {}),
      ...(isLaunchRepo && facts.prState ? { prState: facts.prState } : {}),
      items,
    });
  }
  return { sessions };
}
