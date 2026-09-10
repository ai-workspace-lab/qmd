# 规划：qmd 任务协调层（多 agent 共享任务记忆）

> 状态：草案（待评审） · 日期：2026-09-11
> 范围决策：**在既有 PG 记忆桥梁之上并列新增"协调层"**（`qmd memory` 保持不变）；协调层是**结构化 + 强一致**的，不走语义检索。

## 1. 问题（有实测证据）

同一批仓库上并行跑着多个 agent，彼此不知道对方在干嘛：

- 本机当前 **13 个会话**，其中 4 个 interactive 正在跑；另有 `.codex-worktrees/`、`.worktrees/` 下的 Codex 工作树，以及 Remote Control 会话。
- 会话标题本身就在撞车：「Cloudflare Pages/Worker 额度优化」「Portal build error: boundary undefined」「微调修复部署失败原因」——同一条 serverless 链路的不同切面。
- **一次真实事故（2026-09-11）**：在 `platform-ops-toolkit` 的 `.github/workflows/serverless-orchestrator.yml` 上做改动时，基线是 5 个提交之前的旧版本。这三天里 #668 / #672 / #675 已经改过同一个文件，其中 #672 恰好实现了本次分析建议的一项，#672 还顺带把另一条建议的前提推翻了。**分析结论作废、返工，纯粹因为不知道别人已经在做。**

现有手段都不覆盖这个场景：

| 手段 | 为什么不够 |
|---|---|
| `ListAgents` / `SendMessage` | 点对点，得先知道该问谁；跨不到 Codex |
| `search_session_transcripts` | 事后回溯，且只有 Claude 会话，Codex 不在内 |
| git / PR 列表 | 只反映**已提交**的工作，反映不了"我正要动这个文件" |
| `qmd memory`（现状） | 语义检索，是"记得什么"，不是"现在谁占着什么" |

## 2. 关键判断：记忆层 ≠ 协调层

`qmd` 的 PG 记忆桥梁已经具备共享记忆的全部要素（`PgMemoryStore` 的 add/search/get/delete/list/namespaces、MCP 的 `memory_*`、pgvector + pg_jieba）。但直接拿它做任务协调会失败，有四个结构性缺口：

1. **检索 ≠ 认领**。`memory_search` 是混合检索 + 重排，答案是"最相关的若干条"。协调需要的是确定性回答："此刻有没有人占着这个文件"——漏检一次就等于没有协调。
2. **没有原子认领**。两个 agent 同时启动，各自搜一遍、都没搜到、都开始改。必须是 compare-and-set 语义，而 `addMemory` 是内容寻址写入，不是互斥量。
3. **没有存活性**。记忆是永久的；认领必须会过期——会话崩了、窗口关了，锁不能永远挂着。
4. **namespace 的方向是反的**。现有设计按 agent 隔离（openclaw / hermes）；协调恰恰需要**按项目共享**，让所有 agent 看见同一块板子。

> **结论**：复用同一套 PG 连接 / 配置 / namespace 管道，但**另起一张结构化表**。认领信息不进语义索引——既不该花 embedding 成本，也不该污染记忆检索结果。

## 3. 设计

### 3.1 两层分工

| 层 | 载体 | 语义 | 生命周期 |
|---|---|---|---|
| **协调层**（新增） | `qmd_task_claim` 表 | "谁正占着什么"，结构化、强一致 | 有 TTL，会过期 |
| **记忆层**（现有） | `qmd_memory` + 向量 | "做过什么、为什么这么做"，语义可检索 | 永久 |

释放认领时把叙述沉淀进记忆层，两层自然衔接。

### 3.2 Schema

