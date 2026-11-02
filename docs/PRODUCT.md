# Product Requirements

## Vision
Axis is an AI agent manager for software development, with a fully capable IDE built in. A developer or team runs coding agents in isolated workspaces, watches them work, reviews and commits their changes, and drops into a full IDE whenever they want to edit, debug or inspect code directly. Agents use approved connections to several model providers and a shared, permissioned project intelligence layer.

Axis is not a copy of VS Code. The agent manager is the primary surface; the IDE is a secondary view of the same workspace, one click or shortcut away, never a reduced editor. Product direction and its mapping to the architecture are recorded in ADR 0004.

## Audience
Solo developers, power users, software teams, and agencies. Support personal and team Spaces (the container above projects, `CONTEXT.md`) with clear data ownership.

## Product model
- **Workspace:** an isolated Git worktree and branch for one task or agent, with its agents, terminals and changes. A repository can have many workspaces at once. The user's own checkout of the repository is listed as the *local checkout*; it is not an agent workspace, and agents never run in it. Worktrees live outside the repository, under the Axis app data directory by default (ADR 0004).
- **Dashboard:** the home screen. It lists workspaces with their agents, status, terminals and changes. Selecting one focuses it.
- **Agent view:** the dashboard and the focused workspace's view: file tree, changes and diff review, terminals and panes, composer, agent activity.
- **IDE view:** the full IDE for the focused workspace.
- **View modes:** the user chooses a per-workspace toggle, a global toggle, or a side-by-side split. Clicking a file or a diff in Agent view opens the IDE at that location.

## Jobs to be done
- Start a task in an isolated workspace, hand it to an agent, and keep working on something else.
- See every workspace's agents, status, terminals and changes at a glance, and know which ones need me.
- Review an agent's changes as a diff, accept or reject them, and commit.
- Run commands and CLI tools in terminals bound to a workspace.
- Open any file or diff in a full IDE at the right location, and edit/debug/run without losing normal IDE functionality.
- Ask an AI to explain, plan, implement, test, and review code.
- Delegate a goal to multiple workers without branch/file collisions.
- Compare or switch model/provider/accounts within permitted access scopes.
- Reuse approved context, rules, skills, decisions, and artifacts across projects.
- Invite teammates to work together, review agent changes, and share context with explicit access control.

## Feature priorities
Priority follows `docs/ROADMAP.md`. The v1 agent manager is the Phase 1 slice, shipped as Phase 1a (agent workspace shell, CLI agents, diff review, IDE view) and then Phase 1b (composer, providers, vault, approvals); it is the product's first usable release target.

### 1. Agent manager (primary; v1 in Phases 1a and 1b)
- **Workspaces and worktrees:** create a workspace from a base branch with a new branch, recorded base SHA, list, focus, rename, archive and remove (removal refuses to discard uncommitted work without explicit confirmation). Several workspaces can exist and run agents at once, within a per-device limit.
- **Dashboard:** one dense row per workspace: name, branch, agents (composer and CLI agent runs) and their state (idle, running, waiting for approval, quiet (may be waiting for input), failed, done), terminals, changed files, last activity.
- **Terminals and split panes:** terminals bound to the workspace's worktree, split and arranged in panes, for running commands. Layout persists per workspace.
- **CLI coding agents (first-class):** launch the user's installed agent CLIs (for example, official provider CLIs) in a workspace terminal, through their documented command-line interfaces, under the user's own login and terms. Each launch is a run on the dashboard, with status from the process and terminal state Axis owns. The CLI's own permission prompts stay in its terminal; Axis surfaces them and does not override them. The CLI runs with the user's credentials and can push on its own; Axis says so at launch. Changes go through Axis diff review, and changes to the repository's shared Git configuration or hooks during the run are flagged. (Phase 1a)
- **File tree, changes and diff review:** file tree of the worktree; changed-files list against the workspace's base; diff review with accept and reject per file and per hunk; commit on the workspace branch with the user's Git identity; push the branch; open a pull request on GitHub (other forges: push only). Protected paths are highlighted. A "files changed outside the agent" indicator shows user edits made during a run. (Phase 1a)
- **Composer:** one composer with explicit Ask, Edit and Agent modes, bound to the focused workspace. v1 ships the mock provider and the Anthropic (Claude) API adapter with an API key in the connection vault, model selection within that connection, streaming, and an approval UI. (Phase 1b)
- **Agent activity:** live progress, tool calls, approvals requested, errors and recovery actions for the workspace's composer agent run. (Phase 1b)

