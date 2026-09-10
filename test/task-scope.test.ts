/**
 * task-scope.test.ts - Pure unit tests for coordination environment sensing.
 *
 * These never touch a database or a git repo, so they run everywhere. The
 * live-PostgreSQL tests for the claim protocol are in
 * pg-task.integration.test.ts (gated on QMD_PG_URL).
 */

import { describe, test, expect } from "vitest";
import {
  normalizeRemote,
  resolveScope,
  resolveAgentKind,
  resolveAgentId,
} from "../src/pg/task-scope.js";

describe("normalizeRemote", () => {
  test("SSH and HTTPS clones of one repo produce the same scope", () => {
    const expected = "github.com/acme/widgets";
    expect(normalizeRemote("git@github.com:acme/widgets.git")).toBe(expected);
    expect(normalizeRemote("https://github.com/acme/widgets.git")).toBe(expected);
    expect(normalizeRemote("https://github.com/acme/widgets")).toBe(expected);
    expect(normalizeRemote("ssh://git@github.com/acme/widgets.git")).toBe(expected);
  });

  test("keeps a non-default host and port-bearing ssh urls", () => {
    expect(normalizeRemote("ssh://git@git.internal:2222/team/repo.git")).toBe(
      "git.internal/team/repo",
    );
    expect(normalizeRemote("git@gitlab.example.com:group/sub/proj.git")).toBe(
      "gitlab.example.com/group/sub/proj",
    );
  });

  test("tolerates trailing slashes and empty input", () => {
    expect(normalizeRemote("https://github.com/acme/widgets/")).toBe("github.com/acme/widgets");
    expect(normalizeRemote("")).toBeUndefined();
    expect(normalizeRemote("   ")).toBeUndefined();
    expect(normalizeRemote("not a url")).toBeUndefined();
  });
});

describe("resolveScope", () => {
  test("an explicit override wins over everything", () => {
    expect(resolveScope("my-scope", { QMD_TASK_SCOPE: "env-scope" })).toBe("my-scope");
  });

  test("falls back to QMD_TASK_SCOPE before touching git", () => {
    expect(resolveScope(undefined, { QMD_TASK_SCOPE: "env-scope" })).toBe("env-scope");
  });

  test("blank overrides are ignored, not treated as a scope", () => {
    expect(resolveScope("   ", { QMD_TASK_SCOPE: "env-scope" })).toBe("env-scope");
  });

  test("outside a git checkout it still yields a usable scope", () => {
    // /tmp has no origin remote; the basename keeps the command working, it
    // just coordinates less widely.
    const scope = resolveScope(undefined, {}, "/");
    expect(typeof scope).toBe("string");
    expect(scope.length).toBeGreaterThan(0);
  });
});

describe("resolveAgentKind", () => {
  test("honours an explicit override", () => {
    expect(resolveAgentKind({ QMD_AGENT_KIND: "codex" })).toBe("codex");
    expect(resolveAgentKind({ QMD_AGENT_KIND: "HUMAN" })).toBe("human");
  });

  test("detects each client from its own environment markers", () => {
    expect(resolveAgentKind({ CLAUDECODE: "1" })).toBe("claude");
    expect(resolveAgentKind({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(resolveAgentKind({ OPENCODE: "1" })).toBe("opencode");
    expect(resolveAgentKind({ ANTIGRAVITY: "1" })).toBe("antigravity");
  });

  test("an unknown client still coordinates", () => {
    expect(resolveAgentKind({})).toBe("unknown");
  });

  test("an unrecognised override does not leak through", () => {
    expect(resolveAgentKind({ QMD_AGENT_KIND: "banana" })).toBe("unknown");
  });
});

describe("resolveAgentId", () => {
  test("an explicit id wins", () => {
    expect(resolveAgentId("me", { QMD_AGENT_ID: "other" })).toBe("me");
  });

  test("prefers a session id so re-claiming is idempotent across calls", () => {
    // Stability matters: two claims from one session must collide with
    // themselves (→ refresh), not with a stranger (→ blocked).
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc123" };
    expect(resolveAgentId(undefined, env)).toBe("claude:abc123");
    expect(resolveAgentId(undefined, env)).toBe(resolveAgentId(undefined, env));
  });

  test("falls back to a host+pid identity that is stable within a process", () => {
    const a = resolveAgentId(undefined, {});
    const b = resolveAgentId(undefined, {});
    expect(a).toBe(b);
    expect(a.startsWith("unknown:")).toBe(true);
  });
});
