# Local task handoff between code apps

Stdio MCP needs no bearer authentication. Configure each code app to use the
same QMD build and PostgreSQL database. Task state lives in PostgreSQL; the MCP
processes do not need to be shared.

For a native HTTP server, set `QMD_BACKEND=pg`, configure its PostgreSQL
connection privately, and start:

```sh
QMD_LOCAL_NO_AUTH=1 qmd mcp --http --host 127.0.0.1 --port 8182
```

This explicit mode skips bearer checks for `/mcp`, `/api/v1/agent/ingest` and
task read routes. It refuses non-loopback bind addresses, including when a
remote token is configured. Origin and Host checks remain active. Other local
processes can read and write tasks; use only on a trusted desktop. Container
publish rules do not establish this trust: a server binding `0.0.0.0` cannot
enable this mode. Existing authenticated remote deployments retain their policy.

Use `task_catalog({scope:"github.com/org/repo"})` to find tasks independently of
the local checkout. Both the text and structured response include recent thread
IDs. Resume an existing ID with `task_resume({thread_id:"...",client:"codex"})`
or the corresponding client name. Use the returned session ID for `task_note`.
Acquire a driver lease only when coordinating direction, then use `task_handoff`
with the returned fence and a concrete next action. Main/default branches do
not identify a unique task and never silently select or create one.

Archive final documents in the Knowledge repository. Store repository-relative
document paths, PR/commit references, decisions and next actions in the task.
Update the Knowledge collection and generate embeddings after archiving; task
read/write, document indexing and vector retrieval are separate checks.