### 2. IDE view (secondary, fully capable; v1 in Phase 1a)
File explorer, multi-tab editor, splits, breadcrumbs, search/replace, symbols, command palette, keybindings, terminal, tasks, Git staging/diffs/merge, debugger, diagnostics, LSP, formatter, workspace settings, themes, extension support subject to compatibility testing, local repositories. Remote repositories come later (the browser skeleton and remote workspace protocol are Phase 2).

### 3. AI interaction (beyond the v1 composer)
Inline edit in the IDE editor, selection/context attachments, explain/fix/test/refactor, streaming patches, code citations, model/account switcher across connections, capability display, request cost/usage where supported, conversation history, prompt templates, checkpoints and undo.

### 4. Agents (beyond a single agent per workspace)
Parallel runs on one goal, planner/worker/reviewer roles, graph of dependent tasks, one workspace per coding worker, budgets, permission requests, live logs, artifacts, review queue, conflict resolution, merge, rollback, resumability, cancellation.

### 5. Intelligence
Repository indexing, file/symbol graph, task and decision history, project rules, reusable skills, embeddings and keyword retrieval, provenance and TTL, cross-project knowledge with explicit scope and consent, redaction and deletion.

### 6. Universal artifacts
Native project documents, structured plans, notes, diagrams, task boards and exportable reports. Slides and other artifacts can be added through native renderers or supported provider tools. Provider-branded features are only available when official APIs/integrations permit; offer functional equivalents otherwise.

### 7. Teams
Organizations, invites, roles, permissions, project sharing, presence, co-editing, comments, shared agents, task assignment, review/approval, audit trail, sync and offline conflict handling.

### 8. Extensibility
MCP client/server integration with scoped permissions, custom provider SDK, custom tools, skills/rules, extension compatibility where verified, future curated extension catalog.

## Constraints
- Workspaces isolate edits, not privileges. They are Git worktrees, not security sandboxes, and the UI never describes them as secure (`SECURITY.md`, ADR 0004).
- Code-changing agents, composer or CLI, are launched only in workspaces, never with the user's local checkout or a shared writable checkout as working directory (`AGENT_SYSTEM.md`). This is a working-directory rule, not a security boundary.
- CLI agents run with the user's privileges and credentials under the CLI's own permission model: they can write outside the worktree and can push. Axis does not claim approvals, budgets or containment for them. Their terminals get no Axis secrets and none of the Code OSS, Electron or Git askpass/editor variables Axis or extensions inject (PTY-5, ADR 0004), and Axis flags changes to the repository's shared Git configuration and hooks after each run.
- Provider and CLI connections use official, documented paths only (`PROVIDERS.md`).
- The IDE view keeps full IDE capability; ADR 0002 criterion 1 applies to it.

## Non-goals for initial release
Reimplement every proprietary AI app feature; guarantee VS Code extension marketplace access; unrestricted autonomous deployments; automatic cross-tenant knowledge sharing; feature-identical browser and desktop shells.

## Core acceptance scenarios
1. Dashboard → create workspace from a base branch → worktree and branch created, base SHA recorded → run an agent in Agent mode (mock provider, then the Anthropic API) → approve a requested action → review the diff → accept some hunks, reject others → commit on the workspace branch → push the branch and open a pull request.
2. Focused workspace → launch an installed agent CLI from Axis → the run appears on the dashboard (running, quiet (may be waiting for input), exited) → the CLI's own permission prompt appears in its terminal and is answered there → its changes appear in diff review → accept → commit → push the branch → open a pull request (GitHub). The CLI's environment follows the PTY-5 rule.
3. Agent view file tree, changed file or diff hunk → IDE view opens at that file and line → edit → diagnostics appear → return to Agent view with workspace and editor state preserved. Repeat in split mode, where the file opens in the IDE pane.
4. Focused workspace → split terminal panes → run tests in one and a command in the other, both in the worktree → changes made by either appear in the changes list for review. Editing a file in IDE view during an agent run shows the "files changed outside the agent" indicator.
5. Open repo → edit TypeScript in IDE view → get diagnostics → run tests in terminal → commit.
6. Connect approved provider credential → select model → ask for change → review diff → apply or reject.
7. Launch planner with two coding workers → one workspace each → tests → reviewer → user approval → merge.
8. Reopen workspace offline → edit, search, access local memory; sync when online and opted in.
9. Team member joins project → sees allowed context → co-edits → reviews agent output; denied access stays denied.
10. Unsupported provider capability is labeled unavailable, never silently emulated or misrepresented.
