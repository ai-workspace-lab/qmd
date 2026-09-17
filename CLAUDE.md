# QMD - Query Markup Documents

Use Bun instead of Node.js (`bun` not `node`, `bun install` not `npm install`).

## Commands

```sh
qmd collection add . --name <n>   # Create/index collection
qmd collection list               # List all collections with details
qmd collection remove <name>      # Remove a collection by name
qmd collection rename <old> <new> # Rename a collection
qmd ls [collection[/path]]        # List collections or files in a collection
qmd context add [path] "text"     # Add context for path (defaults to current dir)
qmd context list                  # List all contexts
qmd context check                 # Check for collections/paths missing context
qmd context rm <path>             # Remove context
qmd get <file>                    # Get document by path or docid (#abc123)
qmd multi-get <pattern>           # Get multiple docs by glob or comma-separated list
qmd status                        # Show index status and collections
qmd update [--pull]               # Re-index all collections (--pull: git pull first)
qmd embed                         # Generate vector embeddings (uses node-llama-cpp)
qmd query <query>                 # Search with query expansion + reranking (recommended)
qmd search <query>                # Full-text keyword search (BM25, no LLM)
qmd vsearch <query>               # Vector similarity search (no reranking)
qmd mcp                           # Start MCP server (stdio transport)
qmd mcp --http [--port N]         # Start MCP server (HTTP, default port 8181)
qmd mcp --http --daemon           # Start as background daemon
qmd mcp stop                      # Stop background MCP daemon
```

## Collection Management

```sh
# List all collections
qmd collection list

# Create a collection with explicit name
qmd collection add ~/Documents/notes --name mynotes --mask '**/*.md'

# Remove a collection
qmd collection remove mynotes

# Rename a collection
qmd collection rename mynotes my-notes

# List all files in a collection
qmd ls mynotes

# List files with a path prefix
qmd ls journals/2025
qmd ls qmd://journals/2025
```

## Context Management

```sh
# Add context to current directory (auto-detects collection)
qmd context add "Description of these files"

# Add context to a specific path
qmd context add /subfolder "Description for subfolder"

# Add global context to all collections (system message)
qmd context add / "Always include this context"

# Add context using virtual paths
qmd context add qmd://journals/ "Context for entire journals collection"
qmd context add qmd://journals/2024 "Journal entries from 2024"

# List all contexts
qmd context list

# Check for collections or paths without context
qmd context check

# Remove context
qmd context rm qmd://journals/2024
qmd context rm /  # Remove global context
```

## Document IDs (docid)

Each document has a unique short ID (docid) - the first 6 characters of its content hash.
Docids are shown in search results as `#abc123` and can be used with `get` and `multi-get`:

```sh
# Search returns docid in results
qmd search "query" --json
# Output: [{"docid": "#abc123", "score": 0.85, "file": "docs/readme.md", ...}]

# Get document by docid
qmd get "#abc123"
qmd get abc123              # Leading # is optional

# Docids also work in multi-get comma-separated lists
qmd multi-get "#abc123, #def456"
```

## Options

```sh
# Search & retrieval
-c, --collection <name>  # Restrict search to a collection (matches pwd suffix)
-n <num>                 # Number of results
--all                    # Return all matches
--min-score <num>        # Minimum score threshold
--full                   # Show full document content
--line-numbers           # Add line numbers to output

# Multi-get specific
-l <num>                 # Maximum lines per file
--max-bytes <num>        # Skip files larger than this (default 10KB)

# Output formats (search and multi-get)
--json, --csv, --md, --xml, --files
```

## PostgreSQL memory bridge (optional)

QMD can additionally run as a shared, namespaced memory store backed by
PostgreSQL (`pgvector` + `pg_jieba` + `pg_trgm`, e.g. `postgresql.svc.plus`) for
external agents (OpenClaw, Hermes). SQLite remains the default and is unchanged.

```sh
export QMD_BACKEND=pg
export QMD_PG_URL='postgres://user:pass@host:5443/db'   # stunnel TLS port
export QMD_NAMESPACE=openclaw                            # tenant isolation

qmd pg status                              # backend health
qmd memory add <key> "text" --title T      # store/replace (text or stdin)
qmd memory search <query>                  # hybrid FTS(pg_jieba)+vector(pgvector), RRF
qmd memory get|rm|ls|namespaces
```

When `QMD_BACKEND=pg`, `qmd mcp` also exposes `memory_add/memory_search/
memory_get/memory_list` tools. Code lives in `src/pg/`. Design + usage:
`docs/plan/pg-backend-memory-bridge.md`, `docs/plan/pg-memory-bridge-usage.md`.

## Task coordination (PG backend, optional)

