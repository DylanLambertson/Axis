# ADR 0004: Agent-first workspace shell

- **Status:** Proposed. Becomes Accepted when the Phase 0 gate in `docs/ROADMAP.md` is met, including the agent-view skeleton (validation criteria below).
- **Date:** 2026-11-02. Open questions resolved by the owner on 2026-11-02 (see Resolved questions).
- **Decision owner:** Dylan Lambertson (product direction given 2026-11-02).
- **Depends on:** ADR 0002 (Code OSS integration strategy, Proposed) and ADR 0003 (Electron IPC bridge, Proposed). This ADR changes neither decision; it changes what the Axis shell layer shows first and when product services are needed.
- **Related:** `docs/PRODUCT.md`, `docs/UX.md`, `docs/ROADMAP.md`, `docs/AGENT_SYSTEM.md`, `docs/security/threat-model-phase0.md` (threat IDs such as PTY-2 and WT-2 refer to it), `docs/design/axis-shell.md` (Stage 1 restyle, done; Stage 2 superseded by this ADR), `docs/design/axis-agent-shell.md` (the agent-first shell design, added separately).
- **Evidence tags:** **[V]** verified in upstream source or an existing Axis document; **[I]** inferred, not verified.

## Context

### Owner direction

On 2026-11-02 the owner set a new centre of gravity for the product:

- Axis is not a copy of VS Code. The **AI agent manager is the main product**. The IDE is the optional, secondary part, but it stays fully capable.
- The home screen is a **workspace dashboard**. A workspace is an isolated Git worktree and branch for one task or agent. The dashboard shows each workspace's agents, status, terminals and changes. Selecting a workspace focuses it.
- A file tree is part of the agent surface. The IDE comes up through it: clicking a file or a diff opens the IDE view at that location.
- Users choose how Agent view and IDE view relate. All three are supported, as preferences:
  - (a) a per-workspace toggle with a shortcut, where file and diff clicks open IDE view at the location;
  - (b) a global, app-wide toggle;
  - (c) a side-by-side split with resizable or collapsible panes.
- The agent shell moves earlier in the roadmap. Phase 0/1 builds the Agent view, not an IDE-first slice.
- Agent view v1 contains: workspaces and worktrees; terminals with split panes (to run CLI agents and commands); a file tree, changed-files list and diff review with accept, reject and commit; and an agent composer with Ask, Edit and Agent modes. So the mock provider and one official provider adapter move earlier than the former Phase 2.

### Why the specifications were IDE-first

- The original blueprint described Axis as a workspace "combining Code OSS-class editing" with AI and agents. `PRODUCT.md` led with IDE jobs and the IDE feature inventory [V].
- `UX.md` "Default layout" was the upstream workbench topology: activity rail, explorer, editor tabs, an *optional* right-hand AI panel and a bottom terminal [V]. Its design acceptance asked that a power user manage agents "without leaving the editor" [V].
- `ROADMAP.md` sequenced risk in the order it was understood: the Code OSS spike (Phase 0), then an IDE vertical slice (Phase 1), then AI and a single agent (Phase 2), then parallel orchestration (Phase 3) [V].
- `docs/design/axis-shell.md` therefore mapped every element onto existing upstream parts and treated agent surfaces (timeline, review queue) as future Axis parts [V, §1 and §3.4].

The IDE-first order reflected the biggest technical unknown (can a custom shell carry the full IDE?), not a product decision that the editor is primary. That unknown remains, and ADR 0002 still gates it.

### Upstream precedent

Code OSS 1.144.0 ships `src/vs/sessions`, the "Agents Window": a second top-level shell above `vs/workbench`, with its own entry points, its own `IWorkbenchLayoutService` implementation, its own parts (`SessionsPart`, `ProjectBarPart`, `CustomViewGridPart`) and lint-enforced layering [V, `docs/feasibility/code-oss-inventory.md`, `integration-alternatives.md` §0]. ADR 0002 decision 2 already chose to model the Axis shell layer on it. Upstream's own direction is the same shape as the owner's: an agent-first surface built on the shared workbench services.

## Options

