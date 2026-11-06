# Product vision v2: the agent home

- **Status:** Proposed (planning only). Nothing here changes `docs/ROADMAP.md`, `docs/PRODUCT.md`, `docs/UX.md` or an ADR. Proposed edits to those files are collected in §6 and need the owner's approval before they are applied.
- **Date:** 2026-11-05. Verified against `origin/main` at `74cd12e`.
- **Decision owner:** Dylan Lambertson.
- **Companion files:** `docs/design/inter-agent-communication.md` (messaging between agents), `docs/design/extensibility.md` (plugins, pages, tasks, integrations), `docs/design/product-vision-v2-tickets.md` (ticket breakdown and ADR list).
- **Evidence tags:** **[V]** verified on `origin/main` or on the named branch at the stated commit; **[B]** exists only on an unmerged branch or open PR; **[I]** inferred or uncertain; **[N]** new, nothing exists.

## 1. The owner's direction (2026-11-05)

Restated from the owner's words, item by item:

1. Projects can be made.
2. Inside a project, agents are made, and agents can be put into groups.
3. Agents can talk to each other whatever their type: composer agents or any CLI agent.
4. Next to the agents, on the side, is the codebase, and the user can edit it there.
5. The agent view is the main surface. It shows what each agent is doing.
6. Opening a project first shows a dashboard: pull requests, usage and cost, run status, tasks.
7. Users can make pages, install plugins, keep tasks and connect third-party integrations.
8. Axis is an **agent home management system**. The IDE editor is the second focus, reached by a toggle.

### 1.1 In repository terms

ADR 0004 (Proposed) already made the agent manager the primary surface and the IDE a switchable view in the same window. v2 keeps that decision and changes three things:

- **The unit the user manages becomes the agent, not the workspace.** Today a workspace (one worktree and branch) is the dashboard row, and runs (`agent_runs`, kind `composer` or `cli`) happen inside it. An *agent* is not a stored entity anywhere on main [V: `packages/journal/src/schema.ts` has `projects`, `agent_workspaces`, `agent_runs`, no agent or group table]. v2 adds a persistent, named agent with a type, a home workspace and an optional group.
- **The landing surface becomes a project home dashboard**, one level above the per-workspace list that `UX.md` describes.
- **The product grows a collaboration and extension layer:** messages between agents, tasks, pages, plugins and integrations. Today `PRODUCT.md` puts these in §4 (agents), §6 (universal artifacts) and §8 (extensibility), spread over Phases 3, 4 and "long-term".

What does not change: worktrees are not sandboxes (`SECURITY.md`, ADR 0004 implication 1); no agent runs in the local checkout; CLI agents stay governed by their own permissions and Axis never answers for them (ADR 0004 decision 10); all privileged work stays in the daemon behind ADR 0003; approvals are resolved only by the user (DMN-3).

### 1.2 Terminology collision (needs an owner decision)

The owner's sentence says "workspace → project → groupings". In tracked Axis documents **"workspace" means one agent worktree** (ADR 0004 terminology, decided), and the container above projects is a **Space** (`CONTEXT.md`). This document uses the decided terms:

