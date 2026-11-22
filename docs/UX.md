# UX and Visual Design System

## Design thesis
An agent home first, with a full IDE one step away: closer to Paradev than to Cursor, with Linear-inspired precision and a distinct original identity. Minimal, dense where useful, calm by default. Accent color and boldness signal interaction, selection, focus, or meaningful status—not decoration. No gratuitous glows, gradient-heavy surfaces, metric walls, or oversized cards; the project home and the agent lists are dense, actionable lists (usage is numbers in rows, not charts).

**Visual direction: C**, "precise instrument" (`docs/design/ui/directions.md` §4 and §7; owner decision of 2026-11-21, ADR 0006): a flat, bordered surface shared by Agent view and IDE view, a timeline axis in the activity stream, one glyph shape plus a text label per status, keyboard hints on primary actions, and a lifted layer only for a pending decision and for overlays. The token, glyph, elevation, typography, target, focus and motion changes it implies are listed in `directions.md` §8 and are applied to this file by their own change; until then the tokens below stand.

## Visual tokens (provisional)
Dark default: canvas `#111214`, surface `#181A1D`, raised `#202227`, border `#2B2E34` (decorative separators only), control-border `#6B7079` (inputs, checkboxes and other component boundaries; 3.77:1 canvas, 3.50:1 surface, 3.20:1 raised), primary text `#E8E9EB`, secondary `#9A9EA7` (also placeholder text), muted `#70757F` (disabled text only; 4.0:1 on canvas, 3.8:1 on surface, so never body or placeholder text). Light alternative: canvas `#FAFAFB`, surface `#FFFFFF`, raised `#FFFFFF` with border, border `#E5E7EB` (decorative), control-border `#8A8F98` (>= 3:1 on surface and canvas), text `#17191D`, secondary `#50555F` (7.2:1; also placeholder text), muted `#6B7280` (4.6:1). Decorative borders may fall below 3:1. Any boundary needed to identify a control uses `control-border` (WCAG 2.2 SC 1.4.11). Interaction accent from the brand violet (hue 255°), configurable and sparingly used: `accent` `#5823F6` for filled primary controls in both themes (white label 7.0:1) and for text, links and focus in the light theme (6.7:1 on canvas); `accent-on-dark` `#9776F9` for text, links, icons and focus rings on dark surfaces (5.6:1 canvas, 5.2:1 surface, 4.8:1 raised). Status colors must meet contrast requirements and never be sole indicator.

## Brand
Brand assets live in `assets/brand/`: `axis-mark.svg` (symbol), `axis-logo-dark.svg` / `axis-logo-light.svg` (symbol and wordmark for dark / light backgrounds), and `axis-app-icon.svg` (1024px application icon on the macOS icon grid). `assets/brand/source/` holds the original raster artwork the vectors were derived from. Use the logo variant that matches the background; do not recolor, outline, rotate or stretch the mark. Keep clear space of at least the mark's corner radius around it, and prefer the symbol alone below 24px. The mark's gradients and the icon's glow are part of the logo only; product UI surfaces follow the flat token system above.

## Typography and spacing
System/Inter-like UI sans with strong legibility; code font user-selectable. 12–13px dense controls, 13–14px standard UI, restrained headings. 4px spacing grid, 28–34px compact rows, 36–40px primary controls. Use consistent 6–8px corner radii; near-zero shadows unless layering requires them. These are starting tokens to validate through prototypes.

## Surfaces
Axis has two views of the same workspace, in one window (ADR 0004). **Agent view** is the default and the home of the product. **IDE view** is the full IDE. Both share the top bar.

**Top bar (both views):** compact project switcher, command/search, agent activity indicator, account/model control, and the view control (Agent / IDE, or Split when that mode is on). In a workspace, a breadcrumb shows Dashboard › workspace › branch; from Phase 1c it shows Project › group › agent.

