# Axis agent-first shell: technical design for M3 Stage 2

- **Status:** Draft; design decisions D-1 to D-13 recorded 2026-11-02 (§9.2); D-11 is now ADR 0004 decision 14. Aligned with ADR 0004 as merged on `main` (`a0cb0a3`, amended in this branch for D-13 and the Phase 1a audit log), including its resolved questions. The items ADR 0004 defers to this design, and the terminal, git, snapshot, shortcut and wording policies, are in the companion `axis-agent-shell-policies.md` (the "policies"). It replaces the IDE-first Stage 2 of `docs/design/axis-shell.md` §3 and §6 (S2.x). Stage 1 (§2 and §2.9 there) is done and still applies. Product direction comes from ADR 0004 (`docs/adr/0004-agent-first-workspace-shell.md`), which this document implements and does not restate.
- **Date:** 2026-11-02
- **Upstream baseline:** Code OSS `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.
- **Inputs:** ADR 0002 (decisions 1–7, criteria 1–7), ADR 0003 (D1–D7), ADR 0004 (decisions 1–14, as merged), `docs/design/axis-shell.md`, `docs/security/threat-model-phase0.md`, `docs/AGENT_SYSTEM.md`, `docs/feasibility/code-oss-inventory.md` §3–4, and the upstream `src/vs/sessions` specifications (`README.md`, `LAYOUT.md`, `LAYERS.md`, `LAYOUT_CONTROLLER.md`, `DESKTOP.md`, `SESSIONS.md`).
- **Conventions:** as in `axis-shell.md`.
  - Upstream paths are relative to the Code OSS root at the baseline commit, or to `src/vs/` when they start with `sessions/`, `workbench/`, `platform/` or `base/`. `file:line` refers to that commit.
  - **[V]** means verified by reading the source. **[I]** means inferred. No upstream code was run.
  - "Code OSS workspace" means the upstream folder set open in a window. "Workspace" alone means the Axis agent workspace (ADR 0004 terminology).

## 0. Summary

1. **Build approach: (i), an Axis layer modelled on `vs/sessions`**, with a few small pieces of sessions code adapted and tracked (§2). Reusing `vs/sessions` directly (ii) is not viable: its domain model is built on chat and agent-host types, and it ships as a second window type. Building inside the stock workbench (iii) is the fallback if `AxisWorkbench` slips. The Agent-view views are written so they work in either host.
2. **One window per project.** The window opens an Axis-managed, per-project Code OSS workspace file. Its folder list follows the focused workspace's worktree, which is the mechanism sessions uses. Changing folders in a workspace that is already in the `WORKSPACE` state does not restart the extension host (§3.2). This answers ADR 0004 resolved question 4.
3. **All three view modes are one grid with a layout swap** in `AxisWorkbench`, the Axis implementation of `IWorkbenchLayoutService`. Upstream parts are reused as singletons. There is one new Axis part, the agent part. The two-window model is rejected (§3).
4. **Upstream footprint:** the agent shell adds **no upstream file** to the shell block beyond the planned bootstrap and bridge seams. Its estimate is 10 files and about 50 changed lines against the 12-file, 300-line budget. No ADR 0002 amendment is needed (§7).
5. **Worktrees.** Phase 0 lists them read-only from the git metadata on disk. Creation and cleanup come in Phase 1, through the Git CLI in the Axis daemon (ADR 0003), with the safety rules in §5.
6. **CLI agent runs are first-class** (ADR 0004 decision 8). Axis launches the user's installed agent CLIs in a pty spawned by the Axis pty process (not the daemon), with the PTY-5 environment, attached to an upstream terminal. Their status comes only from process and terminal state (§4.5).
7. **Concurrent writers** (user, one composer run, any number of CLI runs) are allowed. The composer writes by compare-and-swap and is told about drift; CLI runs are only observed (policies §3). The daemon orchestrates Axis commit and push under its lock and drift gate, and git runs in the Axis pty process; the SCM view is a user path outside those guarantees (policies §6).
8. **The composer** is an Axis view. It calls `axis.runs/1` on the daemon. Its mock provider lives in the daemon. The renderer has no provider code and shows an honest "agent service unavailable" state when the daemon is absent (§6).
9. **First slice (Phase 0 gate):** the dashboard lists worktrees; the workspace view shows the file tree, terminal and changes; a toggle and the split mode open IDE view at a file (§8, tasks A1–A8).

## 1. Concept model

### 1.1 Entities and where they live

| Entity | Definition | Owner (source of truth) | Renderer projection |
|---|---|---|---|
| **Project** | One Git repository: the common git dir plus the user's own checkout (the *local checkout*) | Daemon `projects` table (Phase 1). In Phase 0, the window's per-project workspace file (§3.2) | `IAxisProjectService` |
| **Workspace** | One worktree, its branch, its recorded base SHA, its runs, its terminals and its changes | Daemon worktree manager: the `agent_workspaces` record, with its on-disk worktree in `worktrees` (`IMPLEMENTATION.md` entities). In Phase 0, read-only discovery (§5.2) | `IAxisWorkspaceService`: list, focused workspace, state observables |
| **Worktree** | The Git linked worktree on disk | Git (`$GIT_COMMON_DIR/worktrees/<name>`), reconciled by the daemon into `worktrees` | Path, HEAD, lock state |
| **Branch** | `axis/<slug>` created with the worktree; base ref and base SHA recorded at creation | Git refs plus the daemon journal | Ahead/behind against the base |
| **Agent session (run)** | A **composer run** (one Ask, Edit or Agent request, at most one active per workspace) or a **CLI agent run** (a user-installed CLI launched by Axis in a workspace pty), bound to one workspace | Daemon `agent_runs` (kind `composer` or `cli`) and `agent_tasks` tables (ADR 0003 `axis.runs/1`) | `IAxisRunsService` streams |
| **Terminal** | A pty bound to a workspace: either a user terminal (upstream pty host) or, from Phase 1a, an Axis pty-process pty | Upstream `ITerminalService`. Axis keeps the instance-to-workspace map | `AxisWorkspaceTerminals` (§4.4) |
| **Changeset** | The worktree's changes against its base: committed since the base, staged, unstaged, untracked | Git. Read through the workbench `IGitService` (git extension delegate) for the mounted workspace and through the daemon for the others. All Axis git writes go through the daemon (policies §6) | The Changes view, the multi-diff editor |
| **View state** | Agent or IDE view per workspace, the global view, split geometry, focus targets | Renderer storage (§3.6) | `IAxisViewService` |

The **local checkout** is listed on the dashboard but is never an agent workspace (`AGENT_SYSTEM.md`: no shared writable repository directory; ADR 0004 decision 6: no agent, composer or CLI, runs in it). The daemon refuses any launch whose canonical working directory is the local checkout or inside it.

### 1.2 Axis-owned versus reused

| Layer | Axis-owned (overlay, `src/vs/axis/**`) | Reused from upstream, unchanged |
|---|---|---|
| Shell | `AxisWorkbench` (grid, view modes, `IAxisWorkbenchLayoutService`), the agent part | Title bar, editor part, side bar, panel, auxiliary bar, status bar, banner, notifications (`axis-shell.md` §1) |
| Renderer services | `IAxisProjectService`, `IAxisWorkspaceService`, `IAxisViewService`, `IAxisRunsService` (bridge client), `AxisWorkspaceTerminals` | `IEditorService`, `IEditorGroupsService` working sets, `ITerminalService`/`ITerminalGroupService`, `IGitService`, `IWorkspaceEditingService`, `IWorkspaceTrustManagementService`, `IViewsService`, `IStorageService` |
| Views | Workspaces list and dashboard (inside the agent part), Files (an `ExplorerView` subclass), Changes, Composer, Activity | Explorer, Search, SCM, Debug and the terminal views in IDE view; the multi-diff and diff editors |
| Daemon (ADR 0003, Phase 1) | Worktree lifecycle manager, Git CLI runner, tool broker, policy, approvals, run journal, provider gateway with the mock provider. It never forks shells | The upstream `utilityProcess` host and MessagePort framing (ADR 0003 D1) |
| Axis pty process (Phase 1a) | A separate utility process that hosts upstream `PtyService` and spawns every workspace pty (§4.4). It holds no vault secrets | Upstream `PtyService`, `TerminalProcess` and `node-pty`, in a `utilityProcess` (ADR 0003 D1 framing) |

## 2. How much of `vs/sessions` Axis can use

### 2.1 What upstream ships

- **Size.** `src/vs/sessions` has 623 non-test `.ts` files and about 199,000 lines [V, `find`/`wc`].
- **Coupling.** 220 of those files import `workbench/contrib/chat/`, 142 import `platform/agentHost/`, and 288 import one or the other [V, `grep -lE 'workbench/contrib/chat/|platform/agentHost/'`].
- **The domain model is chat-shaped.** `services/sessions/common/session.ts:17-19` imports chat session file-change types, chat customizations and chat pills [V]. `SESSIONS.md` defines a session as a group of chats (`IChat`) adapted by providers (Copilot Chat, Agent Host, Remote Agent Host) [V, `SESSIONS.md:13-28,108-118`].
- **The shell.** `browser/workbench.ts` is 3,205 lines: `abstract class Workbench ... implements IAgentWorkbenchLayoutService` (`:277`), with desktop and mobile grid descriptors (`:1734`) and per-part "effective" versus desired visibility (`_effectiveVisible`, `:903-904`) [V]. Its topology is a sidebar, a main region of Sessions part, editor, auxiliary bar and custom view grid, and a panel. There is no activity bar, status bar or banner (`LAYOUT.md:35-44`) [V].
- **Coexistence with the main workbench is a second window type.**
  - It opens a synthetic Code OSS workspace (`windowsMainService.ts:296-335`). A window is a sessions window when its workspace is that file (`:1599`). It loads `sessions.html` instead of `workbench.html` (`windowImpl.ts:1314-1315`). It gets its own profile (`windowsMainService.ts:1726-1727`) [V].
  - Extensions run in it only if allow-listed or declared (`workbench/services/extensions/common/extensionManifestPropertiesService.ts:187-200,237`) [V].
  - View containers are filtered per window type (`WindowEnablement`, `views.ts:64-77`; `viewDescriptorService.ts:331-342`) [V].
  - `isSessionsWindow` appears in 112 non-test files under `workbench`, `platform` and `code` [V, grep].
- **Switching to the editor is a protocol URL.** "Open in VS Code" builds a `vscode://file/<folder>?windowId=_blank` URL and opens it externally. That opens another window at folder granularity, with no file or line (web: `sessions/browser/actions/vscodeActions.ts:59-105`; desktop: `nativeHostService.openWindow(folders, { forceNewWindow: true })`, `sessions/electron-browser/actions/vscodeActions.ts:92`) [V].
- **It follows the active session's folder** by rewriting the window's workspace folders (`contrib/workspace/browser/workspaceFolderManagement.ts:42-90`). It mounts only trusted folders (`:57-67`) and inherits trust only for worktrees under `<repo>.worktrees` (`services/sessions/browser/worktreeTrust.ts:30-55`) [V].
- **D8 already removes its entry points** in block `1500–1999` (`axis-shell.md` D8). ADR 0004 keeps D8.

### 2.2 Component assessment

| Sessions component | Verdict | Reason |
|---|---|---|
| `sessions.*.main.ts`, `electron-browser/sessions.main.ts` (a 420-line copy of `DesktopMain`) | **Replace** | Axis boots through the P2 `createWorkbench` hook (`axis-shell.md` §3.2), not a bootstrap copy |
| `browser/workbench.ts` (grid, restore phases, notifications, persistence) | **Adapt patterns, not code** | It references `ISessionsService` and chat layout presentation (`:78-80,72`), plus mobile. The patterns Axis takes: a fixed grid owned by the shell, desired versus effective visibility (`LAYOUT.md:133`), one high-priority flex surface (`LAYOUT.md:62`), and reparenting grid views without resizing them (`LAYOUT.md:72`) [V] |
| `SessionsPart`, chat group views, session header (`browser/parts/*`) | **Replace** | They render chat sessions. The Axis agent part renders the dashboard and the workspace view |
| `ProjectBarPart` (`projectBarPart.ts:85,124`, string part id) | **Pattern only** | Confirms that an Axis-only part with a string id needs no `Parts` enum change [V] |
| `CustomViewGridPart` with `ICustomViewService` | **Pattern only** | Mutually exclusive full-surface views with remembered visibility. This is the shape of the Agent/IDE swap |
| `services/sessions/**` (about 13,900 lines) and the providers | **Replace** | Chat-centred contracts. Axis has no chat transcripts in the renderer; runs live in the daemon |
| `contrib/workspace/workspaceFolderManagement.ts` (about 120 lines) | **Adapt** (copy and rewrite) | The folder-follows-focus mechanism with a trust backstop. Its input becomes `IAxisWorkspaceService.focused` |
| `contrib/files/**` (`ExplorerView` subclass in an auxiliary-bar container, `files.contribution.ts:46-75`, `filesView.ts:29-55`) | **Adapt** | It has no chat imports, but imports `AGENT_HOST_SCHEME` from `platform/agentHost` (`files.contribution.ts:14`), which the adaptation drops. Its containers use `WindowEnablement.Sessions` and would be hidden in a normal window, so they must be re-registered with the default enablement |
| `contrib/terminal/sessionsTerminalContribution.ts` (1,003 lines) | **Adapt the pattern** | Per-session terminals by `moveToBackground` and `showBackgroundTerminal` (`:689-760`: `showBackgroundTerminal` `:749`, `moveToBackground` `:756`; restored terminals `:241-252`) and default cwd sync (`:172-184`) [V]. Its agent-host backend is not used |
| `contrib/layout/**` controllers (14 files, chat-free) | **Adapt rules** | Per-owner editor working sets (`baseSessionLayoutController.ts:701`, `LAYOUT_CONTROLLER.md:33-35`) [V]. The owner key becomes the Axis workspace id |
| `contrib/changes/**` (28 files; `changesView.ts` alone is 2,487 lines) | **Replace** | Driven by provider changesets and pull-request flows. Axis changes come from Git |
| "Open in VS Code" | **Replace** | Axis switches in place (§3) |

### 2.3 Recommendation

**(i): an Axis layer modelled on `vs/sessions`**, as ADR 0002 decision 2 assumed and ADR 0004 decision 3 proposes.

- **Against the footprint budget.** (i) and (iii) both add no upstream file (§7). (ii) would need the sessions entry points kept (undoing D8's build removals), the chat and agent-host graph type-checked, and the sessions window type, which has 112 coupled files, all against block `1500–1999`'s removal work. Under Stage 1's option (a1), most of `platform/agentHost/**` is excluded from type-checking (`axis-shell.md` §2.9).
- **Against sync cost.** Copying sessions code means carrying it through weekly syncs. Its specifications expose experimental, reload-only modes (`LAYOUT.md:18-33`) [V], which is a sign of active churn [I]. (i) copies only about 400–600 lines (the folder manager, the Files view and the terminal pattern), each recorded with its source path and commit (`axis-shell.md` R8).
- **Against (iii).** The stock grid is closed. Contributions get only the side bar, panel and auxiliary bar (`views.ts:39-43`) [V], or an editor tab. The agent surface would be a closable editor tab that competes with editor groups, and split mode would be an editor-group split rather than two views. (iii) stays the fallback: if S2-level `AxisWorkbench` work slips, the same Files, Changes and Composer views run in the stock workbench, and the agent surface becomes an `EditorPane` hosting the same widget.

## 3. View-switching modes

### 3.1 Mechanism: one window, one grid, layout swap

`AxisWorkbench` owns the grid (`axis-shell.md` §3.3; `SerializableGrid`, as `sessions/browser/workbench.ts` does). It extends that design in four ways:

- it adds an **agent part** (`axis.parts.agent`), a `Part` with a string id (`part.ts:53-62`) [V];
- it fixes the panel to span the full width (sessions' justified alignment, `LAYOUT.md:72`);
- it keeps the auxiliary bar on the **right** in every mode, matching `UX.md`'s IDE view (agent panel on the right);
- it keeps a **desired-visibility record per view**, with effective visibility derived from the mode, as sessions does for custom views (`LAYOUT.md:133`).

```text
root (vertical): titlebar | banner | middle | statusbar
middle (vertical): row | panel                      (panel spans the full width)
row (horizontal): agent | activitybar | sidebar | editor | auxiliarybar
```

With `workbench.sideBar.location: right`, the IDE nodes are reparented as `agent | auxiliarybar | editor | sidebar | activitybar`, matching upstream's rule that the auxiliary bar sits opposite the side bar. The views are moved without resizing them, as sessions does for panel alignment (`LAYOUT.md:72`). The agent part stays leftmost.

| Part | Agent view | IDE view | Split |
|---|---|---|---|
| `axis.parts.agent` (dashboard or workspace view, composer) | shown, **flex** | hidden | shown; proportion persisted |
| Auxiliary bar | shown with the Axis Workspace container (Files, Changes) | user's choice; the Axis Agent container (Composer, Activity) is available | shown with Files and Changes, at the right edge |
| Activity bar, side bar | hidden | shown (Explorer, Search, SCM, Debug, Extensions) | shown, collapsible |
| Editor | hidden; **editors stay open** | shown, **flex** | shown, **flex** |
| Panel (terminals) | the workspace's terminal visibility | the user's panel visibility | shared |

- Only one part is high-priority at a time: agent in Agent view, editor otherwise (sessions rule, `LAYOUT.md:62`) [V].
- **Switching never recreates a part and never reloads the window or the extension host.** It is `setPartHidden` and a grid resize, plus `openPaneComposite` for the auxiliary bar's remembered container [I; S2-style unit tests below].
- **Rejected: two windows** (the `isSessionsWindow` model). It needs main-process patches (`windowImpl.ts:1314`, `windowsMainService.ts:1599`), a second HTML entry, a second extension host and profile, and cross-window routing for "open at file:line". That is ADR 0004 option C. An optional "Open workspace in new IDE window" uses upstream `IHostService.openWindow` (`services/host/browser/host.ts:106`) with `gotoLineMode` (`platform/window/common/window.ts:70`) and needs no patch [V].

### 3.2 The window's Code OSS workspace follows the focused workspace

- **Per-project workspace file.** Each project gets `<user data>/axis/projects/<projectId>.code-workspace`, written by Axis and opened with `IHostService.openWindow`.
- **Folder swap.** The window starts in `WorkbenchState.WORKSPACE`, so folder changes go to `contextService.addFolders`/`updateFolders` and never to `createAndEnterWorkspace` (`abstractWorkspaceEditingService.ts:205-226`). Only `enterWorkspace` stops and restarts extension hosts (`electron-browser/workspaceEditingService.ts:178-213`) [V]. Extensions receive `onDidChangeWorkspaceFolders`. No ext-host restart path on a first-folder change was found in `services/extensions` [I].
- **Folder set.** It is exactly the focused workspace's worktree, or the local checkout when that entry is focused. The adapted folder manager (§2.2) mounts it, with a trust backstop.
- **Why not sessions' in-memory workspace?** `SessionsWorkspaceContextService` is injected by the copied bootstrap (`sessions.main.ts:310`) [V]. Axis would need a second hook in `DesktopMain` (P2b, about 10 lines in the same file; §7). Held in reserve.
- **Costs** (risks R1–R3, §9): language servers and the git extension re-index on each switch; extension `workspaceState` is shared by all workspaces of a project; a dirty editor of the outgoing workspace stays open.

### 3.3 State model

| Preference `axis.view.mode` (ADR 0004) | State consulted on switch and on focusing a workspace |
|---|---|
| `perWorkspace` (proposed default) | `workspaceState[wsId].view`: `agent` or `ide`. Focusing another workspace applies that workspace's view |
| `global` | `globalView` (application storage). Focusing another workspace keeps it |
| `split` | `split.ratio` and `split.collapsed`: `none`, `agent` or `ide`. The toggle moves focus between halves |

`IAxisViewService` exposes `mode`, `currentView(wsId)`, `toggle()`, `show(view)` and `reveal(target)`. It sets the context keys `axis.view` (`agent`/`ide`/`split`) and `axis.focusedWorkspace` for `when` clauses. `AxisWorkbench` subscribes to it and applies the visibility table.

### 3.4 "Open in IDE at file:line" routing

```text
Files / Changes / Activity click
  → IAxisViewService.reveal({ wsId, kind: file | diff | multiDiff, resource, selection?, source })
     1. if wsId ≠ focused: IAxisWorkspaceService.focus(wsId)       (§3.2 mount, §4.4 terminals, working set)
     2. perWorkspace → workspaceState[wsId].view = ide
        global       → globalView = ide
        split        → expand the IDE half if it is collapsed (view state unchanged)
     3. IEditorService.openEditor({ resource, options: { selection, revealIfOpened: true, pinned: true } })
        diff: IResourceDiffEditorInput; changes list: IResourceMultiDiffEditorInput with goToFileResource
     4. remember the agent-side element as the return-focus target
```

- `openEditor` overloads are at `services/editor/common/editorService.ts:290-293`; `selection` and `revealIfOpened` are at `platform/editor/common/editor.ts:543,242`; the multi-diff input is at `workbench/common/editor.ts:555-575` [V]. Sessions likewise requires every open to go through `IEditorService` (`LAYOUT.md:123`) [V].
- **Editors opened from elsewhere while the editor part is hidden** (an extension, Quick Open, a link) follow decision D-5: explicit user opens switch to IDE view, and background opens badge the view control.

### 3.5 Focus and keyboard

- Commands, all in the palette:
  - `axis.view.toggle`, `axis.view.showAgent`, `axis.view.showIde`;
  - `axis.dashboard.show`, `axis.workspace.focus.1`…`.9`, `axis.workspace.next`/`previous`;
  - `axis.split.collapseAgent`/`collapseIde`.
- **Shortcut conflicts.** The provisional `UX.md` defaults collide with upstream at the pin:
  - `Mod+Alt+V` is editor dictation (`codeEditor/browser/dictation/editorDictation.ts:69`, active when a speech provider exists);
  - on macOS, `Mod+Alt+0` is Toggle Editor Group Layout (`files/browser/views/openEditorsView.ts:938`) [V].

  The verified conflict-free set (D-7) is in policies §8, adopted by `UX.md`.
- **F6 and Shift+F6** cycle the visible parts in grid order, through `getVisibleNeighborPart`, which `AxisWorkbench` implements (`axis-shell.md` §3.3 and §5). In split mode both halves are in the cycle.
- **Focus rules** (`UX.md` focus rules 1–2): a toggle restores the destination's last focused element per workspace, falling back to the composer, the active editor or the first dashboard row. Every switch announces "Agent view, <workspace>" or "IDE view, <file>" through `status()` (`base/browser/ui/aria/aria.ts:65`) [V].

### 3.6 Persistence

| State | Storage |
|---|---|
| `axis.view.mode` | User setting (application scope) |
| `globalView` | `StorageScope.APPLICATION`, `StorageTarget.MACHINE` |
| `workspaceState` map: view, auxiliary-bar container, panel visibility, return-focus id | `StorageScope.WORKSPACE` (the per-project Code OSS workspace), keyed by workspace id |
| Grid sizes, split ratio | `StorageScope.WORKSPACE`, as `axis-shell.md` §3.3 |
| Focused workspace | `StorageScope.WORKSPACE` |
| Editors per workspace | Upstream working sets `saveWorkingSet`/`applyWorkingSet` (`editorGroupsService.ts:709-726`) [V], named `axis.ws.<id>`, applied on focus change as sessions does per session (`LAYOUT_CONTROLLER.md:33`) |

### 3.7 Patches versus contributions

| Need | Mechanism | Upstream patch? |
|---|---|---|
| Mode swap, split, agent part | `AxisWorkbench` grid (overlay) | No |
| Folder follows focus | `IWorkspaceEditingService.updateFolders` in a `WORKSPACE`-state window | No |
| Per-workspace editors | Working sets | No |
| Per-workspace terminals | `moveToBackground`/`showBackgroundTerminal` | No |
| Keybindings, context keys, commands | Contributions | No |
| In-memory workspace (if per-project files prove unworkable) | P2b hook in `desktop.main.ts` | Yes, same file as P2: +~10 lines, 0 new files |
| Two-window model | `windowImpl.ts`, `windowsMainService.ts`, HTML entry | Yes. Rejected |

## 4. Dashboard and workspace view

### 4.1 Agent part layout

```text
┌ axis.parts.agent ───────────────────────────────┬ auxiliary bar: "Workspace" ─┐
│ Workspaces rail (collapsible)                   │ Files (ExplorerView subclass)│
│  Project ▸ local checkout · ws-a · ws-b …       │ Changes (vs base · staged ·  │
├─────────────────────────────────────────────────┤  unstaged · untracked)       │
│ Dashboard (nothing focused)  |  Workspace view  │                              │
│  dense rows                  |  header, activity│                              │
│                              |  composer        │                              │
└─────────────────────────────────────────────────┴──────────────────────────────┘
  panel (full width): terminals of the focused workspace, split panes
```

The rail and the main region are an internal split view inside the agent part, so the agent half needs one grid leaf.

### 4.2 Dashboard

| Column | Data | Source in Phase 0 | Source in Phase 1 |
|---|---|---|---|
| Name, project | Workspace label; worktree folder name | Discovery (§5.2) | `axis.worktrees/1.list` |
| Branch, base | Branch; base ref and short SHA; ahead/behind | HEAD from discovery; base "not recorded" | Journal plus `git rev-list --left-right --count` |
| State | idle · running · waiting for approval (1b) · quiet (may be waiting for input) · failed · changes to review · done (policies §9) | idle, or "external" for a worktree Axis did not create | Runs and approvals from the daemon (`AGENT_SYSTEM.md` state machine) |
| Agents | Composer run (provider, model, mode, state) and CLI agent runs (label, §4.5 status) | none | `axis.runs/1.list`, `axis.cliRuns/1.list` |
| Drift | "Files changed outside the agent" count per run, and "Git configuration changed" (policies §3, §6) | none | daemon drift ledger |
| Terminals | Count and running processes (this window) | `AxisWorkspaceTerminals` | same |
| Changes | Files and +/- lines | Focused workspace: `IGitService` state. Others: "—" | `axis.worktrees/1.status` (batched) |

- Rows that need the user sort first and give the reason in text (`UX.md`).
- Actions: Open, Open in IDE, Reveal in Finder; New workspace and Archive/Remove from Phase 1.
- With no project open (an empty window), the dashboard lists recent projects from `IWorkspacesService` recents filtered to Axis project files [I], plus "Open repository…".

### 4.3 Workspace view

- **Header.** Name, branch, base SHA, state, and Open in IDE.
- **Activity stream** (Phase 1). Run events as escaped text (PTY-3) and inline approval challenges (ADR 0003 D4).
- **Composer** (§6).
- **Trust** follows the source repository (ADR 0004 decision 12; policies §2).
- **Files** reuses `ExplorerView` (subclassed, as sessions does) in an Axis auxiliary-bar container with the default `WindowEnablement`. The mounted folder is the worktree, so the explorer is already scoped. A click calls `reveal(file)`.
- **Changes** is an Axis tree view.
  - Read path only: `IGitService.openRepository(worktree)` and its observable `state`: index, working-tree and untracked changes with `originalUri`/`modifiedUri` (`contrib/git/common/gitService.ts:33-35,50-57,83-98,110-120`) [V]. The delegate is the git extension (`mainThreadGitExtensionService.ts:99,103`) [V].
  - Phase 1 adds "since base" with `diffBetweenWithStats(baseSha, 'HEAD')` (`gitService.ts:90`).
  - Selecting a file opens a diff and "Review all" opens a multi-diff (`MultiDiffEditorInput`, `multiDiffEditorInput.ts:41-42`) [V], both through `reveal`.
  - Accept, reject and commit are §5.4.

### 4.4 Terminals per workspace

- `AxisWorkspaceTerminals` creates terminals with `cwd` set to the worktree (`ICreateTerminalOptions.cwd`, `contrib/terminal/browser/terminal.ts:769`). It records instance → workspace id and, on focus change, backgrounds the other workspaces' terminals and restores the focused one's (`moveToBackground` `:622`, `showBackgroundTerminal` `:616`) [V].
- Processes keep running in the background, so CLI agents continue while the user looks elsewhere.
- Split panes are upstream terminal groups (`splitInstance`, `:726`; `location: { parentTerminal } | { splitActiveTerminal }`, `:757`) [V]. A split always starts in the worktree root, never in the shell-integration-detected cwd (policies §5). The group layout is saved per workspace.
- **Labelling.** User terminals are tagged "not managed by Axis" (ADR 0004 security 3).
- **Managed terminals** (Phase 1a, all workspace terminals by default) run in the **Axis pty process**, not in the daemon:

  ```text
  main ──fork (fixed entry)──► daemon            vault use (1b), policy, journal; never forks shells
   │  └─fork (fixed entry)──► Axis pty process  upstream PtyService + TerminalProcess; no vault, no privileged port
   │                           ▲  control channel (daemon → pty): spawn {argv, cwd, env, si}, kill, exit and activity events
   └─brokers ports──► renderer ┘  data channel (renderer ↔ pty): input, output, resize, for terminal ids the daemon issued
  ```

  - The renderer asks the daemon (`axis.terminals/1.create`, `axis.cliRuns/1.start`). The daemon validates the worktree, builds the PTY-5 environment (policies §4) and sends the exact spawn to the pty process.
  - The pty process accepts spawns only on its daemon channel, and data attachments only for terminal ids the daemon issued.
  - Keystrokes do not pass through the daemon.
  - Main brokers the renderer ↔ pty data port only after ADR 0003 D1's window-identity checks: `getWindowByWebContents` must return an Axis workbench code window, `senderFrame.url` must be the workbench URL, and the sender must be the main frame. Auxiliary windows and `about:blank` frames get no port.
  - It reuses upstream `PtyService` (`platform/terminal/node/ptyService.ts:98`) and `TerminalProcess`, so ConPTY (`terminalProcess.ts:161-171`), shell-integration injection (`:213-242`) and reattach after a window reload come with it [V].
  - **Close-on-exec** is required on every daemon and pty-process file descriptor (SQLite, ports, watcher, logs), so no shell or git child inherits one. Task B9 tests this.
  - The renderer attaches through `IShellLaunchConfig.customPtyImplementation` (`platform/terminal/common/terminal.ts:568`). Upstream bridges agent-host ptys the same way (`agentHostTerminalService.ts:349`, `agentHostPty.ts:85`) [V].
  - The opt-out `axis.terminals.scrubEnvironment: false` puts plain user terminals back on the upstream pty host.
- **What plain workspace terminals keep and lose** (versus the upstream pty host):
  - **Kept:** profiles and the default shell (resolved in the renderer by `ITerminalProfileResolverService`, `contrib/terminal/common/terminal.ts:45,55-56`) [V], shell args, `terminal.integrated.env.*` (applied before the deny-list, so it cannot re-add a denied name), cwd, ConPTY on Windows, shell integration (policies §5), split panes, reattach after a window reload.
  - **Lost or changed:** extension environment collections (by design, PTY-5); persistent revive across an **app restart** is reduced to relaunching fresh shells in the saved layout, with no buffer replay, in 1a [I].
  - **Keystroke latency** through the data channel is measured with upstream `getLatency` (`platform/terminal/common/terminal.ts:352,436`) [V]. The budget is set from the A8 baseline of upstream terminals.
- **Phase 0 residual** (no daemon or pty process): workspace terminals are upstream terminals. D-6 (`git.terminalAuthentication: false`; `askpass.ts:168`) removes only the askpass variables. `VSCODE_GIT_IPC_HANDLE` and `VSCODE_IPC_HOOK_CLI` remain (policies §4.1). Phase 0 launches no CLI agents.

### 4.5 CLI agent runs (ADR 0004 decision 8)

- **Configuration.** `axis.cliAgents` is a list of `{ id, label, command, args[], envPassthrough[] }`. It, `axis.terminals.scrubEnvironment`, `axis.git.runHooks` and `axis.worktrees.root` are **application or machine scope only**: workspace and folder `.vscode/settings.json` values are ignored and a warning is surfaced (threat model CFG-1, decision Q-3), so a cloned repository cannot define a CLI agent or weaken PTY-5. `envPassthrough` can add variables but never a denied one. Axis offers presets for known official CLIs, but only resolves the command on `PATH` and uses documented arguments. It never adds flags that bypass the CLI's own permission prompts.
- **Launch.** The user starts a run from the workspace view or the dashboard. The renderer calls `axis.cliRuns/1.start { workspaceId, agentId }` and the daemon:
  1. resolves the worktree from the journal and checks it with `realpath` (never the local checkout; ADR 0004 decision 6), and **refuses to start unless main attests that the worktree's source repository is trusted** (policies §2; threat model TRU-2); a renderer claim alone never gates a run. Restricted Mode shows the workspace read-only with a "Trust to run" action;
  2. builds the environment: `getResolvedShellEnv` (`platform/shell/node/shellEnv.ts:32`) [V], resolved by main and passed to the daemon, then `envPassthrough`, then the PTY-5 deny-list, which always wins. It keeps `SSH_AUTH_SOCK` and adds no vault value (policies §4.2);
  3. asks the Axis pty process to spawn it in its own process group with shell integration off **and no nonce supplied** (`node-pty` is an upstream dependency, `package.json:160`) [V];
  4. records `{ runId, workspaceId, agentId, command, args, cwd, startedAt }` in `agent_runs` with kind `cli`.
- **Attachment.** The renderer creates an upstream terminal whose `customPtyImplementation` (`platform/terminal/common/terminal.ts:568`) proxies input, output and resize to the Axis pty process over the data channel, as upstream does for agent-host ptys (`agentHostTerminalService.ts:349`) [V]. The shell-integration addon still parses its output (`xtermTerminal.ts:339-340`) [V]. Axis derives no status from marks, and splits use the worktree root (policies §5). The terminal sits in the workspace's terminal group and supports split panes.
- **Status, from state Axis owns only:**

  | Status | Source |
  |---|---|
  | starting, running, exited (code), killed | Process lifecycle, reported by the pty process to the daemon |
  | active | Output in the last 5 s |
  | quiet (may be waiting for input) (policies §9) | Process alive and no output for the configured interval |
  | attention | A BEL character in the output (a standard terminal signal) |
  | changes | Worktree changes observed during the run (policies §3) |

  Axis never parses the CLI's output format, session stores or private files.
- **Labels.** The dashboard and terminal tab say the run is "governed by the CLI's own permissions". Axis shows no approvals, budgets or tool audit for it.
- **What Axis cannot stop.** A CLI run is not brokered. It can still run `git` with the user's own credentials (credential helpers and `SSH_AUTH_SOCK`), including `git push`, and it can write hooks or config into the shared `$GIT_COMMON_DIR`. The scrub only removes the editor's askpass, IPC handles and extension variables. The daemon snapshots the **GIT-SNAP-1** set (policies §6.4, ADR 0004 implication 3) before launch, after exit and before any Axis commit, and flags any change on the dashboard and in the SCM view (policies §6.3). The change also gates Axis commit (§5.3 invariant 5).
- **Stop:** the daemon tells the pty process to send SIGINT, then SIGTERM, then SIGKILL to the process group (PTY-4). Reload keeps ptys running, and the renderer reattaches by terminal id (R4).

## 5. Worktree lifecycle

### 5.1 Executor: the Git CLI in the daemon, not the git extension

- The git extension can add, list and remove worktrees (`extensions/git/src/git.ts:2311-2335,3114-3170`; API `api/git.d.ts:343-344`) [V]. But it lives in the extension host. The workbench-side `IGitService` exposes no worktree operations (`gitService.ts:83-120`) [V].
- Driving it through commands would make side-effecting commands reachable by every extension, which ADR 0003 D4 forbids.
- The daemon therefore runs `git` itself, with an explicit argument vector, a scrubbed environment and per-project serialisation. ARCHITECTURE.md's "Git CLI or libgit2" choice resolves to the CLI for worktrees, because `git worktree` has no stable libgit2 equivalent for locking and pruning [I].

### 5.2 Phase 0: read-only discovery

- **Discovery.** It reads `<common dir>/worktrees/*/{HEAD,gitdir}` and the main `HEAD` through `IFileService`, which is the git extension's own approach (`git.ts:3118-3170`) [V]. No process is spawned.
- **Finding the common dir.** When the opened checkout's `.git` is a file (it is itself a linked worktree or a submodule), discovery follows its `gitdir:` line and then that directory's `commondir` file.
- **What the dashboard shows.** The local checkout, plus every linked worktree marked `external`, since none were created by Axis yet.
- **Replacement.** Phase 1 replaces discovery with `git worktree list --porcelain -z`, reconciled against the journal.

### 5.3 Phase 1 operations (`axis.worktrees/1`)

| Operation | Side effect, tier | Steps |
|---|---|---|
| `create {projectId, name, baseRef?}` | write, tier 2 | Resolve the project root from the journal by `projectId` (never from a payload path; ADR 0004 security 2). Resolve `baseSha` with `rev-parse --verify <ref>^{commit}`. Check the branch name with `check-ref-format --branch`. Choose the path `<worktree root>/<project>-<hash>/<slug>` (D-3), which must not be inside any registered repository's working tree and must not exist. Run `git -c core.hooksPath=<empty> -c core.fsmonitor=false worktree add -b axis/<slug> <path> <baseSha>`, then `worktree lock --reason axis:<id>`. Record an `agent_workspaces` row `{id, projectId, branch, baseRef, baseSha, createdBy, state: READY}` and a `worktrees` row `{workspaceId, path(realpath), locked}`, plus the GIT-SNAP-1 baseline (policies §6.4; WT-2). Return the id |
| `list`, `status {ids}` | read | Journal joined with porcelain output: present, missing, locked, external; HEAD, dirty counts, ahead/behind against the base |
| `discard {id, paths, hunks?}` (reject) | write, tier 2 | Write a backup commit of the worktree, without ignored files (policies §7), to `refs/axis/backup/<id>/<ts>`, then restore the paths or reverse-apply the hunks. Reversible from the backup |
| `finalise {id, outcome: merged ∣ archived ∣ abandoned}` | write, tier 2 | Refuse while runs or managed ptys are active. Point `refs/axis/archive/<id>` at the tip (the rollback ref). For `merged`, check the tip is reachable from the base branch |
| `remove {id, deleteBranch?}` | destructive, tier 4 (challenge plus native confirmation, ADR 0003 D4; task B4) | Require `finalise`. Refuse if dirty unless the user confirms a discard, which writes a backup first. Then `worktree unlock`, `worktree remove <path>` (never `--force` without a backup ref), optionally delete the branch (the archive ref keeps the commits), and set state `CLEANED` |

**Safety invariants** (`AGENT_SYSTEM.md` Git isolation; threat model §5.5):

1. **The base SHA is recorded at creation and never rewritten.** Drift is reported, not repaired.
2. **The local checkout is never written.** The daemon refuses any operation whose canonical target is the local checkout or inside it. `worktree add` writes only the shared common dir (refs and `worktrees/<name>`), which is inherent in git and documented to the user.
3. **Cleanup only after finalisation**, with rollback refs kept (D-8 sets the retention period).
4. **Every daemon git call except commit and push** (policies §6.1) passes an explicit `--git-dir` and `--work-tree` taken from the journal (never discovered from the worktree directory, which a CLI can redirect through its `.git` file; threat model GIT-4), and uses an empty hooks path, `core.fsmonitor=false` and the **GIT-ENV-1** environment (policies §6.5; WT-2). GIT-ENV-1 is distinct from PTY-2, which is for broker tools. Paths are canonicalised with `realpath` at the time of use (WT-1).
5. **Common-dir drift.** The GIT-SNAP-1 set (policies §6.4, including the worktree `.git` file, `commondir` and any in-worktree `core.hooksPath` target) is compared before launch and after exit of each run, before every Axis commit **and every Axis push**, and on status refresh. On drift the workspace shows "Git configuration changed", and **Axis** commit and push stay blocked until the user reviews it (WT-2). They are also refused while a CLI run is active in the workspace. SCM-view commits are not blocked; they show the banner (policies §6.3).
6. **Trust** is copied from the source repository to each Axis-created worktree and re-derived at each mount and at each run start (ADR 0004 decision 12; policies §2). It is never granted to the worktree root. No CLI or agent run starts in a worktree of an untrusted repository.
7. **One mutating Axis git operation at a time per project** (a daemon mutex), because worktree operations lock refs in the shared common dir [I]. Git commands outside Axis (the SCM view, terminals, CLIs) are not serialised.

### 5.4 Review actions

- **Accept** (per file, per hunk in Phase 1) marks content for commit. In Phase 0 that is file selection.
- **Commit** and **Push** are user actions run by the daemon (`axis.worktrees/1.commit`, `.push`), under the git mutex and write lock, with commit gated by the drift check (policies §6.1). Protected paths (WT-3) and common-dir changes are flagged before commit.
- **Reject** is `axis.worktrees/1.discard`, which is reversible.
- Hunk-level accept and reject use a daemon `applyPatch` to the index. The renderer never edits the index.
- **Open a pull request** uses a GitHub compare URL or `gh pr create --web` (policies §6.2).
- **The SCM view** in IDE view stays a user path through the git extension, outside these guarantees, with a drift banner (policies §6.3).
- **Merge into the base branch** stays out of Phase 1. The integration and merge queue is Phase 3.

## 6. Composer integration point

- **First provider:** the Anthropic API (ADR 0004 resolved question 1), as an adapter in the daemon gateway. Its key is stored in the connection vault and decrypted only through the main-process broker (ADR 0003 D1.6). Stage 1 removed `@anthropic-ai/sdk` from `package.json` together with the agent host (`axis-shell.md` §2.9). The adapter therefore uses the documented HTTP API with Node `fetch`, a streaming parser and Zod schemas, which needs no `package.json` or lockfile patch (ADR 0004 decision 14).
- **The UI.** `AxisComposerWidget` is hosted in the workspace view and, in IDE view, in a `ViewPane` in the Axis Agent auxiliary-bar container. It is one widget, bound to `axis.focusedWorkspace`.
  - Modes are Ask, Edit and Agent, and a provider/model picker comes from `axis.providers/1.list`.
  - Context chips come from Files and Changes selections and travel as `UriComponents` inside the worktree. The daemon re-checks them (DMN-1, WT-1).
- **The contract** (ADR 0003 D2–D3):
  - `axis.runs/1.start { workspaceId, mode, prompt, attachments, providerId, modelId }`, with an idempotency key, returns `{ runId }`;
  - `events(runId)` streams tokens, tool proposals, approval challenges, file-change notices and status;
  - `cancel(runId)`.
  - Long work returns an `operationId` and is never a held RPC.
- **Execution, by mode:**
  - Ask has no tools.
  - Edit writes into the worktree through the broker at tier 2. The result is just a changeset, reviewed in Changes.
  - Agent runs the broker's tool loop, never in the user's pty host (PTY-1).
  - Protected paths raise approval challenges (WT-3).
- **The mock provider lives in the daemon** (`axis.provider.mock`), labelled "Mock", with scripted scenarios: echo, propose an edit, request approval, fail, slow stream. These are the deterministic fixtures for UI and contract tests.
- **Stub-capable renderer:**
  - with no daemon connected, `IAxisRunsService` is `DisconnectedRunsService` and the composer shows "Agent service not running" with a retry;
  - unit tests use a `FakeRunsService` under `test/` only;
  - no provider code or credential ever enters the renderer (PRV-2).
- **The upstream chat UI stays disabled** (`chat.disableAIFeatures`, `axis-shell.md` §2.2). The Axis composer does not reuse the chat widget, which is tied to the chat agent and `defaultChatAgent` infrastructure (R3 there).

## 7. Upstream footprint estimate

| Block | Contents | Files | Changed lines (excluding markers) | Change from `axis-shell.md` §3.10 |
|---|---|---|---|---|
| `0001–0999` shell (criterion 2) | P2–P9 bootstrap, lint and filters (P8 and P9 landed on the Stage 1 branch, `axis-shell.md` §2.9), plus bridge seams (ADR 0003 D6, called seams B1–B3 in `axis-shell.md` §3.6; distinct from the tasks below) | **10** | **~50** (about 80 with markers) | The pty-process entry adds about 1 line to `build/next/index.ts` and about 3 to `app.ts`, both already counted files. The agent part, view modes, Files, Changes, terminals binding and composer are all overlay |
| `0001–0999` worst case | + P2b in-memory workspace hook (same file as P2), + `build/next/resources.ts` if Axis UI loads assets by URI, + optional P11/P12 | 11–13 | ~65 | P11/P12 must stay out unless the final count leaves room (unchanged advice). With them **and** `resources.ts`, the count reaches 13 and breaks the 12-file limit |
| `1000–1499` rebrand | G1–G3 | 4 incl. `product.json` | 90 / 106 measured (§2.9) | None |
| `1500–1999` Copilot, agent host, D8 | Measured 19 files (185 / 122); D8 adds about 12 deletion lines in `build/next/index.ts` and about 6 in `windowsMainService.ts` | ~20 | ~200 | None. D8 stays: the agent shell does not need the sessions window |
| `2000–2999` hardening | H1–H4 | 2 | ~25 | None |

- **Conclusion.** The agent-first shell does not, by design, need more than the ADR 0002 shell budget. **No amendment is proposed.**
- **Risks to the budget.** Resolve them early in task A8:
  1. the in-memory workspace hook, if per-project workspace files misbehave (R1);
  2. web: if the reh-web Agent view needs a server-side seam beyond the `serverServices.ts` bridge seam [I, Phase 2 or later, since the browser skeleton is out of Phase 1];
  3. any Axis need to change upstream part internals, which is forbidden by ADR 0002 decision 2. That would trigger ADR 0004's revisit clause, not an amendment.
- **Axis-owned code.** Overlay grows from `axis-shell.md`'s 3–4.5k lines to about 8–10k [I]: `AxisWorkbench` with modes about 2.5k, the agent part and dashboard about 2k, services about 1.5k, views about 1.5k, the composer about 1k, the pty process and its channels about 1k (it reuses upstream `PtyService`), tests extra. Adapted sessions copies (about 0.5k) carry `Adapted from <path>@2c33b50` headers (`axis-shell.md` §3.7).

## 8. Phased implementation tasks

- **Prerequisite.** `axis-shell.md` S2.1 (layer scaffold; P8 and P9 landed on the Stage 1 branch) and S2.2 (bootstrap P2–P7, Phase A wholesale contributions) are unchanged and come first.
- **Test conventions.** Tests follow `axis-shell.md` §6: `./scripts/test.sh --grep Axis`, `npm run test-browser -- --grep Axis`, and smoke runs with `--grep`.
- **Fixtures.** Worktree fixtures are created by test setup with the Git CLI in a temporary directory (electron-browser/node test layer) [I].

### 8.1 Phase 0 skeleton (the gate): first slice

| Task | Scope | Acceptance criteria | Verification |
|---|---|---|---|
| **A1** | `AxisWorkbench` v1 with the §3.1 grid and two modes. IDE mode is the former S2.3 contract; Agent mode shows an empty agent part. `IAxisViewService` with `perWorkspace` and `global`, context keys and `axis.view.toggle` | IDE view passes ADR 0002 criterion 1. Switching never recreates parts or restarts the extension host. Open editors survive a round trip | Unit tests over the visibility table and the persistence round trip. The criterion 1 smoke subset. The extension host pid is unchanged across 20 toggles (log) |
| **A2** | `IAxisProjectService` (per-project `.code-workspace` create and open; empty-window project list) and `IAxisWorkspaceService` with read-only discovery (§5.2), the local checkout entry and the focused workspace. The folder manager (adapted from sessions) with a trust backstop | Opening a repo yields a project window in `WORKSPACE` state. Focusing a workspace mounts exactly its worktree. An untrusted worktree is not mounted. External worktrees are labelled | Unit tests on fixture repos (0, 1 and 3 linked worktrees, detached HEAD, missing `gitdir`). Integration test: `onDidChangeWorkspaceFolders` fires, the extension host does not restart |
| **A3** | The agent part: rail and dashboard rows (§4.2, Phase 0 columns), keyboard navigation of the list, the empty-window state | The dashboard lists the local checkout and the worktrees. Enter focuses a row. Workspace 1–9 commands work | Unit tests on the view model. Accessibility: rows are a list with names and states read as text. Screenshot |
| **A4** | The workspace view: the header, the Files view (`ExplorerView` subclass, Axis auxiliary-bar container), and `AxisWorkspaceTerminals` (cwd, background/foreground on focus change, split panes, "not managed" tag) | The file tree shows the focused worktree. A new terminal starts in the worktree. Switching workspaces swaps the visible terminals while background processes keep running | Unit tests on the terminal map. A manual script: run `sleep 600` in ws-a, switch to ws-b, back again, and the process is alive |
| **A5** | The Changes view (read-only, `IGitService` state) and diff and multi-diff open through `reveal` | Modified, staged and untracked files are listed. A click opens a diff in IDE view at the change | Unit test with a fake `IGitService`. Manual test on a fixture repo |
| **A6** | `reveal` routing (§3.4) and `split` mode (sash, collapse, F6 across halves, the `sideBar.location: right` reparenting) | A file click in Agent view opens IDE view at file:line in `perWorkspace`, and opens in the IDE half without switching in `split`. Collapsing either half keeps it reachable by F6 | Unit tests per mode and per side-bar location. Manual check in all three modes |
| **A7** | Per-workspace working sets, focus return, screen-reader announcements, shortcuts (policies §8) | Returning to Agent view restores workspace and editor state. Focus never falls to the body. Keyboard-only walkthrough of all three modes passes | The `UX.md` focus-rule script with VoiceOver on macOS. A keybinding report against the upstream defaults, plus manual checks on macOS, Linux and Windows (Polish and Czech layouts) |
| **A8** | Gate check: footprint report per block, packaged macOS and Linux builds, the ADR 0004 Phase 0 gate items 1–4 | Block `0001–0999` within 12 files and 300 lines. Gate items pass | `code-oss/scripts/footprint` output. Smoke subset. A recorded walkthrough. A keystroke-latency baseline for upstream terminals, which sets B9's budget |

### 8.2 Phase 1a: daemon, worktrees, terminals, CLI agents, review, push

1a is the agent shell (ADR 0004 decision 13). Per ADR 0004 security implication 4 (as amended), 1a builds the challenge and native-confirmation mechanism (B4) for `remove` and other tier-4 user actions. Agent approval policy, the broker and the approval UI are 1b.

| Task | Scope | Acceptance criteria | Verification |
|---|---|---|---|
| **B1** | Bridge transport: the daemon fork with a fixed entry (the `app.ts` and `build/next/index.ts` bridge seams), the `vscode:axisConnect` handshake, window-identity and frame checks, the envelope check (ADR 0003 D1, D2 envelope) | Only an Axis workbench window gets a port; auxiliary windows and `about:blank` frames are refused. Oversized or deep messages are rejected before parsing. Native modules (node-pty, the watcher) load in the packaged daemon | ADR 0003 validation tests for D1. Negative tests per check. A packaged-build launch |
| **B2** | Contracts and the policy pipeline skeleton: schema validation (Zod facade), identity from `ConnectionContext`, default-deny `policy.evaluate`, structured errors, the audit log with hash chain (DMN-5) for user and daemon actions, redaction by field sensitivity (DMN-6). Phase 1b extends the same log to agent approvals and tool calls | Unknown keys and `__proto__` are rejected. No rule means deny. Every policy decision and every tier-4 or privileged action (remove, commit, push, discard) writes an audit event, and the chain verifies. Secret fields never appear in logs | Contract tests. Audit chain tamper test. Redaction test with planted secrets |
| **B3** | The journal: SQLite (WAL, migrations) for `projects`, `agent_workspaces`, `worktrees`, `agent_runs` and `audit_events`; journal-first state changes; restart recovery (DMN-7) | Killing the daemon at each state transition and restarting it recovers a consistent state. The worktree is intact | Kill-and-recover test matrix |
| **B4** | Challenges and native confirmation (ADR 0003 D4): daemon-issued `challengeId` bound to a request digest, `approvals.resolve` by `user` actors only, `confirmNative` over the privileged port for tiers 4–5 | A tier-4 request blocks until a native dialog confirms. An agent actor resolving a challenge gets `E_POLICY_DENIED`. A stale or replayed challenge is refused | DMN-3 negative tests. Manual native-dialog check |
| **B5** | `axis.worktrees/1.list`/`status` replacing Phase 0 discovery | The dashboard is fed by the daemon, including non-mounted workspaces' change counts. Daemon down: unavailable states shown, then recovery | Unit tests. Kill-daemon test |
| **B6** | `create`, `finalise`, `remove` with the §5.3 invariants; trust copy (policies §2); dashboard New workspace and Archive/Remove | Base SHA recorded. The local checkout is byte-identical after a create/remove cycle (status, index hash, HEAD). Removing a dirty workspace needs a B4 confirmation and writes a backup. Rollback refs exist after removal | Daemon tests on temporary repos. Hooks-planted fixture: no hook runs during a worktree call. Untrusted-source fixture: the worktree opens restricted |
| **B7** | Review: daemon `commit`, `discard`, `applyPatch` (hunks), the drift gate, WT-2 and WT-3 flags, the SCM-view banner (policies §6) | Commit uses the user identity and refuses on unacknowledged common-dir drift. Reject is reversible. The SCM banner appears while drift is present | Unit and integration tests. A commit from the SCM view during drift shows the banner and succeeds as a user path |
| **B8** | Push and open PR (policies §6.1–6.2) | Explicit refspec, never mirror. `GIT_TERMINAL_PROMPT=0`, with the terminal fallback. Compare URL correct for GitHub HTTPS and SSH remotes. No forge credential stored | Unit tests on refspec and URL derivation |
| **B9** | The Axis pty process (§4.4): its fixed entry and fork, upstream `PtyService` hosting, the daemon control channel and the brokered renderer data channel, terminal-id attachment checks, close-on-exec | Spawns are accepted only from the daemon channel. Data attaches only for daemon-issued ids. No vault access. ConPTY works on Windows | **Child-fd test**: a spawned shell lists its open fds and sees only stdio and its pty. A spawn sent on the data channel is refused. Keystroke latency is within the budget set from A8 |
| **B10** | Workspace terminals and CLI agent runs (§4.4–4.5; policies §4–5): `axis.cliAgents`, attachment, status, dashboard rows, stop, opt-out | Runs start only in a worktree. Splits start in the worktree root | **PTY-5 test**: dump the child environment of a CLI run and a plain terminal. None of the denied variables, `SSH_AUTH_SOCK` kept, `envPassthrough` cannot re-add a denied name, `NODE_OPTIONS` restored. The SI-ENV set (policies §4.3) is present in plain terminals and absent in CLI runs; in particular `VSCODE_NONCE` is absent in CLI runs. Kept features (profiles, env settings, shell args, ConPTY) work in plain terminals. GIT-SNAP-1 fixtures: an `info/attributes` filter driver and a `core.sshCommand` change are each flagged. Also a PTY-4 kill test, a local-checkout refusal test, a reattach-after-reload test, and an OSC 633 cwd-spoof test (the split still opens in the worktree root) |
| **B11** | CLI-run drift attribution (policies §3.2, §3.6): `refs/axis/runbase/<runId>` at CLI run start, the watcher-based drift ledger with time-window attribution, the dashboard Drift column, the "files changed outside the agent" indicator and attribution groups in Changes, and "Restore from before this run" in diff review | PRODUCT scenario 4 passes with only CLI runs: a user edit during a CLI run shows the indicator and the path grouped as "changed during CLI run X". A CLI overwrite of a user change is restorable from the run base | Daemon tests: policies §3.8 scenarios 7 and 9. A manual run with two CLIs in one workspace |

### 8.3 Phase 1b: vault, broker, composer, provider, concurrency

| Task | Scope | Acceptance criteria | Verification |
|---|---|---|---|
| **C1** | Connection vault: credentials stored through the main secret broker; backend checked on every encrypt; `basic_text` refused without consent (PRV-1); plaintext never leaves main or the daemon (PRV-2) | No credential in renderer state, extensions, prompts, environment or logs | PRV-1 and PRV-2 tests. Redaction scan |
| **C2** | The broker: tool contracts, tiers, protected paths (WT-3), timeouts and output caps (PTY-4), the allow-listed tool environment (PTY-2), the Agent-mode tool loop, and policy rules on top of the B2 skeleton | A composer push request is denied. Protected-path writes raise a B4 challenge. A runaway command is killed at the cap | Broker deny tests, including push. A cap and kill test. **PTY-2 test**: dump a broker child's environment; only allow-listed variables are present |
| **C3** | The composer widget and view, `IAxisRunsService` (bridge client and disconnected state), the daemon mock provider and scenarios, the approval UI | Ask/Edit/Agent run against the mock. An Edit change appears in Changes. Cancel works | Contract tests against the mock scenarios. UI tests with `FakeRunsService` |
| **C4** | The Anthropic API adapter (ADR 0004 decision 14) in the daemon gateway | `PROVIDERS.md` `ProviderAdapter` contract tests pass. No silent cross-provider routing (PRV-4). Budgets enforced (PRV-6) | Contract tests. PRV-4 and PRV-6 tests |
| **C5** | Composer drift (policies §3.3–3.4, building on B11): compare-and-swap with temp-and-rename, advisory locks, drift notices, HEAD-moved and branch-moved handling | Policies §3.8 scenarios 1–6 and 8 pass | Daemon tests per scenario. A manual run with a CLI and the composer in one workspace |

## 9. Risks and open questions

### 9.1 Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Folder swap side effects: language servers and the git extension re-scan on each focus change; extensions that cache the first folder at activation go stale [I] | Measure switch latency in A2. If it is too slow, keep the recently focused worktrees mounted (multi-root) and scope views to the focused one. Last resort: P2b |
| R2 | Extension `workspaceState` and workspace storage are shared by every workspace in a project | Accept and document. Axis keys its own state by workspace id |
| R3 | `applyWorkingSet` on focus change meets dirty editors [I] | Keep dirty editors open across the swap, or prompt. Test in A7 |
| R4 | Backgrounded terminals across a window reload lose their workspace mapping [I] | Axis ptys live in the pty process, are keyed by terminal id and reattach. Upstream-pty terminals (opt-out) restore hidden as sessions does (`sessionsTerminalContribution.ts:241-252`) |
| R5 | `IWorkbenchLayoutService` churn now carries more Axis logic (`axis-shell.md` R4) | Contract unit tests. Sync step 3 diff of `layoutService.ts` and `sessions/browser/workbench.ts` |
| R6 | CLI agent runs are not brokered: no policy, budgets or audit. The CLI can still use the user's Git credentials (including push), and can reach the local checkout (ADR 0004 decision 6 governs the working directory only) | PTY-5 (policies §4). Common-dir snapshot around each CLI run. Labelled "governed by the CLI's own permissions". All their changes go through review |
| R12 | Drift attribution for CLI runs is by time window, not by writer; a CLI can overwrite other changes | Shown, not prevented. Restore from run base for 7 days (policies §3.6) |
| R13 | Snapshot refs store untracked, non-ignored files (possibly secrets) as objects in the shared common dir, and grow the repository | Ignored files excluded. Files over 50 MiB skipped. Never mirror-pushed. Retention and user-run cleanup (policies §7) |
| R14 | Git commands outside Axis (SCM view, terminals, CLIs) bypass the mutex, lock and drift gate | Scoped guarantees, the SCM banner, and HEAD-moved notices to the composer (policies §6.3) |
| R7 | The shared `$GIT_COMMON_DIR` lets anything in a worktree (a CLI agent, a user command) plant hooks or config that later run in the local checkout | Drift snapshot (invariant 5), surfaced on the dashboard. Never described as a sandbox |
| R8 | Adapted sessions code drifts | Copies under 600 lines with source and commit headers; diffed at each sync (`axis-shell.md` R8) |
| R9 | Phase 0 discovery parser diverges from git's metadata format | Read-only, tolerant of missing files (as `git.ts:3166,3177`). Replaced by porcelain output in task B5 |
| R10 | Split mode with a single side bar and auxiliary bar: both halves cannot each have their own | The agent half keeps its rail inside the agent part. The auxiliary bar is shared (Files and Changes) |
| R11 | Web (reh-web) Agent view, Phase 2 or later: the daemon runs as a reh child and worktrees live on the server | Desktop first. Web bring-up follows ADR 0003 D1.7 with a gap list |

### 9.2 Decisions (recorded 2026-11-02)

| ID | Decision | Status |
|---|---|---|
| D-1 | Build approach (§2.3): (i), with (iii) as the documented fallback | **Decided** |
| D-2 | Window model: one window per project, with a per-project `.code-workspace` whose folder is the focused worktree (§3.2) | **Decided** |
| D-3 | Worktree root, per ADR 0004 decision 7: the Axis application data directory, `worktrees/<project>-<hash>/<slug>` beneath it. macOS `~/Library/Application Support/Axis/worktrees/…`; Linux `$XDG_DATA_HOME/Axis/worktrees/…` (default `~/.local/share/Axis/…`); Windows `%LOCALAPPDATA%\Axis\worktrees\…`. `<hash>` is the first 8 hex digits of SHA-256 over the canonical common-dir path, so two clones with the same name do not collide. Configurable by `axis.worktrees.root`; the daemon rejects a root inside any registered repository's working tree | **Decided** (aligned with ADR 0004) |
| D-4 | Branch naming `axis/<slug>`, refused if it exists | **Decided** |
| D-5 | Editors opened while Agent view is showing: explicit user opens switch to IDE view; background opens badge the view control | **Decided** |
| D-6 | Default `git.terminalAuthentication: false` (Phase 0 and opt-out terminals). From Phase 1a, PTY-5 applies to all workspace terminals, with the opt-out `axis.terminals.scrubEnvironment` (policies §4) | **Decided** |
| D-7 | Default shortcuts (policies §8) | **Decided**; adopted by `UX.md` on `main` (`a0cb0a3`) |
| D-8 | Keep `refs/axis/archive/*` until the user deletes them; keep `refs/axis/backup/*` for 30 days | **Decided** |
| D-9 | External (non-Axis) worktrees appear read-only, labelled, with no agent actions | **Decided** |
| D-10 | Dashboard scope: the current project, with a project switcher in the top bar | **Decided** |
| D-12 | The daemon orchestrates Axis commit and push; git, and its hooks, runs in the Axis pty process; the SCM view is a user path outside the guarantees (policies §6) | **Decided** |
| D-13 | The challenge machinery is built in Phase 1a (task B4) and reused by 1b | **Decided** |

The Anthropic adapter's "HTTP API, no SDK" choice is ADR 0004 decision 14.

### 9.3 Open questions

1. Is a per-project `.code-workspace` acceptable product-wise? Users see a workspace file name in the title and in recents. A label formatter can hide it [I].
2. Do restored editors of a non-focused workspace's files (outside the mounted folder) behave correctly with Workspace Trust and the file watcher [I]? Checked in A7.
3. Should Phase 1 keep more than one worktree mounted, for cross-workspace search? Depends on the R1 measurements.
