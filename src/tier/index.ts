/**
 * tier/index.ts - Open the three-tier memory engine from the environment.
 *
 * Environment (all optional except the PG backend):
 *   QMD_BACKEND=pg, QMD_PG_URL, QMD_PG_SSL, QMD_NAMESPACE   L2 connection (fork config)
 *   MEM_HOME              base dir (default ~/.local/share/qmd-mem)
 *   MEM_L1_DIR            L1 Markdown dir (default $MEM_HOME/l1/hot)
 *   MEM_L1_COLLECTION     QMD collection name for L1 (default "hot")
 *   MEM_L1_INDEX_PATH     QMD SQLite index (default INDEX_PATH or $XDG_CACHE_HOME/qmd/index.sqlite)
 *   MEM_L3_CACHE_DIR      staged L3 originals (default $MEM_HOME/l3-cache)
 *   MEM_QUARANTINE_DIR    redaction failures (default $MEM_HOME/quarantine)
 *   MEM_L3_REDACT_CMD     external redactor (stdin → JSON); default: fork findSecret
 *   MEM_WORKSPACE_ROOT    root used by .archive manifest keys (default /workspace)
 *   MEM_ARCHIVE_STATE_DIR .archive state dir (default /workspace/.archive/state)
 *   MEM_NO_L1=1           disable L1 (L2-only)
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LlamaCpp, resolveEmbedModel } from "../llm.js";
import { PgClient } from "../pg/db-pg.js";
import { bootstrapSchema } from "../pg/schema-pg.js";
import { isPgBackend, resolvePgConfig } from "../pg/config.js";
import { getConfigDir } from "../collections.js";
import { DEFAULT_POLICY } from "./policy.js";
import { QmdL1Index } from "./l1.js";
import { makeRedactor } from "./l3.js";
import { TierEngine } from "./engine.js";
import type { TierConfig } from "./types.js";

export { TierEngine, isUuid, lexicalTerms } from "./engine.js";
export * from "./policy.js";
export * from "./types.js";
export { QmdL1Index, itemIdFromL1Path, renderL1Files, writeL1Item, removeL1Item, l1Usage } from "./l1.js";
export type { L1Index, L1Hit } from "./l1.js";
export { makeRedactor, readArchiveManifest, l3TargetPath, sha256Hex } from "./l3.js";
export { ExtractiveSummarizer, stripFrontmatter } from "./summarize.js";
export type { Summarizer } from "./summarize.js";
export { proposeFact, upsertEntity, addEdge, listFacts, activateEligibleFacts, findEntity, ENTITY_TYPES } from "./facts.js";

export function resolveTierConfig(env: NodeJS.ProcessEnv = process.env): TierConfig {
  const home = resolve(env.MEM_HOME || join(homedir(), ".local", "share", "qmd-mem"));
  return {
    namespace: (env.QMD_NAMESPACE ?? "").trim() || "default",
    home,
    l1Dir: resolve(env.MEM_L1_DIR || join(home, "l1", "hot")),
    l3CacheDir: resolve(env.MEM_L3_CACHE_DIR || join(home, "l3-cache")),
    quarantineDir: resolve(env.MEM_QUARANTINE_DIR || join(home, "quarantine")),
    workspaceRoot: resolve(env.MEM_WORKSPACE_ROOT || "/workspace"),
    archiveStateDir: resolve(env.MEM_ARCHIVE_STATE_DIR || "/workspace/.archive/state"),
    embedModel: resolveEmbedModel(),
    policy: { ...DEFAULT_POLICY },
    partBytes: Number.parseInt(env.MEM_PART_BYTES ?? "", 10) || 2048,
  };
}

export function resolveL1IndexPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEM_L1_INDEX_PATH) return resolve(env.MEM_L1_INDEX_PATH);
  if (env.INDEX_PATH) return resolve(env.INDEX_PATH);
  const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return resolve(cache, "qmd", "index.sqlite");
}

export interface OpenTierOptions {
  env?: NodeJS.ProcessEnv;
  /** Skip the embedder (lexical-only; used by status and tests). */
  noEmbedder?: boolean;
  noL1?: boolean;
}

export async function openTierEngine(opts: OpenTierOptions = {}): Promise<TierEngine> {
  const env = opts.env ?? process.env;
  if (!isPgBackend(env)) {
    throw new Error("Tiered memory needs the PostgreSQL backend. Set QMD_BACKEND=pg and QMD_PG_URL.");
  }
  const pg = resolvePgConfig(env);
  const client = await PgClient.create(pg);
  await bootstrapSchema(client);
  const config = resolveTierConfig(env);
  const embedder = opts.noEmbedder
    ? null
    : new LlamaCpp({ inactivityTimeoutMs: 5 * 60 * 1000, disposeModelsOnInactivity: true });
  const l1 = opts.noL1 || env.MEM_NO_L1 === "1"
    ? null
    : new QmdL1Index({
        dbPath: resolveL1IndexPath(env),
        configPath: join(getConfigDir(), "index.yml"),
        collection: env.MEM_L1_COLLECTION || "hot",
        l1Dir: config.l1Dir,
      });
  const engine = new TierEngine({
    client,
    config,
    embedder,
    l1,
    redactor: makeRedactor(env.MEM_L3_REDACT_CMD),
  });
  await engine.bootstrap();
  const origClose = engine.close.bind(engine);
  engine.close = async () => {
    await origClose();
    if (embedder) await embedder.dispose();
  };
  return engine;
}
