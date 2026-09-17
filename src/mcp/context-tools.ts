/**
 * mcp/context-tools.ts - MCP tools for shared task context
 *
 * task_resume / task_note / task_handoff let any MCP-capable client (Claude
 * Code, Codex, Antigravity, OpenCode) pick up the PR/branch thread another
 * client left, add to it, and hand it on. Like the task_* claim tools they take
 * `cwd` explicitly: a shared HTTP daemon does not run in the caller's checkout.
 */

import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ITEM_KINDS,
  resolveBaseSha,
  resolveBranch,
  resolveScope,
  type ContextBridge,
  type ContextThread,
  type IncomingItem,
} from "../pg/index.js";
import { renderBriefing } from "../pg/context-brief.js";

const itemSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  text: z.string().describe("Short text: the step, decision, pitfall, command, or repo-relative path"),
  status: z
    .string()
    .optional()
    .describe("plan_step: todo|doing|done|dropped · verification: pass|fail|not_run · question/blocker: open|resolved"),
  key: z.string().optional().describe("Stable key: plan step key or decision memory key"),
  detail: z.string().optional().describe("path: modified|claimed|reviewed · resolution text for question/blocker"),
});

type ItemArg = z.infer<typeof itemSchema>;

export function registerContextTools(server: McpServer, ctx: ContextBridge, fallbackScope: string): void {
  const store = ctx.store;

  /** Client identity: explicit arg, else the MCP client's own name. */
  const sourceOf = (client?: string): string => {
    const name = client?.trim() || server.server.getClientVersion()?.name || "mcp";
    return `mcp:${name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
  };

  /**
   * Where the caller's checkout is. Locally the daemon can inspect `cwd` with
   * git. In remote mode (QMD behind xworkmate-bridge) the caller's directory
   * does not exist on this host, so the client must send scope/branch/head_sha
   * itself — silently deriving a scope from a missing path would file the work
   * under the wrong project.
   */
  const checkoutOf = (
    args: { cwd?: string | undefined; scope?: string | undefined; branch?: string | undefined; head_sha?: string | undefined },
  ): { scope?: string; branch?: string; head?: string } | { error: string } => {
    const local = args.cwd && existsSync(args.cwd) ? args.cwd : undefined;
    if (args.cwd && !local && !args.scope?.trim()) {
      return {
        error:
          `cwd ${args.cwd} does not exist on the QMD host (remote mode). ` +
          `Pass scope (e.g. github.com/org/repo) and branch, and head_sha when known.`,
      };
    }
    const scope = args.scope?.trim() || (local ? resolveScope(undefined, process.env, local) : undefined);
    const branch = args.branch?.trim() || (local ? resolveBranch(local) : undefined);
    const head = args.head_sha?.trim() || (local ? resolveBaseSha(local) : undefined);
    return { ...(scope ? { scope } : {}), ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
  };

  const threadFor = async (
    args: {
      thread_id?: string | undefined; cwd?: string | undefined; scope?: string | undefined;
      pr?: number | undefined; branch?: string | undefined; head_sha?: string | undefined;
    },
  ): Promise<{ thread: ContextThread; created: boolean } | { error: string }> => {
    if (args.thread_id) {
      const thread = await store.getThread(args.thread_id);
      return thread ? { thread, created: false } : { error: `thread ${args.thread_id} not found` };
    }
    const checkout = checkoutOf(args);
    if ("error" in checkout) return checkout;
    const scope = checkout.scope ?? fallbackScope;
    const branch = checkout.branch;
    const head = checkout.head;
    const resolved = await store.resolveThread({
      scope,
      ...(branch ? { headBranch: branch } : {}),
      ...(args.pr ? { prNumber: args.pr } : {}),
      ...(head ? { headSha: head } : {}),
    });
    if (!resolved.ok) {
      return {
        error:
          `${branch ?? "this checkout"} is a default branch, so it does not identify a task. ` +
          `Pass pr, or thread_id of an existing thread.`,
      };
    }
    return { thread: resolved.thread, created: resolved.created };
  };

  const toItems = (items: ItemArg[] | undefined, cwd?: string, headSha?: string): IncomingItem[] => {
    const head = headSha?.trim() || (cwd && existsSync(cwd) ? resolveBaseSha(cwd) : undefined);
    return (items ?? []).map((i) => ({
      kind: i.kind,
      text: i.text,
      ...(i.status ? { status: i.status } : {}),
      ...(i.key ? { key: i.key } : {}),
      ...(i.detail ? { detail: i.detail } : {}),
      ...(head ? { gitHead: head } : {}),
    }));
  };

  server.registerTool(
    "task_resume",
    {
      title: "Resume the shared task for this branch",
      description:
        "Call at the START of a session. Finds the task thread for the checkout's PR/branch — the one " +
        "other clients (Claude Code, Codex, Antigravity, OpenCode, web) have been contributing to — attaches " +
        "you to it and returns the merged briefing: goal, next action, plan, decisions, pitfalls, " +
        "verification results, touched paths, and git drift against your checkout. Set lead=true when you " +
        "intend to change direction (goal, next action, plan order); otherwise you contribute as a peer.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        cwd: z.string().optional().describe("Absolute path of your checkout (strongly recommended)"),
        thread_id: z.string().optional().describe("Resume a specific thread instead of resolving from cwd"),
        pr: z.number().optional().describe("PR number, when known"),
        scope: z.string().optional().describe("Project key; omit to derive from cwd"),
        branch: z.string().optional().describe("Git branch; required with scope in remote mode"),
        head_sha: z.string().optional().describe("Current HEAD sha; recommended in remote mode"),
        lead: z.boolean().optional().describe("Acquire the driver lease"),
        takeover: z.boolean().optional().describe("With lead: take over a handed-off or paused thread"),
        client: z.string().optional().describe("Your client name, e.g. claude-code, codex, antigravity"),
        session_id: z.string().optional().describe("Your client's own session id, for stable attribution"),
      },
    },
    async ({ cwd, thread_id, pr, scope, branch, head_sha, lead, takeover, client, session_id }, extra) => {
      const found = await threadFor({ thread_id, cwd, scope, pr, branch, head_sha });
      if ("error" in found) return { content: [{ type: "text", text: found.error }], isError: true };
      const head = head_sha?.trim() || (cwd && existsSync(cwd) ? resolveBaseSha(cwd) : undefined);
      const sessionId = await store.attachSession(found.thread.id, {
        source: sourceOf(client),
        sourceSessionId: session_id || extra.sessionId || "stdio",
        agentKind: client ?? "unknown",
        ...(head ? { headSha: head } : {}),
      });
      let leadNote = "";
      let fence: number | null = null;
      if (lead) {
        const res = await store.lead(found.thread.id, sessionId, { takeover: !!takeover });
        if (res.ok) fence = res.fence;
        else leadNote = `\nNot the driver: session ${res.holder} holds the lease until ${res.leaseExpiresAt}. ` +
          `Contribute as a peer, wait, or retry with takeover=true once it is handed off.`;
      }
      const briefing = await store.briefing(found.thread.id);
      const text = renderBriefing(briefing!, { ...(cwd && existsSync(cwd) ? { cwd } : {}), sessionId }) +
        (found.created ? "\n(new thread created for this branch)" : "") + leadNote +
        `\n\nsession_id for task_note/task_handoff: ${sessionId}${fence !== null ? ` · fence ${fence}` : ""}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { threadId: found.thread.id, sessionId, fence, created: found.created, briefing },
      };
    },
  );

  server.registerTool(
    "task_note",
    {
      title: "Add to the shared task context",
      description:
        "Record important session facts as you work so any client can continue: decisions (with why), " +
        "pitfalls you hit, verification commands with pass/fail, plan progress, open questions, repo-relative " +
        "paths. Never include file contents, diffs, logs, secrets or absolute paths — they are rejected. " +
        "goal/next_action from a non-driver are stored as proposals.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        session_id: z.string().describe("session_id returned by task_resume"),
        thread_id: z.string().optional().describe("Thread from task_resume; omit to resolve from cwd"),
        cwd: z.string().optional().describe("Absolute path of your checkout"),
        scope: z.string().optional().describe("Project key; required with branch in remote mode when thread_id is omitted"),
        branch: z.string().optional().describe("Git branch (remote mode)"),
        head_sha: z.string().optional().describe("Current HEAD sha (remote mode)"),
        fence: z.number().optional().describe("Fence from task_resume when you are the driver"),
        items: z.array(itemSchema).min(1).max(50),
      },
    },
    async ({ session_id, thread_id, cwd, scope, branch, head_sha, fence, items }) => {
      const found = await threadFor({ thread_id, cwd, scope, branch, head_sha });
      if ("error" in found) return { content: [{ type: "text", text: found.error }], isError: true };
      const result = await store.mergeItems(found.thread.id, session_id, toItems(items, cwd, head_sha), {
        ...(fence !== undefined ? { fence } : {}),
      });
      const text =
        `Merged into ${found.thread.prNumber ? `PR #${found.thread.prNumber}` : found.thread.headBranch ?? found.thread.id}: ` +
        `+${result.inserted} new, ${result.updated} updated, ${result.touched} already known` +
        (result.proposed ? `, ${result.proposed} stored as proposals (you are not the driver)` : "") +
        (result.rejected.length ? `\nRejected: ${result.rejected.map((r) => `${r.kind}: ${r.reason}`).join("; ")}` : "");
      return { content: [{ type: "text", text }], structuredContent: { result } };
    },
  );

  server.registerTool(
    "task_handoff",
    {
      title: "Hand the task off",
      description:
        "Call before you stop or switch clients while you are the driver. Records the next action (required) " +
        "and any final items, releases the driver lease and marks the thread handed off so the next client's " +
        "task_resume starts exactly where you left off.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        thread_id: z.string(),
        session_id: z.string(),
        fence: z.number(),
        next_action: z.string().describe("One concrete, executable next step"),
        cwd: z.string().optional(),
        head_sha: z.string().optional().describe("Current HEAD sha (remote mode)"),
        items: z.array(itemSchema).max(50).optional(),
      },
    },
    async ({ thread_id, session_id, fence, next_action, cwd, head_sha, items }) => {
      const res = await store.handoff(thread_id, session_id, fence, next_action, toItems(items, cwd, head_sha));
      if (!res.ok) return { content: [{ type: "text", text: `Handoff refused: ${res.reason}` }], isError: true };
      return {
        content: [{ type: "text", text: `Handed off. Next: ${next_action}` }],
        structuredContent: { result: res.merge },
      };
    },
  );

  server.registerTool(
    "task_catalog",
    {
      title: "Get shared task catalog, pinned tasks, and project directories",
      description:
        "Returns the unified catalog across Codex, Claude Code, Antigravity, and OpenCode: " +
        "1. Pinned tasks (置顶任务, e.g. from Codex Desktop). " +
        "2. Shared project directories and workspaces. " +
        "3. Active resource leases and locks across agents. " +
        "4. Recent active task threads. " +
        "Use this tool to discover tasks or projects to resume, or to check which agent is working on what.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        cwd: z.string().optional().describe("Current working directory to filter or highlight relative tasks"),
      },
    },
    async ({ cwd }) => {
      const catalog = await store.getCatalog(cwd ? { scope: resolveScope(undefined, process.env, cwd) } : {});

      let text = `# Shared Task & Project Catalog\n\n`;

      text += `## 📌 Pinned Tasks (置顶任务 - ${catalog.page.pinnedTotal})\n`;
      if (catalog.pinnedTasks.length === 0) {
        text += `*(No pinned tasks)*\n\n`;
      } else {
        for (const [idx, t] of catalog.pinnedTasks.entries()) {
          const proj = t.projectName ? ` [${t.projectName}]` : "";
          const branch = t.gitBranch ? ` (${t.gitBranch})` : "";
          const where = t.scope ? `${t.scope}${t.location && t.location !== "." ? `/${t.location}` : ""}` : t.location ?? "n/a";
          text += `${idx + 1}. **${t.title}**${proj}${branch}\n   Source: \`${t.source}\` | Location: \`${where}\`\n`;
        }
        text += "\n";
      }

      text += `## 📁 Shared Projects (共享项目 - ${catalog.page.projectsTotal})\n`;
      if (catalog.sharedProjects.length === 0) {
        text += `*(No shared projects)*\n\n`;
      } else {
        for (const p of catalog.sharedProjects) {
          text += `- **${p.name}**: \`${p.key}\` (${p.kind}; sources: ${p.sources.join(", ")})\n`;
        }
        text += "\n";
      }

      text += `## 🔒 Active In-Flight Leases (正在执行中 - ${catalog.activeClaims.length})\n`;
      if (catalog.activeClaims.length === 0) {
        text += `*(No active resource locks)*\n\n`;
      } else {
        for (const c of catalog.activeClaims) {
          text += `- \`${c.resource}\` held by ${c.agentKind} (\`${c.agentId}\`)${c.intent ? ` for "${c.intent}"` : ""} (expires: ${c.expiresAt})\n`;
        }
        text += "\n";
      }

      return {
        content: [{ type: "text", text }],
        structuredContent: catalog,
      };
    },
  );
}