```sql
CREATE TABLE IF NOT EXISTS qmd_task_claim (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope         text NOT NULL,              -- 项目，如 github.com/ai-workspace-infra/platform-ops-toolkit
  resource      text NOT NULL,              -- 被占用者，如 .github/workflows/serverless-orchestrator.yml
  agent_id      text NOT NULL,              -- claude:ai-workspace-lab-69 / codex:wt-abc123
  agent_kind    text NOT NULL,              -- claude | codex | human
  intent        text NOT NULL,              -- 一句话意图
  branch        text,
  worktree      text,
  pr_number     integer,
  base_sha      text,                       -- 认领时的基线，用于漂移检测
  status        text NOT NULL DEFAULT 'active',   -- active | done | abandoned
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now(),
  ttl_seconds   integer NOT NULL DEFAULT 1800,
  released_at   timestamptz,
  note          text
);

-- 一个 resource 同时只能有一个 active 认领；历史行照常保留
CREATE UNIQUE INDEX IF NOT EXISTS qmd_task_claim_active_uniq
  ON qmd_task_claim (scope, resource) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS qmd_task_claim_scope_idx
  ON qmd_task_claim (scope, status, heartbeat_at DESC);
```

**部分唯一索引**是这套设计的支点：它让"同一资源只能有一个活跃认领"成为数据库约束，而不是应用层的君子协定。

### 3.3 原子认领（含惰性过期）

```sql
-- 先把过了 TTL 的活跃认领判死，再插入
WITH expired AS (
  UPDATE qmd_task_claim SET status = 'abandoned', released_at = now()
   WHERE scope = $1 AND resource = $2 AND status = 'active'
     AND heartbeat_at < now() - make_interval(secs => ttl_seconds)
  RETURNING 1
)
INSERT INTO qmd_task_claim (scope, resource, agent_id, agent_kind, intent, branch, base_sha, ttl_seconds)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT DO NOTHING
RETURNING id, claimed_at;
```

返回 0 行 = 认领失败，随即查出持有者返回给调用方。**惰性过期**意味着不依赖 pg_cron；可选再挂一个 pg_cron 定期清扫，纯属锦上添花。

### 3.4 CLI（沿用 `qmd memory` 的命令风格）

```sh
qmd task claim <resource> --intent "给 4 个 Node job 加依赖缓存" [--ttl 1800]
qmd task heartbeat <resource>
qmd task release <resource> [--status done|abandoned] [--note "..."]
qmd task who <resource>        # 谁在动这个东西
qmd task ls [--stale]          # 当前 scope 的认领列表
qmd task board                 # 全景：谁 / 在哪个分支 / 动什么 / 多久了
```

`scope` 默认从 git remote 自动推导，避免各 agent 自己编字符串对不上。

### 3.5 MCP 工具

`task_claim` / `task_release` / `task_who` / `task_board` / `task_heartbeat`，与现有 `memory_*` 并列注册在 `src/mcp/server.ts`。

## 4. 接入方式（决定这套东西是否真的被用上）

设计得再好，agent 不调用就等于零。三个接入点：

1. **Claude Code —— PreToolUse hook（最关键）**：在 `Edit`/`Write` 前自动跑 `qmd task who <file>`，若被他人持有则告警。这一步把协调从"自觉"变成"默认"。
2. **Claude Code —— skill**：放进 `skills/`，教 agent 在动手前 claim、收尾时 release 并写入记忆。
3. **Codex —— 同一个 CLI**：Codex 没有 skill 机制，但 `qmd task` 是命令行，shell 即可调用；提供一个 wrapper 脚本即可对齐。

> **修正（2026-09-11）**：本节初稿断言"CLI 是唯一公共分母、MCP 只是加速路径"。核实四端扩展机制后该判断不成立——Claude Code / OpenCode / Codex / Antigravity **全部原生支持 MCP**。因此 **MCP 才是公共底座，CLI 退为兜底**（无 MCP 的场景、脚本、CI）。详见 §8。

## 5. 与 git 的衔接：漂移检测

认领时记 `base_sha`，释放时对比当前上游 —— 直接命中本文档 §1 那次事故：

```
$ qmd task release .github/workflows/serverless-orchestrator.yml --status done
⚠️  基线已漂移：认领时 7d9d31e，现在 a6caee4（相差 5 个提交，其中 3 个改过本文件）
    建议先 rebase 再提交。
```

