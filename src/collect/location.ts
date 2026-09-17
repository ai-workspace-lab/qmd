/**
 * collect/location.ts - Turn a machine-local directory into a shareable location
 *
 * Shared context must not carry absolute paths: they leak the local user name
 * and mean nothing on another machine. A directory is described as
 *   - a git repository scope plus a repo-relative subpath, or
 *   - a ChatGPT/Codex cloud project id, or
 *   - a plain directory name when neither applies.
 */

import { existsSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import { resolveScope, resolveWorktree } from "../pg/task-scope.js";

export type LocationKind = "repo" | "chatgpt-project" | "directory";

export interface SharedLocation {
  kind: LocationKind;
  /** Git scope (github.com/org/repo) for repositories, else null. */
  scope: string | null;
  /** Repo-relative subpath ("." for the root), a cloud project ref, or dir:<name>. */
  location: string;
  /** Stable identity for de-duplication across agents and machines. */
  key: string;
  /** Short human label. */
  label: string;
}

const CHATGPT_PROJECT = /[\\/]\.codex[\\/]\.chatgpt-projects[\\/](g-p-[A-Za-z0-9]+)/;

export function describeLocation(absPath: string): SharedLocation {
  const cloud = CHATGPT_PROJECT.exec(absPath);
  if (cloud) {
    const ref = `chatgpt-project:${cloud[1]}`;
    return { kind: "chatgpt-project", scope: null, location: ref, key: ref, label: cloud[1]! };
  }
  const root = existsSync(absPath) ? resolveWorktree(absPath) : undefined;
  if (root) {
    const scope = resolveScope(undefined, {}, root);
    const rel = relative(root, absPath).split(sep).join("/") || ".";
    return {
      kind: "repo",
      scope,
      location: rel,
      key: rel === "." ? scope : `${scope}/${rel}`,
      label: rel === "." ? scope.split("/").pop() || scope : `${basename(root)}/${rel}`,
    };
  }
  const name = basename(absPath) || "directory";
  return { kind: "directory", scope: null, location: `dir:${name}`, key: `dir:${name}`, label: name };
}
