/**
 * tier/l3.ts - L3 cold layer hand-off.
 *
 * The box cannot call Drive directly, so L3 is staged as files under
 * `l3-cache/` and travels to Drive with the existing `.archive` flow
 * (redact → residual scan → tar → UploadFile → verify → commit). An outbox
 * row becomes `committed` only after the archive's committed manifest lists
 * the same path with the same sha256.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findSecret } from "../collect/redact.js";

export interface RedactResult {
  text: string;
  counts: Record<string, number>;
  /** Non-empty when the redacted text still matches a secret pattern. */
  residual: string[];
}

export type L3Redactor = (text: string) => RedactResult;

/**
 * Redactor backed by an external command (the box uses ops/redact-l3.py which
 * wraps .archive/redact.py). Falls back to the fork's findSecret, which cannot
 * mask values: any hit is reported as residual so the caller quarantines.
 */
export function makeRedactor(cmd?: string): L3Redactor {
  if (cmd && cmd.trim()) {
    const [bin, ...args] = cmd.trim().split(/\s+/);
    return (text: string) => {
      const r = spawnSync(bin!, args, { input: text, maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) {
        return { text: "", counts: {}, residual: [`redactor-exit-${r.status ?? "signal"}`] };
      }
      const parsed = JSON.parse(r.stdout.toString("utf8")) as RedactResult;
      return { text: parsed.text, counts: parsed.counts ?? {}, residual: parsed.residual ?? [] };
    };
  }
  return (text: string) => {
    const hit = findSecret(text);
    return { text, counts: {}, residual: hit ? [hit] : [] };
  };
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Drive-style relative target: raw/YYYY/MM/<kind>/<source>/<name> */
export function l3TargetPath(kind: string, source: string, occurredAt: Date, name: string): string {
  const local = new Date(occurredAt.getTime() + 8 * 3600 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
  const safeSource = source.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `raw/${y}/${m}/${kind}/${safeSource}/${safe}`;
}

export interface StagedFile {
  localPath: string;
  targetPath: string;
  sha256: string;
  bytes: number;
}

/** Write an already-redacted original into l3-cache (idempotent, never overwrites different content). */
export function writeL3Cache(l3CacheDir: string, targetPath: string, text: string): StagedFile {
  let localPath = join(l3CacheDir, targetPath);
  const sha = sha256Hex(text);
  if (existsSync(localPath)) {
    const existing = readFileSync(localPath);
    if (sha256Hex(existing) !== sha) {
      // Never overwrite an uploaded original: write a new version instead.
      let v = 2;
      while (existsSync(`${localPath}.v${v}`)) v++;
      localPath = `${localPath}.v${v}`;
      targetPath = `${targetPath}.v${v}`;
    }
  }
  mkdirSync(dirname(localPath), { recursive: true });
  if (!existsSync(localPath)) writeFileSync(localPath, text);
  return { localPath, targetPath, sha256: sha, bytes: Buffer.byteLength(text) };
}

export function quarantine(quarantineDir: string, name: string, reasons: string[]): string {
  mkdirSync(quarantineDir, { recursive: true });
  const p = join(quarantineDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
  // Only metadata: the offending text is NOT copied (it may contain a secret).
  writeFileSync(p, JSON.stringify({ name, reasons, at: new Date().toISOString() }, null, 2));
  return p;
}

export interface ArchiveManifest {
  runId: string;
  archiveBase: string;
  files: Map<string, { sha256: string; size: number }>;
}

/** Read `.archive/state/manifest.json` (the last committed archive baseline). */
export function readArchiveManifest(stateDir: string): ArchiveManifest | null {
  const p = join(stateDir, "manifest.json");
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf8")) as {
    run_id?: string;
    archive_base?: string;
    files?: Record<string, { sha256?: string; size?: number }>;
  };
  const files = new Map<string, { sha256: string; size: number }>();
  for (const [k, v] of Object.entries(raw.files ?? {})) {
    if (v?.sha256) files.set(k, { sha256: v.sha256, size: v.size ?? 0 });
  }
  return { runId: raw.run_id ?? "", archiveBase: raw.archive_base ?? "", files };
}

/** Path key used by .archive manifests (relative to the workspace root). */
export function archiveKey(workspaceRoot: string, localPath: string): string {
  return relative(workspaceRoot, localPath).split("\\").join("/");
}