## 6. 风险

| 风险 | 缓解 |
|---|---|
| **没人用** | 靠 hook 默认触发，而非依赖自觉；这是首要风险 |
| **PG 不可用会阻塞干活** | **fail-open**：连不上就告警放行，绝不因为协调层挂了而卡住开发 |
| 锁粒度 | 先做文件级，`resource` 允许 glob（如 `.github/workflows/*`）表达区域级 |
| 会话崩溃留下僵尸锁 | TTL + 惰性过期；`--stale` 可查可强制释放 |
| 认领风暴 | 只对写操作认领，读不认领 |
| **HTTP MCP 无鉴权** | 当前只绑 localhost，同机可接受；**跨机使用前必须先加 bearer 鉴权**（Codex 的 `bearer_token_env_var` 已预留位置） |
| OpenCode / Codex 无 hook，必然漏调 | 咨询锁语义（§8.3）；并在这两端把约定写进 AGENTS.md |

## 7. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| ~~**P1**~~ ✅ | schema + `qmd task claim/who/release/ls` | 并发用例已写（`test/pg-task.integration.test.ts`），**待真实 PG 上跑通** |
| ~~**P2**~~ ✅ | MCP `task_*` 工具 | 已注册 `task_claim/who/release/board/heartbeat` |
| **P3** | PreToolUse hook + skill | 编辑他人持有的文件时自动告警 |
| **P4** | Codex wrapper + release 时沉淀进 `qmd memory` | Codex 工作树与 Claude 会话互相可见 |
| **P5** | `task board` + 漂移检测 | 复现 §5 的告警 |
| **P6** | `qmd install <client>` 四端配置自动写入 + Antigravity plugin bundle | 四端各自能看到同一块认领板 |

## 8. 四端接入（Claude Code / OpenCode / Codex / Antigravity）

### 8.1 共同底座：一个共享 HTTP daemon

四端都支持 MCP，所以推荐**单进程共享**而非每端各起一个 stdio 子进程：

```
qmd mcp --http --daemon --port 8181          ← 一个进程
        │
        ├── Claude Code   CLI / App
        ├── OpenCode      CLI / App
        ├── Codex         CLI / ChatGPT App / IDE 扩展
        └── Antigravity   CLI / IDE
                    ↓
        postgresql.svc.plus  (qmd_task_claim + qmd_memory)
```

好处：一份 PG 连接池、一份索引缓存，认领状态天然一致，不会出现四个进程各看各的。

**已核实的两个前提**（`src/mcp/server.ts:946`）：HTTP MCP **只绑 localhost**，且**目前没有 bearer 鉴权**。同机四端够用；跨机（Remote Control、云端会话）必须先补鉴权，见 §6 风险表。

### 8.2 逐端配置

**Claude Code CLI / App** —— 已经接好一半。仓库里 `.claude-plugin/marketplace.json` 已注册 `mcpServers` 与 `skills`，只需补 hooks 与 task skill：

```json
{ "plugins": [{
  "name": "qmd",
  "skills": ["./skills/"],
  "mcpServers": { "qmd": { "type": "http", "url": "http://localhost:8181/mcp" } },
  "hooks": "./hooks/hooks.json"
}] }
```

`hooks.json` 里对 `Edit|Write` 挂 PreToolUse，调 `qmd task who "$FILE"`。

**OpenCode CLI / App** —— `~/.config/opencode/opencode.json`（全局）或项目根 `opencode.json`：

```json
{ "mcp": { "qmd": { "type": "remote", "url": "http://localhost:8181/mcp", "enabled": true } } }
```

stdio 形态则是 `{ "type": "local", "command": ["qmd", "mcp"] }`。OpenCode 没有 Claude 式 PreToolUse，只能靠 AGENTS.md / rules 约束。

**Codex CLI / ChatGPT App / IDE 扩展** —— **一份配置覆盖三端**（三者共用同一个 `~/.codex/config.toml`）：

