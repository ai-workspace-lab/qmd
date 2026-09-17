# 规划：多 Code Agent 共享任务上下文 + 共享项目记忆（跨客户端交接续作）

> 状态：实施中 / 架构定型 · 日期：2026-09-17 · 分支：`feat/task-coordination`  
> 前置：[agent-task-coordination.md](./agent-task-coordination.md)（认领/协调层）、[pg-backend-memory-bridge.md](./pg-backend-memory-bridge.md)（PG 记忆桥梁）  
>
> **架构定型决策（2026-09-17）**  
> 1. **QMD 即协调服务**：废除早期“独立 Go 协调服务 / Bridge 持有 Schema”方案。QMD 是 task-coordination 协调服务本身，直连 PostgreSQL，持有统一 Schema（`src/pg/schema-pg.ts` 的 `qmd_ctx_*` 表）。  
> 2. **本地原生目录为第一数据源**：以 Desktop / CLI 在本机可读的会话目录为主，由 QMD daemon 按规则增量抽取高价值事实写入 PG。  
> 3. **Bridge 严守单向网关**：xworkmate-bridge 仅负责将网页端/移动端插件数据以 `POST /api/v1/agent/ingest` 单向提交给 QMD，不存数据、不持有 Schema、不提供读接口。  
> 4. **只承载重要会话事实，坚决不承载制品**：每个条目 body 严格 $\le$ 4 KiB，严格杜绝源码、Diff 与原始测试日志。  
> 5. **同一 Git PR / 分支的任务合并为一个线程（Thread）**：规则确定性合并，纯函数状态机治理，LLM 留作后续可选扩展。  

---

## 1. 问题：今天切换客户端 = 从零开始

`feat/task-coordination` 最初解决的是**并行文件独占**问题（谁占着哪个文件）。但真实研发中，最大的痛点是**跨客户端接力**与**多端汇总**：

| 切换客户端或多工作区时丢失的内容 | 现有各端原生载体 | 核心缺口与痛点 |
|---|---|---|
| 这个分支要做什么、计划到第几步、下一步 | 各客户端私有 transcript | 格式互不兼容，模型上下文压缩后严重遗忘 |
| 两个 Agent 分别得出的设计方案与共识 | 各自的私有本地缓存 | 同一分支信息散落各地，无法自动汇总 |
| 已做出的关键决定、踩过的坑 | 无跨端沉淀 | Agent B 不知 Agent A 已试过某方案行不通，重复踩坑 |
| 验证跑过没有、基于哪个 Commit Head | 终端临时输出 / CI | Git/CI 不知道本地验证是否在当前 Commit 通过 |
| 谁正在推进这个任务、协调租约 | `qmd_task_claim` | 粒度是文件，不是整个任务线程 |

因此需要两个一等实体：**以 PR / 分支为键的任务线程（Thread）**，以及线程内**可合并的上下文条目（Context Item）**。交接卡是这些条目合并后的动态物化视图。

---

## 2. 拓扑与分级承载

```
 T0 本地原生会话 (主数据源)      Claude / Codex / Antigravity / OpenCode(预留) 本地会话目录
        │                                                     ChatGPT / Claude 网页与移动端扩展
        │                                                                    │
        │                                                                    │ POST /api/v1/agent/ingest
        │                                                                    ▼
        │                                                      xworkmate-bridge (8787)
        │                                                      白名单无状态转发, 128 KiB 上限, 令牌置换
        │                                                                    │ POST /api/v1/agent/ingest
        │  本地采集与增量 Cursor                                               │ (带 QMD_INGEST_TOKEN)
        ▼                                                                    ▼
 T1 QMD Daemon (8181)  npx tsx src/cli/qmd.ts mcp --http
        ├─ 本地多会话直采：~/.claude, ~/.codex, ~/.gemini, opencode (预留)
        ├─ 纯函数确定性合并状态机 (Unicode NFKC + 规则，无 LLM 幻觉)
        ├─ PgContextStore：pg_advisory_xact_lock 保证同分支串行关联
        ├─ MCP 服务端：task_resume / task_note / task_handoff / task_claim
        └─ 单向 Ingest 接口：POST /api/v1/agent/ingest
        │
        ▼ 127.0.0.1:15432 (本地直连, QMD_PG_SSL=disable)
 T2 持久层  postgresql.svc.plus (容器化 PG 17)
        ├─ 核心 Schema：qmd_ctx_thread, qmd_ctx_session, qmd_ctx_item, qmd_ctx_ingest_cursor
        └─ 扩展栈：pgvector · pg_jieba · pg_trgm
```

