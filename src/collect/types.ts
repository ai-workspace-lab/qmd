/**
 * collect/types.ts - Local session directory collectors
 *
 * Desktop and CLI agent clients keep readable session logs on disk. A collector
 * turns one client's log format into neutral SessionFacts; extract.ts then
 * decides which facts are important enough to become shared context items.
 * Collectors never return message bodies, tool output or diffs.
 */

import { open } from "node:fs/promises";
import type { AgentKind } from "../pg/task-scope.js";

export interface PathFact {
  absPath: string;
  action: "modified";
  at: string;
}

export interface CommandFact {
  command: string;
  /** null when the result is unknown (still running, interrupted, not reported). */
  exitCode: number | null;
  /** Directory the command ran in, when the client records it per call. */
  cwd?: string;
  at: string;
}

/** Everything one client session revealed about one checkout+branch. */
export interface SessionFacts {
  source: string;
  agentKind: AgentKind;
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  prNumber?: number;
  prState?: "open" | "merged" | "closed";
  title?: string;
  updatedAt: string;
  paths: PathFact[];
  commands: CommandFact[];
}

export interface ParseResult {
  facts: SessionFacts[];
  /** Byte offset after the last complete record consumed. */
  nextOffset: number;
  /** State a later chunk of the same file needs (session id, cwd, pending calls). */
  meta: Record<string, unknown>;
}

export interface SessionFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SessionSource {
  id: string;
  label: string;
  agentKind: AgentKind;
  /** False for sources that are reserved but not parsed yet. */
  implemented: boolean;
  /** Whether this client's session directory exists on this machine. */
  detect(): boolean;
  /** Session files modified at or after `sinceMs`. */
  files(sinceMs: number): Promise<SessionFile[]>;
  /** Parse from `offset`. Whole-file sources ignore the offset and return size. */
  parse(file: SessionFile, offset: number, meta: Record<string, unknown>): Promise<ParseResult>;
}

/**
 * Stream complete JSONL records from `offset` without loading the file. A
 * trailing partial line (the client is still writing) is left for next time.
 */
export async function readJsonlFrom(
  path: string,
  offset: number,
  onRecord: (record: any) => void,
): Promise<number> {
  const handle = await open(path, "r");
  const block = Buffer.alloc(4 * 1024 * 1024);
  let position = offset;
  let consumed = offset;
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let buf = carry.length ? Buffer.concat([carry, block.subarray(0, bytesRead)]) : block.subarray(0, bytesRead);
      let start = 0;
      for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
        const line = buf.subarray(start, nl).toString("utf8").trim();
        consumed += nl - start + 1;
        start = nl + 1;
        if (!line) continue;
        try {
          onRecord(JSON.parse(line));
        } catch {
          // A corrupt line is skipped, not fatal: the rest of the session still counts.
        }
      }
      carry = Buffer.from(buf.subarray(start));
    }
  } finally {
    await handle.close();
  }
  return consumed;
}

export function isoOr(value: unknown, fallback: string): string {
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}
