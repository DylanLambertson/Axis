# Implementation Roadmap and Gates

Sequenced agent-first per ADR 0004: the Agent view shell is built in Phases 0–1, alongside the IDE view on the same custom shell. The first usable release target is the Phase 1 slice (1a, then 1b).

## Phase 0 — Feasibility and product architecture
Deliver Code OSS custom workbench spike, Electron+web prototypes, extension compatibility matrix, licenses/marketplace review, threat model, ADRs, architecture benchmarks, and an **agent-view skeleton** on the custom shell (M3, to be specified in `docs/design/axis-agent-shell.md`). **Gate:**
- basic IDE operations (ADR 0002 criterion 1) work in **IDE view** on the custom shell, with a credible upstream maintenance strategy;
- the shell boots into the agent-view skeleton: a dashboard listing workspaces (mock or read-only data) and a workspace view with a file tree and a terminal bound to a folder;
- per-workspace toggle and split modes work; a file-tree click opens IDE view at that file; switching back preserves workspace and editor state;
- the shell-layer footprint including the skeleton is measured against ADR 0002 criterion 2.

## Phase 1 — Agent workspace shell + IDE view vertical slice
A minimal, end-to-end agent manager on desktop, with the full IDE view. Phase 1 ships in two steps, both part of Agent view v1 (ADR 0004 decision 13); 1a ships first.

### Phase 1a — Agent workspace shell
- **Workspaces and worktrees:** dashboard; create, focus, rename, archive and remove workspaces; daemon worktree lifecycle manager (one worktree and branch per workspace, base SHA recorded, removal refuses to discard uncommitted work); worktrees outside the repository under the app data directory (configurable); Workspace Trust inherited from the source repository; several workspaces concurrently within a per-device limit; no agent runs in the local checkout (working-directory rule, not a security boundary).
- **Terminals and panes:** terminals bound to the worktree, split panes, layout persisted per workspace.
- **CLI coding agents (first-class):** launch installed agent CLIs in a workspace terminal through their documented interfaces, under the user's login and terms; dashboard runs with status from process and terminal state; PTY-5 environment deny-list; `$GIT_COMMON_DIR` snapshot around every run; changes through diff review.
- **File tree, changes and diff review:** file tree; changed-files list against the base; accept/reject per file and hunk; protected-path highlighting; commit on the workspace branch with the user's Git identity; push the branch; open a pull request on GitHub (`gh` if installed, else the web compare URL; other forges push only; no merge action, merge queue is Phase 3); "files changed outside the agent" indicator; open in IDE view at the location.
- **IDE view:** repo open/edit/search, explorer, terminal, Git, diagnostics, language services, command palette, settings, theme, keyboard navigation; the debugger and extension host as already required by ADR 0002 criterion 1.
- **View modes:** per-workspace, global and split, with the focus rules in `docs/UX.md`.
- **Platform:** ADR 0003 bridge (validation criteria 1–7); local SQLite journal for workspaces, worktrees and runs; the ADR 0003 D4 challenge and native-confirmation mechanism, used by workspace removal and other tier-4 user actions (ADR 0004 implication 4).
- **Security controls:** PTY-5, CLI-side WT-2 snapshot, WT-3 highlighting, WT-4, the DMN-2 worktree rule, DMN-7 journal recovery (ADR 0004).

