# Product Requirements

## Vision
Axis is an agent home for software development: projects, agents and groups, with a full IDE as the second view. A developer or team adds a project, creates agents of any type (Axis composer agents or the user's installed agent CLIs) inside it, organises them into groups, watches what each one is doing, reviews and commits their changes, and drops into a full IDE whenever they want to edit, debug or inspect code directly. Agents use approved connections to several model providers and a shared, permissioned project intelligence layer.

Axis is not a copy of VS Code. The agent home is the primary surface; the IDE is a secondary view of the same workspace, one click or shortcut away, never a reduced editor. Product direction and its mapping to the architecture are recorded in ADR 0004 and ADR 0006.

## Audience
Solo developers, power users, software teams, and agencies. Support personal and team Spaces (the container above projects, `CONTEXT.md`) with clear data ownership.

## Product model
The model is decided in ADR 0006: Space → Project → (Agent group) → Agent → home Workspace → runs.
- **Space:** the container above projects; personal in v1, team Spaces in Phase 5 (`CONTEXT.md`).
- **Project:** one repository (owner decision O-2), added by the user's explicit, confirmed **Add project** action. A new project is untrusted until the user trusts it in a dialog Axis's main process shows (owner decisions §5).
- **Agent:** a named, persistent agent inside a project, of type composer (a provider connection, model and default mode) or CLI (one of the user's configured agent CLIs). Each agent has exactly one home workspace; several agents share a workspace only by the user's explicit choice (O-3). Creating, renaming, archiving and grouping agents are user actions. (Phase 1c)
- **Agent group:** an optional, ordered, one-level folder of agents, used for the side panel, bulk actions and the messaging scope. A group is not a security boundary. (Phase 1c)
- **Project home:** the landing surface when a project opens: needs attention, agents, pull requests, usage and cost, run status; tasks and pages from Phase 2a. (Phase 1c)
- **Workspace:** an isolated Git worktree and branch, the home of one agent (or of several, by explicit choice), with its runs, terminals and changes. A repository can have many workspaces at once. The user's own checkout of the repository is listed as the *local checkout*; it is not an agent workspace, and agents never run in it. Worktrees live outside the repository, under the Axis app data directory by default (ADR 0004).
- **Dashboard:** in Phases 1a and 1b, the home screen listing workspaces with their runs, status, terminals and changes. From Phase 1c the project home replaces it, and its rows are agents.
- **Agent view:** the project home and the focused agent's view: activity, its home workspace's file tree, changes and diff review, terminals and panes, composer; a side panel with the agents and the code, where quick edits can be made.
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
Priority follows `docs/ROADMAP.md`. The v1 agent home is the Phase 1 slice, shipped as Phase 1a (agent workspace shell, CLI agents, diff review, IDE view), then Phase 1b (composer, providers, vault, approvals), then Phase 1c (projects, agents and groups, project home, side panel); it is the product's first usable release target.

### 1. Agent manager (primary; v1 in Phases 1a, 1b and 1c)
- **Workspaces and worktrees:** create a workspace from a base branch with a new branch, recorded base SHA, list, focus, rename, archive and remove (removal refuses to discard uncommitted work without explicit confirmation). Several workspaces can exist and run agents at once, within a per-device limit.
- **Dashboard:** one dense row per workspace: name, branch, agents (composer and CLI agent runs) and their state (idle, running, waiting for approval, quiet (may be waiting for input), failed, done), terminals, changed files, last activity.
- **Terminals and split panes:** terminals bound to the workspace's worktree, split and arranged in panes, for running commands. Layout persists per workspace.
- **CLI coding agents (first-class):** launch the user's installed agent CLIs (for example, official provider CLIs) in a workspace terminal, through their documented command-line interfaces, under the user's own login and terms. Each launch is a run on the dashboard, with status from the process and terminal state Axis owns. The CLI's own permission prompts stay in its terminal; Axis surfaces them and does not override them. The CLI runs with the user's credentials and can push on its own; Axis says so at launch. Changes go through Axis diff review, and changes to the repository's shared Git configuration or hooks during the run are flagged. (Phase 1a)
- **File tree, changes and diff review:** file tree of the worktree; changed-files list against the workspace's base; diff review with accept and reject per file and per hunk; commit on the workspace branch with the user's Git identity; push the branch; open a pull request on GitHub (other forges: push only). Protected paths are highlighted. A "files changed outside the agent" indicator shows user edits made during a run. (Phase 1a)
- **Composer:** one composer with explicit Ask, Edit and Agent modes, bound to the focused workspace. v1 ships the mock provider and the Anthropic (Claude) API adapter with an API key in the connection vault, model selection within that connection, streaming, and an approval UI. (Phase 1b)
- **Agent activity:** live progress, tool calls, approvals requested, errors and recovery actions for the workspace's composer agent run. (Phase 1b)
- **Projects, agents and groups:** add a project (explicit confirmation; untrusted until the user trusts it); create composer and CLI agents, each with its own home workspace; group them; archive an agent without removing its workspace. (Phase 1c)
- **Project home:** a dense, text-first landing surface: needs attention (approvals, failures, quiet CLI runs, Git-config flags), agents by group, the user's own open pull requests on `axis/*` branches, read through their own `gh` (read-only, no stored token; `docs/design/forge-pr-list.md`), usage and cost against the run budget (CLI agents: "not available"), run status. It never resolves an approval. (Phase 1c)
- **All agents and the side panel:** one lane per agent with state, current step, waiting reason and changes; a side panel with an Agents tab (groups, New agent, New group) and a Code tab (file tree, Changes and an embedded editor for quick edits, read-only for an untrusted project, with a one-step hand-off to IDE view). (Phase 1c)

### 2. IDE view (secondary, fully capable; v1 in Phase 1a)
File explorer, multi-tab editor, splits, breadcrumbs, search/replace, symbols, command palette, keybindings, terminal, tasks, Git staging/diffs/merge, debugger, diagnostics, LSP, formatter, workspace settings, themes, extension support subject to compatibility testing, local repositories. Remote repositories come later (the browser skeleton and remote workspace protocol are Phase 2).

### 3. AI interaction (beyond the v1 composer)
Inline edit in the IDE editor, selection/context attachments, explain/fix/test/refactor, streaming patches, code citations, model/account switcher across connections, capability display, request cost/usage where supported, conversation history, prompt templates, checkpoints and undo.

### 4. Agents (beyond a single agent per workspace)
Messaging between agents is in §9 (Phase 2a). Parallel runs on one goal, planner/worker/reviewer roles, graph of dependent tasks, one workspace per coding worker, budgets, permission requests, live logs, artifacts, review queue, conflict resolution, merge, rollback, resumability, cancellation.

### 5. Intelligence
Repository indexing, file/symbol graph, task and decision history, project rules, reusable skills, embeddings and keyword retrieval, provenance and TTL, cross-project knowledge with explicit scope and consent, redaction and deletion.

### 6. Universal artifacts
Project pages (Markdown) and the project task list come first, in §9 (Phase 2a). Beyond them: native project documents, structured plans, notes, diagrams, task boards and exportable reports. Slides and other artifacts can be added through native renderers or supported provider tools. Provider-branded features are only available when official APIs/integrations permit; offer functional equivalents otherwise.

### 7. Teams
Organizations, invites, roles, permissions, project sharing, presence, co-editing, comments, shared agents, task assignment, review/approval, audit trail, sync and offline conflict handling.

### 8. Extensibility
Phase 4a (`docs/design/extensibility.md`): Axis plugins, separate from Code OSS extensions (declarative and sandboxed-UI plugins; plugins that run code only after the Phase 3 OS sandbox, owner decision O-6); third-party integrations through a daemon credential proxy. MCP client/server integration with scoped permissions, custom provider SDK, custom tools, skills/rules, extension compatibility where verified, future curated extension catalog.

### 9. Collaboration (Phase 2a)
- **Messages between agents:** agents of any type and the user exchange messages through Axis, which carries every message and shows it to the user with its sender, type, provenance and hop. A message never approves anything. A run that reads another agent's message needs the user's approval for every side-effecting action that follows. CLI agents take part only when the user turns messaging on for them, and only by pulling messages. The user can pause messaging for a project (`docs/design/inter-agent-communication.md`).
- **Tasks:** a project task list, assignable to an agent or a group and linked to runs, workspaces, pull requests and pages. A task reaches an agent only when the user starts it, with the full prompt shown.
- **Pages:** project pages in a Markdown subset, rendered without script, readable by agents (as untrusted content) and written by them only with approval.

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
11. Space → Add project (folder, repository root and remote shown, confirmed) → the project starts untrusted → trust it → create a composer agent and a CLI agent in two groups, each with its own home workspace → both appear on the project home and the All-agents surface with live state → edit a file in the side panel → the "files changed outside the agent" indicator appears → Open in IDE lands on the same file and line → the project home lists the user's own open pull requests on `axis/*` branches from `gh`, and CLI usage reads "not available". (Phase 1c)
12. A composer agent sends a message to another agent → the user sees it in the thread with sender, type and hop → the receiving composer run gets it at its next turn and its next side-effecting action needs the user's approval, whose card lists the message → the user pauses messaging and no new message is delivered. A task assigned to an agent runs only after the user's Start. (Phase 2a)
