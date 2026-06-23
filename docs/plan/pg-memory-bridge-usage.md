# qmd PostgreSQL Memory Bridge — Usage

The PG backend turns qmd into a shared, namespaced, persistent **memory bridge**
for external agents (OpenClaw, Hermes, …) on top of a PostgreSQL instance with
`pgvector` + `pg_jieba` + `pg_trgm` (e.g. the `postgresql.svc.plus` runtime).

> The existing local-SQLite document workflow is **unchanged** and remains the
> default. The PG backend is additive and opt-in.

## Architecture

```
OpenClaw ─┐                         ┌─ pgvector         (semantic / 语义)
          ├─ qmd MCP / CLI ───────→ │  pg_jieba+pg_trgm (中文全文 / fuzzy)
Hermes  ──┘  memory_* + pg status    └─ namespaced tables
             backend=pg ↔ backend=sqlite (default)
```

Memory records are content-addressed, chunked, embedded with the **same external
embedding API** qmd uses for SQLite (so vectors are comparable across hosts), and
searched with hybrid retrieval: `pg_jieba/tsvector` lexical + `pgvector` cosine,
fused with Reciprocal Rank Fusion (RRF).

## Configuration (environment)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `QMD_BACKEND` | `sqlite` | Set to `pg` to enable the memory bridge. **Explicit** — a bare URL won't switch it. |
| `QMD_PG_URL` / `DATABASE_URL` | — | `postgres://user:pass@host:5443/db` |
| `QMD_NAMESPACE` | `default` | Tenant namespace (e.g. `openclaw`, `hermes`). |
| `QMD_PG_SSL` | TLS, no-verify | `disable` \| `no-verify` \| `require` (use `QMD_PG_CA` for verification). |
| `QMD_PG_CA` | — | Path to a CA bundle (implies verification on). |
| `QMD_PG_POOL_MAX` | `5` | Connection pool size. |
| `QMD_PG_CONNECT_TIMEOUT_MS` | `10000` | Connection timeout. |

`postgresql.svc.plus` terminates TLS at stunnel (default port **5443**); point
`QMD_PG_URL` at that endpoint, or connect plainly via a local `stunnel-client`
with `QMD_PG_SSL=disable`.

## CLI

```sh
export QMD_BACKEND=pg
export QMD_PG_URL='postgres://postgres:***@db.example.com:5443/qmd'
export QMD_NAMESPACE=openclaw

qmd pg status                          # backend health: server, fts caps, counts
qmd memory add note/auth "OAuth refresh rotation design"  --title "Auth"
echo "long body..." | qmd memory add note/big            # body via stdin
qmd memory search "how does auth refresh work"            # hybrid search
qmd memory get note/auth
qmd memory ls
qmd memory rm note/auth
qmd memory namespaces                  # list namespaces + counts
```

Flags: `--namespace <ns>`, `--title <t>`, `-n <limit>`, `--full`, `--json`.

## MCP (the agent-facing bridge)

When `QMD_BACKEND=pg`, `qmd mcp` additionally registers memory tools alongside
the existing document-search tools:

- `memory_search(query, namespace?, limit?, full?)` — hybrid search
- `memory_add(key, body, title?, namespace?, metadata?)` — store/replace
- `memory_get(key, namespace?)` — fetch full body
- `memory_list(namespace?, limit?)` — recent memories

If PG is misconfigured the MCP server logs a warning and continues serving local
document search — it never takes the server down.

## Schema (PostgreSQL)

| Table | Role |
| :--- | :--- |
| `qmd_memory_content(namespace, hash, body, tsv)` | Content-addressed bodies + generated `tsvector` (GIN; `pg_trgm` for fuzzy). |
| `qmd_memory(namespace, key, title, hash, metadata, …, active)` | Memory records (the documents layer); `UNIQUE(namespace, key)`. |
| `qmd_memory_vectors(namespace, hash, seq, pos, embedding, model)` | Per-chunk `pgvector` embeddings; HNSW cosine index added lazily once the dimension is known. |
| `qmd_memory_config(namespace, key, value)` | Bridge metadata (e.g. `vector_dim`). |

## Running integration tests

```sh
docker compose -f test/pg-compose.yml up -d
QMD_PG_URL='postgres://postgres:postgres@localhost:5432/postgres' \
  npx vitest run test/pg-memory.integration.test.ts
docker compose -f test/pg-compose.yml down -v
```

The integration test uses a deterministic stub embedder (no network/models). The
pure config tests (`test/pg-config.test.ts`) always run.

## Notes & fidelity

- PostgreSQL FTS ranks with `ts_rank_cd`, **not** BM25 — absolute scores differ
  from the SQLite engine, but RRF fusion keeps hybrid ranking robust.
- Without `pg_jieba`, FTS falls back to the `english` config (Latin tokenization).
- Embeddings must come from a **shared** external embedding API for vectors to be
  comparable across hosts/agents.
