/**
 * location.test.ts - Shared locations never carry absolute paths.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLocation } from "../src/collect/location.js";

let root: string;
let repo: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "qmd-loc-")));
  repo = join(root, "widgets");
  mkdirSync(join(repo, "packages", "core"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: repo });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("describeLocation", () => {
  test("a repository root becomes its git scope", () => {
    expect(describeLocation(repo)).toEqual({
      kind: "repo", scope: "github.com/acme/widgets", location: ".", key: "github.com/acme/widgets", label: "widgets",
    });
  });

  test("a subdirectory keeps only the repo-relative path", () => {
    const loc = describeLocation(join(repo, "packages", "core"));
    expect(loc).toMatchObject({ kind: "repo", scope: "github.com/acme/widgets", location: "packages/core", key: "github.com/acme/widgets/packages/core" });
  });

  test("a ChatGPT/Codex cloud project becomes its project ref", () => {
    const loc = describeLocation("/Users/someone/.codex/.chatgpt-projects/g-p-6a24e4bb29f88191");
    expect(loc).toEqual({
      kind: "chatgpt-project", scope: null, location: "chatgpt-project:g-p-6a24e4bb29f88191",
      key: "chatgpt-project:g-p-6a24e4bb29f88191", label: "g-p-6a24e4bb29f88191",
    });
  });

  test("a plain or missing directory is reduced to its name", () => {
    expect(describeLocation(root).location).toMatch(/^dir:qmd-loc-/);
    expect(describeLocation("/Users/someone/workspaces/ai-workspace-service")).toMatchObject({
      kind: "directory", location: "dir:ai-workspace-service",
    });
  });

  test("no field contains the absolute path", () => {
    for (const p of [repo, join(repo, "packages", "core"), root]) {
      expect(JSON.stringify(describeLocation(p))).not.toContain(root);
    }
  });
});
