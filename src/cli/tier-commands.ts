/**
 * cli/tier-commands.ts - `qmd tier …` (three-tier memory; the box `mem` wrapper calls this).
 *
 * `qmd mem` stays the fork's alias for `qmd memory`; tiered memory lives under
 * `qmd tier` so no existing fork command changes meaning.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { openTierEngine, isUuid, ENTITY_TYPES, proposeFact, listFacts } from "../tier/index.js";
import type { TierEngine } from "../tier/index.js";
import type { MemItemKind } from "../pg/schema-mem.js";
import { MEM_ITEM_KINDS } from "../pg/schema-mem.js";

type Values = Record<string, unknown>;

const C = { reset: "\x1b[0m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", yellow: "\x1b[33m" };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
function int(v: unknown): number | undefined {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** "7d" / "12h" / ISO date → Date */
export function parseSince(v: string | undefined, now = new Date()): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([dhm])$/.exec(v.trim());
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "d" ? 86400000 : m[2] === "h" ? 3600000 : 60000;
    return new Date(now.getTime() - n * ms);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${v}`);
  return d;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function tierHelp(): string {
  return `Usage: qmd tier <command> [options]      (box wrapper: mem <command>)

Search & read
  search <query>            Tiered search L1 → L2 (+facts); logs heat, promotes L2 hits to L1
                            [-n 10] [--scope s] [--kind k] [--since 7d|date] [--agent a] [--json]
  recall <item_id|query>    Full content; summary-only items rehydrate from l3-cache or queue a fetch
  context <task>            Injectable context (facts + recent summaries + top snippets) [--budget 2000]
  timeline                  Items/summaries/facts in a window [--since 7d] [--until date] [--scope s]
  facts                     Active facts [--entity e] [--predicate p] [--status active|proposed|retired|all]
  facts add <statement>     --entity <name> --type <${ENTITY_TYPES.join("|")}> --predicate p --evidence id[,id] [--object o]
  summary <day|week|month>  Show a period summary [--date YYYY-MM-DD] [--generate]
  status                    Tier sizes, backlog, hit rate, invariant check [--json]

Write
  remember [text]           Write-through note (stdin ok) --title t [--kind note] [--scope s]
  ingest <file|dir>         Batch ingest .md/.txt/.jsonl --kind ${MEM_ITEM_KINDS.join("|")} [--source s] [--scope s]
  forget <item_id>          Tombstone (L1 delete, L2 purge, L3 tombstone append) --reason r
  pin|unpin <item_id>       Keep in / release from L1

Maintenance
  embed                     Embed pending L2 parts [--batch 64] [--max N] [--delay ms]
  tier                      Admission/eviction/compaction pass [--dry-run]
  rebuild-l1                Rebuild L1 from L2
  nightly                   Full nightly consolidation [--dry-run]
  l3 outbox|commit|fetch-queue|rehydrate <id> [--from path]
                            L3 hand-off: uploads ride the .archive flow; commit reads its committed manifest

