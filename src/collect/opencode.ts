/**
 * collect/opencode.ts - OpenCode CLI / App (reserved)
 *
 * OpenCode keeps session data under ~/.local/share/opencode. Detection is wired
 * so `qmd ctx sources` reports it, but parsing is intentionally not implemented
 * until the on-disk format can be verified on a machine that has OpenCode
 * sessions. OpenCode can still contribute today through the MCP task_* tools.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionSource } from "./types.js";

export function opencodeDir(home = homedir()): string {
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
}

export const opencodeSource: SessionSource = {
  id: "opencode",
  label: "OpenCode CLI / App (~/.local/share/opencode) — reserved",
  agentKind: "opencode",
  implemented: false,
  detect: () => existsSync(opencodeDir()),
  files: async () => [],
  parse: async () => {
    throw new Error("OpenCode session parsing is not implemented yet");
  },
};
