# Implementation Roadmap and Gates

> **Direction change (2026-11-26):** ADR 0011 (`docs/adr/0011-own-shell-ide-as-optional-feature.md`, Proposed) replaces the Code OSS-based shell with our own shell, in which the IDE is one optional feature module. It supersedes ADR 0002. The gate lines below that name Code OSS, IDE view, Restricted Mode, extensions, Open VSX, reh-web or ADR 0002 criteria 1 and 2 are re-stated in ADR 0011 ("Roadmap gate changes") and will be rewritten here once it is accepted. The ticket plan is `docs/design/own-shell-plan.md`.

**Gate status (2026-11-26, `origin/main` `9b2f0e9`):** Phases 0, 1a, 1b and 1c are not signed off. Merged package and headless-slice tests cover parts of the pty process, trust gate, review attributes and content, composer tools and provider, journal recovery, snapshot scanning and static network checks. The required macOS acceptance run, Windows/Linux smoke, real extension environment and packaged-build checks remain open. A merged component alone does not satisfy its full gate line; see `docs/security/threat-model-phase1-unverified-gates.md`.

Sequenced agent-first per ADR 0004 and ADR 0006: the Agent view shell is built in Phases 0–1, alongside the IDE view on the same custom shell, and Axis becomes an agent home in Phase 1c. The first usable release target is the Phase 1 slice: 1a, then 1b, then 1c. Phase 1c is part of the target because ADR 0006 makes the agent, not the workspace, the unit the product manages and the project home its landing surface: a release without 1c would ship the workspace dashboard that ADR 0006 replaces (decided 2026-11-21 with O-7, `docs/design/owner-decisions-2026-11-21.md`).

The phase structure follows owner decision O-7: Phase 1c is inserted after 1b, Phase 2 is split into 2a and 2b, and Phase 4 into 4a and 4b. Gates 0, 1a and 1b are unchanged. The ticket breakdown for 1c, 2a and 4a is `docs/design/product-vision-v2-tickets.md`.

## Phase 0 — Feasibility and product architecture
Deliver Code OSS custom workbench spike, Electron+web prototypes, extension compatibility matrix, licenses/marketplace review, threat model, ADRs, architecture benchmarks, and an **agent-view skeleton** on the custom shell (M3, to be specified in `docs/design/axis-agent-shell.md`). **Gate:**
- basic IDE operations (ADR 0002 criterion 1) work in **IDE view** on the custom shell, with a credible upstream maintenance strategy;
- the shell boots into the agent-view skeleton: a dashboard listing workspaces (mock or read-only data) and a workspace view with a file tree and a terminal bound to a folder;
- per-workspace toggle and split modes work; a file-tree click opens IDE view at that file; switching back preserves workspace and editor state;
- the shell-layer footprint including the skeleton is measured against ADR 0002 criterion 2.

## Phase 1 — Agent workspace shell + IDE view vertical slice
A minimal, end-to-end agent manager on desktop, with the full IDE view. Phase 1 ships in three steps: 1a and 1b, both part of Agent view v1 (ADR 0004 decision 13), then 1c, the agent home (ADR 0006). 1a ships first.

### Phase 1a — Agent workspace shell
- **Workspaces and worktrees:** dashboard; create, focus, rename, archive and remove workspaces; daemon worktree lifecycle manager (one worktree and branch per workspace, base SHA recorded, removal refuses to discard uncommitted work); worktrees outside the repository under the app data directory (configurable); Workspace Trust inherited from the source repository; several workspaces concurrently within a per-device limit; no agent runs in the local checkout (working-directory rule, not a security boundary).
- **Terminals and panes:** terminals bound to the worktree, split panes, layout persisted per workspace.
- **CLI coding agents (first-class):** launch installed agent CLIs in a workspace terminal through their documented interfaces, under the user's login and terms; dashboard runs with status from process and terminal state; PTY-5 environment deny-list; `$GIT_COMMON_DIR` snapshot around every run; changes through diff review.
- **File tree, changes and diff review:** file tree; changed-files list against the base; accept/reject per file and hunk; protected-path highlighting; commit on the workspace branch with the user's Git identity; push the branch; open a pull request on GitHub (`gh` if installed, else the web compare URL; other forges push only; no merge action, merge queue is Phase 3); "files changed outside the agent" indicator; open in IDE view at the location.
- **IDE view:** repo open/edit/search, explorer, terminal, Git, diagnostics, language services, command palette, settings, theme, keyboard navigation; the debugger and extension host as already required by ADR 0002 criterion 1.
- **View modes:** per-workspace, global and split, with the focus rules in `docs/UX.md`.
- **Platform:** ADR 0003 bridge (validation criteria 1–7); local SQLite journal for workspaces, worktrees and runs; the ADR 0003 D4 challenge and native-confirmation mechanism, used by workspace removal and other tier-4 user actions (ADR 0004 implication 4); the audit log with hash chain and redaction for user and daemon actions (ADR 0003 D5).
- **Security controls:** PTY-5, CLI-side WT-2 snapshot, WT-3 highlighting, WT-4, the DMN-2 worktree rule, DMN-5 audit and DMN-6 redaction for user and daemon actions, DMN-7 journal recovery (ADR 0004).

