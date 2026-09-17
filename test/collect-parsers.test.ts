/**
 * collect-parsers.test.ts - Local session collectors and rule-based extraction.
 *
 * All fixtures are hand-written minimal records shaped like each client's
 * on-disk format; no real transcript content is used. Extraction runs against
 * a throwaway git repository.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeRecords, parseClaudeDesktopSession } from "../src/collect/claude-code.js";
import { parseCodexRecords } from "../src/collect/codex.js";
import { parseAntigravityRecords } from "../src/collect/antigravity.js";
import { readJsonlFrom } from "../src/collect/types.js";
import { extractSession, verificationSegment, scrubCommand, toRepoRelative } from "../src/collect/extract.js";

let repo: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "qmd-collect-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", "git@github.com:acme/widgets.git");
  writeFileSync(join(repo, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feat/context");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("Claude Code transcript", () => {
  const ts = "2026-09-17T10:00:00.000Z";
  const records = () => [
    { type: "custom-title", customTitle: "Shared context layer", sessionId: "c1" },
    {
      type: "assistant", sessionId: "c1", cwd: repo, gitBranch: "feat/context", timestamp: ts,
      message: { content: [
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(repo, "src/a.ts") } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "cd src && npx vitest run test/a.test.ts 2>&1 | tail" } },
        { type: "text", text: "never collected" },
      ] },
    },
    {
      type: "user", sessionId: "c1", cwd: repo, gitBranch: "feat/context", timestamp: ts,
      message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "boom" }] },
    },
  ];

  test("collects edited paths, command results and the title — never message text", () => {
    const { facts } = parseClaudeRecords(records(), {});
    expect(facts).toHaveLength(1);
    const f = facts[0]!;
    expect(f).toMatchObject({ source: "claude-code", sessionId: "c1", gitBranch: "feat/context", title: "Shared context layer" });
    expect(f.paths.map((p) => p.absPath)).toEqual([join(repo, "src/a.ts")]);
    expect(f.commands).toEqual([expect.objectContaining({ exitCode: 1 })]);
    expect(JSON.stringify(facts)).not.toContain("never collected");
    expect(JSON.stringify(facts)).not.toContain("boom");
  });

  test("a tool call answered in a later chunk is resolved from cursor meta", () => {
    const all = records();
    const first = parseClaudeRecords(all.slice(0, 2), {});
    expect(first.facts[0]!.commands).toHaveLength(0);
    const second = parseClaudeRecords(all.slice(2), JSON.parse(JSON.stringify(first.meta)));
    expect(second.facts[0]!.commands).toEqual([expect.objectContaining({ exitCode: 1 })]);
  });

  test("a branch switch inside one session yields one fact set per branch", () => {
    const { facts } = parseClaudeRecords(
      [
        { type: "assistant", sessionId: "c2", cwd: repo, gitBranch: "a", timestamp: "2026-09-17T10:00:00Z",
          message: { content: [{ type: "tool_use", id: "x", name: "Write", input: { file_path: join(repo, "a") } }] } },
        { type: "assistant", sessionId: "c2", cwd: repo, gitBranch: "b", timestamp: "2026-09-17T11:00:00Z",
          message: { content: [{ type: "tool_use", id: "y", name: "Write", input: { file_path: join(repo, "b") } }] } },
      ],
      {},
    );
    expect(facts.map((f) => f.gitBranch)).toEqual(["a", "b"]);
  });
});

describe("Claude Desktop session metadata", () => {
  test("maps linked PRs onto the CLI session id", () => {
    const facts = parseClaudeDesktopSession(
      {
        cliSessionId: "c1", cwd: repo, title: "Shared context layer", lastActivityAt: 1789600000000,
        prs: [
          { prNumber: 12, branch: "feat/context", state: "OPEN", repo: "acme/widgets" },
          { prNumber: 9, branch: "old", state: "MERGED", dismissed: true },
        ],
      },
      0,
    );
    expect(facts).toEqual([
      expect.objectContaining({ source: "claude-code", sessionId: "c1", prNumber: 12, gitBranch: "feat/context", prState: "open" }),
    ]);
  });

  test("sessions without a CLI transcript id are ignored", () => {
    expect(parseClaudeDesktopSession({ cwd: repo, title: "x" }, 0)).toEqual([]);
  });
});

describe("Codex rollout", () => {
  test("reads session cwd, command exit codes and file changes", () => {
    const { facts, meta } = parseCodexRecords(
      [
        { timestamp: "2026-09-17T09:00:00Z", type: "session_meta", payload: { id: "x1", cwd: repo, originator: "Codex Desktop" } },
        { timestamp: "2026-09-17T09:01:00Z", type: "response_item", payload: { type: "message", content: [{ text: "never collected" }] } },
        { timestamp: "2026-09-17T09:02:00Z", type: "event_msg", payload: { type: "item_completed", item: {
          type: "CommandExecution", command: ["/bin/zsh", "-lc", "go test ./..."], exit_code: 0, status: "completed", aggregated_output: "secret output" } } },
        { timestamp: "2026-09-17T09:03:00Z", type: "event_msg", payload: { type: "item_completed", item: {
          type: "FileChange", changes: { [join(repo, "internal/x.go")]: { type: "update", unified_diff: "@@ diff @@" } } } } },
      ],
      {},
    );
    expect(meta).toMatchObject({ sessionId: "x1", cwd: repo });
    const f = facts[0]!;
    expect(f.commands).toEqual([expect.objectContaining({ command: "go test ./...", exitCode: 0 })]);
    expect(f.paths.map((p) => p.absPath)).toEqual([join(repo, "internal/x.go")]);
    const serialized = JSON.stringify(facts);
    for (const leaked of ["never collected", "secret output", "@@ diff @@"]) expect(serialized).not.toContain(leaked);
  });

  test("later chunks keep the session identity from cursor meta", () => {
    const { facts } = parseCodexRecords(
      [{ timestamp: "2026-09-17T09:05:00Z", type: "event_msg", payload: { type: "item_completed", item: {
        type: "CommandExecution", command: ["make", "test"], exit_code: 2 } } }],
      { sessionId: "x1", cwd: repo },
    );
    expect(facts[0]).toMatchObject({ sessionId: "x1", cwd: repo, commands: [{ command: "make test", exitCode: 2 }] });
  });
});

describe("Antigravity transcript", () => {
  test("anchors to the command Cwd and records written files", () => {
    const { facts } = parseAntigravityRecords(
      "ag1",
      [
        { type: "PLANNER_RESPONSE", created_at: "2026-09-17T08:00:00Z", tool_calls: [
          { name: "run_command", args: { CommandLine: "go test ./...", Cwd: repo } },
          { name: "write_to_file", args: { TargetFile: join(repo, "docs/x.md") } },
          { name: "view_file", args: { AbsolutePath: join(repo, "README.md") } },
        ] },
      ],
      {},
      "Antigravity title",
    );
    expect(facts).toEqual([
      expect.objectContaining({ source: "antigravity", sessionId: "ag1", cwd: repo, title: "Antigravity title", commands: [] }),
    ]);
    expect(facts[0]!.paths.map((p) => p.absPath)).toEqual([join(repo, "docs/x.md")]);
  });

  test("no cwd, no facts", () => {
    expect(parseAntigravityRecords("ag2", [{ type: "USER_INPUT", created_at: "2026-09-17T08:00:00Z" }], {}).facts).toEqual([]);
  });
});

describe("incremental JSONL reading", () => {
  test("stops before a partial trailing line and resumes from the offset", async () => {
    const file = join(repo, "session.jsonl");
    writeFileSync(file, `{"n":1}\n{"n":2}\n{"n":`);
    const seen: number[] = [];
    const offset = await readJsonlFrom(file, 0, (r) => seen.push(r.n));
    expect(seen).toEqual([1, 2]);
    appendFileSync(file, `3}\n`);
    await readJsonlFrom(file, offset, (r) => seen.push(r.n));
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("extraction", () => {
  test("verification segment is the check itself, without pipes or cd", () => {
    expect(verificationSegment("cd src && npx vitest run test/a.test.ts 2>&1 | tail")).toBe("npx vitest run test/a.test.ts");
    expect(verificationSegment("git status")).toBeUndefined();
  });

  test("command text carries no repo or home paths", () => {
    expect(scrubCommand(`go test ${repo}/internal/...`, repo, "/Users/someone")).toBe("go test ./internal/...");
  });

  test("paths outside the repository are dropped", () => {
    expect(toRepoRelative(join(repo, "src/a.ts"), repo)).toBe("src/a.ts");
    expect(toRepoRelative("/etc/hosts", repo)).toBeUndefined();
  });

  test("a session becomes scope + branch + head + items", () => {
    const outcome = extractSession({
      source: "codex", agentKind: "codex", sessionId: "x1", cwd: join(repo), updatedAt: new Date().toISOString(),
      paths: [
        { absPath: join(repo, "src/a.ts"), action: "modified", at: "2026-09-17T09:00:00Z" },
        { absPath: join(repo, "src/a.ts"), action: "modified", at: "2026-09-17T09:01:00Z" },
        { absPath: "/tmp/elsewhere.txt", action: "modified", at: "2026-09-17T09:01:00Z" },
      ],
      commands: [
        { command: "npx vitest run", exitCode: 1, at: "2026-09-17T09:02:00Z" },
        { command: "npx vitest run", exitCode: 0, at: "2026-09-17T09:03:00Z" },
        { command: "ls -la", exitCode: 0, at: "2026-09-17T09:03:00Z" },
        { command: "go test ./...", exitCode: null, at: "2026-09-17T09:04:00Z" },
      ],
    });
    expect(outcome.sessions).toHaveLength(1);
    const s = outcome.sessions[0]!;
    expect(s.scope).toBe("github.com/acme/widgets");
    expect(s.headBranch).toBe("feat/context");
    expect(s.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(s.items.filter((i) => i.kind === "path").map((i) => i.text)).toEqual(["src/a.ts"]);
    expect(s.items.filter((i) => i.kind === "verification")).toEqual([
      expect.objectContaining({ text: "npx vitest run", status: "pass", gitHead: s.headSha }),
    ]);
  });

  test("an old session without a recorded branch is not attributed to today's checkout", () => {
    const outcome = extractSession(
      { source: "codex", agentKind: "codex", sessionId: "old", cwd: repo, updatedAt: "2026-01-01T00:00:00Z", paths: [], commands: [] },
      Date.parse("2026-09-17T00:00:00Z"),
    );
    expect(outcome.sessions[0]?.headBranch).toBeUndefined();
  });

  test("missing or non-repo directories are skipped with a reason", () => {
    const base = { source: "codex", agentKind: "codex" as const, sessionId: "s", updatedAt: new Date().toISOString(), paths: [], commands: [] };
    expect(extractSession({ ...base })).toEqual({ sessions: [], skipped: "no_cwd" });
    expect(extractSession({ ...base, cwd: join(repo, "does-not-exist") })).toEqual({ sessions: [], skipped: "cwd_missing" });
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "qmd-plain-")));
    mkdirSync(join(plain, "x"));
    expect(extractSession({ ...base, cwd: plain })).toEqual({ sessions: [], skipped: "not_a_repo" });
    rmSync(plain, { recursive: true, force: true });
  });

  test("a session launched above several checkouts is split per repository", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "qmd-multi-")));
    const other = join(parent, "other");
    mkdirSync(other);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: other, stdio: "ignore" });
    git("init", "-q", "-b", "feat/other");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("remote", "add", "origin", "https://github.com/acme/other.git");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const outcome = extractSession({
      source: "claude-code", agentKind: "claude", sessionId: "m1", cwd: parent, gitBranch: "HEAD", title: "multi",
      updatedAt: new Date().toISOString(),
      paths: [
        { absPath: join(repo, "src/a.ts"), action: "modified", at: "2026-09-17T09:00:00Z" },
        { absPath: join(other, "lib/b.ts"), action: "modified", at: "2026-09-17T09:00:00Z" },
      ],
      commands: [{ command: `cd ${other} && go test ./...`, exitCode: 0, at: "2026-09-17T09:01:00Z" }],
    });
    const byScope = Object.fromEntries(outcome.sessions.map((s) => [s.scope, s]));
    expect(Object.keys(byScope).sort()).toEqual(["github.com/acme/other", "github.com/acme/widgets"]);
    expect(byScope["github.com/acme/other"]!.headBranch).toBe("feat/other");
    expect(byScope["github.com/acme/widgets"]!.headBranch).toBe("feat/context");
    expect(byScope["github.com/acme/other"]!.items.map((i) => i.kind).sort()).toEqual(["goal", "path", "verification"]);
    rmSync(parent, { recursive: true, force: true });
  });
});

describe("heredoc bodies are never mistaken for verification commands", () => {
  test("a heredoc that writes a fixture mentioning 'go test' is not a verification", () => {
    const command = [
      "cat > test/fixture.ts <<'EOF2'",
      'const cmd = { command: ["/bin/zsh", "-lc", "go test ./..."], exit_code: 0 };',
      "EOF2",
    ].join("\n");
    expect(verificationSegment(command)).toBeUndefined();
  });

  test("a real command after a heredoc is still detected", () => {
    const command = [
      "cat > file.txt <<'EOF2'",
      "some content mentioning go test but not run",
      "EOF2",
      "go test ./...",
    ].join("\n");
    expect(verificationSegment(command)).toBe("go test ./...");
  });
});

describe("only commands that run a check count as verification", () => {
  test.each([
    ['git commit -m "fix\n\n- `npm test`\n- `terraform validate`"', undefined],
    ['echo \'{ "cmd": "go test ./...", "result": "pass" }\'', undefined],
    ["go test ./...`, exitCode: 0 }],", undefined],
    ["grep -n 'go test' Makefile", undefined],
    ["env -u QMD_MCP_TOKEN -u QMD_BACKEND npx vitest run test/mcp.test.ts", "env -u QMD_MCP_TOKEN -u QMD_BACKEND npx vitest run test/mcp.test.ts"],
    ["CI=1 go test ./internal/acp/", "CI=1 go test ./internal/acp/"],
    ["cd bridge && time make test", "time make test"],
  ])("%s", (command, expected) => {
    expect(verificationSegment(command)).toBe(expected);
  });
});
