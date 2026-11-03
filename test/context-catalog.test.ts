import { expect, test } from "vitest";
import { registerContextTools } from "../src/mcp/context-tools.js";

test("text-only clients discover the same resumable thread across checkouts", async () => {
  const handlers = new Map<string, any>();
  const thread = { id: "11111111-1111-4111-8111-111111111111", scope: "github.com/org/repo", headBranch: "fix/data", prNumber: 42, title: "Repair data", state: "handed_off" };
  const seen: unknown[] = [];
  const server = { registerTool: (name: string, _schema: unknown, handler: unknown) => handlers.set(name, handler) };
  const bridge = { get: async () => ({ store: { getCatalog: async (opts: unknown) => {
    seen.push(opts);
    return { pinnedTasks: [], sharedProjects: [], activeClaims: [], recentThreads: [thread], page: { pinnedTotal: 0, projectsTotal: 0 } };
  } } }) };
  registerContextTools(server as any, bridge as any, "wrong-project");
  const result = await handlers.get("task_catalog")({ scope: thread.scope });
  expect(seen).toEqual([{ scope: thread.scope }]);
  expect(result.content[0].text).toContain(`task_resume({"thread_id":"${thread.id}"})`);
  expect(result.content[0].text).toContain("fix/data");
  expect(result.content[0].text).toContain("handed_off");
  expect(result.structuredContent.recentThreads).toEqual([thread]);
});