**Gate (1a):** on macOS, plus Windows/Linux CI smoke:
- acceptance scenarios 2–5 in `docs/PRODUCT.md` pass with at least one installed agent CLI; push goes to a local bare remote; with a stub `gh` on `PATH`, Axis runs `gh pr create` in the worktree with the expected arguments, and without `gh` it opens the correct GitHub compare URL;
- **PTY-5:** with the git extension enabled, `git.terminalAuthentication` on and a test extension contributing an environment variable collection, a CLI agent terminal's environment contains no `VSCODE_*`, `ELECTRON_*`, `GIT_ASKPASS`, `SSH_ASKPASS*` or `GIT_EDITOR` variable, none of the test extension's variables and no vault credential, while `SSH_AUTH_SOCK` is present when the parent has it (automated test);
- **WT-2 (CLI side):** a test CLI run that adds a hook under `$GIT_COMMON_DIR/hooks` and sets `core.hooksPath` is flagged in diff review and on the dashboard row with the before/after diff; a run that changes neither shows no flag;
- **WT-3 (highlighting):** a CLI write to a protected path (for example `.github/workflows/`, `.vscode/tasks.json`) is highlighted in diff review;
- **DMN-2:** a daemon call naming a worktree path that the worktree manager did not register, including one that reaches a registered worktree through a symlink or `..`, is refused;
- creating a worktree inside a registered repository is refused; removing a workspace with uncommitted changes is refused without explicit confirmation;
- **tier-4 confirmation:** a tier-4 action (for example workspace removal) without a valid, unexpired challenge confirmed through the native dialog is refused, and a replayed challenge is refused;
- a worktree of an untrusted repository opens in Restricted Mode in IDE view;
- killing the app during a CLI agent run and restarting recovers the workspaces, terminal layout and run record from the journal, and the worktree is intact;
- the scenarios and all three view modes complete keyboard-only, and the switching focus rules pass;
- the threat model is revised for the new phase order before the gate review (ADR 0004 implication 7).

### Phase 1b — Composer and brokered agent
- **Composer and single agent:** Ask / Edit / Agent composer; agent activity stream; mock provider plus the **Anthropic (Claude) API** adapter; connection vault holding its API key; model selection within that connection; streaming; single-agent tool broker with approval policy and approval UI, reusing the Phase 1a challenge mechanism; drift notification to the composer agent; run journal and audit log.
- **Security controls:** WT-1, WT-2 (broker side), WT-3 approval, PTY-2, PTY-4, DMN-3, DMN-5, DMN-6, PRV-1, PRV-2, PRV-4, PRV-6; PRV-5 if custom endpoints ship (ADR 0004).

**Gate (1b):** on macOS, plus Windows/Linux CI smoke:
- acceptance scenarios 1 and 6 in `docs/PRODUCT.md` pass with the mock provider and the Anthropic API;
- **DMN-3:** a requested approval blocks the action until resolved by the user; an agent actor resolving it is denied;
- **WT-1:** a composer agent write through `..`, an absolute path, or a symlink planted in the repository that points outside the worktree is refused;
- **WT-2 (broker side):** a hook planted in `$GIT_COMMON_DIR/hooks` does not run during broker-run git; a composer run that changes `$GIT_COMMON_DIR/config` or `hooks/` fails closed and is reported;
- **WT-3 (approval):** a composer write to a protected path requires explicit approval and is highlighted in diff review;
- **PTY-4:** a broker command that exceeds its timeout or output cap is killed with its process group, and the run records why;
- **DMN-5:** every approval and side effect writes an audit event with approver identity and expiry; altering a stored event is detected by the hash-chain check;
- **PTY-2:** a broker-launched child process's environment contains only allow-listed variables (`PATH`, `HOME`, `LANG`, `TERM` and declared per-tool additions); variables set in the app, terminal or extension environment, including `VSCODE_*`, `GIT_ASKPASS`, `SSH_AUTH_SOCK` and `*_TOKEN`/`*_KEY`, are absent unless a scoped grant applies;
- **PRV-6:** a composer run that reaches its per-run token or cost budget is stopped by the daemon before the next provider request, and the run records why;
- **PRV-1:** with the Linux `basic_text` backend, storing the API key is refused or needs explicit consent, and the UI shows the storage backend;
- no credential appears in logs, renderer state, prompts or agent environments (redaction tests, PRV-2 and DMN-6);
- killing the app mid composer run and restarting recovers the run state from the journal, and the worktree is intact.