```toml
[mcp_servers.qmd]
url = "http://localhost:8181/mcp"
# stdio 形态：
# command = "qmd"
# args = ["mcp"]
```

项目级 `.codex/config.toml` 仅对 trusted project 生效。Codex 无 hook，只能在 `AGENTS.md` 里写死"动文件前先 `task claim`"。**这是四端里"没人用"风险最高的一端**，而恰恰你的 `.codex-worktrees/` 下有 8 个工作树。

**Antigravity CLI / IDE** —— 插件模型最接近 Claude Code。全局 `~/.gemini/config/mcp_config.json`，或工作区 `.agents/mcp_config.json`：

```json
{ "mcpServers": { "qmd": { "url": "http://localhost:8181/mcp" } } }
```

Antigravity 的 plugin 是命名空间 bundle：必需 `plugin.json`，可选 `mcp_config.json` / `hooks.json` / `skills/` / `rules/`。→ 可以把 QMD 打成一个 Antigravity plugin，MCP + hooks + skill 一次装好，能力与 Claude Code 插件对齐。

### 8.3 能力矩阵

| 客户端 | 配置位置 | 格式 | MCP | Hook（自动拦截） | Skill / 规则 | 协调可达性 |
|---|---|---|---|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json` | JSON | ✅ | ✅ PreToolUse | ✅ `skills/` | **完整** |
| Antigravity | `~/.gemini/config/mcp_config.json` 或 plugin | JSON | ✅ | ✅ `hooks.json` | ✅ `skills/` + `rules/` | **完整** |
| OpenCode | `~/.config/opencode/opencode.json` | JSON | ✅ | ❌ | AGENTS.md / rules | 靠自觉 |
| Codex / ChatGPT | `~/.codex/config.toml` | TOML | ✅ | ❌ | AGENTS.md | 靠自觉 |

**由此推出一条硬性设计约束**：只有一半客户端能做到"编辑前自动查认领"，另一半必然会漏调。所以 `qmd task claim` 必须是**咨询锁（advisory lock），不能是强制锁**——漏调只会失去协调收益，绝不能导致数据损坏或流程卡死。

### 8.4 分发

- **npm** `npm install -g @tobilu/qmd` —— 四端通用前提
- **Claude Code**：现有 marketplace.json 即可
- **Antigravity**：打成 plugin bundle
- **OpenCode / Codex**：只能给配置片段 → 建议做 `qmd install <claude|opencode|codex|antigravity>`，自动探测并写入对应配置文件，避免四份手抄

## 8.5 实施中修正的设计

1. **原子认领不能用单条 data-modifying CTE**。规划 §3.3 写的是"CTE 过期 + INSERT
   ON CONFLICT"一条语句。PostgreSQL 的 `WITH` 子语句刻意互相看不到对方的效果，
   过期与插入必须互相可见，因此实现改为 `client.tx()` 内的显式三步：过期 → 查持有者
   → `INSERT ... ON CONFLICT DO NOTHING`。竞争者在部分唯一索引上串行化，败者拿到
   0 行后重新读出真正的赢家。

2. **共享 daemon 下 scope 不能由服务端 cwd 推导**。§8.1 推荐的单进程 HTTP daemon
   的工作目录并不是调用方的项目目录，若在服务端 `process.cwd()` 上推导 scope，四端
   的认领会全部落到 daemon 启动目录下。因此 MCP 工具显式接受 `scope` 或 `cwd`，
   只有 stdio（服务端与调用方同目录）才回落到 bridge 默认值。

## 9. 关联文件索引

- `src/pg/schema-pg.ts` —— 建表引导，新表加在此处
- `src/pg/memory-store.ts` —— `PgMemoryStore`，`PgTaskStore` 与之并列
- `src/cli/pg-commands.ts` —— `runMemoryCommand` 旁新增 `runTaskCommand`
- `src/mcp/server.ts` —— 注册 `task_*` 工具
- `docs/plan/pg-backend-memory-bridge.md` —— 本层所依赖的记忆桥梁规划