### Agent view: dashboard (Phases 1a and 1b)
From Phase 1c the project home below replaces this dashboard, and its rows are agents rather than workspaces (ADR 0006). Until then:
- The home screen. One dense row per workspace, grouped by project: name, branch, agents (composer runs and CLI agent runs) and their state (idle, running, waiting for approval, quiet (may be waiting for input), failed, done), terminal count, changed-file count with additions/deletions, last activity.
- The project's own checkout appears as a *local checkout* row; it opens in IDE view, but no agent runs in it and it offers no agent actions.
- **CLI agent runs** show the CLI's name, the launch command and a status derived from the process and terminal Axis owns (running, quiet (may be waiting for input), exited with code, killed; Axis cannot tell whether a quiet CLI is waiting), never from the CLI's private data. Selecting one focuses its terminal. They are labelled "permissions: CLI-managed", and never show Axis approvals or budgets. A row whose run changed the repository's shared Git configuration or hooks shows a "Git config or hooks changed" flag in text.
- Primary action: **New workspace** (base branch, new branch name, optional first task, optional agent: composer or an installed CLI). Secondary: filter by needs attention / running / all; archive; remove.
- Selecting a row focuses that workspace and opens its workspace view. Rows that need the user (approval, failure) sort first within a project and show the reason in text, not only color.
- Empty state: open a repository, then create the first workspace. No sample metrics, charts or onboarding cards.

### Agent view: project home (Phase 1c)
Opening a project shows its project home; opening Axis shows the last focused project's home, or the Space's project list (name, repository, agents running, needs-attention count, **Add project**) when there is none. Sections, top to bottom, each a dense list with text labels on every number:
- **Needs attention:** approvals waiting (count per agent; Enter opens the agent), failed runs, quiet CLI runs (may be waiting for input), drift and Git-config flags; unread messages to the user from Phase 2a. An approval is never decided here: the agent's view shows the full request.
- **Agents:** one row per agent, grouped by agent group, with ungrouped agents last: name, type (composer or CLI, in text and by avatar shape, never by colour alone), state, current step, branch, changed files, last activity. Rows that need the user sort first within their group and show the reason in text.
- **Pull requests:** titled "Your pull requests": the open pull requests opened by the account `gh` is logged in as, on this project's GitHub repository, whose head is an `axis/*` branch of it, read through the user's own `gh` (read-only; Axis stores no token): number, title, branch, author, draft, checks and review state, all shown as escaped text. If `gh` cannot narrow to the user's own pull requests, the section lists every pull request on the repository's `axis/*` branches and is titled "Pull requests on axis/ branches". Without `gh` the section says so and offers the compare URL; other forges are not shown. The list refreshes while the section is visible once its data is older than 60 seconds, and from the Refresh button (at most once per 15 seconds per project); there is no background timer (`docs/design/forge-pr-list.md`).
- **Usage and cost:** per agent and per project, against the run budget, with the percentage in text. CLI agents show "not available", never zero cost.
- **Run status:** the last runs with state and reason.
- **Tasks** and **Pages** sections arrive with Phase 2a.

Empty states: an empty Space offers Add project; an empty project offers New agent. No sample metrics, charts or onboarding cards.

