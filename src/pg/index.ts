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
import { PgTaskStore } from "./task-store.js";
import { resolveScope, resolveAgentId, resolveAgentKind } from "./task-scope.js";

export { PgMemoryStore } from "./memory-store.js";
export { PgTaskStore } from "./task-store.js";
export type { TaskClaim, ClaimInput, ClaimResult, ClaimStatus } from "./task-store.js";
export {
  resolveScope,
  resolveAgentId,
  resolveAgentKind,
  resolveBranch,
  resolveBaseSha,
  resolveWorktree,
  describeDrift,
  normalizeRemote,
} from "./task-scope.js";
export type { AgentKind } from "./task-scope.js";
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

export interface TaskBridge {
  store: PgTaskStore;
  config: PgConnectionConfig;
  scope: string;
  agentId: string;
  agentKind: string;
  dispose(): Promise<void>;
}

/**
 * Open the coordination layer.
 *
 * Deliberately lighter than `openMemoryBridge`: claims are never embedded, so
 * no LlamaCpp instance is constructed. `qmd task who` runs on the pre-write hook
 * path of every editor keystroke-to-disk, and paying model-loading latency
 * there would guarantee the hook gets disabled.
 */
export async function openTaskBridge(
  opts: { scope?: string; agentId?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskBridge> {
  if (!isPgBackend(env)) {
    throw new Error(
      "PostgreSQL backend is not selected. Set QMD_BACKEND=pg and QMD_PG_URL to use task commands.",
    );
  }
  const config = resolvePgConfig(env);
  const scope = resolveScope(opts.scope, env);
  const agentId = resolveAgentId(opts.agentId, env);
  const agentKind = resolveAgentKind(env);
  const store = await PgTaskStore.open(config, scope);

  return {
    store,
    config,
    scope,
    agentId,
    agentKind,
    dispose: () => store.close(),
  };
}
