/**
 * pg/context-merge.ts - Field-level merge rules for shared task context
 *
 * Several agent sessions (Claude Code, Codex, Antigravity, a web plugin …) can
 * contribute to the same PR/branch thread. Rather than letting each session
 * overwrite one handoff document, every fact is a keyed *item* and this module
 * decides — deterministically, with no I/O — how an incoming item combines with
 * what is already stored. Semantic near-duplicate detection is deliberately not
 * done here: a missed dedupe costs one extra row, a wrong merge loses a fact.
 *
 * Two write classes (docs/plan/multi-agent-shared-context.md §3):
 *  - direction items (goal, next_action, plan ordering/dropping) belong to the
 *    session holding the thread lease; anyone else's write is kept as `proposed`
 *  - accumulating items (decision, pitfall, verification, path, question,
 *    blocker, plan progress) merge from any session
 */

import { createHash } from "node:crypto";

export const ITEM_KINDS = [
  "goal",
  "next_action",
  "plan_step",
  "decision",
  "pitfall",
  "verification",
  "path",
  "question",
  "blocker",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Upper bound for one item's JSON body. Anything larger is an artifact, not context. */
export const MAX_ITEM_BYTES = 4096;

export interface IncomingItem {
  kind: ItemKind;
  /** Short human text: the goal, the step, the pitfall, the command, the path. */
  text: string;
  /** Explicit dedupe key (plan stepKey, decision memoryKey). */
  key?: string;
  /** plan_step: todo|doing|done|dropped · verification: pass|fail|not_run · question/blocker: open|resolved */
  status?: string;
  /** git HEAD the fact was observed against. */
  gitHead?: string;
  /** ISO timestamp of the observation; defaults to now. */
  at?: string;
  /** path: modified | claimed | reviewed · question/blocker: resolution text. */
  detail?: string;
  /** plan_step ordering (driver only). */
  ord?: number;
}

export interface StoredItem {
  kind: ItemKind;
  key: string;
  status: string;
  ord: number | null;
  body: ItemBody;
  gitHead: string | null;
}

export interface ItemBody {
  text: string;
  at: string;
  detail?: string;
}

export interface MergeContext {
  /** Session writing this item. */
  sessionId: string;
  /** True when the session holds the thread lease with the current fence. */
  isDriver: boolean;
  /** The thread's current head, used to rank verification results. */
  threadHead?: string | null;
}

export type MergeVerdict =
  | { action: "insert"; next: StoredItem; event?: string }
  | { action: "update"; next: StoredItem; event?: string }
  /** Nothing new: only record that this session also observed the item. */
  | { action: "touch" }
  | { action: "reject"; reason: string };

const PLAN_RANK: Record<string, number> = { todo: 0, doing: 1, done: 2 };
const VERIFY_RESULTS = new Set(["pass", "fail", "not_run"]);
const PATH_ACTIONS = new Set(["modified", "claimed", "reviewed"]);

/** NFKC, trim, collapse whitespace. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/** Content key for items without an explicit key. */
export function hashKey(text: string): string {
  const digest = createHash("sha256").update(normalizeText(text).toLowerCase()).digest("hex");
  return `h:${digest.slice(0, 16)}`;
}

function slugKey(key: string): string {
  return normalizeText(key)
    .toLowerCase()
    .replace(/[^a-z0-9/._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A repo-relative path is the only location an item may carry. Absolute paths,
 * home-relative paths and parent escapes are machine-specific and are rejected.
 */
export function isRepoRelativePath(path: string): boolean {
  const p = path.trim();
  if (!p || p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.includes("\0")) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** The stored key an incoming item maps to, given who is writing it. */
export function itemKey(item: IncomingItem, ctx: MergeContext): string {
  switch (item.kind) {
    case "goal":
    case "next_action":
      return ctx.isDriver ? "current" : `proposed:${ctx.sessionId}`;
    case "plan_step":
      return item.key ? slugKey(item.key) : hashKey(item.text);
    case "decision":
      return item.key ? slugKey(item.key) : hashKey(item.text);
    case "verification":
      return normalizeText(item.text);
    case "path":
      return normalizeText(item.text);
    default:
      return hashKey(item.text);
  }
}

function bodyOf(item: IncomingItem, at: string): ItemBody {
  return {
    text: normalizeText(item.text),
    at,
    ...(item.detail ? { detail: normalizeText(item.detail) } : {}),
  };
}

function tooLarge(item: StoredItem): boolean {
  return Buffer.byteLength(JSON.stringify(item.body), "utf8") > MAX_ITEM_BYTES;
}

function later(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}

/**
 * Decide how `incoming` combines with `existing` (the stored row for the same
 * kind+key, or null). Pure: callers do the locking and persistence.
 */
export function mergeItem(
  existing: StoredItem | null,
  incoming: IncomingItem,
  ctx: MergeContext,
): MergeVerdict {
  if (!(ITEM_KINDS as readonly string[]).includes(incoming.kind)) {
    return { action: "reject", reason: `unknown kind '${incoming.kind}'` };
  }
  if (!incoming.text || !normalizeText(incoming.text)) {
    return { action: "reject", reason: "empty text" };
  }

  const at = incoming.at && !Number.isNaN(new Date(incoming.at).getTime())
    ? new Date(incoming.at).toISOString()
    : new Date().toISOString();
  const key = itemKey(incoming, ctx);
  const gitHead = incoming.gitHead ?? null;

  let next: StoredItem;
  switch (incoming.kind) {
    case "goal":
    case "next_action": {
      next = {
        kind: incoming.kind,
        key,
        status: ctx.isDriver ? "current" : "proposed",
        ord: null,
        body: bodyOf(incoming, at),
        gitHead,
      };
      if (tooLarge(next)) return { action: "reject", reason: "item body exceeds 4 KiB" };
      if (!existing) return { action: "insert", next };
      if (existing.body.text === next.body.text) return { action: "touch" };
      return {
        action: "update",
        next,
        ...(ctx.isDriver ? { event: `${incoming.kind === "goal" ? "goal" : "next_action"}.revised` } : {}),
      };
    }

    case "plan_step": {
      const status = incoming.status ?? "todo";
      if (!(status in PLAN_RANK) && status !== "dropped") {
        return { action: "reject", reason: `invalid plan status '${status}'` };
      }
      next = {
        kind: "plan_step",
        key,
        status,
        ord: incoming.ord ?? existing?.ord ?? null,
        body: bodyOf(incoming, at),
        gitHead,
      };
      if (tooLarge(next)) return { action: "reject", reason: "item body exceeds 4 KiB" };
      if (!existing) {
        if (!ctx.isDriver) next.ord = null; // non-drivers append; ordering is the driver's call
        return { action: "insert", next };
      }
      if (ctx.isDriver) {
        const same =
          existing.status === next.status &&
          existing.ord === next.ord &&
          existing.body.text === next.body.text;
        return same ? { action: "touch" } : { action: "update", next };
      }
      // Non-driver: progress may only move forward; dropping or reopening needs the driver.
      if (status === "dropped" || existing.status === "dropped") return { action: "touch" };
      if ((PLAN_RANK[status] ?? 0) <= (PLAN_RANK[existing.status] ?? 0)) return { action: "touch" };
      return {
        action: "update",
        next: { ...existing, status, gitHead: gitHead ?? existing.gitHead, body: { ...existing.body, at } },
      };
    }

    case "decision": {
      next = { kind: "decision", key, status: "active", ord: null, body: bodyOf(incoming, at), gitHead };
      if (tooLarge(next)) return { action: "reject", reason: "item body exceeds 4 KiB" };
      if (!existing) return { action: "insert", next };
      if (existing.body.text === next.body.text) return { action: "touch" };
      // Only reachable with an explicit key (a hash key implies identical text).
      return { action: "update", next, event: "decision.revised" };
    }

    case "pitfall": {
      next = { kind: "pitfall", key, status: "active", ord: null, body: bodyOf(incoming, at), gitHead };
      if (tooLarge(next)) return { action: "reject", reason: "item body exceeds 4 KiB" };
      return existing ? { action: "touch" } : { action: "insert", next };
    }

    case "verification": {
      const result = incoming.status ?? "not_run";
      if (!VERIFY_RESULTS.has(result)) {
        return { action: "reject", reason: `invalid verification result '${result}'` };
      }
      next = { kind: "verification", key, status: result, ord: null, body: bodyOf(incoming, at), gitHead };
      if (tooLarge(next)) return { action: "reject", reason: "item body exceeds 4 KiB" };
      if (!existing) return { action: "insert", next };

      const head = ctx.threadHead ?? null;
      const incomingOnHead = !!head && gitHead === head;
      const existingOnHead = !!head && existing.gitHead === head;
      let wins: boolean;
      if (incomingOnHead !== existingOnHead) wins = incomingOnHead;
      else wins = later(at, existing.body.at);
      if (!wins) return { action: "touch" };
      if (existing.status === result && existing.gitHead === gitHead) {
        return { action: "update", next: { ...existing, body: { ...existing.body, at } } };
      }
      return { action: "update", next };
    }

    case "path": {
      if (!isRepoRelativePath(incoming.text)) {
        return { action: "reject", reason: "path must be repo-relative" };
      }
      const detail = incoming.detail ?? "modified";
      if (!PATH_ACTIONS.has(detail)) return { action: "reject", reason: `invalid path action '${detail}'` };
      next = {
        kind: "path",
        key,
        status: "active",
        ord: null,
        body: { text: normalizeText(incoming.text), at, detail },
        gitHead,
      };
      if (tooLarge(next)) return { action: "reject", reason: "item body exceeds 4 KiB" };
      if (!existing) return { action: "insert", next };
      if (existing.body.detail === detail && existing.gitHead === gitHead) return { action: "touch" };
      return later(at, existing.body.at) ? { action: "update", next } : { action: "touch" };
    }

    case "question":
    case "blocker": {
      const status = incoming.status ?? "open";
      if (status !== "open" && status !== "resolved") {
        return { action: "reject", reason: `invalid ${incoming.kind} status '${status}'` };
      }
      if (status === "resolved" && !incoming.detail) {
        return { action: "reject", reason: `resolving a ${incoming.kind} requires a resolution` };
      }
      next = { kind: incoming.kind, key, status, ord: null, body: bodyOf(incoming, at), gitHead };
      if (tooLarge(next)) return { action: "reject", reason: "item body exceeds 4 KiB" };
      if (!existing) return { action: "insert", next };
      if (existing.status === status) return { action: "touch" };
      if (existing.status === "resolved" && !ctx.isDriver) return { action: "touch" };
      return { action: "update", next };
    }
  }
}
