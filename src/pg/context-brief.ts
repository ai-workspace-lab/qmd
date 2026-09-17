/**
 * pg/context-brief.ts - Render a thread briefing for a model's context window
 *
 * Shared by `qmd ctx brief` and the task_resume MCP tool so every client sees
 * the same handoff text. Local git drift is computed here, on the reader's
 * machine, because the stored head is only what some other session observed.
 */

import type { Briefing, BriefingItem } from "./context-store.js";
import { describeDrift, resolveBaseSha, resolveBranch } from "./task-scope.js";

const PLAN_MARK: Record<string, string> = { done: "✅", doing: "▶", todo: "☐", dropped: "✗" };

function byKind(items: BriefingItem[], kind: string): BriefingItem[] {
  return items.filter((i) => i.kind === kind);
}

function who(item: BriefingItem): string {
  return item.sources.length ? ` (${item.sources.join(", ")})` : "";
}

export function renderBriefing(b: Briefing, opts: { cwd?: string; sessionId?: string } = {}): string {
  const t = b.thread;
  const lines: string[] = [];
  const label = t.prNumber ? `PR #${t.prNumber}${t.headBranch ? ` · ${t.headBranch}` : ""}` : t.headBranch ?? "explicit thread";
  const goals = byKind(b.items, "goal");
  const goal = goals.find((g) => g.status === "current") ?? goals[goals.length - 1];
  lines.push(`## Resume ${label}${goal ? `: ${goal.text}` : ""}`);
  lines.push(`thread ${t.id} · ${t.scope} · state ${t.state}${t.prState ? ` · PR ${t.prState}` : ""}`);

  const leaseLive = !!t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() > Date.now();
  const driver = leaseLive
    ? t.driverSessionId === opts.sessionId
      ? `you (fence ${t.fence})`
      : `another session until ${t.leaseExpiresAt} (fence ${t.fence})`
    : "nobody — call task_resume with lead=true to drive";
  lines.push(`driver: ${driver}`);
  if (b.contributors.length) {
    lines.push(`contributors: ${b.contributors.map((c) => `${c.source} ×${c.sessions}`).join(", ")}`);
  }

  if (opts.cwd) {
    const localBranch = resolveBranch(opts.cwd);
    const localHead = resolveBaseSha(opts.cwd);
    if (t.headBranch && localBranch && localBranch !== t.headBranch) {
      lines.push(`⚠️ local checkout is on ${localBranch}, thread is ${t.headBranch}`);
    }
    if (t.headSha && localHead && localHead !== t.headSha) {
      const drift = describeDrift(t.headSha, ".", opts.cwd);
      lines.push(
        drift
          ? `⚠️ drift: thread head ${t.headSha.slice(0, 7)}, local ${localHead.slice(0, 7)} (+${drift.commits} commits)`
          : `⚠️ drift: thread head ${t.headSha.slice(0, 7)} is not an ancestor of local ${localHead.slice(0, 7)}`,
      );
    }
  }

  const next = byKind(b.items, "next_action");
  const current = next.find((n) => n.status === "current");
  lines.push(`next: ${current ? current.text : "(not set)"}`);
  for (const p of next.filter((n) => n.status === "proposed")) lines.push(`  ↳ proposed${who(p)}: ${p.text}`);
  for (const g of goals.filter((g) => g !== goal)) lines.push(`  ↳ other goal${who(g)}: ${g.text}`);

  const plan = byKind(b.items, "plan_step");
  if (plan.length) lines.push(`plan: ${plan.map((p) => `${PLAN_MARK[p.status] ?? "?"} ${p.text}`).join(" · ")}`);

  const section = (title: string, kind: string, fmt: (i: BriefingItem) => string, limit = 20) => {
    const items = byKind(b.items, kind);
    if (!items.length) return;
    lines.push(`${title}:`);
    for (const i of items.slice(0, limit)) lines.push(`  - ${fmt(i)}`);
    if (items.length > limit) lines.push(`  … ${items.length - limit} more`);
  };

  section("decisions", "decision", (i) => `${i.text}${who(i)}`);
  section("pitfalls", "pitfall", (i) => `${i.text}${who(i)}`);
  section("open questions", "question", (i) =>
    i.status === "resolved" ? `~~${i.text}~~ → ${i.detail}` : `${i.text}${who(i)}`,
  );
  section("blockers", "blocker", (i) => (i.status === "resolved" ? `~~${i.text}~~ → ${i.detail}` : `${i.text}${who(i)}`));
  section("verification", "verification", (i) => {
    const stale = t.headSha && i.gitHead && i.gitHead !== t.headSha ? " ⚠️ stale head" : "";
    const head = i.gitHead ? ` @${i.gitHead.slice(0, 7)}` : "";
    return `${i.text}: ${i.status}${head}${stale}${who(i)}`;
  });
  section("paths", "path", (i) => `${i.text} (${i.detail ?? "modified"})${who(i)}`, 30);

  return lines.join("\n");
}