Env: QMD_BACKEND=pg QMD_PG_URL QMD_NAMESPACE MEM_HOME MEM_L3_REDACT_CMD (see src/tier/index.ts)`;
}

function out(json: boolean, data: unknown, text: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else text();
}

function fmtDate(d: string | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

function walk(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return [p];
  const res: string[] = [];
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const q = join(p, e.name);
    if (e.isDirectory()) res.push(...walk(q));
    else if (/\.(md|markdown|txt|jsonl)$/i.test(e.name)) res.push(q);
  }
  return res;
}

export async function ingestPath(
  engine: TierEngine,
  target: string,
  opts: { kind: MemItemKind; source?: string; scope?: string | null; root?: string },
): Promise<Array<{ path: string; id: string; created: boolean; unchanged: boolean; l3: string }>> {
  const abs = resolve(target);
  const root = opts.root ?? (statSync(abs).isDirectory() ? abs : resolve(abs, ".."));
  const results = [];
  for (const file of walk(abs).sort()) {
    const text = readFileSync(file, "utf8");
    if (!text.trim()) continue;
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    const rel = relative(root, file).split("\\").join("/");
    const st = statSync(file);
    const r = await engine.upsertItem({
      kind: opts.kind,
      source: opts.source ?? `file:${opts.kind}`,
      sourceRef: rel,
      scope: opts.scope ?? null,
      title: heading ?? basename(file, extname(file)),
      occurredAt: st.mtime,
      body: text,
      rawName: basename(file),
      embed: true,
    });
    results.push({ path: rel, id: r.id, created: r.created, unchanged: r.unchanged, l3: r.l3 });
  }
  return results;
}

export async function runTierCommand(args: string[], values: Values): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || values.help) {
    console.error(tierHelp());
    return sub ? 0 : 1;
  }
  const json = !!values.json || values.format === "json";
  const agent = str(values.agent) ?? process.env.QMD_AGENT_ID;

  let engine: TierEngine;
  try {
    engine = await openTierEngine({ noEmbedder: sub === "status" });
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  }

  try {
    switch (sub) {
      case "search":
      case "query": {
        const q = args.slice(1).join(" ").trim();
        if (!q) throw new Error("Usage: qmd tier search <query>");
        const r = await engine.search(q, {
          limit: int(values.n) ?? 10,
          scope: str(values.scope),
          kind: str(values.kind),
          since: parseSince(str(values.since)),
          agent,
        });
        out(json, r, () => {
          if (!r.hits.length) console.log(`${C.dim}no results${C.reset}`);
          r.hits.forEach((h, i) => {
            console.log(
              `${C.bold}${i + 1}. ${h.title ?? "(untitled)"}${C.reset} ${C.dim}[${h.tier}${h.promoted ? "→L1" : ""}] ${h.kind} · ${h.source} · ${fmtDate(h.occurredAt)}${h.scope ? ` · ${h.scope}` : ""} · ${h.itemId}${C.reset}`,
            );
            console.log(`   ${h.snippet.replace(/\s+/g, " ").slice(0, 220)}`);
          });
          for (const f of r.facts) console.log(`${C.cyan}fact${C.reset} ${f.statement}`);
          console.log(`${C.dim}L1 ${r.tiers.l1} · L2 ${r.tiers.l2}${r.shortCircuit ? " · L1 short-circuit" : ""}${r.promoted.length ? ` · promoted ${r.promoted.length}` : ""}${C.reset}`);
        });
        return 0;
      }

      case "recall":
      case "get": {
        const q = args.slice(1).join(" ").trim();
        if (!q) throw new Error("Usage: qmd tier recall <item_id|query>");
        const r = await engine.recall(q, { agent });
        out(json, r, () => {
          if (!r.item) return console.log(`${C.dim}not found${C.reset}`);
          if (r.tombstoned) return console.log(`${C.yellow}forgotten${C.reset} ${r.item.id}`);
          console.log(`${C.bold}${r.item.title ?? r.item.id}${C.reset} ${C.dim}${r.item.kind} · ${r.item.source} · ${fmtDate(r.item.occurred_at)} · tier ${r.tier ?? "L3 (queued)"} · ${r.item.id}${C.reset}\n`);
          if (r.body) console.log(r.body);
          else {
            console.log(r.summary ?? "");
            if (r.pendingFetch) console.log(`\n${C.yellow}pending_fetch: original is only in L3; queued for the nightly routine${C.reset}`);
          }
        });
        return r.item ? 0 : 1;
      }

      case "remember": {
        const title = str(values.title);
        if (!title) throw new Error("Usage: qmd tier remember --title <t> [text]  (or pipe the body)");
        const body = args.slice(1).join(" ").trim() || (await readStdin()).trim();
        if (!body) throw new Error("no body (pass text or pipe stdin)");
        const kind = (str(values.kind) ?? "note") as MemItemKind;
        const r = await engine.remember({ title, body, kind, scope: str(values.scope) ?? null, agent });
        out(json, r, () => console.log(`${C.green}✓${C.reset} ${r.created ? "stored" : r.unchanged ? "unchanged" : "updated"} ${r.id} ${C.dim}(${r.parts} part(s), L3 ${r.l3}, L1 ${r.l1 ?? "-"})${C.reset}`));
        return 0;
      }

      case "ingest": {
        const target = args[1];
        const kind = str(values.kind) as MemItemKind | undefined;
        if (!target || !kind || !MEM_ITEM_KINDS.includes(kind)) {
          throw new Error(`Usage: qmd tier ingest <file|dir> --kind ${MEM_ITEM_KINDS.join("|")}`);
        }
        if (!existsSync(target)) throw new Error(`not found: ${target}`);
        const res = await ingestPath(engine, target, { kind, source: str(values.source), scope: str(values.scope) ?? null });
        await engine.syncL1().catch(() => null);
        out(json, res, () => {
          const c = res.filter((r) => r.created).length;
          const u = res.filter((r) => r.unchanged).length;
          console.log(`${C.green}✓${C.reset} ingested ${res.length} file(s): ${c} new, ${res.length - c - u} updated, ${u} unchanged`);
        });
        return 0;
      }

      case "forget": {
        const id = args[1];
        const reason = str(values.reason);
        if (!id || !isUuid(id) || !reason) throw new Error("Usage: qmd tier forget <item_id> --reason <text>");
        const ok = await engine.forget(id, reason);
        out(json, { ok }, () => console.log(ok ? `${C.green}✓${C.reset} forgotten ${id}` : `${C.red}✗${C.reset} not found`));
        return ok ? 0 : 1;
      }

      case "pin":
      case "unpin": {
        const id = args[1];
        if (!id || !isUuid(id)) throw new Error(`Usage: qmd tier ${sub} <item_id>`);
        const ok = await engine.setPinned(id, sub === "pin");
        out(json, { ok }, () => console.log(ok ? `${C.green}✓${C.reset} ${sub}ned ${id}` : `${C.red}✗${C.reset} not found`));
        return ok ? 0 : 1;
      }

      case "facts": {
        if (args[1] === "add") {
          const statement = args.slice(2).join(" ").trim();
          const entity = str(values.entity);
          const type = str(values.type) ?? "product";
          const predicate = str(values.predicate);
          const evidence = (str(values.evidence) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          if (!statement || !entity || !predicate || !evidence.length) {
            throw new Error("Usage: qmd tier facts add <statement> --entity e --type t --predicate p --evidence id[,id] [--object o]");
          }
          if (!(ENTITY_TYPES as readonly string[]).includes(type)) throw new Error(`--type must be one of ${ENTITY_TYPES.join(", ")}`);
          const r = await proposeFact(engine.client, {
            subject: { type: type as (typeof ENTITY_TYPES)[number], name: entity },
            predicate,
            objectText: str(values.object),
            statement,
            confidence: 1,
            status: "active",
            evidence,
          });
          out(json, r, () => console.log(`${C.green}✓${C.reset} fact ${r.id} (${r.status}${r.superseded.length ? `, superseded ${r.superseded.length}` : ""})`));
          return 0;
        }
        const rows = await listFacts(engine.client, {
          entity: str(values.entity),
          predicate: str(values.predicate),
          status: str(values.status) ?? "active",
          query: args.slice(1).join(" ").trim() || undefined,
        });
        out(json, rows, () => {
          if (!rows.length) console.log(`${C.dim}no facts${C.reset}`);
          for (const f of rows) console.log(`- ${f.statement} ${C.dim}[${f.status} · ${f.subject ?? "-"} · ${f.predicate} · conf ${f.confidence}]${C.reset}`);
        });
        return 0;
      }

      case "summary": {
        const period = (args[1] ?? "day") as "day" | "week" | "month";
        if (!["day", "week", "month"].includes(period)) throw new Error("Usage: qmd tier summary day|week|month [--date YYYY-MM-DD] [--generate]");
        const date = str(values.date);
        if (values.generate) {
          const at = date ? new Date(`${date}T12:00:00+08:00`) : new Date();
          const r = await engine.generatePeriodSummary(period, at);
          if (!r) {
            out(json, null, () => console.log(`${C.dim}no items in that ${period}${C.reset}`));
            return 0;
          }
        }
        const s = await engine.getSummary(period, date);
        out(json, s, () => console.log(s ? s.body : `${C.dim}no summary (use --generate)${C.reset}`));
        return 0;
      }

      case "timeline": {
        const to = str(values.until) ? new Date(str(values.until)!) : new Date();
        const from = parseSince(str(values.since) ?? "7d")!;
        const r = await engine.timeline({ from, to, scope: str(values.scope), limit: int(values.n) ?? 100 });
        out(json, r, () => {
          for (const it of r.items as Array<{ occurred_at: string; kind: string; title: string; id: string }>) {
            console.log(`${fmtDate(it.occurred_at)} [${it.kind}] ${it.title ?? it.id}`);
          }
          console.log(`${C.dim}${r.items.length} items · ${r.summaries.length} summaries · ${r.facts.length} facts${C.reset}`);
        });
        return 0;
      }

      case "context": {
        const task = args.slice(1).join(" ").trim();
        if (!task) throw new Error("Usage: qmd tier context <task> [--scope s] [--budget tokens]");
        const r = await engine.context(task, { scope: str(values.scope), budgetTokens: int(values.budget), agent });
        out(json, r, () => console.log(r.text));
        return 0;
      }

      case "embed": {
        const r = await engine.embedPending({
          batch: int(values.batch) ?? 64,
          max: int(values.max),
          delayMs: int(values.delay) ?? 0,
          onProgress: json ? undefined : (d, t) => process.stderr.write(`\r  embedded ${d}/${t || "?"}`),
        });
        if (!json) process.stderr.write("\n");
        out(json, r, () => console.log(`${C.green}✓${C.reset} embedded ${r.embedded}, failed ${r.failed}, ${r.requests} request(s); pending now ${0}`));
        return r.failed ? 2 : 0;
      }

      case "tier":
      case "tiering": {
        const r = await engine.runTiering({ dryRun: !!values["dry-run"] });
        out(json, r, () =>
          console.log(`${r.dryRun ? "(dry run) " : ""}admitted ${r.admitted.length} · evicted ${r.evicted.length} · capacity ${r.capacityEvicted.length} · compacted ${r.compacted.length} · invariant violations ${r.invariantViolations.length}`),
        );
        return r.invariantViolations.length ? 3 : 0;
      }

      case "rebuild-l1": {
        const r = await engine.rebuildL1();
        out(json, r, () => console.log(`${C.green}✓${C.reset} L1 rebuilt: ${r.materialized} materialized, ${r.evicted} not admitted`));
        return 0;
      }

      case "nightly": {
        const r = await engine.nightly({ dryRun: !!values["dry-run"] });
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }

      case "l3": {
        const op = args[1] ?? "outbox";
        if (op === "outbox") {
          const rows = await engine.outbox(str(values.status) ?? "pending", int(values.n) ?? 100);
          out(json, rows, () => {
            for (const r of rows as Array<{ id: string; status: string; target_path: string; bytes: number }>) console.log(`${r.id}\t${r.status}\t${r.bytes}\t${r.target_path}`);
            console.log(`${C.dim}${rows.length} row(s). Uploads travel with the nightly .archive run; then: qmd tier l3 commit${C.reset}`);
          });
        } else if (op === "commit") {
          const r = await engine.commitFromArchive();
          out(json, r, () => console.log(`${C.green}✓${C.reset} committed ${r.committed} · still pending ${r.pending} · sha mismatch ${r.mismatched} · archive run ${r.run ?? "(none)"}`));
        } else if (op === "fetch-queue") {
          const rows = await engine.fetchQueue();
          out(json, rows, () => {
            for (const r of rows as Array<{ item_id: string; l3_locator: string }>) console.log(`${r.item_id}\t${r.l3_locator}`);
            console.log(`${C.dim}${rows.length} queued${C.reset}`);
          });
        } else if (op === "rehydrate") {
          const id = args[2];
          if (!id || !isUuid(id)) throw new Error("Usage: qmd tier l3 rehydrate <item_id> [--from <path>]");
          const ok = await engine.rehydrate(id, str(values.from));
          out(json, { ok }, () => console.log(ok ? `${C.green}✓${C.reset} rehydrated ${id}` : `${C.red}✗${C.reset} no verified local copy`));
          return ok ? 0 : 1;
        } else {
          throw new Error("Usage: qmd tier l3 outbox|commit|fetch-queue|rehydrate <id>");
        }
        return 0;
      }

      case "status": {
        const s = await engine.status();
        out(json, s, () => {
          console.log(`${C.bold}Tiered memory${C.reset} ns=${s.namespace} · embed ${s.embedModel}`);
          console.log(`  items     : ${Object.entries(s.items).map(([k, v]) => `${k} ${v}`).join(" · ") || "0"}`);
          console.log(`  kinds     : ${Object.entries(s.kinds).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}`);
          console.log(`  L1        : ${s.l1.items} items, ${s.l1.files} files, ${(s.l1.bytes / 1024 / 1024).toFixed(2)} MB (${s.l1.dir})`);
          console.log(`  L2        : ${s.l2.parts} parts, ${s.l2.vectors} vectors, ${s.l2.pendingEmbeddings} pending embeddings`);
          console.log(`  L3        : outbox ${JSON.stringify(s.l3.outbox)} · fetch queued ${s.l3.fetchQueued}`);
          console.log(`  hit rate  : L1 ${s.hitRate7d.l1}/${s.hitRate7d.total} (7d)`);
          console.log(`  invariant : ${s.invariantViolations === 0 ? `${C.green}ok${C.reset}` : `${C.red}${s.invariantViolations} violation(s)${C.reset}`}`);
        });
        return s.invariantViolations ? 3 : 0;
      }

      default:
        console.error(tierHelp());
        return 1;
    }
  } catch (err) {
    console.error(`${C.red}✗${C.reset} ${(err as Error).message}`);
    return 1;
  } finally {
    await engine.close().catch(() => {});
  }
}
