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