### 承载什么 / 不承载什么

| ✅ 承载（高价值任务事实） | ❌ 不承载（制品与冗余垃圾） | 替代/降级方式 |
|---|---|---|
| 任务目标、计划步骤状态、下一步 | 源码、文件全量内容、代码补丁（Diff/Patch） | Git 本身：`head_sha`、分支、PR 编号 |
| 关键决定及理由、未决问题、已知坑点 | 编译构建产物、二进制文件、容器镜像 | CI / GHCR 外部制品引用 |
| 验证记录：命令 + pass/fail + 对应 Head + 时间 | 完整测试输出、冗长调试日志 | 单行摘要与退出码，完整日志留在本地 |
| 仓库相对路径（修改、认领、审查的文件） | 截图、PDF、Base64 编码图片 | 外部对象存储或链接 |
| 参与会话贡献记录、主导租约、Claim 记录 | 完整对话 Transcript 聊天记录 | T0 各客户端本地自行保存 |

**硬性约束**：
- 每一条 `ContextItem` 的 `body jsonb` 严格限制在 **$\le$ 4 KiB**；
- 超出大小限制的条目在采集/入站阶段直接丢弃，不静默截断。

---

## 3. 领域模型

| 实体 | 业务语义 | 唯一键与生命周期 |
|---|---|---|
| **project / scope** | 仓库作用域 | `scope` 归一化（如 `github.com/org/repo`） |
| **thread** | 一个工作项 = **一个 PR 或一个分支** | 关联键：`pr_number` 优先，其次 `head_branch`；open $\to$ handed_off / paused $\to$ done |
| **session** | 各客户端的一次会话，挂载到线程 | `(source, source_session_id, thread_id)` 唯一；多个会话可并发挂载 |
| **context item** | 合并最小原子单元：goal / next_action / plan_step / decision / pitfall / verification / path | `(thread_id, kind, item_key)` 唯一 |
| **event** | 线程内审计事件日志 | `(thread_id, seq)` 有序递增；`client_request_id` 幂等 |
| **ingest cursor** | 增量扫描游标 | `(source, path)` 记录 `byte_offset` 与 `mtime_ms`，避免重复扫描巨型日志 |

### 两类写入权限与并发控制

- **主导字段（Dominant Fields）**：`goal`、`next_action`。单值字段，代表演进方向。仅持有有效租约（Fence）的**主导会话（Driver）**可以覆盖；非主导会话写入被自动存为 `status: 'proposed'`，在简报中以“提议分歧”展示。
- **累积字段（Cumulative Fields）**：`decision`、`pitfall`、`verification`、`path`、`plan_step`（状态前进）。集合字段，越多越好。**任何**挂载的会话均可写入，按规范化哈希去重并追加来源。

---

## 4. 关联与确定性合并

### 4.1 会话 $\to$ 线程自动关联（`threads:resolve`）

在 PostgreSQL 事务内执行，先获取会话级事务建议锁：
```sql
SELECT pg_advisory_xact_lock(hashtext('thread:' || $scope || ':' || $head_branch));
```
让同一分支上并发启动的多个 Agent 串行关联，避免创建冲突线程：
1. **默认分支（main/master）或 detached HEAD** 且无 PR：不自动关联，返回 `requires_explicit_thread`，让用户显式选择或新建；
2. **存在对应 PR 的活跃线程**：直接挂载，补齐分支名；
3. **无 PR 线程，存在同名活跃分支线程**：直接挂载；若上报了 PR 号则更新；
4. **PR 线程与分支线程同时存在且不同**：自动执行合并（分支线程并入 PR 线程）；
5. **都不存在**：新建线程；
6. **PR 状态为 merged / closed**：线程标记为 `done`。

