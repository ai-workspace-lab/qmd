/**
 * pg/config.ts - Backend selection & PostgreSQL connection resolution
 *
 * QMD defaults to the local SQLite backend (unchanged behaviour). When the PG
 * backend is selected, qmd talks to a shared PostgreSQL instance (e.g. the
 * postgresql.svc.plus runtime with pgvector + pg_jieba + pg_trgm) and acts as a
 * memory bridge for external agents (OpenClaw, Hermes, ...).
 *
 * Nothing here imports `pg` — connection objects are built lazily in db-pg.ts so
 * that SQLite-only installs never need the driver.
 */

import { readFileSync } from "node:fs";

export type Backend = "sqlite" | "pg";

/** TLS configuration passed through to node-postgres' `ssl` option. */
export type PgSslConfig =
  | false
  | {
      rejectUnauthorized: boolean;
      ca?: string;
    };

export interface PgConnectionConfig {
  /** PostgreSQL connection string (postgres://user:pass@host:port/db). */
  connectionString: string;
  /** TLS settings. postgresql.svc.plus terminates TLS at stunnel (default 5443). */
  ssl: PgSslConfig;
  /** Logical tenant namespace — isolates OpenClaw / Hermes / ... memory. */
  namespace: string;
  /** Max pool size. */
  max: number;
  /** Connection/statement timeout (ms). */
  connectionTimeoutMillis: number;
}

export const DEFAULT_NAMESPACE = "default";

/**
 * Resolve the active backend from QMD_BACKEND. Defaults to "sqlite".
 * A bare `QMD_PG_URL`/`DATABASE_URL` does NOT silently switch the backend —
 * selection is explicit so existing SQLite workflows never change.
 */
export function resolveBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const raw = (env.QMD_BACKEND ?? "").trim().toLowerCase();
  if (raw === "pg" || raw === "postgres" || raw === "postgresql") return "pg";
  return "sqlite";
}

/** True when QMD is configured to use PostgreSQL. */
export function isPgBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBackend(env) === "pg";
}

/**
 * Resolve the namespace for the current process. Agents override per-call, but
 * this is the default tenant when none is supplied.
 */
export function resolveNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const ns = (env.QMD_NAMESPACE ?? "").trim();
  return ns || DEFAULT_NAMESPACE;
}

/**
 * Resolve the TLS configuration.
 *
 *  - QMD_PG_SSL=disable        → no TLS (plain; e.g. via a local stunnel-client)
 *  - QMD_PG_SSL=no-verify      → TLS without certificate verification
 *  - QMD_PG_SSL=require (def.)  → TLS, verify against system / QMD_PG_CA bundle
 *  - QMD_PG_CA=/path/to/ca.pem → custom CA bundle (implies verification on)
 */
export function resolvePgSsl(env: NodeJS.ProcessEnv = process.env): PgSslConfig {
  const mode = (env.QMD_PG_SSL ?? "").trim().toLowerCase();
  const caPath = (env.QMD_PG_CA ?? "").trim();
  const ca = caPath ? readFileSync(caPath, "utf8") : undefined;

  if (mode === "disable" || mode === "off" || mode === "false") return false;
  if (mode === "no-verify" || mode === "allow") {
    return { rejectUnauthorized: false, ...(ca ? { ca } : {}) };
  }
  // Default: require TLS. Verify only when a CA is supplied (stunnel often uses
  // self-signed certs, so default to no-verify unless an explicit CA is given).
  return { rejectUnauthorized: !!ca, ...(ca ? { ca } : {}) };
}

/**
 * Build the full PG connection config from the environment.
 * Throws a clear error when the PG backend is selected without a connection URL.
 */
export function resolvePgConfig(env: NodeJS.ProcessEnv = process.env): PgConnectionConfig {
  const connectionString = (env.QMD_PG_URL ?? env.DATABASE_URL ?? "").trim();
  if (!connectionString) {
    throw new Error(
      "PostgreSQL backend selected (QMD_BACKEND=pg) but no connection URL found. " +
        "Set QMD_PG_URL (or DATABASE_URL), e.g.\n" +
        "  export QMD_PG_URL='postgres://postgres:***@db.example.com:5443/qmd'",
    );
  }

  const max = Number.parseInt(env.QMD_PG_POOL_MAX ?? "", 10);
  const timeout = Number.parseInt(env.QMD_PG_CONNECT_TIMEOUT_MS ?? "", 10);

  return {
    connectionString,
    ssl: resolvePgSsl(env),
    namespace: resolveNamespace(env),
    max: Number.isFinite(max) && max > 0 ? max : 5,
    connectionTimeoutMillis: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
  };
}

/** Redact credentials from a connection string for logging. */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return connectionString.replace(/:\/\/[^@]*@/, "://***@");
  }
}
