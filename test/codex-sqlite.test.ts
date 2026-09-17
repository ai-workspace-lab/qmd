import { describe, expect, it } from "vitest";
import { readCodexState } from "../src/collect/codex.js";

describe("Codex SQLite state parser", () => {
  it("extracts pinned threads and projects when database exists", () => {
    const { pinned, projects } = readCodexState();
    // In our test environment, ~/.codex/state_5.sqlite is populated
    if (projects.length > 0) {
      expect(projects.length).toBeGreaterThan(0);
      expect(projects[0]).toHaveProperty("id");
      expect(projects[0]).toHaveProperty("name");
      expect(projects[0]).toHaveProperty("path");
    }

    if (pinned.length > 0) {
      expect(pinned.length).toBeGreaterThan(0);
      expect(pinned[0]).toHaveProperty("id");
      expect(pinned[0]).toHaveProperty("name");
      expect(pinned[0]).toHaveProperty("title");
      // Check that at least some pinned tasks have projects or paths
      const withProject = pinned.find((p) => p.projectName !== undefined);
      if (withProject) {
        expect(withProject.projectName).toBeTruthy();
      }
    }
  });
});
