/**
 * pg/db-pg.ts - PostgreSQL connection layer
 *
 * Thin async wrapper over node-postgres. `pg` is imported lazily so SQLite-only
 * installs never load the driver. Provides a small query surface used by the
 * memory store plus a transaction helper.
 */

import type { PgConnectionConfig } from "./config.js";
import { redactConnectionString } from "./config.js";

// Minimal structural types — we avoid importing `pg`'s types at module load so
// the dependency stays optional at runtime.
interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
  on(event: "error", handler: (err: Error) => void): void;
}

interface PoolClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}

let PoolCtor: (new (config: Record<string, unknown>) => PoolLike) | null = null;

async function loadPoolCtor(): Promise<new (config: Record<string, unknown>) => PoolLike> {
  if (PoolCtor) return PoolCtor;
  let mod: any;
  try {
    mod = await import("pg");
  } catch (err) {
    throw new Error(
      "The 'pg' package is required for the PostgreSQL backend but is not installed. " +
        "Run `bun add pg` (and `bun add -d @types/pg`).\n" +
        `Underlying error: ${(err as Error).message}`,
    );
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) throw new Error("Could not resolve `Pool` from the 'pg' package.");
  PoolCtor = Pool;
  return Pool;
}

export class PgClient {
  private pool: PoolLike;
  readonly namespace: string;
  readonly connectionLabel: string;

  private constructor(pool: PoolLike, namespace: string, connectionLabel: string) {
    this.pool = pool;
    this.namespace = namespace;
    this.connectionLabel = connectionLabel;
  }

  static async create(config: PgConnectionConfig): Promise<PgClient> {
    const Pool = await loadPoolCtor();
    const pool = new Pool({
      connectionString: config.connectionString,
      ssl: config.ssl,
      max: config.max,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    });
    // Surface background pool errors instead of crashing the process.
    pool.on("error", (err) => {
      console.error(`[qmd:pg] idle client error: ${err.message}`);
    });
    return new PgClient(pool, config.namespace, redactConnectionString(config.connectionString));
  }

  /** Run a query and return all rows. */
  async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(text, params);
    return res.rows as T[];
  }

  /** Run a query and return the first row (or null). */
  async queryOne<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
    const res = await this.pool.query(text, params);
    return (res.rows[0] as T) ?? null;
  }

  /** Run a statement and return the affected row count. */
  async exec(text: string, params: unknown[] = []): Promise<number> {
    const res = await this.pool.query(text, params);
    return res.rowCount ?? 0;
  }

  /** Run `fn` inside a transaction on a dedicated client. */
  async tx<T>(fn: (client: PgTxClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgTxClient(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Liveness check — returns the server version string. */
  async ping(): Promise<string> {
    const row = await this.queryOne<{ version: string }>("SELECT version() AS version");
    return row?.version ?? "unknown";
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Query handle bound to a single transaction client. */
export class PgTxClient {
  constructor(private client: PoolClientLike) {}

  async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(text, params);
    return res.rows as T[];
  }

  async queryOne<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
    const res = await this.client.query(text, params);
    return (res.rows[0] as T) ?? null;
  }

  async exec(text: string, params: unknown[] = []): Promise<number> {
    const res = await this.client.query(text, params);
    return res.rowCount ?? 0;
  }
}

/** Format a JS number[] as a pgvector literal: [1,2,3]. */
export function toVectorLiteral(embedding: number[] | Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}
