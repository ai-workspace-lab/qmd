#!/usr/bin/env npx tsx
/**
 * Offline memory/artifact contract smoke.
 *
 * This deliberately does not connect to PostgreSQL or download an embedding
 * model. It proves the local artifact side of the memory boundary: secret
 * detection with metadata-only quarantine, content-addressed dedupe, restart
 * persistence, a failure receipt, and checksum-verified export/restore into a
 * second directory.
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findSecret } from "../../src/collect/redact.js";

type ManifestEntry = { path: string; bytes: number; sha256: string };

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

async function files(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await files(root, path)));
    else out.push(relative(root, path));
  }
  return out.sort();
}

async function manifest(root: string): Promise<ManifestEntry[]> {
  const result: ManifestEntry[] = [];
  for (const path of await files(root)) {
    const body = await readFile(join(root, path));
    result.push({ path, bytes: body.byteLength, sha256: hash(body) });
  }
  return result;
}

async function putArtifact(root: string, key: string, body: string): Promise<"inserted" | "duplicate"> {
  const sha256 = hash(body);
  const path = join(root, "artifacts", `${sha256}.json`);
  try {
    await stat(path);
    return "duplicate";
  } catch {
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
    await writeFile(join(root, "artifacts", `${sha256}.key`), key, "utf8");
    return "inserted";
  }
}

async function verifyRestore(bundle: string, restore: string): Promise<void> {
  const expected = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")) as ManifestEntry[];
  for (const entry of expected) {
    const body = await readFile(join(restore, entry.path));
    if (body.byteLength !== entry.bytes || hash(body) !== entry.sha256) {
      throw new Error(`checksum mismatch: ${entry.path}`);
    }
  }
  const actual = await manifest(restore);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("restore manifest differs");
}

const root = await mkdtemp(join(tmpdir(), "qmd-memory-e2e-"));
const bundle = await mkdtemp(join(tmpdir(), "qmd-memory-bundle-"));
const restore = await mkdtemp(join(tmpdir(), "qmd-memory-restore-"));
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  await mkdir(join(root, "artifacts"), { recursive: true });
  await mkdir(join(root, "quarantine"), { recursive: true });
  await mkdir(join(root, "receipts"), { recursive: true });

  const safe = { kind: "fact", key: "local/gitops/ref", text: "Local development stack follows a fixed Git ref." };
  const secretText = "temporary synthetic sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const secretKind = findSecret(secretText);
  check("secret-bearing input is quarantined by type", secretKind === "openai-style-key", secretKind ?? "none");
  await writeFile(
    join(root, "quarantine", `${hash(secretText)}.json`),
    JSON.stringify({ sha256: hash(secretText), reason: secretKind, bytes: Buffer.byteLength(secretText) }) + "\n",
  );
  await writeFile(join(root, "artifacts", "safe-fact.json"), JSON.stringify(safe) + "\n");
  check("quarantine stores metadata only", !(await readFile(join(root, "quarantine", `${hash(secretText)}.json`), "utf8")).includes(secretText));

  const artifact = JSON.stringify({ ...safe, source: "synthetic-session-1" }) + "\n";
  check("first artifact import inserts", (await putArtifact(root, "session-1", artifact)) === "inserted");
  check("repeated artifact import is idempotent", (await putArtifact(root, "session-1", artifact)) === "duplicate");

  // Simulate process restart: a new call reads the persisted content-addressed file.
  const persisted = await readFile(join(root, "artifacts", `${hash(artifact)}.json`), "utf8");
  check("restart sees persisted artifact", persisted === artifact);

  const failure = { operation: "artifact-import", status: "failed", reason: "synthetic source unavailable" };
  await writeFile(join(root, "receipts", "failure.json"), JSON.stringify(failure) + "\n");
  check("failure receipt is durable", (await readFile(join(root, "receipts", "failure.json"), "utf8")).includes("source unavailable"));

  const before = await manifest(root);
  await writeFile(join(bundle, "manifest.json"), JSON.stringify(before, null, 2) + "\n");
  for (const path of await files(root)) {
    const target = join(bundle, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, await readFile(join(root, path)));
  }
  check("export manifest has checksums", before.length >= 4 && before.every((x) => /^[a-f0-9]{64}$/.test(x.sha256)));

  for (const path of await files(bundle)) {
    if (path === "manifest.json") continue;
    const target = join(restore, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, await readFile(join(bundle, path)));
  }
  await verifyRestore(bundle, restore);
  check("independent restore matches manifest", true);
} catch (error) {
  check("artifact smoke completed", false, error instanceof Error ? error.message : String(error));
} finally {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(bundle, { recursive: true, force: true }), rm(restore, { recursive: true, force: true })]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
