# 规划：qmd 接入 PostgreSQL，成为 OpenClaw + Hermes 的记忆桥梁

> 状态：草案（待评审） · 日期：2026-06-22
> 范围决策：**PG 作为可切换的替代后端**（SQLite 保持默认且完全不变）；桥梁需要 **写入 + 命名空间隔离**。

## 1. 现状与判断（已核实）

**qmd**（`@tobilu/qmd` 2.1.0）是本地混合检索引擎：

- 存储层两文件：
  - `src/db.ts` —— 跨运行时 **同步** SQLite 抽象，窄接口 `exec / prepare→{run,get,all} / transaction / loadExtension / close`。
  - `src/store.ts` —— 4690 行，承载所有数据访问 + 检索逻辑。
- `Store` 是 `createStore()`（`src/store.ts:1604`）构造的门面对象，约 50 个方法。**今天只有 3 个是 async**（`searchVec / expandQuery / rerank`，受 LLM 限制），其余全部同步。
- Schema 强 SQLite 方言：
  - `content`（内容寻址，source of truth）
  - `documents`（虚拟路径 → 内容 hash 映射）
  - `content_vectors` + `vectors_vec`（sqlite-vec `vec0` 虚拟表）
  - `documents_fts`（FTS5 BM25 + 触发器）
  - `llm_cache` / `store_collections` / `store_config`
- 已暴露 MCP（stdio / http），目前以 **只读检索** 为主（约 4 个 tool）。

**postgresql.svc.plus** 恰好提供桥梁所需全部扩展：**pgvector**（向量）、**pg_jieba + pg_trgm**（中文分词 + 全文/模糊）、**pgmq**（轻量消息队列）、pg_cron。经 **stunnel TLS 5443** 接入。

> **关键结论**：**不能在 `Database` 驱动层做适配**。
> 原因：(1) node-postgres 是异步，而 `Database` 接口是同步；(2) FTS5 / `vec0` / `PRAGMA` / 触发器都是 SQLite 专有 SQL，换驱动也必须重写 SQL。
> 正确切口是 **把 `Store` 抽象成接口，做并列的后端实现**。

## 2. 目标架构（记忆桥梁）

```
OpenClaw agent ─┐                          ┌─ pgvector         (语义检索)
                ├─ qmd MCP (stdio/http) ──→ │  pg_jieba+pg_trgm (中文全文/模糊)
Hermes  agent ──┘   memory_* + search 工具   └─ pgmq            (异步入库队列, 可选)
                         │                   postgresql.svc.plus (stunnel 5443 TLS)
                  backend=pg ↔ backend=sqlite (默认, 不变)
```

- 默认仍是 `~/.cache/qmd/index.sqlite`；设 `QMD_BACKEND=pg` + 连接串即切到共享 PG。
- 多 agent 通过 **namespace**（openclaw / hermes / …）隔离，共用同一 PG 记忆库。
- 价值：记忆从“单机 SQLite”升级为“跨 agent、跨主机、持久共享”的中心化记忆。

## 3. 后端抽象设计（核心）

### 3.1 提升 `Store` 为 `IStore` 接口，统一异步

- 现有 `createStore` 原样保留为 `createSqliteStore`，**内部逻辑一行不改**，仅把同步方法用 `Promise.resolve(...)` 包一层以满足异步签名 → 满足“原有功能不变”，靠现有测试全绿守住回归。
- 新增工厂 `createStore({ backend, url, namespace })`，按 `QMD_BACKEND` / config 分发到 sqlite 或 pg。
- CLI（`src/cli/qmd.ts`）与 MCP（`src/mcp/server.ts`）调用处统一 `await`（绝大多数本就在 async 上下文）。

### 3.2 新增 `createPgStore`

- 新文件 `src/store-pg.ts` + `src/db-pg.ts`，使用 `pg` 连接池 + TLS。
- 实现同一 `IStore`，对外行为与 SQLite 后端对齐。

## 4. Schema 映射（SQLite → PG 扩展）

