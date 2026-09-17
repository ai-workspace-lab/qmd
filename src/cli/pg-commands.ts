/**
 * cli/pg-commands.ts - `qmd memory` and `qmd pg` command handlers.
 *
 * These drive the PostgreSQL memory bridge. They own their own bridge lifecycle
 * (connection pool + embedder) and are no-ops for the default SQLite backend.
 */

import {
  openMemoryBridge,
  openTaskBridge,
  redactConnectionString,
  resolveBranch,
  resolveBaseSha,
  resolveWorktree,
  describeDrift,
} from "../pg/index.js";
import type { TaskClaim } from "../pg/index.js";
import { openContextBridge, resolveScope, resolveAgentId, resolveAgentKind, ITEM_KINDS } from "../pg/index.js";
import type { IncomingItem, ItemKind } from "../pg/index.js";
import { renderBriefing } from "../pg/context-brief.js";
import { SOURCES, runCollect } from "../collect/index.js";

// Minimal ANSI helpers (kept local to avoid coupling to the formatter).
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

type Values = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function memoryHelp(): void {
  console.error(`Usage: qmd memory <add|search|get|rm|ls|namespaces> [options]

Commands:
  qmd memory add <key> [text]      Store/replace a memory (text from arg or stdin)
  qmd memory search <query...>     Hybrid search (pg_jieba FTS + pgvector, RRF fused)
  qmd memory get <key>             Fetch a memory's full body
  qmd memory rm <key>              Soft-delete a memory
  qmd memory ls                    List memories in the namespace
  qmd memory namespaces            List namespaces and counts

Options:
  --namespace <ns>   Tenant namespace (default: $QMD_NAMESPACE or "default")
  --title <text>     Title for 'add'
  -n <num>           Max results for 'search'/'ls'
  --full             Return full body in 'search'
  --json             JSON output

Requires: QMD_BACKEND=pg and QMD_PG_URL (see docs/plan/pg-backend-memory-bridge.md)`);
}