When several agents (Claude Code, OpenCode, Codex, Antigravity) work the same
repo, `qmd task` gives them one shared view of who is touching what. Needs the
PG backend but *not* pgvector or an embedder.

```sh
export QMD_BACKEND=pg
export QMD_PG_URL='postgres://user:pass@host:5443/db'

qmd task claim <path> --intent "..."   # take an advisory claim before editing
qmd task who <path>                    # exit 1 when another agent holds it
qmd task release <path> [--status done|abandoned] [--note ...]
qmd task heartbeat <path>              # extend a long-running claim
qmd task ls [--stale] | history | scopes | status
```

`scope` (the project key) is derived from the git remote, so SSH and HTTPS
clones coordinate together; override with `--scope` or `$QMD_TASK_SCOPE`.
Identity comes from `$QMD_AGENT_ID` or is auto-detected per client.

Claims are **advisory**. Only some clients can enforce a pre-write hook, so a
missed claim loses coordination, never correctness — nothing here ever blocks an
edit, and an unreachable PostgreSQL degrades to "no coordination".

`qmd mcp` additionally exposes `task_claim/task_who/task_release/task_board/
task_heartbeat`. With one shared `qmd mcp --http --daemon`, pass `scope` or
`cwd` to those tools: the daemon's own directory is not the caller's project.

Design: `docs/plan/agent-task-coordination.md`. Code: `src/pg/task-store.ts`,
`src/pg/task-scope.ts`.

## Shared task context (PG backend, optional)

Threads keyed by PR (else branch) that every agent client contributes to, so a
task started in one client can be resumed in another. Stores only important
session facts — never file contents, diffs, logs, absolute paths or secrets.

```sh
qmd ctx sources                         # local session dirs this machine has
qmd ctx collect --since 3d --dry-run    # preview what would be extracted
qmd ctx collect --since 3d              # extract into threads (incremental)
qmd ctx threads | brief [--thread id]   # list / merged handoff briefing
qmd ctx note pitfall "…" | lead | handoff --next "…"
```

MCP: `task_resume`, `task_note`, `task_handoff` (pass `cwd`). HTTP daemon also
serves write-only `POST /api/v1/agent/ingest` when `QMD_INGEST_TOKEN` is set.
Code: `src/pg/context-*.ts`, `src/collect/`, `src/mcp/context-tools.ts`,
`src/mcp/agent-ingest.ts`. Collectors only ever read client session
directories; never modify them.

## Development

```sh
bun src/cli/qmd.ts <command>   # Run from source
bun link               # Install globally as 'qmd'
```

## Tests

All tests live in `test/`. Run everything:

```sh
npx vitest run --reporter=verbose test/
bun test --preload ./src/test-preload.ts test/
```

## Architecture

- SQLite FTS5 for full-text search (BM25)
- sqlite-vec for vector similarity search
- External OpenAI-compatible API for default embeddings; node-llama-cpp for optional local embeddings, reranking (qwen3-reranker), and query expansion (Qwen3)
- Reciprocal Rank Fusion (RRF) for combining results
- Smart chunking: 900 tokens/chunk with 15% overlap, prefers markdown headings as boundaries
- AST-aware chunking: use `--chunk-strategy auto` to chunk code files (.ts/.js/.py/.go/.rs) at function/class/import boundaries via tree-sitter. Default is `regex` (existing behavior). Markdown and unknown file types always use regex chunking.

## Important: Do NOT run automatically

- Never run `qmd collection add`, `qmd embed`, or `qmd update` automatically
- Never modify the SQLite database directly
- Write out example commands for the user to run manually
- Index is stored at `~/.cache/qmd/index.sqlite`
- On this machine, always run CLI commands via `npx tsx src/cli/qmd.ts`, NOT `bin/qmd` (prevents bun.lock detection failure when node ABI is used)
- Always require user confirmation before installing system daemons, editing client configs, or pushing git branches

## Do NOT compile

- Never run `bun build --compile` - it overwrites the shell wrapper and breaks sqlite-vec
- The `qmd` file is a shell script that runs compiled JS from `dist/` - do not replace it
- `npm run build` compiles TypeScript to `dist/` via `tsc -p tsconfig.build.json`

## Releasing

Use `/release <version>` to cut a release. Full changelog standards,
release workflow, and git hook setup are documented in the
[release skill](skills/release/SKILL.md).

Key points:
- Add changelog entries under `## [Unreleased]` **as you make changes**
- The release script renames `[Unreleased]` → `[X.Y.Z] - date` at release time
- Credit external PRs with `#NNN (thanks @username)`
- GitHub releases roll up the full minor series (e.g. 1.2.0 through 1.2.3)