## Phase 2 — Agent depth and IDE-view AI
Inline edit and inline diff in the IDE editor, selection/file/symbol context attachments, model/account switcher across connections, capability display, conversation history, checkpoints and undo (moved from Phase 3, ADR 0004), prompt templates, cost/usage where supported. Browser workspace skeleton with remote workspace protocol (moved from Phase 1; documented gaps, not gating). **Gate:** inline edit → reversible diff → accept/reject in IDE view; restoring a checkpoint returns the worktree to the recorded state; unsupported capabilities are labeled unavailable.

## Phase 3 — Parallel orchestration
Planner DAG, one workspace per worker, queue, reviewer, merge integration queue, retries, planner and per-goal budgets, task history, logs, OS sandbox for agent subprocesses (threat model §8.2), advanced DAG and worktree views. **Gate:** two workers independently implement tasks in separate workspaces, pass validation, and integrate without silent overwrites.

## Phase 4 — Intelligence and extensibility
Repository indexing, project memory, rules, skills, knowledge graph, ACL retrieval, MCP, provider SDK, supported CLI sessions as provider connections (`PROVIDERS.md` type 3, beyond Phase 1 CLI agent runs) and additional providers. **Gate:** provenance-aware retrieval, data deletion, cross-project isolation and plugin contract tests.

## Phase 5 — Teams and sync
Organizations, RBAC, presence, CRDT collaboration, shared tasks/agents, encrypted opt-in sync, cloud runners, audit. **Gate:** concurrent editing and team agent runs pass permission, offline/conflict and recovery tests.

## Phase 6 — Hardening and public release
Cross-platform packaging, signed updates, performance, telemetry consent, extension matrix, security audit, migration reliability, docs/onboarding, pricing if commercial. **Gate:** defined SLOs and release-blocker checklist satisfied.

## Long-term
Provider-native artifact integrations where official APIs exist; universal docs/slides, remote workspace fleets, extension marketplace, enterprise SSO/policies, advanced code graph, automation and richer collaboration.

## Recommended first 10 tickets
Tickets 1–7 are Phase 0 and 1a; 8–10 are Phase 1b.

1. Agent-view skeleton on the Axis shell: dashboard, workspace view with file tree and terminal, view-mode service with per-workspace, global and split modes (Phase 0 gate).
2. IDE view on the custom shell passing ADR 0002 criterion 1, opened from the skeleton's file tree at file and line.
3. ADR 0003 bridge spike: daemon utility process, handshake, contracts and policy hook (validation criteria 1–7).
4. Git worktree lifecycle manager in the daemon: create, list, remove, base SHA, app-data location, uncommitted-work protection, Workspace Trust inheritance, DMN-2 registration checks, conflict and crash tests.
5. SQLite schema + migrations + event journal (`agent_workspaces`, `worktrees`, `agent_runs`, `approvals`, `audit_events`).
6. Workspace terminals and split panes bound to the worktree, persisted per workspace; CLI agent launch with the PTY-5 environment rule, `$GIT_COMMON_DIR` snapshot and dashboard run status.
7. Changes list and diff review: accept/reject per file and hunk, protected-path and Git-directory flags, commit, push branch, GitHub pull request, outside-the-agent change indicator.
8. Provider adapter interface, contract tests and mock provider.
9. Anthropic (Claude) API adapter + connection vault (API key).
10. Composer (Ask/Edit/Agent) + single-agent tool broker with approval policy and UI, WT-1 and broker-side WT-2; end-to-end dashboard → workspace → agent → diff → commit.

## Milestone measurement
Track cold start, keystroke-to-render latency, view-switch latency (Agent ↔ IDE), workspace creation time, memory footprint, indexing speed, agent task completion, merge conflicts, provider error rate, sandbox denial, sync conflicts and crash-free sessions. Set numerical budgets after the Phase 0 baseline rather than inventing unsupported guarantees.
