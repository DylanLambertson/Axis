# Architecture and Technical Decisions

## System decomposition
- **Shells:** Electron desktop main/preload/renderer; browser client with remote workspace gateway.
- **Workbench:** one Axis shell (ADR 0002, ADR 0004) with two views. **Agent view** (default) is Axis-owned: workspace dashboard, workspace view (file tree, changes and diff review, terminals and panes, composer, agent activity). **IDE view** reuses the upstream workbench parts: editor surface, panels, status, notifications. A view-mode service switches or splits the views per user preference; command registry shared.
- **IDE compatibility:** Code OSS service integration, Monaco editor, LSP/DAP, terminal, Git, search, extension host. Code OSS workbench extraction is a feasibility risk, not a settled reusable library.
- **AI gateway:** provider adapters, account vault, model registry, capability discovery, policy/cost routing, streaming protocol.
- **Orchestrator:** durable task DAG, scheduler, planner/worker/reviewer, approvals, checkpoints, run journal.
- **Execution:** local daemon and optional cloud runners, worktree lifecycle manager (one worktree and branch per workspace), subprocess sandbox, tool broker.
- **Context:** local SQLite metadata, FTS index, symbol/reference graph, pluggable embeddings, provenance and ACL-aware retrieval.
- **Collaboration:** identity, organizations, RBAC/ABAC, presence, real-time document sync, review and audit.
- **Sync:** encrypted, opt-in synchronization with device identities, key management and explicit conflict resolution.

## Runtime boundaries
Desktop renderer cannot access OS APIs directly; Electron contextIsolation on, nodeIntegration off, sandbox on where compatible; narrow validated preload IPC. Local daemon holds terminal, Git, index and execution authority. Web UI talks to a scoped remote workspace service over authenticated TLS. Shared UI packages must not assume Node or native OS APIs.

## Data flow
User request → intent/permission gate → context retrieval (ACL filtered) → model/provider selection → planner DAG → scheduler → isolated workers/tool broker → tests and review → diff/approval → merge → indexed artifacts/memory. Every stage emits auditable events with redacted payloads.

## Proposed technologies (provisional)
Electron; Code OSS-compatible fork/selected services; React + TypeScript for custom UI subject to compatibility spike; Node/TypeScript service layer; SQLite (WAL, migrations, FTS5) for local durable data; Git CLI/libgit2 choice via spike; tree-sitter and language servers for code intelligence; WebSocket/WebRTC or equivalent for presence and collaboration; CRDT such as Yjs for concurrent text; cloud backend selected by auth, region, encryption and operational needs. Avoid choosing cloud vendor before threat modeling.

## Platform behavior
Desktop: native local repo access, local terminal, local execution and offline operation. Web: hosted or user-connected remote workspace, browser-safe editing and terminal streaming; local filesystem requires an explicit companion/bridge. Cloud agents optional and visibly labeled.

## Code OSS compatibility spike (blocking gate)
- Inventory Code OSS build targets, service dependencies, editor and extension host coupling, update/rebase burden, licenses and trademark restrictions.
- Prove custom top-level shell that boots into an agent-view skeleton (dashboard, workspace view with file tree and terminal) and switches to an IDE view with editor, explorer, diagnostics, terminal, debugger, Git, command registry and extension host.
- Test 10 representative extensions (language servers, debugger, formatter, theme, Git-related); record failures.
- Compare direct fork versus embedding selected services and an alternative VS Code-compatible server. Document cost and maintenance.
- Gate: demonstrated end-to-end IDE workflow in IDE view and the agent-view skeleton with view switching (`ROADMAP.md` Phase 0) on macOS and at least one other desktop OS, web prototype with documented feature gaps, and an upstream maintenance plan.

## Reliability
Persist orchestration events and recover incomplete runs; support cancellation and backpressure. Typed versioned RPC, heartbeat/lease for remote workers, idempotent tool operations, bounded retries. Explicitly track partial failures.

## Observability
Local-first diagnostics; opt-in redacted telemetry; run tracing, provider latency, token/cost estimates, agent success rates, sandbox denials, sync conflicts, extension crashes. Export diagnostics with privacy review.
