/**
 * context-merge.test.ts - Table-driven tests for the shared-context merge rules.
 *
 * Pure functions only; the PostgreSQL persistence around them is covered by
 * pg-context.integration.test.ts (gated on QMD_PG_URL).
 */

import { describe, test, expect } from "vitest";
import {
  mergeItem,
  itemKey,
  hashKey,
  isRepoRelativePath,
  type IncomingItem,
  type StoredItem,
  type MergeContext,
} from "../src/pg/context-merge.js";
import { findSecret } from "../src/collect/redact.js";

const driver: MergeContext = { sessionId: "s-driver", isDriver: true, threadHead: "head2" };
const other: MergeContext = { sessionId: "s-other", isDriver: false, threadHead: "head2" };

/** Apply an incoming item to nothing, returning the stored row it would create. */
function stored(item: IncomingItem, ctx: MergeContext): StoredItem {
  const v = mergeItem(null, item, ctx);
  if (v.action !== "insert") throw new Error(`expected insert, got ${v.action}`);
  return v.next;
}

describe("keys", () => {
  test("hash keys ignore case and whitespace differences", () => {
    expect(hashKey("Bridge  needs a branch from main")).toBe(hashKey(" bridge needs a BRANCH from main "));
  });

  test("direction items are keyed by writer role", () => {
    const goal: IncomingItem = { kind: "goal", text: "ship it" };
    expect(itemKey(goal, driver)).toBe("current");
    expect(itemKey(goal, other)).toBe("proposed:s-other");
  });

  test("plan step keys are slugged so clients agree on them", () => {
    expect(itemKey({ kind: "plan_step", text: "x", key: "Resolve API" }, other)).toBe("resolve-api");
  });
});

describe("goal / next_action", () => {
  test("a non-driver write is kept as a proposal, never overwriting the current value", () => {
    const v = mergeItem(null, { kind: "next_action", text: "add bridge route" }, other);
    expect(v.action).toBe("insert");
    if (v.action === "insert") {
      expect(v.next.status).toBe("proposed");
      expect(v.next.key).toBe("proposed:s-other");
    }
  });

  test("the driver revises the current value and emits a revision event", () => {
    const current = stored({ kind: "goal", text: "old goal" }, driver);
    const v = mergeItem(current, { kind: "goal", text: "new goal" }, driver);
    expect(v).toMatchObject({ action: "update", event: "goal.revised" });
  });

  test("same text is a touch", () => {
    const current = stored({ kind: "goal", text: "same" }, driver);
    expect(mergeItem(current, { kind: "goal", text: " same " }, driver).action).toBe("touch");
  });
});

describe("plan_step", () => {
  const base = (status: string, ctx = other) =>
    stored({ kind: "plan_step", text: "migrate", key: "migrate", status }, ctx);

  test.each([
    ["todo", "doing", "update"],
    ["doing", "done", "update"],
    ["done", "doing", "touch"],
    ["done", "todo", "touch"],
    ["doing", "dropped", "touch"],
    ["dropped", "done", "touch"],
  ])("non-driver %s → %s is %s", (from, to, expected) => {
    const v = mergeItem(base(from, driver), { kind: "plan_step", text: "migrate", key: "migrate", status: to }, other);
    expect(v.action).toBe(expected);
  });

  test("the driver may reopen and drop", () => {
    expect(
      mergeItem(base("done", driver), { kind: "plan_step", text: "migrate", key: "migrate", status: "todo" }, driver)
        .action,
    ).toBe("update");
    expect(
      mergeItem(base("doing", driver), { kind: "plan_step", text: "migrate", key: "migrate", status: "dropped" }, driver)
        .action,
    ).toBe("update");
  });

  test("non-drivers cannot set ordering on new steps", () => {
    const v = mergeItem(null, { kind: "plan_step", text: "x", ord: 1 }, other);
    expect(v.action === "insert" && v.next.ord).toBeNull();
  });

  test("invalid status is rejected", () => {
    expect(mergeItem(null, { kind: "plan_step", text: "x", status: "maybe" }, other).action).toBe("reject");
  });
});

