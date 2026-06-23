# 变更日志：PostgreSQL 记忆桥梁

> 关联：[规划](pg-backend-memory-bridge.md) · [使用说明](pg-memory-bridge-usage.md) · [测试报告](pg-memory-bridge-test-report.md)
>
> 本文件为该特性的聚焦式变更记录；面向用户的总览见仓库根 `CHANGELOG.md` 的 `[Unreleased]`。

## [Unreleased] — PostgreSQL 可切换后端 + OpenClaw/Hermes 记忆桥梁

### 新增 (Added)
- **可切换 PG 后端**：`QMD_BACKEND=pg` 时改用 PostgreSQL，SQLite 仍为默认且行为不变。后端工厂集中在 `src/pg/`。
- **PG 记忆存储**（`src/pg/`）：
  - schema 引导（`content` / `documents` / `content_vectors` / `llm_cache` / `store_collections` / `store_config`，均带 `namespace` 列）。
  - **pgvector** 向量列 + HNSW `vector_cosine_ops` 索引（替代 sqlite-vec `vec0`）。
  - **pg_jieba + pg_trgm** 的 `tsvector` 全文/中文分词与模糊匹配（替代 FTS5）。
- **命名空间隔离**：所有读写按 `namespace`（openclaw / hermes / …）过滤，使多 agent 共用同一 PG 记忆库而互不串扰。
- **MCP 记忆工具**：`memory_add` / `memory_search` / `memory_get`（`src/mcp/server.ts`），让 OpenClaw、Hermes 通过 qmd MCP 写入与检索记忆。
- **CLI**：`qmd pg status`（连接/扩展/健康探测）与 `memory` 子命令（`src/cli/pg-commands.ts`、`src/cli/qmd.ts`）。
- **连接配置**：`QMD_PG_URL` / `DATABASE_URL` / `qmd config`，支持 postgresql.svc.plus 的 stunnel TLS（`5443` / `sslmode`）。
- **测试**：`test/pg-config.test.ts`（配置解析）、`test/pg-memory.integration.test.ts`（门控 `QMD_PG_URL` 的集成用例）、`test/pg-compose.yml`（本地 PG 编排）。
- **文档**：`docs/plan/` 下规划、使用说明、测试报告与本变更日志。

### 变更 (Changed)
- `package.json`：新增 `pg` 运行时依赖（Bun 与 Node 均可用）。
- `CLAUDE.md`：补充 PG 后端与记忆桥梁说明。
- `.gitignore`：放开 `docs/**/*.md`，纳入嵌套文档目录。

### 不变 (Unchanged)
- 默认 SQLite 路径（`~/.cache/qmd/index.sqlite`）的索引、检索与所有 CLI/MCP 行为零回归。

### 已知限制 (Known limitations)
- PG `ts_rank` 与 FTS5 BM25 打分语义不同，排序存在差异（RRF + reranker 缓解）。
- 集成测试需外部 PostgreSQL；尚未对接真实实例常态化执行（见测试报告 §5）。
