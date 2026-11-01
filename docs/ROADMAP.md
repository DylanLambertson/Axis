# Implementation Roadmap and Gates

## Phase 0 — Feasibility and product architecture
Deliver Code OSS custom workbench spike, Electron+web prototypes, extension compatibility matrix, licenses/marketplace review, threat model, ADRs, architecture benchmarks. **Gate:** basic IDE operations work with custom shell and a credible upstream maintenance strategy.

## Phase 1 — IDE vertical slice
Desktop repo open/edit/search, explorer, terminal, Git, diagnostics, language services, command palette, settings, theme, keyboard navigation. Browser workspace skeleton with remote workspace protocol. **Gate:** usable editor on macOS plus Windows/Linux CI smoke; essential keyboard and accessibility flows.

## Phase 2 — AI gateway and single agent
Connection vault, one official provider API adapter, model selector, streaming chat, context attachments, inline diff, single-agent tool broker, approval UI, local run journal. **Gate:** request → change → test → diff → accept/reject, with permissions and crash recovery.

## Phase 3 — Parallel orchestration
Planner DAG, worktree-per-worker, queue, reviewer, merge integration, retries, budgets, task history, logs, checkpoints. **Gate:** two workers independently implement tasks, pass validation, and integrate without silent overwrites.

## Phase 4 — Intelligence and extensibility
Repository indexing, project memory, rules, skills, knowledge graph, ACL retrieval, MCP, provider SDK, supported CLI integration and additional providers. **Gate:** provenance-aware retrieval, data deletion, cross-project isolation and plugin contract tests.

## Phase 5 — Teams and sync
Organizations, RBAC, presence, CRDT collaboration, shared tasks/agents, encrypted opt-in sync, cloud runners, audit. **Gate:** concurrent editing and team agent runs pass permission, offline/conflict and recovery tests.

## Phase 6 — Hardening and public release
Cross-platform packaging, signed updates, performance, telemetry consent, extension matrix, security audit, migration reliability, docs/onboarding, pricing if commercial. **Gate:** defined SLOs and release-blocker checklist satisfied.

## Long-term
Provider-native artifact integrations where official APIs exist; universal docs/slides, remote workspace fleets, extension marketplace, enterprise SSO/policies, advanced code graph, automation and richer collaboration.

## Recommended first 10 tickets
1. ADR: Code OSS fork versus service extraction.
2. Compatibility proof with custom workbench and Monaco/LSP.
3. Electron IPC threat model and typed bridge.
4. Workspace filesystem/Git abstraction and browser remote adapter.
5. Git worktree lifecycle manager with conflict tests.
6. SQLite schema + migrations + event journal.
7. Provider adapter interface and mock provider.
8. One supported provider connection + vault.
9. Agent tool broker with approval policy.
10. End-to-end single-agent diff/review flow.

## Milestone measurement
Track cold start, keystroke-to-render latency, memory footprint, indexing speed, agent task completion, merge conflicts, provider error rate, sandbox denial, sync conflicts and crash-free sessions. Set numerical budgets after the Phase 0 baseline rather than inventing unsupported guarantees.