/** Handle `qmd memory ...`. Returns a process exit code. */
export async function runMemoryCommand(args: string[], values: Values): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help") {
    memoryHelp();
    return sub ? 0 : 1;
  }

  const json = !!values.json;
  const namespace = str(values.namespace);
  const limit = values.n ? parseInt(String(values.n), 10) || undefined : undefined;

  let bridge;
  try {
    bridge = await openMemoryBridge();
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  }

  try {
    switch (sub) {
      case "add": {
        const key = args[1];
        if (!key) {
          console.error("Usage: qmd memory add <key> [text]   (text may be piped via stdin)");
          return 1;
        }
        const inline = args.slice(2).join(" ").trim();
        const body = inline || (await readStdin());
        if (!body) {
          console.error(`${C.red}✗${C.reset} No body provided (pass text or pipe via stdin)`);
          return 1;
        }
        const res = await bridge.store.addMemory({
          key,
          body,
          ...(str(values.title) ? { title: str(values.title)! } : {}),
          ...(namespace ? { namespace } : {}),
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(
            `${C.green}✓${C.reset} stored ${C.bold}${res.key}${C.reset} ` +
              `${C.dim}#${res.docid} · ${res.chunks} chunk(s) · ${res.embedded ? "embedded" : "no embedding"} · ns=${res.namespace}${C.reset}`,
          );
        }
        return 0;
      }

      case "search":
      case "query": {
        const query = args.slice(1).join(" ").trim();
        if (!query) {
          console.error("Usage: qmd memory search <query...>");
          return 1;
        }
        const results = await bridge.store.searchMemory(query, {
          ...(namespace ? { namespace } : {}),
          ...(limit ? { limit } : {}),
          full: !!values.full,
        });
        if (json) {
          console.log(JSON.stringify(results, null, 2));
          return 0;
        }
        if (results.length === 0) {
          console.log(`${C.dim}No matches.${C.reset}`);
          return 0;
        }
        for (const r of results) {
          const signals = [
            r.lexRank ? `lex#${r.lexRank}` : null,
            r.vecRank ? `vec#${r.vecRank}` : null,
          ]
            .filter(Boolean)
            .join(" ");
          console.log(
            `${C.cyan}${r.key}${C.reset} ${C.dim}#${r.docid} · score ${r.score.toFixed(4)} · ${signals}${C.reset}`,
          );
          if (r.title) console.log(`  ${C.bold}${r.title}${C.reset}`);
          console.log(`  ${r.body.replace(/\n/g, "\n  ")}`);
          console.log("");
        }
        return 0;
      }

      case "get": {
        const key = args[1];
        if (!key) {
          console.error("Usage: qmd memory get <key>");
          return 1;
        }
        const rec = await bridge.store.getMemory(key, namespace ? { namespace } : undefined);
        if (!rec) {
          console.error(`${C.red}✗${C.reset} not found: ${key}`);
          return 1;
        }
        if (json) {
          console.log(JSON.stringify(rec, null, 2));
        } else {
          if (rec.title) console.log(`${C.bold}${rec.title}${C.reset}`);
          console.log(rec.body);
        }
        return 0;
      }

      case "rm":
      case "remove":
      case "delete": {
        const key = args[1];
        if (!key) {
          console.error("Usage: qmd memory rm <key>");
          return 1;
        }
        const ok = await bridge.store.deleteMemory(key, namespace ? { namespace } : undefined);
        console.log(ok ? `${C.green}✓${C.reset} removed ${key}` : `${C.dim}not found: ${key}${C.reset}`);
        return ok ? 0 : 1;
      }

      case "ls":
      case "list": {
        const rows = await bridge.store.listMemories({
          ...(namespace ? { namespace } : {}),
          ...(limit ? { limit } : {}),
        });
        if (json) {
          console.log(JSON.stringify(rows, null, 2));
          return 0;
        }
        if (rows.length === 0) {
          console.log(`${C.dim}No memories.${C.reset}`);
          return 0;
        }
        for (const r of rows) {
          console.log(`${C.cyan}${r.key}${C.reset} ${C.dim}#${r.docid}${C.reset}  ${r.title}`);
        }
        return 0;
      }

      case "namespaces":
      case "ns": {
        const rows = await bridge.store.listNamespaces();
        if (json) {
          console.log(JSON.stringify(rows, null, 2));
          return 0;
        }
        for (const r of rows) console.log(`${r.namespace}  ${C.dim}(${r.count})${C.reset}`);
        return 0;
      }

      default:
        memoryHelp();
        return 1;
    }
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  } finally {
    await bridge.dispose();
  }
}

