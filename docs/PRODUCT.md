# Product Requirements

## Vision
One development workspace that allows a developer or team to code directly or delegate to multiple coordinated AI agents, using approved connections to several model providers and a shared, permissioned project intelligence layer.

## Audience
Solo developers, power users, software teams, and agencies. Support personal and organization workspaces with clear data ownership.

## Jobs to be done
- Open a repository and edit/debug/run it without losing normal IDE functionality.
- Ask an AI to explain, plan, implement, test, and review code.
- Delegate a goal to multiple workers without branch/file collisions.
- Compare or switch model/provider/accounts within permitted access scopes.
- Reuse approved context, rules, skills, decisions, and artifacts across projects.
- Invite teammates to work together, review agent changes, and share context with explicit access control.

## Feature inventory
### IDE
File explorer, multi-tab editor, splits, breadcrumbs, search/replace, symbols, command palette, keybindings, terminal, tasks, Git staging/diffs/merge, debugger, diagnostics, LSP, formatter, workspace settings, themes, extension support subject to compatibility testing, local and remote workspaces.

### AI interaction
Inline edit, chat, selection/context attachments, explain/fix/test/refactor, streaming patches, code citations, model/account switcher, capability display, request cost/usage where supported, conversation history, prompt templates, checkpoints and undo.

### Agents
Single and parallel runs, planner/worker/reviewer roles, graph of dependent tasks, isolated worktrees, budgets, permission requests, live logs, artifacts, review queue, diff preview, conflict resolution, merge, rollback, resumability, cancellation.

### Intelligence
Repository indexing, file/symbol graph, task and decision history, project rules, reusable skills, embeddings and keyword retrieval, provenance and TTL, cross-project knowledge with explicit scope and consent, redaction and deletion.

### Universal artifacts
Native workspace documents, structured plans, notes, diagrams, task boards and exportable reports. Slides and other artifacts can be added through native renderers or supported provider tools. Provider-branded features are only available when official APIs/integrations permit; offer functional equivalents otherwise.

### Teams
Organizations, invites, roles, permissions, project sharing, presence, co-editing, comments, shared agents, task assignment, review/approval, audit trail, sync and offline conflict handling.

### Extensibility
MCP client/server integration with scoped permissions, custom provider SDK, custom tools, skills/rules, extension compatibility where verified, future curated extension catalog.

## Non-goals for initial release
Reimplement every proprietary AI app feature; guarantee VS Code extension marketplace access; unrestricted autonomous deployments; automatic cross-tenant knowledge sharing; feature-identical browser and desktop shells.

## Core acceptance scenarios
1. Open repo → edit TypeScript → get diagnostics → run tests in terminal → commit.
2. Connect approved provider credential → select model → ask for change → review diff → apply or reject.
3. Launch planner with two coding workers → separate worktrees → tests → reviewer → user approval → merge.
4. Reopen workspace offline → edit, search, access local memory; sync when online and opted in.
5. Team member joins project → sees allowed context → co-edits → reviews agent output; denied access stays denied.
6. Unsupported provider capability is labeled unavailable, never silently emulated or misrepresented.