| Owner's word | Axis term used here | Notes |
|---|---|---|
| workspace (the top container) | **Space** | Personal Space in v1; team Spaces are Phase 5 |
| project | **Project** | One repository today (`projects` table, journal migration J1, #59) [V] |
| grouping | **Agent group** | New [N] |
| agent | **Agent** | New entity [N]; its runs are today's `agent_runs` |
| (the agent's worktree) | **Workspace** | Unchanged |

Recommended default: keep "Space" in documents and UI. If the owner prefers "workspace" for the top level, every existing use (journal tables, protocol contracts `axis.worktrees/1`, ADR 0004, the shell code from #429) has to be renamed first, which is a large, risky churn. Decision O-1 in §7.

## 2. Each ask mapped to what exists

"Phase" is the proposed placement (§5). Packages are `@axis/*` under `packages/`.

| # | Ask | Exists on main [V] | In flight [B] | New [N] | Proposed phase |
|---|---|---|---|---|---|
| 1 | Make projects | `projects` table (J1, #59); `axis.projects/1` contract (#44) and its `list` handler over the real host (H12, #445); registration through the supervisor control channel, main only (`daemon-host-plan.md` §3 Q4, still open); shell dashboard from read-only discovery (A1, #429) | none for this row (the daemon utility process entry and main seam, X1, merged in #454 after this plan was drafted) | "New project" flow (pick a local repository; clone from URL later), project settings, project archive | 1a for registration (already required); UI flow in 1c |
| 2 | Make agents inside projects | Runs, not agents: `@axis/runs` CLI supervisor (#39), `axis.cli-runs/1` handlers (H10, #430), user-scope `axis.cliAgents` launch entries (`@axis/pty-policy`, #19); `agent_runs.kind` `composer`/`cli` | composer runtime C1, `axis.runs/1` on the mock provider (branch `feat/composer-runtime`, not merged) | `agents` record (name, type, launch config, home workspace, group), `axis.agents/1` contract, agent create = workspace create + record | 1c |
| 3 | Group agents | nothing | nothing | `agent_groups` record and contract; groups as folders in the side panel and as a messaging scope | 1c |
| 4 | Agents talk to each other, any type | nothing; relevant controls exist: user-only resolve (`@axis/challenge`, #21), digest-bound single-use consume (APR-1), audit chain (`@axis/audit`, #26), secret scanner (`@axis/secret-scan`, H9-scan, #425) | server events E1 (branch `feat/events-e1`); pty process B9 (branch `feat/pty-process`); composer C1 | daemon-mediated message service, composer tools, a CLI endpoint; see `inter-agent-communication.md` | 2a |
| 5 | Codebase on the side, editable | workspace view with a Files tree (`ExplorerView` subclass) and terminals (A1, #429) [V]; the full editor in IDE view | Changes view (shell task A5) | a side panel with an Agents tab and a Code tab holding an embedded editor that shares text models with IDE view | 1c |
| 6 | Agent view shows what each agent is doing | dashboard rows (A1); CLI run status from process and terminal (`axis.cli-runs/1.get/list`) | composer activity as a polled `axis.runs/1.events` stream (C1); push events E1 | a multi-agent surface (one lane per agent with state, current step, waiting reason, changes) | data in 1a/1b; surface in 1c |
| 7 | Project dashboard: PRs, usage, run status, tasks | "open a pull request" through the user's `gh` or the compare URL (`axis.git/1.compareUrl`, H9, #431); per-run token and cost budget `createRunBudget` (`@axis/providers`, #24); no PR listing; no usage persistence | composer usage in memory only (C1); usage columns are journal ticket J2 (`composer-runtime.md` §5) | project home part; PR list read through the user's `gh`; usage aggregation; attention summary | 1c (tasks section when tasks exist, 2a) |
| 8 | Pages | nothing; `PRODUCT.md` §6 "native project documents" is unscheduled ("long-term" in `ROADMAP.md`) | nothing | project pages (Markdown first), rendered without script; see `extensibility.md` §5 | 2a |
| 9 | Plugins | Code OSS extensions in IDE view from public open-vsx.org (Q-7), fully trusted (EXT-1); `extensions.autoUpdate` off (M3 Stage 1b, #68); signed/unsigned/tampered install test is an open 1a gate line (EXT-3) | nothing | an Axis plugin contract separate from Code OSS extensions; see `extensibility.md` §3–4 | 4a |
| 10 | Tasks | `agent_tasks` is named in ADR 0004's concept mapping and `IMPLEMENTATION.md`, but **no such table exists** [V: `schema.ts`]; planner DAG is Phase 3 | nothing | project task list, assignable to an agent or group, linked to runs, workspaces, PRs and pages | 2a (manual); 3 (DAG uses it) |
| 11 | Third-party integrations | GitHub only through the user's `gh`; Axis stores no forge credentials (ADR 0004 decision 9, engineering addition); MCP is Phase 4 | nothing | integration framework with a daemon credential proxy over `@axis/vault` (#31); see `extensibility.md` §7 | 4a; read-only GitHub via `gh` in 1c |
| 12 | Agent home first, IDE second, toggled | ADR 0004 Option B; `axis.view.mode` per-workspace, global and split; view switching in the shell (A1, #429) | Phase 0 gate items still open (ADR 0004 is Proposed) | framing and copy; side-panel editor hand-off rules (§3.6) | 1c (copy in `PRODUCT.md` after approval) |

## 3. Information architecture

### 3.1 Hierarchy

```text
Space (personal in v1)
└── Project (one repository; its local checkout is listed, never an agent home)
    ├── Project home dashboard (landing surface)
    ├── Agent groups (optional, one level, ordered)
    │   └── Agents
    │       ├── type: composer (provider connection, model, default mode) or CLI (an axis.cliAgents entry id)
    │       ├── home workspace: one worktree + branch + base SHA (WT-4)
    │       ├── runs (agent_runs), activity, changes, terminals
    │       └── messages (threads it takes part in)
    ├── Ungrouped agents
    ├── Tasks
    ├── Pages
    ├── Plugins enabled for this project
    └── Integrations connected for this project
```

### 3.2 Agent, workspace and run

| Rule | Recommended default | Why |
|---|---|---|
| An agent has exactly one home workspace | Yes; creating an agent creates its workspace (`axis.worktrees/1.create`) unless the user picks an existing one | Keeps WT-4 (one worktree per worker) and the drift rules that already exist |
| Several agents in one workspace | Allowed only by explicit choice ("attach to workspace"), with the existing concurrent-writer rules (ADR 0004 deferred item 4: Axis commit and push refused while a CLI run is active) | The rules exist; making it the default would multiply drift |
| One active composer run per agent | Yes (C1 enforces one per workspace [B]) | Unchanged |
| Deleting an agent | Archive the record; removing its workspace is the existing tier-4 `remove` with native confirmation | No new destructive path |
| Agents without a workspace (planner or reviewer that only reads and messages) | Not in 1c; open question O-4 | Every current run path needs a worktree as cwd |
| Run identity | Runs keep their ids; `agent_runs` gains `agent_id` | Audit and recovery code keyed by run stays valid |

### 3.3 Agent groups

- One level, user-defined, ordered; an agent is in at most one group (folder semantics).
- Uses: side-panel grouping, bulk actions (stop all runs, pause messaging), the default messaging scope (`inter-agent-communication.md` §4), later per-group budgets (C10 is per-workspace today).
- **A group is not a security boundary** for files, credentials or processes. It is only an Axis policy scope for messages and bulk actions. UI copy must not suggest isolation.

### 3.4 Project home dashboard (landing surface)

Opening a project shows its home. It follows the `UX.md` thesis: dense, actionable, text-first; no metric walls, no sample data. Sections, top to bottom:

| Section | Contents | Source | Phase | Notes and limits |
|---|---|---|---|---|
| Needs attention | approvals waiting (count per agent, opens the agent), failed runs, quiet CLI runs (may be waiting for input), drift and Git-config flags, unread messages to the user | `axis.approvals/1.pending`, run lists, review flags | 1c | Never resolves an approval from the dashboard (ADR 0004 implication 4) |
| Agents | one row per agent, grouped: type, state, current step, branch, changed files, last activity | agents + runs + worktrees status | 1c | Same states as today's rows |
| Pull requests | open PRs for `axis/*` branches of this project: number, title, branch, checks state, review state | the user's `gh` (`gh pr list` with JSON output) run in the pty-process context under the user's login | 1c | Read-only. No forge credential stored (ADR 0004 decision 9). Output is untrusted: parsed with a strict schema, bounded, display-escaped. Without `gh`: the section says so and offers the compare URL. Other forges: not shown |
| Usage and cost | per agent and per project: tokens, requests, cost where the provider reports pricing, against the run budget (PRV-6) | composer usage, persisted by J2 | 1c after J2 | **CLI agents: "not available".** Axis never reads a CLI's private stores (ADR 0004 decision 8). A CLI's documented usage output, if any, is out of scope until verified per CLI |
| Run status | last N runs with state and reason codes | `axis.cli-runs/1.list`, `axis.runs/1.list` | 1c | |
| Tasks | open tasks, assignee, linked run or PR | `axis.tasks/1` | 2a | |
| Pages and integrations | recently edited pages; connected integrations with health | `axis.pages/1`, `axis.integrations/1` | 2a / 4a | |

Updates: polled in 1a (plan Q5) and pushed once E1 merges. PR data is cached with a minimum refresh interval (recommended 60 s, manual refresh button) to stay within forge rate limits [I].

### 3.5 Agent view (main surface) and the side panel

Layout of the Agent view in v2 (replaces the per-workspace-first layout in `UX.md` "Agent view" once approved):

| Region | Contents |
|---|---|
| Top bar | unchanged: project switcher, command/search, activity indicator, account/model control, view control (Agent / IDE / Split); breadcrumb Project › group › agent |
| Side panel (left, collapsible, resizable) | **Agents tab:** groups and agents as a tree with state badges, New agent, New group. **Code tab:** the focused agent's worktree file tree, Changes list, and an **embedded editor** for quick edits. A switch shows the local checkout instead (user-only; agents never run there) |
| Main area | **Home** (the dashboard above), **All agents** (one lane per agent: state, current step, last tool call or terminal activity, waiting reason, changes count), or **Agent** (the focused agent: activity stream, composer or terminal panes, diff review, its message threads) |
| Right rail (optional) | message threads and tasks for the focused agent |

**Side-panel editor rules (new):**

1. It is a real Code OSS editor widget over the **same text model** as IDE view, so dirty state, undo and diagnostics are shared and switching never forks a buffer [I: embedding cost and footprint to be measured against ADR 0002 criterion 2].
2. Edits there are user edits: they mark "files changed outside the agent" and composer runs get the drift notice (ADR 0004 decision 10), exactly as IDE view edits do.
3. "Open in IDE" (and Enter on a file) hands off to IDE view at the same file and selection, following the active `axis.view.mode`.
4. It is for quick edits: no debugger, no multi-group layout, no extension UI contributions beyond what the editor widget hosts. Anything more is IDE view. This keeps the IDE "second focus, toggled" and avoids building a second IDE.
5. Trust: files of an untrusted repository open read-only there (Restricted Mode, ADR 0004 decision 12).

### 3.6 IDE view, toggle and split

ADR 0004 decision 4 stands: `perWorkspace` (default), `global`, `split`. v2 adds:

- The toggle target follows the focused **agent's** workspace (an agent maps to one workspace, so the existing per-workspace state is reused).
- In `split`, the side panel stays in the Agent half; file clicks open in the IDE half (unchanged rule).
- The project home dashboard is never shown in the IDE half.
- Keyboard: one new command, `axis.sidePanel.toggle`, and focus commands for the Agents and Code tabs; bindings to be checked against the pin as in `axis-agent-shell.md` §9.2 (no binding proposed here).

### 3.7 Pages, plugins, tasks, integrations in the navigation

A project-level navigation (in the side panel above the tabs, or as a rail; decided in the UI directions work, §8): Home, Agents, Tasks, Pages, Integrations, Plugins, Settings. Plugins can add a page, a dashboard section, a side-panel tab or a task provider, only through declared contribution points (`extensibility.md` §3.3).

## 4. Effort and risk, honestly

- **Agent entity and groups (1c):** small in the daemon (a table, a contract, handlers; patterns exist), medium in the shell. Risk: low for security if groups stay non-security scopes.
- **Project home dashboard:** medium. The PR section runs a user binary and parses its output: a new untrusted-input path that needs review. Usage for CLI agents will stay "not available"; the owner should expect that.
- **Side-panel editor:** **high uncertainty.** Embedding the editor widget in an Axis part outside the upstream editor part, with shared models, focus routing and the ADR 0002 criterion 2 budget (at most 12 upstream files, 300 lines), is unproven. A spike is the first ticket (V0). Fallback: the Code tab opens files in a split IDE half instead of an embedded editor.
- **Inter-agent messaging:** **high risk, large.** It creates a new path by which untrusted text from one agent reaches another agent's model or a CLI with the user's credentials. Composer-to-composer is buildable on existing controls; CLI participation needs a new local endpoint and an amendment to PTY-5. Estimate: several large tickets plus a threat-model revision.
- **Plugins and integrations:** **largest risk.** Code-running plugins have no containment until the Phase 3 OS sandbox; v1 plugins should be declarative plus sandboxed UI only (`extensibility.md` §3.2).
- **Pages and tasks:** medium, low-to-medium risk if rendering stays script-free and task text is treated as untrusted when it becomes a prompt.
- **Schedule effect:** adding 1c before Phase 2 delays the IDE-view AI work (inline edit, checkpoints). That matches "IDE second", but it is a real delay, and the Phase 0 gate (IDE view criterion 1) is still the first blocker for everything.

## 5. Proposed phase placement and order

Gates 0, 1a and 1b are **not changed**. The proposal inserts one phase and splits two.

| Phase | Contents | Status |
|---|---|---|
| 0, 1a, 1b | as in `ROADMAP.md` | unchanged |
| **1c — Agent home (new)** | agent entity and groups; project home dashboard v1 (attention, agents, PRs via `gh`, usage after J2, run status); All-agents surface; side panel with Agents and Code tabs and the embedded editor (after the V0 spike); E1 server events in the UI | proposed |
| **2a — Agent collaboration (new split)** | inter-agent messaging (composer and user first, then CLI through the endpoint); tasks v1; pages v1 (Markdown); dashboard Tasks and Pages sections | proposed |
| **2b — IDE-view AI** | today's Phase 2 contents unchanged (inline edit, context attachments, switcher, checkpoints, browser skeleton) | renamed only |
| 3 | unchanged; the planner DAG builds on 2a tasks and messages; OS sandbox | unchanged contents |
| **4a — Extensibility (split, first)** | Axis plugins (declarative and sandboxed UI; code plugins only inside the Phase 3 sandbox), integrations with the credential proxy, MCP | proposed reorder |
| **4b — Intelligence** | indexing, memory, rules, skills, retrieval | today's Phase 4 remainder |
| 5, 6 | unchanged | unchanged |

Order rationale: 1c needs only shipped 1a/1b services plus E1. Messaging needs the composer (1b) and B9. Plugins with code need the OS sandbox (Phase 3), so pulling them before Phase 3 would ship uncontained third-party code; that is why 4a stays after 3 even though the owner lists plugins early. Declarative plugins could move earlier if the owner wants (decision O-6).

## 6. PROPOSED ROADMAP AND PRODUCT EDITS (not applied)

> Everything in this section is a proposal. It is applied only after the owner approves it, in a separate change that also updates ADR 0004's status text.

**`docs/ROADMAP.md`:**

1. Add after Phase 1b:
   > **Phase 1c — Agent home.** Agents (named, typed, one home workspace each) and agent groups; project home dashboard (needs attention, agents, pull requests through the user's `gh`, usage and cost for composer runs, run status); All-agents surface; side panel with Agents and Code tabs and an embedded editor sharing text models with IDE view; server events. **Gate:** create a project, create a composer agent and a CLI agent in two groups, see both on the dashboard and the All-agents surface with live state; edit a file in the side panel and see the drift indicator; the PR section lists a stub `gh`'s output escaped, and refuses malformed or oversized output; CLI usage shows "not available"; keyboard-only walkthrough of the side panel and hand-off to IDE view in all three modes; footprint measured against ADR 0002 criterion 2.
2. Split Phase 2 into **2a — Agent collaboration** (messaging, tasks, pages; gate lines from `inter-agent-communication.md` §11 and `extensibility.md` §9) and **2b — IDE-view AI** (today's Phase 2 text and gate, unchanged).
3. Split Phase 4 into **4a — Extensibility** (plugins, integrations, MCP, provider SDK, CLI sessions as provider connections; the existing "plugin contract tests" gate item moves here) and **4b — Intelligence** (the rest of today's Phase 4 and its gate items).
4. Replace "Recommended first 10 tickets" only after 1a ships; until then, add a pointer to `docs/design/product-vision-v2-tickets.md`.

**`docs/PRODUCT.md`:** rewrite "Vision" to "an agent home for software development: projects, agents and groups, with a full IDE as the second view"; add Agent and Agent group to "Product model"; add the project home dashboard; move tasks and pages from §4/§6 into a "Collaboration" section; add acceptance scenarios for 1c and 2a.

**`docs/UX.md`:** add the project home dashboard (§3.4), the side panel and its editor rules (§3.5), and the inter-agent thread view; keep "no metric walls" (usage is numbers in rows, not charts).

**ADR 0004:** an amendment, not a rewrite: the landing surface is the project home; the dashboard row unit is the agent; terminology per O-1. Its Phase 0 gate and validation criteria do not change.

## 7. Owner decisions for this document

| # | Decision | Recommended default |
|---|---|---|
| O-1 | Name of the top container | Keep **Space**; do not rename "workspace" |
| O-2 | Does a project hold one repository or several | One in 1c; multi-repository projects later, with a design (worktrees, review and push are per repository) |
| O-3 | Agent to workspace | One home workspace per agent; attaching several agents to one workspace only by explicit choice |
| O-4 | Agents without a workspace | Not in 1c; revisit with the Phase 3 planner |
| O-5 | PR data source | The user's `gh`, read-only, no stored token; a GitHub integration with a vault token only in 4a, and only if the owner reverses ADR 0004 decision 9's engineering addition "Axis stores no forge credentials" (`extensibility.md` D-9) |
| O-6 | Plugins before Phase 3 | Declarative and sandboxed-UI plugins may move to 2a if wanted; code-running plugins only after the OS sandbox |
| O-7 | Insert Phase 1c and split 2 and 4 (§5) | Yes |
| O-8 | Side-panel editor scope | Quick edits only (§3.5 rule 4); fall back to the IDE split half if the V0 spike exceeds the footprint budget |

## 8. Impact on the UI mockups

Screens to add to the design directions work. Each needs dark and light variants, keyboard focus order and the empty state; none uses sample metrics.

1. **Project home dashboard:** needs-attention block, agents table grouped by group, PR table (with the "no `gh`" and "other forge" states), usage rows per agent with budget bars as text plus a thin bar (CLI rows say "not available"), run status, tasks and pages sections (2a).
2. **Agent groups:** side-panel Agents tab with groups, drag to reorder, New agent and New group dialogs, the agent type picker (composer: connection and model; CLI: an `axis.cliAgents` entry, with the "governed by its own permissions, can push" disclosure), bulk actions.
3. **All-agents surface:** one lane per agent with state, current step, waiting reason and changes; density at 5, 20 and 50 agents.
4. **Inter-agent thread view:** sender and recipients with type badges (user, composer, CLI, plugin), provenance labels, the "untrusted content" marker, refused-message notices, hop and rate-limit notices, per-agent mute, the project **Pause messaging** kill switch; an approval card next to a thread must look unlike any message.
5. **Side panel with editable code:** Agents and Code tabs; file tree, Changes list, embedded editor with dirty state, "Open in IDE", Restricted Mode read-only state, local-checkout switch; behaviour in split mode.
6. **Navigation for pages, plugins, tasks and integrations:** the project nav; pages list and a page (Markdown, no script); task list and task detail with "assign to agent" (shows the full prompt that will be sent); plugin install dialog (publisher, hash, signature state, permissions, network origins) and permission-increase dialog on update; integration connect flow (system browser), connected-integration health and revoke.
7. **Settings:** per-agent messaging (accept from: none, group, project), per-project messaging pause, retention.
