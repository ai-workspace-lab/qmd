/**
 * tier/l1.ts - L1 hot layer: materialized Markdown files indexed by a QMD
 * collection (default "hot"), searched with the SQLite engine (BM25 + vector,
 * no LLM rerank/expansion so it never loads local models).
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";

export interface L1Hit {
  /** qmd://<collection>/<path> */
  file: string;
  itemId: string;
  score: number;
  snippet: string;
}

/** The slice of QMD's SQLite engine the tier engine needs. Swappable in tests. */
export interface L1Index {
  search(query: string, limit: number): Promise<L1Hit[]>;
  /** Re-scan the hot collection and embed new/changed files. */
  sync(opts?: { embed?: boolean }): Promise<{ indexed: number; embedded: number }>;
  close(): Promise<void>;
}

const ITEM_FILE_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-p\d+)?\.md$/i;

export function itemIdFromL1Path(p: string): string | null {
  const m = ITEM_FILE_RE.exec(p);
  return m ? m[1]!.toLowerCase() : null;
}

export const L1_MAX_FILE_BYTES = 64 * 1024;

export interface MaterializeInput {
  id: string;
  kind: string;
  source: string;
  scope: string | null;
  title: string | null;
  occurredAt: Date;
  sha256: string;
  reason: string;
  summary: string | null;
  body: string;
}

function ym(d: Date): [string, string] {
  // Bucket by Asia/Shanghai calendar month (the user's zone).
  const local = new Date(d.getTime() + 8 * 3600 * 1000);
  return [String(local.getUTCFullYear()), String(local.getUTCMonth() + 1).padStart(2, "0")];
}

export function l1RelDir(occurredAt: Date): string {
  const [y, m] = ym(occurredAt);
  return `${y}/${m}`;
}

/** Render an item to one or more Markdown files (each ≤ 64 KiB). */
export function renderL1Files(input: MaterializeInput): Array<{ name: string; content: string }> {
  const fm = {
    item_id: input.id,
    kind: input.kind,
    source: input.source,
    scope: input.scope ?? undefined,
    occurred_at: input.occurredAt.toISOString(),
    sha256: input.sha256,
    tier_reason: input.reason,
  };
  const header = `---\n${YAML.stringify(fm).trim()}\n---\n\n# ${input.title || input.id}\n\n`;
  const summary = input.summary ? `> ${input.summary.replace(/\n+/g, " ").slice(0, 1200)}\n\n` : "";
  const enc = new TextEncoder();
  const budget = L1_MAX_FILE_BYTES - enc.encode(header).length - 64;
  const files: Array<{ name: string; content: string }> = [];
  let rest = input.body;
  let part = 1;
  do {
    let take = rest;
    const pre = part === 1 ? summary : "";
    // Shrink by characters until the part fits the byte budget.
    while (enc.encode(pre + take).length > budget) {
      const cut = take.lastIndexOf("\n\n", Math.floor(take.length * 0.9));
      take = cut > 0 ? take.slice(0, cut) : take.slice(0, Math.floor(take.length * 0.9));
    }
    const name = part === 1 ? `${input.id}.md` : `${input.id}-p${part}.md`;
    files.push({ name, content: header + pre + take + "\n" });
    rest = rest.slice(take.length).replace(/^\s+/, "");
    part++;
  } while (rest.length > 0);
  return files;
}

/** Write files for an item, removing stale parts. Returns total bytes written. */
export function writeL1Item(l1Dir: string, input: MaterializeInput): { paths: string[]; bytes: number } {
  removeL1Item(l1Dir, input.id);
  const dir = join(l1Dir, l1RelDir(input.occurredAt));
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  let bytes = 0;
  for (const f of renderL1Files(input)) {
    const p = join(dir, f.name);
    writeFileSync(p, f.content);
    paths.push(p);
    bytes += Buffer.byteLength(f.content);
  }
  return { paths, bytes };
}

/** Delete every L1 file of an item (any month dir). Returns the number removed. */
export function removeL1Item(l1Dir: string, id: string): number {
  if (!existsSync(l1Dir)) return 0;
  let removed = 0;
  for (const p of listL1Files(l1Dir)) {
    if (itemIdFromL1Path(p) === id.toLowerCase()) {
      rmSync(p, { force: true });
      removed++;
    }
  }
  return removed;
}

export function listL1Files(l1Dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(l1Dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(l1Dir);
  return out;
}

export function l1Usage(l1Dir: string): { files: number; bytes: number; items: Map<string, number> } {
  const items = new Map<string, number>();
  let bytes = 0;
  const files = listL1Files(l1Dir);
  for (const p of files) {
    const b = statSync(p).size;
    bytes += b;
    const id = itemIdFromL1Path(p);
    if (id) items.set(id, (items.get(id) ?? 0) + b);
  }
  return { files: files.length, bytes, items };
}

/**
 * QMD-backed L1 index. Uses the SDK store over the shared SQLite index so the
 * MCP server and the CLI see the same `hot` collection.
 */
export class QmdL1Index implements L1Index {
  private storePromise?: Promise<import("../index.js").QMDStore>;

  constructor(
    private opts: { dbPath: string; configPath?: string; collection: string; l1Dir: string },
  ) {}

  private store() {
    if (!this.storePromise) {
      this.storePromise = (async () => {
        const { createStore } = await import("../index.js");
        mkdirSync(dirname(this.opts.dbPath), { recursive: true });
        mkdirSync(this.opts.l1Dir, { recursive: true });
        const store = await createStore({
          dbPath: this.opts.dbPath,
          ...(this.opts.configPath && existsSync(this.opts.configPath) ? { configPath: this.opts.configPath } : {}),
        });
        const cols = await store.listCollections();
        if (!cols.some((c) => c.name === this.opts.collection)) {
          await store.addCollection(this.opts.collection, { path: this.opts.l1Dir, pattern: "**/*.md" });
        }
        return store;
      })();
    }
    return this.storePromise;
  }

  async search(query: string, limit: number): Promise<L1Hit[]> {
    const store = await this.store();
    const results = await store.search({
      queries: [
        { type: "lex", query },
        { type: "vec", query },
      ],
      rerank: false,
      collections: [this.opts.collection],
      limit: Math.max(limit * 2, 10),
    });
    const hits: L1Hit[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const itemId = itemIdFromL1Path(r.file);
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      hits.push({ file: r.file, itemId, score: r.score, snippet: (r.bestChunk || r.body || "").slice(0, 400) });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async sync(opts: { embed?: boolean } = {}): Promise<{ indexed: number; embedded: number }> {
    const store = await this.store();
    const up = await store.update({ collections: [this.opts.collection] });
    let embedded = 0;
    if (opts.embed !== false) {
      const res = await store.embed({ collection: this.opts.collection });
      embedded = (res as { chunksEmbedded?: number }).chunksEmbedded ?? 0;
    }
    const u = up as unknown as { indexed?: number; updated?: number };
    return { indexed: (u.indexed ?? 0) + (u.updated ?? 0), embedded };
  }

  async close(): Promise<void> {
    if (this.storePromise) {
      const s = await this.storePromise;
      await s.close();
      this.storePromise = undefined;
    }
  }
}