### 4.2 字段合并规则（纯函数 `mergeItem`）

纯函数实现于 `src/pg/context-merge.ts`，规范化：Unicode NFKC $\to$ 去首尾空白 $\to$ 折叠多余空格；哈希键：`h:` + sha256 前 16 位。

- **goal / next_action**：主导者覆盖；非主导者存为 `proposed`；
- **plan_step**：状态**只进不退**（`todo -> doing -> done`）；`dropped` 或重新打开需主导权限；非主导新增步骤追加至末尾；
- **decision**：有显式 key 则更新，无则哈希去重并集；
- **pitfall**：哈希并集去重，相同只追加来源会话（`touch`）；
- **verification**：按命令归一化；若与当前分支的最新 `gitHead` 匹配则优先采纳，落后于当前 Head 则在简报中标记为 `[STALE 已过期]`；
- **path**：仅接受仓库相对路径；相同路径且 action/gitHead 相同视为 `touch`，有新变更且时间戳更新视为 `update`。

---

## 5. Schema（QMD `src/pg/schema-pg.ts`）

所有协同数据表均在 QMD 内通过 `bootstrapContextSchema` 统一初始化，沿用 `qmd_` 前缀，不依赖 pgvector 即可完成基础协同：

- `qmd_ctx_thread`：核心任务线程，附带活跃分支与 PR 部分唯一索引；
- `qmd_ctx_session`：记录接入的客户端会话元数据；
- `qmd_ctx_item`：合并后的事实条目（硬限制 $\le$ 4 KiB）；
- `qmd_ctx_item_source`：记录每个事实条目被哪些 Agent 会话观察/贡献过；
- `qmd_ctx_event`：幂等事件审计流；
- `qmd_ctx_ingest_cursor`：记录 GB 级会话日志的扫描偏移量（`byte_offset`）。

---

## 6. 本地采集器矩阵（`src/collect/`）

- **Claude Code CLI** (`claude-code.ts`)：扫描 `~/.claude/projects/<slug>/<sessionId>.jsonl`；
- **Claude Desktop** (`claude-desktop.ts`)：扫描 `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json`；
- **GPT Codex CLI / Desktop** (`codex.ts`)：增量扫描 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；
- **Google Antigravity** (`antigravity.ts`)：只读打开 `~/.gemini/antigravity/conversation_summaries.db`；
- **OpenCode** (`opencode.ts`)：预留探针；
- **安全脱敏** (`redact.ts`)：入库前正则抹除 GitHub Token、OpenAI/Anthropic Key 等敏感信息。

---

## 7. 接口与网关职责

### 7.1 QMD MCP & Ingest API（8181 端口）

- **MCP 工具**：
  - `task_resume(cwd)`：获取当前分支完整交接简报（目标、步骤、避坑、验证结论、代码漂移）；
  - `task_note(cwd, kind, note)`：轻量追加决策或踩坑；
  - `task_handoff(cwd, next_action)`：收工交接，释放主导权；
  - `task_claim / task_who / task_release / task_board / task_heartbeat`：继承既有文件独占协议。
- **HTTP Ingest 端点**：
  - `POST /api/v1/agent/ingest`：内部 Bearer 鉴权（`QMD_INGEST_TOKEN`），接受结构化条目提交。

### 7.2 xworkmate-bridge（8787 端口）

- **纯单向透传网关**：
  - 仅暴露 `POST /api/v1/agent/ingest`，限制请求体 $\le$ 128 KiB；
  - 校验客户端 `AI_WORKSPACE_AUTH_TOKEN`，向上游转发时置换为 `QMD_INGEST_TOKEN`；
  - 严格禁止任何读接口，无状态、不存数据。