| SQLite 现状 | PG 实现 | 备注 |
|---|---|---|
| `content` / `documents` / `llm_cache` / `store_collections` / `store_config` | 普通表，结构基本一致 | 加 `namespace` 列 |
| `content_vectors` + `vectors_vec`(vec0) | 单表 `vector` 列（**pgvector**）+ HNSW `vector_cosine_ops` 索引 | 维度由外部 embedding API 决定 |
| `documents_fts`(FTS5 BM25) + 触发器 | `tsvector` 生成列（**pg_jieba** 中文 + english 双配置）+ GIN 索引；`pg_trgm` 供模糊 | ⚠️ `ts_rank` ≠ BM25，打分语义不同 |
| docid = hash 前 6 位 | 应用层不变 | — |
| 触发器维护 FTS | PG 生成列 / 触发器 | — |

## 5. 记忆桥梁能力（写入 + 命名空间）

- 所有表加 `namespace TEXT NOT NULL`；`store({ namespace })` 注入；查询/写入自动按 namespace 过滤。OpenClaw、Hermes 各自隔离，亦可读共享 namespace。
- 新增 MCP 写入工具：
  - `memory_add` —— 写入一条记忆（内容寻址 + 分块 + 嵌入）
  - `memory_search` —— 即现有 hybrid query，带 namespace
  - `memory_get`
- 读路径复用现有 search / query / get。
- 可选：用 **pgmq** 做异步入库（agent 高频写入先入队，后台批量 embed），避免阻塞 agent。

## 6. 连接与配置

- 连接串：`QMD_PG_URL` / `DATABASE_URL`，或 `qmd config set backend pg / pg-url ...`。
- TLS：走 postgresql.svc.plus 的 stunnel `5443`（`sslmode` / CA 配置）。`pg` 在 Bun 与 Node 均可用。
- **嵌入向量必须用共享的外部 OpenAI 兼容 API**（qmd 已支持），保证跨主机维度/模型一致；本地 node-llama-cpp 仅用于 SQLite 单机场景。
- `qmd status` 显示当前 backend / namespace / PG 健康。

## 7. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1 接口化** | `Store→IStore` 异步化 + `createSqliteStore` 包装 + backend 工厂 + 调用处 await | **全量测试在 SQLite 路径零回归** |
| **P2 PgStore** | `db-pg.ts` + `store-pg.ts`，DDL 引导（pgvector/pg_jieba/pg_trgm），实现全部 `IStore` 方法 | PgStore 通过与 SQLite 相同的单测子集 |
| **P3 配置接入** | env/config 选择 PG，连 postgresql.svc.plus，`qmd status` 展示后端 | 真实连通 + 健康检查 |
| **P4 桥梁** | `namespace` 隔离 + `memory_add/search/get` MCP 工具（+ 可选 pgmq 异步入库） | 双 agent 命名空间隔离可验证 |
| **P5 测试与文档** | 用 postgresql.svc.plus 镜像起 PG 跑集成/对等测试（SQLite vs PG 结果对比），更新 README/CLAUDE.md/CHANGELOG | 对等测试 + 文档 |

## 8. 主要风险

1. **打分语义漂移**：PG `ts_rank` 非 BM25 → 排序差异；靠 RRF 融合 + reranker 缓解（可后续评估 ParadeDB BM25）。
2. **同步→异步重构面广**：CLI/MCP 多处调用 → 回归风险；以 SQLite 路径全测试守住。
3. **远程延迟**：远程 PG over TLS vs 本地 SQLite，每查询多次往返；用连接池 + 批量，必要时保留本地 SQLite 作读缓存。
4. **嵌入一致性**：跨主机必须统一外部 embedding 服务，否则向量不可比。

## 9. 关联文件索引

- qmd 存储抽象：`src/db.ts`、`src/store.ts`（`createStore` @ `src/store.ts:1604`）
- qmd MCP：`src/mcp/server.ts`
- qmd CLI：`src/cli/qmd.ts`
- PG 运行时与扩展：`../postgresql.svc.plus/`（pgvector / pg_jieba / pg_trgm / pgmq / pg_cron，stunnel 5443）