### Agent view: navigation rail and side panel (Phase 1c)
- **Navigation rail:** a labelled rail at the left of Agent view, one icon and one word per destination, the current one marked by fill, a 2 px accent edge and `aria-current`. It lists only destinations whose phase has shipped: Home, Agents, Workspaces and Settings in 1c; Threads, Tasks and Pages in 2a; Plugins and Integrations in 4a. In IDE view the upstream activity bar takes its place.
- **Side panel** (left of the main area, collapsible and resizable): an **Agents** tab with groups and agents as a tree with state glyphs, **New agent** and **New group**, and bulk actions per group (stop all runs; pause messaging from 2a); and a **Code** tab with the focused agent's worktree file tree, its Changes list and an embedded editor. A user-only switch shows the local checkout instead; agents never run there.
- **New agent:** name, type (composer: connection, model and default mode; CLI: one of the configured agent CLIs, with the "governed by its own permissions, can push" disclosure), group, and a new home workspace (base branch, branch name) or, by explicit choice, an existing workspace of the project.
- **Groups are not boundaries.** Copy never suggests that a group isolates files, credentials or processes.
- **Main area:** Home, **All agents** (one lane per agent: state, current step, last tool call or terminal activity, waiting reason, changes count; it stays readable at 5, 20 and 50 agents) or the focused **Agent** (the workspace view below, for that agent's home workspace).

**Side-panel editor rules:**
1. It is a real Code OSS editor over the same text model as IDE view: dirty state, undo and diagnostics are shared, and switching never forks a buffer.
2. Its edits are user edits: they mark "files changed outside the agent", and composer runs get the drift notice, as IDE view edits do.
3. **Open in IDE** (and Enter on a file in the tree) hands off to IDE view at the same file and selection, following the active view mode. In split mode the side panel stays in the Agent half, and file clicks open in the IDE half.
4. Quick edits only: no debugger, no multi-group layout, no extension UI beyond what the editor widget hosts. Anything more is IDE view.
5. Files of an untrusted project open read-only (Restricted Mode), with "Trust to run" offered where the user can act on it.

### Agent view: inter-agent threads (Phase 2a)
- A thread lists its messages in order. Each shows sender → recipients with a type badge (you, composer, CLI, plugin), time, delivery (at a composer's next turn, or "pulled by" a CLI agent with the time) and hop. Everything an agent wrote is marked "untrusted text"; a CLI agent's messages also say "via endpoint, unverified writer".
- Bodies are escaped plain text. A message never carries or implies an approval, and approval cards are separate components that a message cannot render or imitate.
- When a composer run reads another agent's message, a system line says so; from then on its side-effecting actions need the user's approval, and the approval card lists what the run received (sender, type, time, hop).
- **Pause messaging** is user-only, per project or group. Its copy says it stops new deliveries only, that a message an agent has already read cannot be recalled, and that stopping runs is a separate action. Per-agent mute and messaging settings live with the agent. Refused, held, hop-limit and rate-limit notices appear inline.

### Agent view: workspace view
- **Left:** file tree of the worktree and a **Changes** list (changed files against the workspace's base, with per-file counts). Collapsible.
- **Center:** the agent session: activity stream (progress, tool calls, approval requests, errors and recovery actions) with the **composer** docked below it. Selecting a change opens **diff review** in the center, with accept and reject per file and per hunk, **Commit**, and **Push branch** / **Open pull request** (GitHub; other forges push only); closing it returns to the session. Changes from composer agents, CLI agents and the user all appear here; a "files changed outside the agent" indicator marks user edits made during a run. Protected paths, and any change to the repository's shared Git configuration or hooks during a CLI agent run, are flagged at the top of the review with the before/after diff. If a CLI agent overwrites user edits or another agent's changes, review **shows it but Axis does not prevent it**; **Restore from run base** returns a file or hunk to its content when the run started.
- **Terminals and panes:** a pane group of terminals bound to the worktree, split horizontally or vertically, for commands and CLI agents. **Launch CLI agent** starts an installed agent CLI in a new pane of the workspace; its prompts and permission questions stay in that terminal. The launch states plainly that the CLI runs with the user's credentials, can push and can write outside the worktree, and is governed by its own permissions, not Axis approvals.
- Approvals show exactly what action, scope and consequence are requested, inline in the activity stream; the dashboard row shows "waiting for approval".
- Every pane is resizable, collapsible and keyboard navigable. Pane layout, open terminals and the last selection persist per workspace.
- Exact part arrangement is to be specified in `docs/design/axis-agent-shell.md`.

### IDE view
- Left: collapsible activity rail + explorer/search/Git. Center: editor tabs, splits, inline diff and preview. Right: optional workspace agent panel showing the focused workspace's activity and composer. Bottom: terminal/problems/output. Status bar kept.
- The IDE view always shows the focused workspace's worktree. It is the full IDE (ADR 0002 criterion 1), not a reduced editor.
- Every panel is resizable, hideable, and keyboard navigable. Preserve user layout per workspace.

## View switching
The mode is a user preference (`axis.view.mode`), changeable in settings, from the command palette, and from the view control.

| Mode | Behaviour |
|---|---|
| **Per-workspace toggle** (`perWorkspace`, default) | Each workspace remembers Agent or IDE view. The toggle shortcut switches the focused workspace only. Opening a file, changed file or diff hunk from Agent view switches that workspace to IDE view at the file and line (a diff opens in the diff editor). |
| **Global toggle** (`global`) | One app-wide view. The toggle switches every workspace; focusing another workspace keeps the current view. File and diff clicks switch the app to IDE view at the location. |
| **Split** (`split`) | Agent view and IDE view side by side, divided by a resizable sash. Either pane collapses to a thin header and expands again. File and diff clicks open in the IDE pane without switching; if the IDE pane is collapsed, it expands. |

**Keyboard.** Every action is a command in the palette and is rebindable. The defaults below are the verified set from `docs/design/axis-agent-shell.md` §9.2: checked against all 3,003 upstream keybinding registrations and 100 built-in extension bindings at the pinned Code OSS tag, with zero conflicts. Windows and Linux use `Ctrl+Shift+Alt` rather than `Ctrl+Alt`, because `Ctrl+Alt` is AltGr on many keyboard layouts. OS-reserved shortcuts and third-party extension bindings are re-checked during implementation (shell design task A6). Two earlier provisional choices were rejected because they conflict at the pin: `Mod+Alt+V` is editor dictation, and `Cmd+Alt+0` on macOS toggles the editor group layout.

| Action | Command | macOS | Windows / Linux |
|---|---|---|---|
| Toggle Agent / IDE view (per mode above; in split mode, focus the other half) | `axis.view.toggle` | `Ctrl+Cmd+V` | `Ctrl+Shift+Alt+V` |
| Show dashboard | `axis.dashboard.show` | `Ctrl+Cmd+0` | `Ctrl+Shift+Alt+0` |
| Focus workspace 1–9 in dashboard order | `axis.workspace.focus.1` … `.9` | `Ctrl+Alt+Cmd+1` … `9` | `Ctrl+Shift+Alt+1` … `9` |
| Next / previous workspace | `axis.workspace.next` / `axis.workspace.previous` | `Ctrl+Cmd+]` / `Ctrl+Cmd+[` | `Ctrl+Shift+Alt+]` / `Ctrl+Shift+Alt+[` |
| Open the selected file, change or hunk in IDE view at its location | — | `Enter` in the file tree, Changes list or diff review | same |
| Cycle panes and parts, across both views in split mode | upstream | `F6` / `Shift+F6` (upstream behaviour, kept) | same |
| Collapse or expand the Agent pane / IDE pane (split mode) | `axis.split.collapseAgent` / `axis.split.collapseIde` | Command only; no default binding | same |

### Focus and accessibility rules for switching
1. **Focus lands on the target.** Opening a location focuses the editor at that file and line (or the diff hunk). A plain toggle restores the last focused element of the destination view for that workspace; if none, its primary region (workspace view: composer; IDE view: active editor; dashboard: first row).
2. **Focus returns.** Toggling back restores the element focused before the switch. Focus never falls to the document body.
3. **Announce the change.** Each switch announces the view and workspace through a polite live region ("IDE view, workspace fix-login"). The view control exposes its state (pressed or selected), not just its color.
4. **Nothing is lost.** Switching never closes editors, discards unsaved changes, stops terminals or interrupts an agent run. Hidden views keep their state.
5. **Escape never switches views.** It keeps its meaning inside the current component.
6. **Split mode is two landmarks.** Each pane is a labelled region; the sash is keyboard-resizable and announces its position; a collapsed pane stays reachable by `F6` and by its header.
7. **Motion.** A switch uses at most the standard transition range in Motion and is instant under reduced motion. Input is never blocked during the transition.

## AI UX
One unified composer with explicit mode: Ask, Edit, Agent, bound to the focused workspace. Model/account selector reveals only relevant capabilities. Inline edits appear as reversible diffs. In IDE view, agent activity across workspaces collapses into the top-bar indicator; the dashboard is its expanded form. Approvals show exactly what action, scope, and consequence are requested.

## Agent UX
Each agent has one home workspace and works there; the project home and the All-agents surface are the overview of all of them (the dashboard in Phases 1a and 1b). Compact activity stream by default; advanced DAG and worktree graph on demand. Avoid representing each agent as a permanent chat tab. Review is centered on code changes, tests, and commit or merge readiness. Show real errors, waiting states, provider limitations, and recovery actions. Never describe a workspace as a sandbox or as secure; it is an isolated branch and worktree.

## Team UX
Presence is subtle; remote cursors only when collaborating. Comments and review suggestions live with the file/diff. Shared agent activity respects permissions. Explicit separation between personal and team context.

## Motion
Fast, purposeful transitions (roughly 120–200ms), no animation on critical input latency, reduced-motion support, no background motion loops. Favor instantaneous command interactions.

## Accessibility
WCAG 2.2 AA target, keyboard-only workflows, focus visibility, screen-reader semantics, sufficient contrast, zoom scaling, reduced motion, no color-only statuses, command palette access to all essential actions.

## Design acceptance
A new user can open a repo, create a workspace and run an agent, or switch to IDE view and start editing, without understanding orchestration. A power user can manage concurrent workspaces from the dashboard and jump from any file or diff to IDE view at the exact location, and back, without losing state. Every view switch works keyboard-only in all three modes. Primary actions remain discoverable in both compact and expanded states.