| | Option | Summary | Main problem |
|---|---|---|---|
| A | IDE-first with an AI side panel | Keep the current specs: the upstream workbench layout is the default surface, and agents live in the auxiliary bar and a status indicator | Contradicts the owner direction. A side panel cannot hold a multi-workspace dashboard, terminals per workspace and diff review as first-class surfaces |
| B | Agent-first workspace shell, IDE as a switchable view in the same app | The Axis shell layer (ADR 0002 decision 2, modelled on `vs/sessions`) boots into Agent view. IDE view is the reused upstream workbench parts in the same window. Switching is a layout change, not a new process | Larger Axis-owned shell: new Axis parts, a view-mode service and focus rules. The Phase 0 gate grows |
| C | A separate agent-manager app beside an IDE app | Two applications, or two window types, sharing a daemon | Two products to package, sign and update. Opening a file in the IDE crosses a process or window boundary. Provider, vault and approval state are shared across apps, which widens the ADR 0003 trust surface |

Option C is close to how upstream ships `vs/sessions` today: a separate window type in the same app [V]. Axis rejects it because the owner wants one surface where switching (and splitting) is immediate, with shared selection and focus.

## Decision (proposed)

Adopt **Option B**.

1. **Agent view is the default surface.** The app opens on the workspace dashboard. Selecting a workspace opens its workspace view.
2. **IDE view is the upstream workbench parts, reused**, inside the Axis shell (editor, explorer, search, SCM, debugger, problems, extensions, panel, status bar), as in `axis-shell.md` §1. It is fully capable; it is not a reduced editor.
3. **Both views live in one window and one Axis shell.** `AxisWorkbench` owns one grid and one `IWorkbenchLayoutService` implementation (ADR 0002 decision 2). Agent-view surfaces are Axis parts with string IDs, exposed through `IAxisWorkbenchLayoutService`, without extending `const enum Parts` (the pattern in `axis-shell.md` §3.4). Switching views changes part visibility and grid layout; it does not reload the window or the extension host.
4. **View modes are a user preference**, `axis.view.mode`, with three values:
   - `perWorkspace` (**default**): each workspace remembers whether it shows Agent or IDE view; a shortcut toggles the focused workspace; clicking a file or a diff in Agent view opens IDE view at that location.
   - `global`: one app-wide toggle; every workspace shows the same view.
   - `split`: Agent view and IDE view side by side, each pane resizable and collapsible; file and diff clicks open in the IDE pane without switching.
   Shortcuts, focus and accessibility rules are in `docs/UX.md`.
5. **One workspace is in focus at a time.** The focused workspace drives the file tree, changes, terminals, composer and the IDE view. How IDE view follows the focused workspace (folder swap, multi-root Code OSS workspace, or a window per workspace) is decided in `docs/design/axis-agent-shell.md`.
6. **Agents run only in workspaces.** No agent, composer or CLI, runs in the user's local checkout. Axis launches agents only with a worktree as working directory.
7. **Worktrees live outside the repository**, under the Axis application data directory by default, configurable, and never inside the repository:
   - macOS: `~/Library/Application Support/Axis/worktrees/<repo-id>/<workspace>`;
   - Linux: `$XDG_DATA_HOME/Axis/worktrees/<repo-id>/<workspace>` (default `~/.local/share/Axis/...`);
   - Windows: `%LOCALAPPDATA%\Axis\worktrees\<repo-id>\<workspace>`.
   A configured location inside any registered repository's working tree is rejected.
8. **CLI coding agents are first-class in v1.** Axis can launch the user's installed agent CLIs (for example, official provider CLIs) in a workspace terminal, through their documented command-line interfaces, under the user's own login and terms (`PROVIDERS.md` connection type 3).
   - Each launch is a **CLI agent run** of the workspace. The dashboard shows it with a status derived only from state Axis owns: the process (running, exited with code, killed), the terminal (output activity, waiting for input) and the worktree's changes. Axis never parses a CLI's private files, session stores or undocumented output formats.
   - Its changes go through the same Axis diff review as composer agents' changes.
   - Axis never reads private session stores, extracts tokens, or impersonates the CLI's client.
9. **Phase 1 integration ends at the branch.** Beyond commit, Phase 1 offers push of the workspace branch and "open a pull request" where a Git remote and a supported forge exist. Push uses the user's own Git configuration and credentials, and is a user action (an agent request to push is a default-deny tier, `SECURITY.md`). Opening a pull request uses the forge's documented interface (its web compare page, or its official CLI if the user has it installed and signed in); Phase 1 stores no forge credentials in Axis. The integration and merge queue stays in Phase 3.
10. **User edits during an agent run are allowed.** The run's changeset shows both the agent's and the user's changes. The workspace shows a "files changed outside the agent" indicator, and the agent is told of the drift before its next tool write. The detailed conflict policy is in `docs/design/axis-agent-shell.md`.
11. **Product services stay behind ADR 0003.** Worktree lifecycle, tool broker, policy, approvals, run journal and the provider gateway run in the Axis daemon. The Agent view reaches them only through the bridge.