describe("decision / pitfall", () => {
  test("identical pitfalls from two sessions collapse into one row", () => {
    const first = stored({ kind: "pitfall", text: "bridge is on the wrong branch" }, driver);
    expect(mergeItem(first, { kind: "pitfall", text: "Bridge is on the  wrong branch" }, other).action).toBe(
      "touch",
    );
  });

  test("a keyed decision with new text is revised", () => {
    const first = stored({ kind: "decision", key: "decision/claim-tx", text: "use a CTE" }, driver);
    expect(
      mergeItem(first, { kind: "decision", key: "decision/claim-tx", text: "use an explicit tx" }, other),
    ).toMatchObject({ action: "update", event: "decision.revised" });
  });
});

describe("verification", () => {
  const cmd = "go test ./...";

  test("a result on the thread head beats a newer result on an old head", () => {
    const onHead = stored({ kind: "verification", text: cmd, status: "pass", gitHead: "head2", at: "2026-09-17T10:00:00Z" }, other);
    const v = mergeItem(onHead, { kind: "verification", text: cmd, status: "fail", gitHead: "head1", at: "2026-09-17T11:00:00Z" }, other);
    expect(v.action).toBe("touch");
  });

  test("a result reaching the thread head replaces a stale one even if older", () => {
    const stale = stored({ kind: "verification", text: cmd, status: "fail", gitHead: "head1", at: "2026-09-17T11:00:00Z" }, other);
    const v = mergeItem(stale, { kind: "verification", text: cmd, status: "pass", gitHead: "head2", at: "2026-09-17T10:00:00Z" }, other);
    expect(v).toMatchObject({ action: "update", next: { status: "pass", gitHead: "head2" } });
  });

  test("on the same head the latest observation wins", () => {
    const first = stored({ kind: "verification", text: cmd, status: "pass", gitHead: "head2", at: "2026-09-17T10:00:00Z" }, other);
    const v = mergeItem(first, { kind: "verification", text: cmd, status: "fail", gitHead: "head2", at: "2026-09-17T12:00:00Z" }, driver);
    expect(v).toMatchObject({ action: "update", next: { status: "fail" } });
  });
});

describe("path", () => {
  test.each([
    ["src/pg/context-store.ts", true],
    ["./README.md", true],
    ["/Users/me/repo/src/a.ts", false],
    ["~/repo/a.ts", false],
    ["../other/a.ts", false],
    ["C:\\repo\\a.ts", false],
  ])("isRepoRelativePath(%s) = %s", (p, ok) => {
    expect(isRepoRelativePath(p)).toBe(ok);
  });

  test("absolute paths are rejected at merge time", () => {
    expect(mergeItem(null, { kind: "path", text: "/etc/passwd" }, other).action).toBe("reject");
  });
});

describe("question / blocker", () => {
  test("resolving requires a resolution", () => {
    expect(mergeItem(null, { kind: "question", text: "which token?", status: "resolved" }, other).action).toBe(
      "reject",
    );
  });

  test("only the driver reopens a resolved question", () => {
    const resolved = stored(
      { kind: "question", text: "which token?", status: "resolved", detail: "PAT" },
      driver,
    );
    expect(mergeItem(resolved, { kind: "question", text: "which token?", status: "open" }, other).action).toBe("touch");
    expect(mergeItem(resolved, { kind: "question", text: "which token?", status: "open" }, driver).action).toBe(
      "update",
    );
  });
});

describe("limits and secrets", () => {
  test("bodies over 4 KiB are rejected, not truncated", () => {
    expect(mergeItem(null, { kind: "pitfall", text: "x".repeat(5000) }, other)).toMatchObject({ action: "reject" });
  });

  const sampleToken = [["QMD", "INGEST", "TOKEN"].join("_"), ["0123456789", "abcdef0123"].join("")].join("=");
  test.each([
    [["export GITHUB", "_TOKEN=ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""), "github-token"],
    ["psql postgres://qmd:hunter2secret@127.0.0.1:15432/qmd", "url-credentials"],
    [["curl -H 'Auth", "orization: Bearer abcdefghijklmnopqrstuvwxyz012345'"].join(""), "bearer-token"],
    [sampleToken, "assigned-secret"],
  ])("findSecret flags %s", (text, name) => {
    expect(findSecret(text)).toBe(name);
  });

  test("ordinary commands are clean", () => {
    expect(findSecret("npx vitest run test/context-merge.test.ts")).toBeUndefined();
    expect(findSecret("go test ./internal/acp/...")).toBeUndefined();
    expect(findSecret("echo $QMD_INGEST_TOKEN")).toBeUndefined();
  });
});
