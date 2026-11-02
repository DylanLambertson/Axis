# UX and Visual Design System

## Design thesis
An agent manager first, with a full IDE one step away: closer to Paradev than to Cursor, with Linear-inspired precision and a distinct original identity. Minimal, dense where useful, calm by default. Accent color and boldness signal interaction, selection, focus, or meaningful status—not decoration. No gratuitous glows, gradient-heavy surfaces, metric walls, or oversized cards; the workspace dashboard is a dense, actionable list.

## Visual tokens (provisional)
Dark default: canvas `#111214`, surface `#181A1D`, raised `#202227`, border `#2B2E34`, primary text `#E8E9EB`, secondary `#9A9EA7`, muted `#70757F`. Light alternative: canvas `#FAFAFB`, surface `#FFFFFF`, border `#E5E7EB`, text `#17191D`. Interaction accent from the brand violet (hue 255°), configurable and sparingly used: `accent` `#5823F6` for filled primary controls in both themes (white label 7.0:1) and for text, links and focus in the light theme (6.7:1 on canvas); `accent-on-dark` `#9776F9` for text, links, icons and focus rings on dark surfaces (5.6:1 canvas, 5.2:1 surface, 4.8:1 raised). Status colors must meet contrast requirements and never be sole indicator.

## Brand
Brand assets live in `assets/brand/`: `axis-mark.svg` (symbol), `axis-logo-dark.svg` / `axis-logo-light.svg` (symbol and wordmark for dark / light backgrounds), and `axis-app-icon.svg` (1024px application icon on the macOS icon grid). `assets/brand/source/` holds the original raster artwork the vectors were derived from. Use the logo variant that matches the background; do not recolor, outline, rotate or stretch the mark. Keep clear space of at least the mark's corner radius around it, and prefer the symbol alone below 24px. The mark's gradients and the icon's glow are part of the logo only; product UI surfaces follow the flat token system above.

## Typography and spacing
System/Inter-like UI sans with strong legibility; code font user-selectable. 12–13px dense controls, 13–14px standard UI, restrained headings. 4px spacing grid, 28–34px compact rows, 36–40px primary controls. Use consistent 6–8px corner radii; near-zero shadows unless layering requires them. These are starting tokens to validate through prototypes.

## Surfaces
Axis has two views of the same workspace, in one window (ADR 0004). **Agent view** is the default and the home of the product. **IDE view** is the full IDE. Both share the top bar.

**Top bar (both views):** compact project switcher, command/search, agent activity indicator, account/model control, and the view control (Agent / IDE, or Split when that mode is on). In a workspace, a breadcrumb shows Dashboard › workspace › branch.

### Agent view: dashboard
- The home screen. One dense row per workspace, grouped by project: name, branch, agents (composer runs and CLI agent runs) and their state (idle, running, waiting for approval, waiting for input, failed, done), terminal count, changed-file count with additions/deletions, last activity.
- The project's own checkout appears as a *local checkout* row; it opens in IDE view, but no agent runs in it and it offers no agent actions.
- **CLI agent runs** show the CLI's name, the launch command and a status derived from the process and terminal Axis owns (running, waiting for input, exited with code, killed), never from the CLI's private data. Selecting one focuses its terminal. They are labelled "permissions: CLI-managed", and never show Axis approvals or budgets. A row whose run changed the repository's shared Git configuration or hooks shows a "Git config or hooks changed" flag in text.
- Primary action: **New workspace** (base branch, new branch name, optional first task, optional agent: composer or an installed CLI). Secondary: filter by needs attention / running / all; archive; remove.
- Selecting a row focuses that workspace and opens its workspace view. Rows that need the user (approval, failure) sort first within a project and show the reason in text, not only color.
- Empty state: open a repository, then create the first workspace. No sample metrics, charts or onboarding cards.

### Agent view: workspace view
- **Left:** file tree of the worktree and a **Changes** list (changed files against the workspace's base, with per-file counts). Collapsible.
- **Center:** the agent session: activity stream (progress, tool calls, approval requests, errors and recovery actions) with the **composer** docked below it. Selecting a change opens **diff review** in the center, with accept and reject per file and per hunk, **Commit**, and **Push branch** / **Open pull request** (GitHub; other forges push only); closing it returns to the session. Changes from composer agents, CLI agents and the user all appear here; a "files changed outside the agent" indicator marks user edits made during a run. Protected paths, and any change to the repository's shared Git configuration or hooks during a CLI agent run, are flagged at the top of the review with the before/after diff.
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
Each agent works in a workspace; the dashboard is the overview of all of them. Compact activity stream by default; advanced DAG and worktree graph on demand. Avoid representing each agent as a permanent chat tab. Review is centered on code changes, tests, and commit or merge readiness. Show real errors, waiting states, provider limitations, and recovery actions. Never describe a workspace as a sandbox or as secure; it is an isolated branch and worktree.

## Team UX
Presence is subtle; remote cursors only when collaborating. Comments and review suggestions live with the file/diff. Shared agent activity respects permissions. Explicit separation between personal and team context.

## Motion
Fast, purposeful transitions (roughly 120–200ms), no animation on critical input latency, reduced-motion support, no background motion loops. Favor instantaneous command interactions.

## Accessibility
WCAG 2.2 AA target, keyboard-only workflows, focus visibility, screen-reader semantics, sufficient contrast, zoom scaling, reduced motion, no color-only statuses, command palette access to all essential actions.

## Design acceptance
A new user can open a repo, create a workspace and run an agent, or switch to IDE view and start editing, without understanding orchestration. A power user can manage concurrent workspaces from the dashboard and jump from any file or diff to IDE view at the exact location, and back, without losing state. Every view switch works keyboard-only in all three modes. Primary actions remain discoverable in both compact and expanded states.
