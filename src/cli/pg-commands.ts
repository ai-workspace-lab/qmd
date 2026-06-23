/**
 * cli/pg-commands.ts - `qmd memory` and `qmd pg` command handlers.
 *
 * These drive the PostgreSQL memory bridge. They own their own bridge lifecycle
 * (connection pool + embedder) and are no-ops for the default SQLite backend.
 */

import { openMemoryBridge, redactConnectionString } from "../pg/index.js";

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