### Concept mapping

| Product concept | Architecture |
|---|---|
| **Workspace** | One Git worktree + its branch + recorded base SHA + its agent runs + its terminals + its changes. The daemon's worktree manager owns the lifecycle and records it in the `worktrees`, `agent_runs` and `agent_tasks` tables (`IMPLEMENTATION.md`) |
| **Project** | The repository a workspace belongs to. The user's own checkout of it is listed on the dashboard as the *local checkout*; it is not an agent workspace, and no agent runs in it |
| **Space** | The personal or team container above projects (`CONTEXT.md`; formerly called a workspace there). Memory, retrieval and credential scopes are per Space and project |
| **Agent view** | The Axis shell layer: dashboard part, workspace view parts (file tree, changes and diff review, terminals and panes, composer, agent activity), Axis-owned, under `src/vs/axis` |
| **IDE view** | The reused upstream workbench parts and contributions, arranged by `AxisWorkbench` |
| **Terminals and panes** | The upstream terminal service and pty host, with instances bound to the workspace's worktree as working directory and shown inside the workspace view |
| **CLI agent run** | A user-installed agent CLI launched by Axis in a workspace terminal. Axis records the launch (command, worktree, start time) and tracks process and terminal state; the run appears on the dashboard |
| **File tree** | An Axis view over the focused worktree using upstream file services; a click opens the file in IDE view |
| **Changes and diff review** | Worktree changes against the workspace's base, shown in Axis views; the diff opens in the upstream diff editor in IDE view on request |
| **Composer (Ask / Edit / Agent)** | Axis view; requests go through the bridge to the provider gateway, and Agent-mode tool calls go through the daemon tool broker |
| **View mode** | An Axis service that holds the preference, the per-workspace state and the focus targets, and drives `AxisWorkbench` layout |

**Terminology (decided).** "Workspace" means only the agent workspace above. The personal or team container formerly called "Workspace" in `CONTEXT.md` is now a **Space** (Space → Projects → Repositories). The upstream concept (the folder set opened in a window, `ConnectionContext.workspaceUri` in ADR 0003 and the threat model) is called the "Code OSS workspace" where it needs naming.

### What stays the same

- **ADR 0002, unchanged.** Option A (pinned Code OSS checkout plus a patch series), the `src/vs/axis` shell layer modelled on `vs/sessions`, the no-edit rule for `layout.ts` and `workbench/browser/parts/*`, the four patch ranges, the sync cadence, the licensing guardrails, Copilot removal and security hardening.
  - **Criterion 1 still applies in full.** Editor, explorer, search, SCM/Git, terminal, debugger, diagnostics, command palette and extension host must work, now **in IDE view**.
  - **Criterion 2's budget is unchanged** (≤ 12 upstream files, ≤ 300 lines). Agent-view parts are overlay files. No additional upstream patch is expected [I]; the agent-shell design must measure this.
  - **Reuse of `vs/sessions` is open.** Whether the Agent view reuses/adapts upstream `vs/sessions` code or re-implements its architecture is decided in `docs/design/axis-agent-shell.md`. Either way, upstream's Copilot-specific Agents Window behaviour is not shipped as is. That design also states how this interacts with `axis-shell.md` decision D8 (removal of the sessions entry points in range `1500–1999`). Code adapted from sessions records its source path and commit (`axis-shell.md` R8).
- **ADR 0003, unchanged.** Option 3 (main-brokered MessagePort to a daemon utility process), the handshake and window-identity checks, contracts and runtime validation, the single policy pipeline, challenge-based approvals with native confirmation for tiers 4–5, audit and redaction. Two timing consequences follow from the roadmap, not from the design:
  - its "Phase 1 bridge spike" is now on the Phase 1 critical path, before any agent can run;
  - "Until Phase 2 ships privileged services" (Rollback) now reads Phase 1, because the vault, broker and approvals ship in Phase 1.
- **ADR 0001**: separate versioned services, local-first execution and worktree-per-agent isolation.
- **Product rules**: official provider paths only (`PROVIDERS.md`), default-deny policy (`SECURITY.md`), and the existing non-goals.

## Security implications

Cross-references are to `docs/security/threat-model-phase0.md`. Moving the agent earlier moves exposure earlier; it does not change any control's design.

