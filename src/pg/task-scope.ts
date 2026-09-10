/**
 * pg/task-scope.ts - Environment sensing for the task coordination layer
 *
 * Every agent that claims a resource has to agree on *what project* it is
 * working in and *who it is*, without the operator hand-writing a string in
 * four different client configs. These helpers derive both from the git
 * checkout and the process environment.
 *
 * Nothing here touches the database — pure environment/git inspection so it can
 * be unit-tested and reused by the CLI and the MCP server alike.
 */

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/** Agent families we can recognise. `unknown` still coordinates fine. */
export type AgentKind = "claude" | "codex" | "opencode" | "antigravity" | "human" | "unknown";

function git(args: string[], cwd?: string): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const trimmed = out.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalise a git remote URL to a stable `host/owner/repo` scope key so SSH and
 * HTTPS clones of the same repository land on the same scope.
 *
 *   git@github.com:acme/widgets.git      → github.com/acme/widgets
 *   https://github.com/acme/widgets.git  → github.com/acme/widgets
 *   ssh://git@host:2222/acme/widgets     → host/acme/widgets
 */
export function normalizeRemote(remote: string): string | undefined {
  const raw = remote.trim();
  if (!raw) return undefined;

  // scp-like syntax: git@host:owner/repo(.git)
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
  let host: string | undefined;
  let path: string | undefined;

  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else if (scp && scp[1] && scp[2]) {
    host = scp[1];
    path = scp[2];
  } else {
    return undefined;
  }

  if (!host) return undefined;
  const cleaned = (path ?? "")
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return cleaned ? `${host}/${cleaned}` : host;
}

/**
 * Resolve the coordination scope (the "project" all agents share).
 *
 * Precedence: explicit override → $QMD_TASK_SCOPE → git remote → repo root
 * basename → cwd basename. The fallbacks keep the command usable outside a git
 * checkout; they just coordinate less widely.
 */
export function resolveScope(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = (override ?? "").trim();
  if (explicit) return explicit;

  const fromEnv = (env.QMD_TASK_SCOPE ?? "").trim();
  if (fromEnv) return fromEnv;

  const remote = git(["remote", "get-url", "origin"], cwd);
  if (remote) {
    const normalized = normalizeRemote(remote);
    if (normalized) return normalized;
  }

  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const base = (root ?? cwd).split("/").filter(Boolean).pop();
  return base ?? "default";
}

/** Detect which agent family this process belongs to, best-effort. */
export function resolveAgentKind(env: NodeJS.ProcessEnv = process.env): AgentKind {
  const explicit = (env.QMD_AGENT_KIND ?? "").trim().toLowerCase();
  if (
    explicit === "claude" ||
    explicit === "codex" ||
    explicit === "opencode" ||
    explicit === "antigravity" ||
    explicit === "human"
  ) {
    return explicit;
  }

  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_SESSION_ID) return "codex";
  if (env.OPENCODE || env.OPENCODE_CONFIG) return "opencode";
  if (env.ANTIGRAVITY || env.GEMINI_CLI || env.ANTIGRAVITY_SESSION_ID) return "antigravity";
  return "unknown";
}

/**
 * Stable identity for this agent. Two claims from the same agent must produce
 * the same id so re-claiming is idempotent rather than a self-collision.
 */
export function resolveAgentId(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = (override ?? "").trim();
  if (explicit) return explicit;

  const fromEnv = (env.QMD_AGENT_ID ?? "").trim();
  if (fromEnv) return fromEnv;

  const kind = resolveAgentKind(env);
  const session =
    env.CLAUDE_CODE_SESSION_ID ||
    env.CODEX_SESSION_ID ||
    env.ANTIGRAVITY_SESSION_ID ||
    env.QMD_SESSION_ID;
  if (session) return `${kind}:${session}`;

  // No session id available: fall back to host+pid. This is per-process, so a
  // restarted agent gets a new id and relies on TTL expiry to reclaim.
  return `${kind}:${hostname()}:${process.pid}`;
}

/** Current branch name, when inside a git checkout. */
export function resolveBranch(cwd: string = process.cwd()): string | undefined {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/** Current HEAD sha — recorded at claim time to detect base drift on release. */
export function resolveBaseSha(cwd: string = process.cwd()): string | undefined {
  return git(["rev-parse", "HEAD"], cwd);
}

/** Worktree root, so parallel worktrees of one repo are distinguishable. */
export function resolveWorktree(cwd: string = process.cwd()): string | undefined {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * How far the checkout has moved since `baseSha`, and how many of those commits
 * touched `resource`. Returns undefined when the comparison is not possible
 * (no git, unknown sha, shallow clone).
 */
export function describeDrift(
  baseSha: string | undefined,
  resource: string,
  cwd: string = process.cwd(),
): { commits: number; touching: number; head: string } | undefined {
  if (!baseSha) return undefined;
  const head = git(["rev-parse", "HEAD"], cwd);
  if (!head || head === baseSha) return undefined;

  const range = `${baseSha}..${head}`;
  const total = git(["rev-list", "--count", range], cwd);
  if (total === undefined) return undefined;

  // `--` guards against a resource name that also matches a ref.
  const touched = git(["rev-list", "--count", range, "--", resource], cwd);

  return {
    commits: Number.parseInt(total, 10) || 0,
    touching: Number.parseInt(touched ?? "0", 10) || 0,
    head,
  };
}
