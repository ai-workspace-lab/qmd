# 测试验证报告：PostgreSQL 记忆桥梁

> 关联：[规划](pg-backend-memory-bridge.md) · [使用说明](pg-memory-bridge-usage.md)
> 日期：2026-06-23 · 范围：P1–P5（qmd PG 可切换后端 + OpenClaw/Hermes 记忆桥梁）

## 1. 验证矩阵

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit -p tsconfig.build.json` | ✅ 0 errors |
| 构建产物 | `npm run build` | ✅ 成功，`dist/pg/*`、`dist/cli/pg-commands.js` 已 emit |
| 单元/集成测试 | `npx vitest run` | ✅ 249 passed / 6 skipped |
| PG 配置解析 | `test/pg-config.test.ts` | ✅ 15 passed |
| CLI 冒烟 | 见下文 §3 | ✅ 通过 |

> 现有 SQLite 路径全部测试零回归 —— 满足“原有功能不变”。

## 2. 测试范围

### 2.1 已自动覆盖（无需外部依赖）
- **`test/pg-config.test.ts`** —— 连接配置解析：
  - `QMD_PG_URL` / `DATABASE_URL` / `qmd config` 三来源优先级
  - TLS（stunnel `5443` / `sslmode`）参数推导
  - `namespace` 默认值与覆盖
  - 缺失连接串时的报错信息（不暴露口令）
- **现有全量回归** —— SQLite 后端 FTS/向量/RRF/重排/分块/collections/context 等，结果与改造前一致。

### 2.2 需外部 PostgreSQL（默认 skip，门控 `QMD_PG_URL`）
- **`test/pg-memory.integration.test.ts`**（6 用例，未配置时跳过）：
  - schema 引导（pgvector / pg_jieba / pg_trgm 扩展存在性）
  - `memory_add` 写入 → 内容寻址 + 分块 + 嵌入落库
  - `memory_search` 混合检索（tsvector + pgvector，RRF 融合）
  - `namespace` 隔离（openclaw vs hermes 互不可见）
  - `memory_get` 按 docid/path 取回
  - `qmd pg status` 健康探测
- **`test/pg-compose.yml`** —— 一键起本地 PG（postgresql.svc.plus 同款扩展镜像）供上述集成测试使用。

## 3. CLI 冒烟记录
- `qmd --help` —— 新增 `memory`、`pg status` 命令正常列出。
- `qmd memory search foo`（未配置后端）—— 干净报错，提示设置 `QMD_BACKEND=pg` + 连接串，无堆栈泄漏。
- `QMD_BACKEND=pg qmd pg status`（无连接串）—— 干净报错，提示缺少 `QMD_PG_URL`，不打印口令。

## 4. 本地复现集成测试

```sh
# 1) 起本地 PG（pgvector + pg_jieba + pg_trgm）
docker compose -f test/pg-compose.yml up -d      # macOS 先 colima start

# 2) 指向该实例并跑集成测试
export QMD_PG_URL='postgres://postgres:postgres@localhost:5432/qmd'
npx vitest run test/pg-memory.integration.test.ts

# 3) 连真实服务（postgresql.svc.plus，stunnel TLS 5443）
export QMD_PG_URL='postgres://USER:PASS@postgresql.svc.plus:5443/qmd?sslmode=require'
qmd pg status
```

## 5. 限制与待办
- ⚠️ **集成测试尚未对接“真实 PostgreSQL”执行**（本机无运行中的 Docker daemon；macOS 依赖 docker/colima 已补入 infra 基线）。CI 接入 `test/pg-compose.yml` 后即可常态化。
- ⚠️ **打分语义差异**：PG `ts_rank` ≠ FTS5 BM25，排序与 SQLite 后端存在差异，靠 RRF + reranker 缓解；上线前建议跑一轮 SQLite vs PG 对等评测。
- 远程 PG over TLS 的延迟基准尚未压测。
