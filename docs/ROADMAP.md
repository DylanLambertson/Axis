# Implementation Roadmap and Gates

Sequenced agent-first per ADR 0004: the Agent view shell is built in Phases 0–1, alongside the IDE view on the same custom shell. The first usable release target is the Phase 1 slice.

## Phase 0 — Feasibility and product architecture
Deliver Code OSS custom workbench spike, Electron+web prototypes, extension compatibility matrix, licenses/marketplace review, threat model, ADRs, architecture benchmarks, and an **agent-view skeleton** on the custom shell (M3, per `docs/design/axis-agent-shell.md`). **Gate:**
- basic IDE operations (ADR 0002 criterion 1) work in **IDE view** on the custom shell, with a credible upstream maintenance strategy;
- the shell boots into the agent-view skeleton: a dashboard listing workspaces (mock or read-only data) and a workspace view with a file tree and a terminal bound to a folder;
- per-workspace toggle and split modes work; a file-tree click opens IDE view at that file; switching back preserves workspace and editor state;
- the shell-layer footprint including the skeleton is measured against ADR 0002 criterion 2.

## Phase 1 — Agent workspace shell + IDE view vertical slice
A minimal, end-to-end agent manager on desktop, with the full IDE view:
- **Workspaces and worktrees:** dashboard; create, focus, archive and remove workspaces; daemon worktree lifecycle manager (one worktree and branch per workspace, base SHA recorded, removal refuses to discard uncommitted work); worktrees outside the repository under the app data directory (configurable); several workspaces concurrently within a per-device limit; no agent runs in the local checkout.
- **Terminals and panes:** terminals bound to the worktree, split panes, layout persisted per workspace.
- **CLI coding agents (first-class):** launch installed agent CLIs in a workspace terminal through their documented interfaces, under the user's login and terms; dashboard runs with status from process and terminal state; scrubbed environment (no Axis secrets, askpass or IPC handles; PTY-2); changes through diff review.
- **File tree, changes and diff review:** file tree; changed-files list against the base; accept/reject per file and hunk; commit on the workspace branch with the user's Git identity; push the branch and open a pull request where a remote and supported forge exist (no merge action; merge queue is Phase 3); "files changed outside the agent" indicator; open in IDE view at the location.
- **Composer and single agent:** Ask / Edit / Agent composer; mock provider plus the **Anthropic (Claude) API** adapter; connection vault holding its API key; model selection within that connection; streaming; single-agent tool broker with approval policy and approval UI; local SQLite run journal and audit log.
- **IDE view:** repo open/edit/search, explorer, terminal, Git, diagnostics, language services, command palette, settings, theme, keyboard navigation.
- **View modes:** per-workspace, global and split, with the focus rules in `docs/UX.md`.
- **Platform:** ADR 0003 bridge (validation criteria 1–7); browser workspace skeleton with remote workspace protocol (documented gaps, not gating).
- **Security controls moved forward** (ADR 0004): worktree path and git-config controls (WT-1–WT-4), broker environment allow-list, timeouts and output caps (PTY-2, PTY-4), challenge approvals (DMN-3), audit and redaction (DMN-5, DMN-6), journal recovery (DMN-7), credential controls (PRV-1, PRV-2, PRV-4, PRV-6; PRV-5 if custom endpoints ship).

**Gate:** on macOS, plus Windows/Linux CI smoke:
- acceptance scenarios 1–6 in `docs/PRODUCT.md` pass, with the mock provider and the Anthropic API for the composer, and at least one installed agent CLI for scenario 2;
- a CLI agent's terminal environment contains no Axis secrets, `GIT_ASKPASS`/`VSCODE_GIT_ASKPASS*`, `VSCODE_GIT_IPC_HANDLE` or `VSCODE_IPC_HOOK_CLI` (automated test);
- creating a worktree inside a registered repository is refused;
- a requested approval blocks the action until resolved by the user; an agent actor resolving it is denied;
- killing the app mid-run and restarting recovers the run state from the journal, and the worktree is intact;
- no credential appears in logs, renderer state, prompts or agent environments (redaction tests);
- removing a workspace with uncommitted changes is refused without explicit confirmation;
- the scenarios and all three view modes complete keyboard-only, and the switching focus rules pass;
- the threat model is revised for the new phase order (ADR 0004).

## Phase 2 — Agent depth and IDE-view AI
Inline edit and inline diff in the IDE editor, selection/file/symbol context attachments, model/account switcher across connections, capability display, conversation history, checkpoints and undo, prompt templates, cost/usage where supported. **Gate:** inline edit → reversible diff → accept/reject in IDE view; restoring a checkpoint returns the worktree to the recorded state; unsupported capabilities are labeled unavailable.

## Phase 3 — Parallel orchestration
Planner DAG, one workspace per worker, queue, reviewer, merge integration queue, retries, budgets, task history, logs, OS sandbox for agent subprocesses (threat model §8.2), advanced DAG and worktree views. **Gate:** two workers independently implement tasks in separate workspaces, pass validation, and integrate without silent overwrites.

## Phase 4 — Intelligence and extensibility
Repository indexing, project memory, rules, skills, knowledge graph, ACL retrieval, MCP, provider SDK, supported CLI sessions as provider connections (`PROVIDERS.md` type 3, beyond Phase 1 CLI agent runs) and additional providers. **Gate:** provenance-aware retrieval, data deletion, cross-project isolation and plugin contract tests.

## Phase 5 — Teams and sync
Organizations, RBAC, presence, CRDT collaboration, shared tasks/agents, encrypted opt-in sync, cloud runners, audit. **Gate:** concurrent editing and team agent runs pass permission, offline/conflict and recovery tests.

## Phase 6 — Hardening and public release
Cross-platform packaging, signed updates, performance, telemetry consent, extension matrix, security audit, migration reliability, docs/onboarding, pricing if commercial. **Gate:** defined SLOs and release-blocker checklist satisfied.

## Long-term
Provider-native artifact integrations where official APIs exist; universal docs/slides, remote workspace fleets, extension marketplace, enterprise SSO/policies, advanced code graph, automation and richer collaboration.

## Recommended first 10 tickets
1. Agent-view skeleton on the Axis shell: dashboard, workspace view with file tree and terminal, view-mode service with per-workspace, global and split modes (Phase 0 gate).
2. IDE view on the custom shell passing ADR 0002 criterion 1, opened from the skeleton's file tree at file and line.
3. ADR 0003 bridge spike: daemon utility process, handshake, contracts and policy hook (validation criteria 1–7).
4. Git worktree lifecycle manager in the daemon: create, list, remove, base SHA, uncommitted-work protection, WT-1/WT-2 controls, conflict and crash tests.
5. SQLite schema + migrations + event journal (workspaces, worktrees, runs, approvals, audit).
6. Workspace terminals and split panes bound to the worktree, persisted per workspace; CLI agent launch with scrubbed environment and dashboard run status.
7. Changes list and diff review: accept/reject per file and hunk, commit, push branch and open pull request, outside-the-agent change indicator.
8. Provider adapter interface, contract tests and mock provider.
9. Anthropic (Claude) API adapter + connection vault (API key).
10. Composer (Ask/Edit/Agent) + single-agent tool broker with approval policy and UI; end-to-end dashboard → workspace → agent → diff → commit.

## Milestone measurement
Track cold start, keystroke-to-render latency, view-switch latency (Agent ↔ IDE), workspace creation time, memory footprint, indexing speed, agent task completion, merge conflicts, provider error rate, sandbox denial, sync conflicts and crash-free sessions. Set numerical budgets after the Phase 0 baseline rather than inventing unsupported guarantees.
