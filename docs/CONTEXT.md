# Context, Memory and Knowledge

## Data model
Space (personal or team) → Projects → Repositories → Files/Symbols; Repositories → Workspaces (agent worktrees, ADR 0004); Users/Teams → Roles; Agent Runs → Tasks → Artifacts/Decisions; Knowledge Entries → Sources/Provenance/Embeddings/Edges. Every entity has stable ID, scope, owner, ACL, created/updated timestamps and schema version.

## Memory layers
- Ephemeral: task scratchpad, run logs, tool results, short-lived context window.
- Project: architecture, decisions, style rules, repo index, accepted implementation history.
- Space: shared conventions, reusable skills and explicitly approved cross-project knowledge, for a personal or team Space. Agent workspaces read project and Space memory; they do not form a memory layer of their own.
- Personal: private user preferences, optionally synchronized.
- Organization: curated shared policies and approved documentation, permission filtered.

## Retrieval pipeline
Classify request → determine identity and scope → ACL-filter candidates → lexical and semantic search → symbol/graph expansion → rerank → token budget → attach source citations/provenance. Retrieval must never bridge tenants or private projects without authorization.

## Knowledge graph
Nodes: repo, file, symbol, dependency, task, issue, decision, artifact, user, skill. Edges: imports, references, owns, depends_on, implements, supersedes, relates_to. Build incrementally from Git and language-server/tree-sitter data; avoid speculative relationships being treated as facts.

## Memory lifecycle
Separate observed facts from model-generated summaries. Every memory entry has source, confidence/verification status, scope, retention, and delete controls. User-approved durable memories only; auto-generated suggestions require review for cross-project reuse. Support export, purge, reindex and tombstones across sync replicas.

## Local storage
SQLite with FTS5 and transactional migrations; embeddings stored locally or through a pluggable index. Encrypt sensitive local records as needed with OS-backed key material. Sync is opt-in and end-to-end encrypted where feasible; design key recovery and team membership changes before promising E2EE.

## Context handoff
Agent handoff packet: task goal, approved scope, base SHA, relevant source references, constraints, decisions, test commands, artifacts, outstanding questions, and provenance. Summarize to fit context budget, retain original records for audit, and never silently promote untrusted retrieved text to instructions.