**Gate (1a):** on macOS, plus Windows/Linux CI smoke:
- acceptance scenarios 2–5 in `docs/PRODUCT.md` pass with at least one installed agent CLI; push goes to a local bare remote; with a stub `gh` on `PATH`, Axis runs `gh pr create` in the worktree with the expected arguments, and without `gh` it opens the correct GitHub compare URL;
- **PTY-5:** with the git extension enabled, `git.terminalAuthentication` on and a test extension contributing an environment variable collection, a CLI agent terminal's environment contains no `VSCODE_*`, `ELECTRON_*`, `GIT_ASKPASS`, `SSH_ASKPASS*`, `GIT_EDITOR`, `AXIS_*` or git-redirecting or config-injecting variable (exactly `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_PREFIX`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*` and `GIT_CONFIG_PARAMETERS`), none of the test extension's variables and no vault credential, while `SSH_AUTH_SOCK`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM` are present when the parent has them; the same denied set is absent from a plain workspace terminal, which additionally receives the shell-integration set (automated test);
- **WT-2 (CLI side):** a test CLI run that adds a hook under `$GIT_COMMON_DIR/hooks` and sets `core.hooksPath` is flagged in diff review and on the dashboard row with the before/after diff; a run that changes neither shows no flag;
- **WT-3 (highlighting):** a CLI write to a protected path (for example `.github/workflows/`, `.vscode/tasks.json`) is highlighted in diff review;
- **DMN-2:** a daemon call naming a worktree path that the worktree manager did not register, including one that reaches a registered worktree through a symlink or `..`, is refused;
- creating a worktree inside a registered repository is refused; removing a workspace with uncommitted changes is refused without explicit confirmation;
- **DMN-5 (user and daemon actions):** workspace removal, commit, push, discard and every other tier-4 or privileged action writes an audit event with actor identity; altering a stored event is detected by the hash-chain check; no secret appears in the audit log or other logs (DMN-6);
- **tier-4 confirmation:** a tier-4 action (for example workspace removal) without a valid, unexpired challenge confirmed through the native dialog is refused, and a replayed challenge is refused;
- a worktree of an untrusted repository opens in Restricted Mode in IDE view;
- killing the app during a CLI agent run and restarting recovers the workspaces, terminal layout and run record from the journal, and the worktree is intact;
- the scenarios and all three view modes complete keyboard-only, and the switching focus rules pass;
- the threat model is revised for the new phase order before the gate review (ADR 0004 implication 7);
- **Settings scope (CFG-1):** `axis.cliAgents`, `axis.terminals.scrubEnvironment`, `axis.git.runHooks` and `axis.worktrees.root` are user, application or machine scope (never workspace or folder); a repository's `.vscode/settings.json` that defines a CLI agent or disables scrubbing has no effect and a warning is surfaced;
- **GIT-SNAP-1 extensions:** a CLI edit to a hook file under an effective in-worktree `core.hooksPath`, a rewrite of the worktree `.git` file or `commondir`, and a planted `url.*.insteadOf`, `remote.*.pushurl` or `credential.helper` are each flagged; Axis commit and push refuse on unacknowledged drift; daemon git calls use an explicit `--git-dir` and `--work-tree` from the journal;
- **GIT-ENV-1 and hooks:** a hook planted in `$GIT_COMMON_DIR/hooks` does not run during worktree create, status or remove; hooks for Axis commit and push run in the pty process context, not the daemon (for commit this means the host runs `pre-commit` and `commit-msg` in a scratch checkout of the reviewed tree under the daemon's commit lock, after the CLI-run refusal and drift re-take and before `commit-tree` plus the compare-and-swap; `post-commit` style hooks are not run in 1a; see the ADR 0004 §4 amendment of 2026-11-04). **OPEN:** the pty process has scratch and hook primitives and push runs there with hooks off; the host commit hook step and pre-push integration remain open (H9-hooks);
- **Snapshot refs:** ignored files are excluded, files over the size cap are skipped, an Axis push never sends `refs/axis/*`, retention follows the policy, and the snapshot dialog and the workspace Settings page contain the text that snapshots may hold untracked, non-ignored files (string assertion);
- **Pty process (PTY-6, PTY-7):** `VSCODE_NONCE` is absent in a CLI run; a spawned shell sees only stdio and its pty (child-fd test); a spawn sent on the data channel and a foreign terminal id are refused; an OSC 633 `Cwd=` from a CLI does not move where a split opens;
- **Review and push:** a commit with unacknowledged common-dir drift is refused; push uses an explicit refspec and never `--mirror`; a compare URL is built only for host `github.com` and a planted look-alike remote is refused; an `info/attributes` filter and a `core.sshCommand` change are each flagged; protected-path highlighting includes `.husky/`, `.githooks/`, `lefthook.yml` and `.pre-commit-config.yaml`;
- **DMN-2 and trust:** a symlink swap between check and use, macOS case and Unicode-normalisation variants, and a worktree path that is a symlink into the local checkout are refused; a CLI or agent run is refused in a worktree whose source repository is untrusted (Restricted Mode, read-only, "Trust to run"); trust is re-derived at mount and at run start; an external worktree and the worktree root are never trusted;
- **Audit and recovery:** deleting the last audit events is detected through the persisted tail anchor (an `@axis/audit` requirement); a request altered after approval is refused; killing the daemon between the steps of worktree create, remove, commit, push, discard and restore-from-run-base reconciles `git worktree list --porcelain` and `refs/axis/*` with the journal;
- **Drift (CLI only):** policies §3.8 scenarios 7 and 9 pass; the run-base diff, not the watcher alone, decides what changed (dropped watcher events do not hide a change);
- **Open VSX:** a tampered VSIX from public open-vsx.org is refused; the outcomes for a signed and an unsigned VSIX are recorded in `docs/feasibility/extension-compatibility.md` and the test fails if an outcome differs from the record (planned for the M3 Stage 1b validation; not run there, still open);
- **Bridge, UI and bundle:** ADR 0003 validation criteria 1 to 7 pass; the Axis React bundle runs under Trusted Types with no violation; the launch dialog and run row show that the CLI is governed by its own permissions and can push, and Agent-view copy contains no "sandbox" or "secure";
- **Commit and push versus a running CLI:** Axis commit and push are refused while a CLI run is active in that workspace; a hook swapped after the GIT-SNAP-1 re-take but before git executes does not run (the refusal is the test);
- **Trust enforcement:** a run-start call without main's trust attestation for the worktree's source repository is refused by the daemon, a renderer-supplied trust claim alone is refused, and a revoked trust refuses the next run start; main's run-trust answer does not rest on a store a renderer can write (the Workspace Trust model in application storage is renderer-writable, `docs/design/main-answers.md` section 3.3), which must hold before main registers projects (designed in `docs/design/project-registration-and-trust.md`: a rewritten Workspace Trust model alone never yields trusted, and commit, push and worktree create need the same main-confirmed record);
- **Git argument injection:** a workspace name, branch slug, base ref or remote beginning with `-`, containing `--upload-pack`, or using an `ext::` transport is refused, and every daemon git call passes user-controlled values after `--`;
- **Review and commit:** a commit is made from the exact tree hash the user reviewed, and a change to a file after review makes the commit refuse; an Axis push shows a warning that needs confirmation when the pushed diff contains a secret pattern; the file tree and preview do not follow a symlink that points outside the worktree; control and bidirectional characters in paths and hunks are escaped in diff review and in dashboard rows; an Open-in-IDE request for a path outside the worktree is refused;
- **External links (EL-5):** `openExternal` from Axis UI accepts only `http`, `https` and `mailto`, links from agent output show the full URL for confirmation first, and `file:` and custom schemes are refused;
- **No reh-web listener:** during a desktop run, a loopback port scan finds no Axis or reh-web listener, and the desktop artifact does not start a reh-web server;
- **View switch input routing (IDE-1):** after a view switch, typed keys reach only the destination view's last focused element, never a terminal of another workspace, and the switch is announced to screen readers.
- **Executable resolution (CLI-1, CFG-1):** a binary with the CLI's name planted in the worktree, and a relative or empty `PATH` entry that resolves to the worktree, are not run: Axis resolves bare command names itself, ignoring the cwd and empty or relative `PATH` entries, and refuses to launch when only such a candidate exists (automated test);
- **Attribute swap window (REV-2, G-27):** a `filter` attribute swapped in after the review's first attribute read and removed before the second does not reach the reviewed tree;
- **No debugging ports in a packaged build (G-28):** launching a packaged build with `--remote-debugging-port` or `--inspect*` leaves nothing listening on the requested port;

### Phase 1b — Composer and brokered agent
- **Composer and single agent:** Ask / Edit / Agent composer; agent activity stream; mock provider plus the **Anthropic (Claude) API** adapter; connection vault holding its API key; model selection within that connection; streaming; single-agent tool broker with approval policy and approval UI, reusing the Phase 1a challenge mechanism; drift notification to the composer agent; run journal; the Phase 1a audit log extended to agent approvals and tool calls.
- **Security controls:** WT-1, WT-2 (broker side), WT-3 approval, PTY-2, PTY-4, DMN-3, DMN-5, DMN-6, PRV-1, PRV-2, PRV-4, PRV-6; PRV-5 if custom endpoints ship (ADR 0004).

**Gate (1b):** on macOS, plus Windows/Linux CI smoke:
- acceptance scenarios 1 and 6 in `docs/PRODUCT.md` pass with the mock provider and the Anthropic API;
- **DMN-3:** a requested approval blocks the action until resolved by the user; an agent actor resolving it is denied;
- **WT-1:** a composer agent write through `..`, an absolute path, or a symlink planted in the repository that points outside the worktree is refused;
- **WT-2 (broker side):** a hook planted in `$GIT_COMMON_DIR/hooks` does not run during broker-run git; a composer run that changes `$GIT_COMMON_DIR/config` or `hooks/` fails closed and is reported;
- **WT-3 (approval):** a composer write to a protected path requires explicit approval and is highlighted in diff review;
- **PTY-4:** a broker command that exceeds its timeout or output cap is killed with its process group, and the run records why;
- **DMN-5 (agents):** every agent approval and tool side effect writes an audit event with approver identity and expiry; altering a stored event is detected by the hash-chain check;
- **PTY-2:** a broker-launched child process's environment contains only allow-listed variables (`PATH`, `HOME`, `LANG`, `TERM` and declared per-tool additions); variables set in the app, terminal or extension environment, including `VSCODE_*`, `GIT_ASKPASS`, `SSH_AUTH_SOCK` and `*_TOKEN`/`*_KEY`, are absent unless a scoped grant applies;
- **PRV-6:** a composer run that reaches its per-run token or cost budget is stopped by the daemon before the next provider request, and the run records why;
- **PRV-1:** with the Linux `basic_text` backend, storing the API key is refused or needs explicit consent, and the UI shows the storage backend;
- no credential appears in logs, renderer state, prompts or agent environments (redaction tests, PRV-2 and DMN-6);
- killing the app mid composer run and restarting recovers the run state from the journal, and the worktree is intact.
- **Snapshot secret scan (REF-1):** a planted secret pattern in an untracked, non-ignored file is detected before the snapshot is written and reported;
- **Drift (composer):** policies §3.8 scenarios 1 to 6 and 8 pass, with no silent overwrite;
- **Anthropic adapter (ANT-1):** a redirect response is not followed and the key is not sent to the target; an oversized stream event, deeply nested JSON and an error body that echoes the key are handled without leaking the key;
- **Hooks placement:** a decision on `axis.git.runHooks` and where hooks run, made with the vault shipped, is recorded in an ADR or a design section that the gate review references.

### Phase 1c — Agent home
Added by ADR 0006 (owner decision O-7). Needs 1a and 1b services plus server events (E1).
- **Projects:** the Space's project list; **Add project** as an explicit, user-confirmed registration (folder, repository root and remote shown first); a new project is untrusted until the user trusts it. Trusted means the Workspace Trust model **and** a main-owned run-trust record that renderers cannot write, set only from a native dialog main shows (owner decisions §5). One repository per project (O-2).
- **Agents and groups:** agents (named, typed composer or CLI, one home workspace each, O-3) and agent groups (one level, ordered, not a security boundary); user-only writes, audited (ADR 0006 decisions 4 to 6 and 10). No agent without a workspace (O-4).
- **Project home:** needs attention, agents, your pull requests on `axis/*` branches through the user's `gh` (read-only, no stored token, O-5; `docs/design/forge-pr-list.md` §1), usage and cost for composer runs (CLI agents "not available"), run status.
- **Agent view:** the labelled navigation rail (UI direction C); the All-agents surface; the side panel with Agents and Code tabs and an embedded editor for quick edits, sharing text models with IDE view (O-8; the IDE split half if the embed exceeds ADR 0002 criterion 2); server events in the UI.

**Gate (1c):** on macOS, plus Windows/Linux CI smoke:
- add a project through the confirmation; it starts untrusted, no run starts in it until the user trusts it, and trusting it is a user-only, audited action through main's native dialog that writes the main-owned run-trust record (a renderer message alone never trusts it); opening a folder in IDE view does not register it;
- create a composer agent and a CLI agent in two groups; each gets its own home workspace; both appear on the project home and the All-agents surface with live state;
- an agent, group or group-assignment write from any actor other than the user is refused, and every accepted write writes an audit event; no agent or group payload accepts a path, a command or a credential;
- archiving an agent removes no workspace; removing a home workspace names its agents in the tier-4 confirmation and archives them;
- edit a file in the side panel and see the "files changed outside the agent" indicator; a file of an untrusted project opens read-only there;
- the pull request section lists a stub `gh`'s output escaped, and refuses malformed or oversized output; without `gh` it says so;
- CLI agent usage shows "not available", never zero cost;
- keyboard-only walkthrough of the side panel and hand-off to IDE view in all three view modes;
- the shell-layer footprint is measured against ADR 0002 criterion 2.

## Phase 2a — Agent collaboration
Inter-agent messaging (composer agents and the user first, then CLI agents through the endpoint), tasks v1, pages v1 (Markdown), and the project home's Tasks and Pages sections (`docs/design/inter-agent-communication.md`, `docs/design/inter-agent-cli-endpoint.md`, `docs/design/extensibility.md`). **Gate:** the gate lines in `inter-agent-communication.md` §11, `inter-agent-cli-endpoint.md` §7 and `extensibility.md` §9 (2a items) pass; they are numbered, with ADR 0007's and ADR 0010's, as 2a/L1 to L55 in `docs/security/threat-model-phase2a-gates.md`.

## Phase 2b — Agent depth and IDE-view AI
Today's Phase 2, unchanged apart from its name. Inline edit and inline diff in the IDE editor, selection/file/symbol context attachments, model/account switcher across connections, capability display, conversation history, checkpoints and undo (moved from Phase 3, ADR 0004), prompt templates, cost/usage where supported. Browser workspace skeleton with remote workspace protocol (moved from Phase 1; documented gaps, not gating). **Gate:** inline edit → reversible diff → accept/reject in IDE view; restoring a checkpoint returns the worktree to the recorded state; unsupported capabilities are labeled unavailable.

## Phase 3 — Parallel orchestration
Planner DAG (built on the 2a tasks and messages), one workspace per worker, queue, reviewer, merge integration queue, retries, planner and per-goal budgets, task history, logs, OS sandbox for agent subprocesses (threat model §8.2), advanced DAG and worktree views. **Gate:** two workers independently implement tasks in separate workspaces, pass validation, and integrate without silent overwrites.

## Phase 4a — Extensibility
Axis plugins (declarative and sandboxed-UI plugins; plugins that run code only inside the Phase 3 OS sandbox, O-6), integrations with the daemon credential proxy, MCP, provider SDK, supported CLI sessions as provider connections (`PROVIDERS.md` type 3, beyond Phase 1 CLI agent runs) (`docs/design/extensibility.md`). **Gate:** plugin contract tests, and the 4a gate lines in `extensibility.md` §9.

## Phase 4b — Intelligence
Repository indexing, project memory, rules, skills, knowledge graph, ACL retrieval and additional providers. **Gate:** provenance-aware retrieval, data deletion and cross-project isolation.

## Phase 5 — Teams and sync
Organizations, RBAC, presence, CRDT collaboration, shared tasks/agents, encrypted opt-in sync, cloud runners, audit. **Gate:** concurrent editing and team agent runs pass permission, offline/conflict and recovery tests.

## Phase 6 — Hardening and public release
Cross-platform packaging, signed updates, performance, telemetry consent, extension matrix, security audit, migration reliability, docs/onboarding, pricing if commercial. **Gate:** defined SLOs and release-blocker checklist satisfied.

## Long-term
Provider-native artifact integrations where official APIs exist; universal docs/slides, remote workspace fleets, extension marketplace, enterprise SSO/policies, advanced code graph, automation and richer collaboration.

## Recommended first 10 tickets
Tickets 1–7 are Phase 0 and 1a; 8–10 are Phase 1b. This list is replaced after 1a ships; the tickets for 1c, 2a and 4a are in `docs/design/product-vision-v2-tickets.md`.

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
