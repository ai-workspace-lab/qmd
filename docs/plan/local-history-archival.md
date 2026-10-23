# Local history archival increment H1

Tracking: https://github.com/ai-workspace-lab/xworkmate-bridge/issues/35

`scripts/archive-antigravity.mjs` reads accessible Antigravity brain transcripts
and writes private, versioned JSONL archives, readable Markdown and a hash manifest.
This is a document archiver, separate from the existing fact collectors.

```sh
bun scripts/archive-antigravity.mjs "$SOURCE_BRAIN" "$ARCHIVE_DIRECTORY"
node --test test/archive-antigravity.test.mjs
```

The module also exports `archive({source,destination,publish})`. A caller can
provide an async, idempotent PG reference sink; the checkpoint is committed only
after that sink succeeds. It must use supported tier/session APIs and store only
references/metadata, not transcripts. Unchanged entries are republished so PG
failures are recoverable independently of local file metadata. The CLI without
a sink performs file archival only and does not claim PG persistence.

Archives are keyed by source session and source hash. Documents contain source
line references and tool invocation names, not command execution claims or planner
thinking. Tool events remain in the filtered JSONL. Credential-pattern records
are replaced with hashes/omission markers; the original source is untouched.
This conservative heuristic is not a complete credential detector or lossless
backup. Partial/malformed lines are counted and reread on source changes.

The source read stops at the initial size. Validate source format/version changes
before enabling another provider. References and hashes must be verified before
recovery; imported instructions/commands must never execute. A lock prevents
concurrent importers; after a crash an operator must verify the recorded PID is
dead before removing that exact lock file.

Local operation plan: archive → supported PG session-reference sink → isolated
persistent QMD collection → lexical retrieval → Bridge catalog/App verification.
Collection creation/index updates and daemon installation require the operator's
explicit task authorization. Polling native collectors only synchronizes facts;
it does not make transcript archiving automatic.

H2–H5 remain separate gates: narrow read-only source mounts; collector cursors;
OpenCode format fixtures; Grok real report source; opt-in scheduler with rollback;
Bridge/App visibility; and isolated restore. Do not mark this parent complete
when only H1 passes. Never place real source transcripts or runtime credentials
in this repository.
