/**
 * pg-config.test.ts - Pure unit tests for the PG memory bridge configuration.
 *
 * These never touch a database, so they run everywhere. Integration tests that
 * require a live PostgreSQL are in pg-memory.integration.test.ts (gated on
 * QMD_PG_URL).
 */

import { describe, test, expect } from "vitest";
import {
  resolveBackend,
  isPgBackend,
  resolveNamespace,
  resolvePgConfig,
  resolvePgSsl,
  redactConnectionString,
  DEFAULT_NAMESPACE,
} from "../src/pg/config.js";
import { toVectorLiteral } from "../src/pg/db-pg.js";

describe("resolveBackend", () => {
  test("defaults to sqlite", () => {
    expect(resolveBackend({})).toBe("sqlite");
    expect(isPgBackend({})).toBe(false);
  });

  test("accepts pg / postgres / postgresql", () => {
    expect(resolveBackend({ QMD_BACKEND: "pg" })).toBe("pg");
    expect(resolveBackend({ QMD_BACKEND: "postgres" })).toBe("pg");
    expect(resolveBackend({ QMD_BACKEND: "POSTGRESQL" })).toBe("pg");
    expect(isPgBackend({ QMD_BACKEND: "pg" })).toBe(true);
  });

  test("a bare connection URL does NOT switch the backend", () => {
    // Selection must be explicit so existing SQLite workflows never change.
    expect(resolveBackend({ QMD_PG_URL: "postgres://x/y" })).toBe("sqlite");
  });
});

describe("resolveNamespace", () => {
  test("defaults to the default namespace", () => {
    expect(resolveNamespace({})).toBe(DEFAULT_NAMESPACE);
    expect(resolveNamespace({ QMD_NAMESPACE: "  " })).toBe(DEFAULT_NAMESPACE);
  });

  test("uses QMD_NAMESPACE when set", () => {
    expect(resolveNamespace({ QMD_NAMESPACE: "openclaw" })).toBe("openclaw");
  });
});

describe("resolvePgSsl", () => {
  test("disable turns TLS off", () => {
    expect(resolvePgSsl({ QMD_PG_SSL: "disable" })).toBe(false);
  });

  test("no-verify keeps TLS but skips verification", () => {
    expect(resolvePgSsl({ QMD_PG_SSL: "no-verify" })).toEqual({ rejectUnauthorized: false });
  });

  test("defaults to TLS without verification when no CA is supplied", () => {
    expect(resolvePgSsl({})).toEqual({ rejectUnauthorized: false });
  });
});

describe("resolvePgConfig", () => {
  test("throws a helpful error when no URL is set", () => {
    expect(() => resolvePgConfig({ QMD_BACKEND: "pg" })).toThrow(/no connection URL/i);
  });

  test("builds config from QMD_PG_URL", () => {
    const cfg = resolvePgConfig({
      QMD_BACKEND: "pg",
      QMD_PG_URL: "postgres://postgres:secret@db.example.com:5443/qmd",
      QMD_NAMESPACE: "hermes",
    });
    expect(cfg.connectionString).toContain("db.example.com:5443");
    expect(cfg.namespace).toBe("hermes");
    expect(cfg.max).toBeGreaterThan(0);
  });

  test("falls back to DATABASE_URL", () => {
    const cfg = resolvePgConfig({ DATABASE_URL: "postgres://u:p@h:5432/d" });
    expect(cfg.connectionString).toContain("h:5432");
  });

  test("respects pool + timeout overrides", () => {
    const cfg = resolvePgConfig({
      QMD_PG_URL: "postgres://u:p@h:5432/d",
      QMD_PG_POOL_MAX: "12",
      QMD_PG_CONNECT_TIMEOUT_MS: "2500",
    });
    expect(cfg.max).toBe(12);
    expect(cfg.connectionTimeoutMillis).toBe(2500);
  });
});

describe("redactConnectionString", () => {
  test("hides the password", () => {
    const out = redactConnectionString("postgres://postgres:topsecret@db:5443/qmd");
    expect(out).not.toContain("topsecret");
    expect(out).toContain("db:5443");
  });
});

describe("toVectorLiteral", () => {
  test("formats number arrays as a pgvector literal", () => {
    expect(toVectorLiteral([1, 2, 3])).toBe("[1,2,3]");
  });

  test("handles Float32Array", () => {
    expect(toVectorLiteral(new Float32Array([0.5, -0.25]))).toBe("[0.5,-0.25]");
  });
});
