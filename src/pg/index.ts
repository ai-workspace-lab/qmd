/**
 * pg/index.ts - Entry point for the PostgreSQL memory bridge.
 *
 * Wires qmd's LlamaCpp embedder (external OpenAI-compatible API by default,
 * optional local models) to the PG-backed memory store and returns a handle
 * that disposes both the LLM and the connection pool on close.
 */

import { LlamaCpp } from "../llm.js";
import { resolvePgConfig, isPgBackend, type PgConnectionConfig } from "./config.js";
import { PgMemoryStore } from "./memory-store.js";

export { PgMemoryStore } from "./memory-store.js";
export type {
  AddMemoryInput,
  AddMemoryResult,
  MemorySearchResult,
  MemoryRecord,
  SearchOptions,
  Embedder,
} from "./memory-store.js";
export {
  resolveBackend,
  isPgBackend,
  resolveNamespace,
  resolvePgConfig,
  redactConnectionString,
  DEFAULT_NAMESPACE,
} from "./config.js";
export type { Backend, PgConnectionConfig } from "./config.js";

export interface MemoryBridge {
  store: PgMemoryStore;
  config: PgConnectionConfig;
  dispose(): Promise<void>;
}

/**
 * Open the memory bridge from the environment. Throws a clear error if the PG
 * backend is not configured.
 */
export async function openMemoryBridge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryBridge> {
  if (!isPgBackend(env)) {
    throw new Error(
      "PostgreSQL backend is not selected. Set QMD_BACKEND=pg and QMD_PG_URL to use memory commands.",
    );
  }
  const config = resolvePgConfig(env);

  // A dedicated embedder for the bridge — lazy-loads models on first use and
  // auto-unloads after inactivity. Uses the same external embed API as the
  // SQLite engine so vectors are comparable across hosts.
  const llm = new LlamaCpp({
    inactivityTimeoutMs: 5 * 60 * 1000,
    disposeModelsOnInactivity: true,
  });

  const store = await PgMemoryStore.open(config, llm);

  return {
    store,
    config,
    dispose: async () => {
      await store.close();
      await llm.dispose();
    },
  };
}