1. **Workspaces are not sandboxes.** A worktree prevents edit collisions only (`SECURITY.md`; threat model §5.5).
   - Phase 1 agents run with the user's privileges, limited by the broker's policy, not by the OS (R1). The OS sandbox stays a Phase 3 decision (threat model §8.2).
   - UI copy must say "isolated branch" or "separate worktree", never "sandbox" or "secure".
   - Worktrees share `$GIT_COMMON_DIR` (config, hooks, refs). WT-2's controls (empty `core.hooksPath`, `core.fsmonitor=false`, scrubbed `GIT_*` environment, config and hooks snapshot) are owned by Phase 3 in the threat model. Because Phase 1 agents run git in worktrees, they move to Phase 1.
   - WT-1 (path canonicalisation, no writes outside the worktree root) and WT-3 (protected paths need explicit approval and are highlighted in diff review) move from Phase 2 to Phase 1.
   - WT-4 (one worktree and branch per worker, base SHA recorded) moves from Phase 3 to Phase 1, because the worktree lifecycle manager moves to Phase 1.
2. **Daemon scope.** ADR 0003 scopes calls by the window's Code OSS workspace (DMN-2). An agent workspace is a worktree that usually sits outside the opened folder. The daemon must scope calls to the project plus the worktrees its own worktree manager registered, by canonical path and recorded ID, never by a path prefix taken from a payload. This is a rule inside ADR 0003's existing policy step, not a change to the bridge.
3. **Terminals and CLI agent runs.**
   - A terminal in a workspace, and any CLI agent Axis launches in it, runs with the **user's privileges** in the worktree, in the upstream pty host (PTY-1, accepted while renderer equals user). It is **not brokered**: Axis's policy, approvals, budgets and tool audit do not apply to what the CLI does.
   - **The CLI's own permission model is the CLI's responsibility.** Axis surfaces it (the CLI's prompts appear in its terminal, and the dashboard shows the run as waiting for input) but does not override, auto-answer or bypass it. Axis must not claim approvals or budgets for CLI runs, and labels them as governed by the CLI's own permissions.
   - **Environment scrubbing (PTY-2), required in Phase 1.** Terminals that run CLI agents get no Axis secrets and no askpass or IPC handles: `VSCODE_GIT_ASKPASS*`, `GIT_ASKPASS`, `VSCODE_GIT_IPC_HANDLE` and `VSCODE_IPC_HOOK_CLI` are removed, and no provider credential from the Axis vault is injected. The CLI uses its own login and the user's own Git configuration.
   - Axis tracks CLI runs only through state it owns (process, terminal, worktree changes). It never reads private session stores, extracts tokens or impersonates the CLI's client (`PROVIDERS.md`).
   - CLI agents' file changes land in the worktree, so they appear in the changes list and go through the same diff review, including the WT-2 and WT-3 flags, before commit.
   - Composer agents (Agent mode) never run commands through the user-visible pty host. They run through the broker with an allow-listed environment, timeouts and output caps (PTY-1, PTY-2, PTY-4). Their output appears in Axis activity views as escaped text, or in a read-only, non-integrated terminal (PTY-3).
4. **Approvals move to Phase 1.** ADR 0003 D4 applies unchanged: daemon-issued challenges, resolved only by a `user` actor; native confirmation for tiers 4–5; grants bound to a run, with identity and expiry (DMN-3, DMN-5, R5). The dashboard shows "waiting for approval" per workspace; it never resolves an approval from the dashboard without showing the full request.
5. **Credentials move to Phase 1.** The connection vault and the Anthropic API adapter ship in Phase 1, so PRV-1 (refuse or require consent on `basic_text`), PRV-2 (no credential in renderer, extensions, prompts or env), PRV-4 (no silent cross-provider routing), PRV-5 (custom base URL rules, if custom endpoints are enabled) and PRV-6 (budgets) are Phase 1 controls, along with DMN-6 redaction and DMN-7 journal recovery.
6. **Diff review is a security control.** Accept, reject and commit are user actions. Changes to protected paths (WT-3) and to `$GIT_COMMON_DIR` configuration (WT-2) are flagged before commit. Commits use the user's configured Git identity, never an agent identity.
7. **Threat model update.** The threat model's owner-phase tags were written for the old order. Its next revision (it is due "whenever ADR 0002 or ADR 0003 changes" and at the Phase 1 gate) should re-tag the controls above as Phase 1 and add CLI agent runs (user privileges, environment scrubbing, CLI-owned permissions) to §5.3.

## Consequences

- **Positive:**
  - The product's primary surface matches the owner's intent from the first build.
  - Agent services get exercised by real users in Phase 1, which surfaces broker, policy and provider problems a phase earlier.
  - Upstream's own `vs/sessions` direction lowers the risk that the agent shell fights the workbench architecture.
  - IDE capability is preserved by reuse, not reimplemented.
- **Negative:**
  - More Axis-owned shell code: Axis parts, a view-mode service, focus routing between views and per-workspace layout state. `axis-shell.md` estimated 3–4.5k Axis LOC for an IDE-only shell [I]; this grows.
  - Phase 1 is larger: it now carries the worktree manager, broker, vault, one provider and approvals, previously spread over Phases 2–3.
  - Security exposure starts earlier (above), so several controls move forward.
  - Following the focused workspace in IDE view may restart the extension host, or need a multi-root Code OSS workspace (decided in the shell design).
- **Product:**
  - A user who wants only an IDE can switch to IDE view and stay there (`global` mode). Axis does not hide or reduce the IDE.
  - Parallel planner orchestration (DAG, integration queue) is still Phase 3. Phase 1 already allows several workspaces, each with one composer agent run at a time plus any CLI agent runs.

## Phase 0 gate impact

The Phase 0 gate in `ROADMAP.md` now requires, in addition to ADR 0002's criteria:

1. The Axis shell boots into an **agent-view skeleton**: a dashboard listing workspaces (mock or read-only data is acceptable), and a workspace view with a file tree and a terminal bound to a folder.
2. **IDE view on the same custom shell** passes ADR 0002 criterion 1.
3. Switching works in `perWorkspace` and `split` modes. A file click in the skeleton's file tree opens IDE view at that file. Returning to Agent view keeps the workspace state and editor state.
4. The shell-layer footprint, including the skeleton, is measured against criterion 2.

The Phase 0 skeleton does not need the daemon, a provider or real worktree creation; those are Phase 1.

## Validation criteria

**Accept** this ADR when:

1. The Phase 0 gate items 1–4 above pass on macOS and Linux.
2. ADR 0002 criteria 1 and 2 pass with the skeleton in place.
3. Keyboard-only switching passes the focus rules in `UX.md`, with screen-reader announcements verified on at least one platform.

**Revisit** (towards Option A or C) if:

- the agent-view skeleton needs upstream patches beyond criterion 2's budget;
- a single window cannot host both views without reloading the window or losing editor state on every switch;
- the owner changes the product direction.

## Rollback

- **Before Phase 1 ships**, rollback means changing the default view to IDE and moving the Agent-view surfaces into the auxiliary bar (Option A). The Axis parts are overlay files; no upstream patch is affected [I]. The documents revert through the commits that introduced this ADR.
- **After Phase 1**, the product services (worktree manager, broker, vault, provider gateway, journal) are behind ADR 0003 contracts and do not depend on the view layout. A layout rollback leaves them in place.
- Moving to Option C would reuse the same daemon and contracts, with a second window type, at the cost of the ADR 0003 window-identity rules for that window type.

## Resolved questions

Decided on 2026-11-02. Owner decisions are final for this ADR; engineering defaults are decided and revisable.

| # | Question | Decision | Kind |
|---|---|---|---|
| 1 | First provider | **Anthropic (Claude) API**, with an API key stored in the connection vault | Owner |
| 2 | CLI agents in v1 | **First-class** (decision 8, security implication 3) | Owner |
| 3 | Default view mode | `perWorkspace` | Engineering default |
| 4 | How IDE view follows the focused workspace | Decided in `docs/design/axis-agent-shell.md` | Engineering default |
| 5 | Agents in the local checkout | Never; worktrees only (decision 6) | Engineering default |
| 6 | Naming | "Workspace" means only the agent workspace; the `CONTEXT.md` container is a **Space** (personal or team) | Engineering default |
| 7 | Worktree location | Outside the repository, under the app data directory, configurable (decision 7) | Engineering default |
| 8 | Merging back | Commit, push branch and open a PR in Phase 1; integration and merge queue in Phase 3 (decision 9) | Engineering default |
| 9 | User edits during an agent run | Allowed, with drift indicator and agent notification (decision 10); conflict policy in the shell design | Engineering default |

## Open questions

1. Whether the Agent view reuses or adapts upstream `vs/sessions` code, or re-implements its architecture (decided in `docs/design/axis-agent-shell.md`).