/** Handle `qmd pg ...`. Returns a process exit code. */
export async function runPgCommand(args: string[], values: Values): Promise<number> {
  const sub = args[0] ?? "status";
  if (sub !== "status" && sub !== "health") {
    console.error("Usage: qmd pg status");
    return 1;
  }

  let bridge;
  try {
    bridge = await openMemoryBridge();
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  }

  try {
    const health = await bridge.store.health();
    const payload = {
      backend: "pg",
      connection: redactConnectionString(bridge.config.connectionString),
      namespace: health.namespace,
      server: health.server,
      fts: health.fts,
      memories: health.memories,
    };
    if (values.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`${C.green}✓${C.reset} PostgreSQL memory backend`);
      console.log(`  connection : ${payload.connection}`);
      console.log(`  namespace  : ${payload.namespace}`);
      console.log(`  server     : ${payload.server.split(" ").slice(0, 2).join(" ")}`);
      console.log(
        `  fts        : ${health.fts.config}${health.fts.trigram ? " +pg_trgm" : ""}${health.fts.vector ? " +pgvector" : ""}`,
      );
      console.log(`  memories   : ${health.memories} (this namespace)`);
    }
    return 0;
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  } finally {
    await bridge.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `qmd task` — multi-agent coordination
// ─────────────────────────────────────────────────────────────────────────────

function taskHelp(): void {
  console.error(`Usage: qmd task <claim|who|release|heartbeat|ls|history|scopes|status> [options]

Commands:
  qmd task claim <resource>      Take an advisory claim on a file/area
  qmd task who <resource>        Who holds it (exit 1 if held by another agent)
  qmd task release <resource>    Finish a claim (reports base drift)
  qmd task heartbeat <resource>  Extend a claim you hold
  qmd task ls                    Live claims in this scope
  qmd task history               Recently finished claims
  qmd task scopes                Every scope with live claims
  qmd task status                Backend + scope + identity

Options:
  --intent <text>    What you are about to do (claim)
  --ttl <seconds>    Claim lifetime, default 1800
  --scope <key>      Project key (default: derived from git remote)
  --agent <id>       Agent identity (default: $QMD_AGENT_ID or auto)
  --status <s>       done | abandoned (release)
  --note <text>      Note recorded on release
  --pr <number>      Associated PR
  --force            Steal a live claim / release someone else's
  --stale            Include TTL-lapsed claims in 'ls'
  --json             JSON output

Claims are ADVISORY: a missed claim costs coordination, never correctness.
Requires: QMD_BACKEND=pg and QMD_PG_URL (see docs/plan/agent-task-coordination.md)`);
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function printClaim(c: TaskClaim, self: string): void {
  const mine = c.agentId === self;
  const marker = mine ? `${C.green}●${C.reset}` : `${C.cyan}●${C.reset}`;
  const staleTag = c.stale ? ` ${C.red}[stale]${C.reset}` : "";
  console.log(`${marker} ${C.bold}${c.resource}${C.reset}${staleTag}`);
  console.log(
    `    ${mine ? "you" : c.agentId} ${C.dim}(${c.agentKind})${C.reset}` +
      `${c.branch ? ` ${C.dim}on ${c.branch}${C.reset}` : ""}` +
      ` ${C.dim}· ${age(c.claimedAt)}${C.reset}`,
  );
  if (c.intent) console.log(`    ${C.dim}↳${C.reset} ${c.intent}`);
}

/** Handle `qmd task ...`. Returns a process exit code. */
export async function runTaskCommand(args: string[], values: Values): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help") {
    taskHelp();
    return sub ? 0 : 1;
  }

  const json = !!values.json;
  const resource = args[1];
  const ttlRaw = parseInt(String(values.ttl ?? ""), 10);
  const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;
  const prRaw = parseInt(String(values.pr ?? ""), 10);

  let bridge;
  try {
    bridge = await openTaskBridge({
      ...(str(values.scope) ? { scope: str(values.scope)! } : {}),
      ...(str(values.agent) ? { agentId: str(values.agent)! } : {}),
    });
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  }

  const { store, scope, agentId, agentKind } = bridge;

  try {
    switch (sub) {
      case "claim": {
        if (!resource) {
          console.error("Usage: qmd task claim <resource> --intent '...'");
          return 1;
        }
        const res = await store.claim({
          scope,
          resource,
          agentId,
          agentKind,
          intent: str(values.intent) ?? "",
          ...(resolveBranch() ? { branch: resolveBranch()! } : {}),
          ...(resolveWorktree() ? { worktree: resolveWorktree()! } : {}),
          ...(resolveBaseSha() ? { baseSha: resolveBaseSha()! } : {}),
          ...(Number.isFinite(prRaw) ? { prNumber: prRaw } : {}),
          ...(ttlSeconds ? { ttlSeconds } : {}),
          force: !!values.force,
        });

        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return res.ok ? 0 : 1;
        }
        if (!res.ok) {
          console.error(
            `${C.red}✗${C.reset} ${C.bold}${resource}${C.reset} is already claimed`,
          );
          printClaim(res.holder, agentId);
          console.error(
            `${C.dim}  Coordinate with them, pick another file, or --force to take it.${C.reset}`,
          );
          return 1;
        }
        const verb = res.reclaimed ? "refreshed" : res.stolen ? "took over" : "claimed";
        console.log(
          `${C.green}✓${C.reset} ${verb} ${C.bold}${resource}${C.reset} ` +
            `${C.dim}· ttl ${res.claim.ttlSeconds}s · scope ${scope}${C.reset}`,
        );
        return 0;
      }

      case "who": {
        if (!resource) {
          console.error("Usage: qmd task who <resource>");
          return 1;
        }
        const holders = await store.who(scope, resource);
        if (json) {
          console.log(JSON.stringify(holders, null, 2));
        } else if (holders.length === 0) {
          console.log(`${C.dim}unclaimed: ${resource}${C.reset}`);
        } else {
          for (const h of holders) printClaim(h, agentId);
        }
        // Exit 1 only when someone *else* holds it, so a pre-write hook can do
        // `qmd task who "$f" || warn` without tripping on its own claim.
        return holders.some((h) => h.agentId !== agentId) ? 1 : 0;
      }

      case "release": {
        if (!resource) {
          console.error("Usage: qmd task release <resource>");
          return 1;
        }
        const statusRaw = str(values.status);
        const status =
          statusRaw === "abandoned" ? "abandoned" : ("done" as "done" | "abandoned");
        const released = await store.release(scope, resource, {
          agentId,
          status,
          ...(str(values.note) ? { note: str(values.note)! } : {}),
          force: !!values.force,
        });
        if (!released) {
          console.error(
            `${C.red}✗${C.reset} no live claim of yours on ${resource} ` +
              `${C.dim}(use --force to release another agent's)${C.reset}`,
          );
          return 1;
        }
        const drift = describeDrift(released.baseSha ?? undefined, resource);
        if (json) {
          console.log(JSON.stringify({ ...released, drift: drift ?? null }, null, 2));
          return 0;
        }
        console.log(`${C.green}✓${C.reset} released ${C.bold}${resource}${C.reset} (${status})`);
        if (drift) {
          console.log(
            `${C.red}⚠${C.reset}  base drifted: claimed at ${C.bold}${released.baseSha?.slice(0, 7)}${C.reset}, ` +
              `now ${C.bold}${drift.head.slice(0, 7)}${C.reset} ` +
              `(${drift.commits} commit(s), ${drift.touching} touching this file)`,
          );
          if (drift.touching > 0) console.log(`   ${C.dim}rebase before you push.${C.reset}`);
        }
        return 0;
      }

      case "heartbeat":
      case "hb": {
        if (!resource) {
          console.error("Usage: qmd task heartbeat <resource>");
          return 1;
        }
        const ok = await store.heartbeat(scope, resource, agentId);
        if (json) console.log(JSON.stringify({ ok }));
        else
          console.log(
            ok
              ? `${C.green}✓${C.reset} extended ${resource}`
              : `${C.dim}no live claim of yours on ${resource}${C.reset}`,
          );
        return ok ? 0 : 1;
      }

      case "ls":
      case "list":
      case "board": {
        const rows = await store.list(scope, {
          includeStale: !!values.stale,
          ...(values.n ? { limit: parseInt(String(values.n), 10) || 200 } : {}),
        });
        if (json) {
          console.log(JSON.stringify(rows, null, 2));
          return 0;
        }
        console.log(`${C.dim}scope: ${scope}${C.reset}`);
        if (rows.length === 0) {
          console.log(`${C.dim}No live claims.${C.reset}`);
          return 0;
        }
        for (const r of rows) printClaim(r, agentId);
        return 0;
      }

      case "history": {
        const rows = await store.history(
          scope,
          values.n ? parseInt(String(values.n), 10) || 20 : 20,
        );
        if (json) {
          console.log(JSON.stringify(rows, null, 2));
          return 0;
        }
        for (const r of rows) {
          console.log(
            `${C.dim}${r.releasedAt ? age(r.releasedAt) : "?"}${C.reset}  ` +
              `${r.status === "done" ? C.green : C.dim}${r.status}${C.reset}  ` +
              `${r.resource}  ${C.dim}${r.agentId}${C.reset}`,
          );
        }
        return 0;
      }

      case "scopes": {
        const rows = await store.scopes();
        if (json) {
          console.log(JSON.stringify(rows, null, 2));
          return 0;
        }
        for (const r of rows) console.log(`${r.scope}  ${C.dim}(${r.active} active)${C.reset}`);
        return 0;
      }

      case "status": {
        const health = await store.health(scope);
        const payload = {
          backend: "pg",
          connection: redactConnectionString(bridge.config.connectionString),
          scope,
          agentId,
          agentKind,
          server: health.server,
          activeClaims: health.active,
        };
        if (json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(`${C.green}✓${C.reset} task coordination`);
          console.log(`  connection : ${payload.connection}`);
          console.log(`  scope      : ${payload.scope}`);
          console.log(`  agent      : ${payload.agentId} ${C.dim}(${payload.agentKind})${C.reset}`);
          console.log(`  active     : ${payload.activeClaims} claim(s)`);
        }
        return 0;
      }

      default:
        taskHelp();
        return 1;
    }
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  } finally {
    await bridge.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// qmd ctx — shared task context
// ─────────────────────────────────────────────────────────────────────────────

function ctxHelp(): void {
  console.error(`Usage: qmd ctx <sources|collect|threads|brief|note|lead|handoff> [options]

Commands:
  qmd ctx sources                      Local session directories this machine has
  qmd ctx collect [--since 7d] [--source claude-code,codex] [--dry-run]
                                       Extract important session facts into PR/branch threads
  qmd ctx threads [--all]              Threads in this scope
  qmd ctx brief [--thread id]          Merged handoff briefing (default: current branch)
  qmd ctx note <kind> <text>           Add an item: ${ITEM_KINDS.join(" | ")}
  qmd ctx lead                         Become the thread driver (needs a stable $QMD_AGENT_ID)
  qmd ctx handoff --next "<action>"    Hand the thread off with the next action

Options:
  --cwd <dir>        Checkout to resolve scope/branch from (default: current directory)
  --scope <key>      Project key (default: derived from git remote)
  --pr <number>      Associate with a PR
  --status <s>       Item status (plan: todo|doing|done|dropped, verification: pass|fail, ...)
  --key <k>          Item key (plan step key / decision memory key)
  --detail <text>    Path action or question resolution
  --json             JSON output

Only important session facts are stored — never file contents, diffs, logs or attachments.
Requires: QMD_BACKEND=pg and QMD_PG_URL (collect --dry-run and sources work without).`);
}

function parseSince(raw: string | undefined): number {
  if (!raw) return Date.now() - 7 * 86_400_000;
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * unit;
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(`invalid --since '${raw}' (use 30m, 12h, 7d or an ISO date)`);
  return t;
}

/** Handle `qmd ctx ...`. Returns a process exit code. */
export async function runCtxCommand(args: string[], values: Values): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help") {
    ctxHelp();
    return sub ? 0 : 1;
  }
  const json = !!values.json;
  const cwd = str(values.cwd) ?? process.cwd();

  if (sub === "sources") {
    const rows = SOURCES.map((s) => ({ id: s.id, label: s.label, detected: s.detect(), implemented: s.implemented }));
    if (json) console.log(JSON.stringify(rows, null, 2));
    else
      for (const r of rows) {
        const mark = !r.implemented ? `${C.dim}○ reserved${C.reset}` : r.detected ? `${C.green}● ready${C.reset}` : `${C.dim}○ not found${C.reset}`;
        console.log(`${mark}  ${C.bold}${r.id}${C.reset}  ${C.dim}${r.label}${C.reset}${!r.implemented && r.detected ? " (detected, not parsed yet)" : ""}`);
      }
    return 0;
  }

  const dryRun = !!values["dry-run"];
  let bridge: Awaited<ReturnType<typeof openContextBridge>> | undefined;
  if (!(sub === "collect" && dryRun)) {
    try {
      bridge = await openContextBridge();
    } catch (err) {
      console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
      return 1;
    }
  }

  const scope = resolveScope(str(values.scope), process.env, cwd);
  const branch = resolveBranch(cwd);
  const prRaw = Number.parseInt(String(values.pr ?? ""), 10);
  const pr = Number.isInteger(prRaw) && prRaw > 0 ? prRaw : undefined;
  const agentId = resolveAgentId(str(values.agent));
  const agentKind = resolveAgentKind();

  /** Resolve (creating if needed) the thread for this checkout and attach this CLI session. */
  const attach = async () => {
    const store = bridge!.store;
    const threadId = str(values.thread);
    let thread = threadId ? await store.getThread(threadId) : null;
    if (!thread) {
      const resolved = await store.resolveThread({
        scope,
        ...(branch ? { headBranch: branch } : {}),
        ...(pr ? { prNumber: pr } : {}),
        ...(resolveBaseSha(cwd) ? { headSha: resolveBaseSha(cwd)! } : {}),
      });
      if (!resolved.ok) {
        throw new Error(`${branch ?? "this checkout"} is a default branch: pass --thread <id> or --pr <number>`);
      }
      thread = resolved.thread;
    }
    const sessionId = await store.attachSession(thread.id, {
      source: "qmd-cli",
      sourceSessionId: agentId,
      agentKind,
      ...(resolveBaseSha(cwd) ? { headSha: resolveBaseSha(cwd)! } : {}),
    });
    return { thread, sessionId };
  };

  try {
    switch (sub) {
      case "collect": {
        const sources = str(values.source)?.split(",").map((x) => x.trim()).filter(Boolean);
        const report = await runCollect({
          ...(bridge ? { store: bridge.store } : {}),
          ...(sources?.length ? { sources } : {}),
          sinceMs: parseSince(str(values.since)),
          dryRun,
        });
        const threads = [...report.threads.entries()].map(([label, t]) => ({
          label,
          scope: t.scope,
          headBranch: t.headBranch,
          prNumber: t.prNumber,
          sources: [...t.sources],
          sessions: t.sessions.size,
          items: t.items,
          ...(dryRun ? {} : { merged: t.merged }),
        }));
        const payload = {
          dryRun,
          files: report.files,
          filesUnchanged: report.filesSkippedUnchanged,
          sessions: report.sessions,
          skipped: report.skipped,
          secretsDropped: report.secretsDropped,
          errors: report.errors,
          threads,
        };
        if (json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(`${dryRun ? `${C.cyan}dry-run${C.reset} ` : ""}files ${report.files} (unchanged ${report.filesSkippedUnchanged}) · sessions ${report.sessions} · secrets dropped ${report.secretsDropped}`);
          if (Object.keys(report.skipped).length) console.log(`${C.dim}skipped: ${JSON.stringify(report.skipped)}${C.reset}`);
          for (const t of threads) {
            const items = Object.entries(t.items).map(([k, n]) => `${k}:${n}`).join(" ");
            const merged = "merged" in t && t.merged ? ` ${C.dim}→ +${t.merged.inserted} ~${t.merged.updated} =${t.merged.touched} ✗${t.merged.rejected}${C.reset}` : "";
            console.log(`${C.green}●${C.reset} ${C.bold}${t.label}${C.reset} ${C.dim}[${t.sources.join(",")}] ×${t.sessions}${C.reset} ${items}${merged}`);
          }
          for (const e of report.errors.slice(0, 5)) console.error(`${C.red}✗${C.reset} ${e.path}: ${e.message}`);
        }
        return report.errors.length ? 2 : 0;
      }

      case "threads": {
        const rows = await bridge!.store.threads(scope, { all: !!values.all });
        if (json) console.log(JSON.stringify(rows, null, 2));
        else if (!rows.length) console.log(`No threads in ${scope}.`);
        else
          for (const t of rows) {
            const label = t.prNumber ? `#${t.prNumber} ${t.headBranch ?? ""}` : t.headBranch ?? t.title;
            console.log(`${C.cyan}●${C.reset} ${C.bold}${label}${C.reset} ${C.dim}${t.state} · ${t.sessions} sessions · ${t.items} items · ${age(t.updatedAt)} · ${t.id}${C.reset}`);
          }
        return 0;
      }

      case "brief": {
        const store = bridge!.store;
        const threadId = str(values.thread);
        const thread = threadId ? await store.getThread(threadId) : await store.findThread(scope, branch, pr);
        if (!thread) {
          console.error(`No thread for ${scope}${branch ? ` @ ${branch}` : ""}. Run 'qmd ctx collect' or 'qmd ctx note'.`);
          return 1;
        }
        const briefing = await store.briefing(thread.id);
        if (json) console.log(JSON.stringify(briefing, null, 2));
        else console.log(renderBriefing(briefing!, { cwd }));
        return 0;
      }

      case "note": {
        const kind = args[1] as ItemKind | undefined;
        const text = args.slice(2).join(" ") || (await readStdin());
        if (!kind || !(ITEM_KINDS as readonly string[]).includes(kind) || !text) {
          ctxHelp();
          return 1;
        }
        const { thread, sessionId } = await attach();
        const item: IncomingItem = {
          kind,
          text,
          ...(str(values.status) ? { status: str(values.status)! } : {}),
          ...(str(values.key) ? { key: str(values.key)! } : {}),
          ...(str(values.detail) ? { detail: str(values.detail)! } : {}),
          ...(resolveBaseSha(cwd) ? { gitHead: resolveBaseSha(cwd)! } : {}),
        };
        const result = await bridge!.store.mergeItems(thread.id, sessionId, [item]);
        if (json) console.log(JSON.stringify(result, null, 2));
        else if (result.rejected.length) console.error(`${C.red}✗${C.reset} rejected: ${result.rejected[0]!.reason}`);
        else console.log(`${C.green}✓${C.reset} ${kind} merged into ${thread.headBranch ?? thread.id} (+${result.inserted} ~${result.updated} =${result.touched}${result.proposed ? `, ${result.proposed} proposed` : ""})`);
        return result.rejected.length ? 1 : 0;
      }

      case "lead": {
        const { thread, sessionId } = await attach();
        const res = await bridge!.store.lead(thread.id, sessionId, { takeover: !!values.force });
        if (json) console.log(JSON.stringify(res, null, 2));
        else if (res.ok) console.log(`${C.green}✓${C.reset} driving ${thread.headBranch ?? thread.id} (fence ${res.fence})`);
        else console.error(`${C.red}✗${C.reset} held by session ${res.holder} until ${res.leaseExpiresAt}`);
        return res.ok ? 0 : 1;
      }

      case "handoff": {
        const next = str(values.next);
        if (!next) {
          console.error(`${C.red}✗${C.reset} --next "<action>" is required`);
          return 1;
        }
        const { thread, sessionId } = await attach();
        const res = await bridge!.store.handoff(thread.id, sessionId, thread.fence, next);
        if (json) console.log(JSON.stringify(res, null, 2));
        else if (res.ok) console.log(`${C.green}✓${C.reset} handed off ${thread.headBranch ?? thread.id}`);
        else console.error(`${C.red}✗${C.reset} ${res.reason}`);
        return res.ok ? 0 : 1;
      }

      default:
        ctxHelp();
        return 1;
    }
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  } finally {
    await bridge?.dispose();
  }
}
