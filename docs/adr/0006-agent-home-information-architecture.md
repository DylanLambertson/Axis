# ADR 0006: Agent home information architecture

- **Status:** Proposed. Becomes Accepted when the Phase 1c gate in `docs/ROADMAP.md` is met (validation criteria below). The owner decisions it records (O-1 to O-8, UI direction C) are decided; the engineering defaults it adds are decided and revisable.
- **Date:** 2026-11-21.
- **Decision owner:** Dylan Lambertson. The owner delegated every open decision to the project lead on 2026-11-21; the decisions are recorded in `docs/design/owner-decisions-2026-11-21.md`, and the owner can reverse any of them there.
- **Depends on:** ADR 0002 (Code OSS integration strategy), ADR 0003 (Electron IPC bridge), ADR 0004 (agent-first workspace shell) and ADR 0005 (packages layout), all Proposed. This ADR changes none of their security decisions.
- **Amends:** ADR 0004: the landing surface, the dashboard row unit and the terminology (section "Amendment to ADR 0004" below). ADR 0004's Phase 0 gate and validation criteria do not change.
- **Related:** `docs/design/product-vision-v2.md` (the proposal this ADR decides), `docs/design/product-vision-v2-tickets.md` (ticket PV-R1 and the tickets it unblocks), `docs/design/ui/directions.md` (direction C), `docs/design/inter-agent-communication.md` and `docs/design/messages-contract.md` (messaging, which addresses agents by id), `docs/design/forge-pr-list.md` (the pull request list), `docs/design/pv-v0-editor-embed.md` (the side-panel editor spike), `docs/CONTEXT.md` (Space).
- **Evidence tags:** **[V]** verified on `origin/main` at `6dcf226` or in an existing Axis document; **[I]** inferred, not verified.

## Context

### Owner direction

On 2026-11-06 the owner described Axis as an **agent home management system** (`product-vision-v2.md` §1): projects are made; agents are made inside a project and put into groups; agents of any type can talk to each other; the codebase sits beside the agents and can be edited there; the agent view is the main surface; opening a project first shows a dashboard (pull requests, usage and cost, run status, tasks); pages, plugins, tasks and integrations come later; the IDE is the second focus, reached by a toggle.

ADR 0004 already made the agent manager the primary surface and the IDE a switchable view in one window. That stays. What it does not have is the unit the owner manages: ADR 0004's dashboard lists **workspaces**, and an agent is only a run inside one.

### What exists on main

- `projects`, `agent_workspaces` and `agent_runs` (kind `composer` or `cli`) are journal tables. There is no agent or agent group table [V, `packages/journal/src/schema.ts`].
- A project is one registered repository with a canonical path chosen by the host and a `trusted` flag [V, schema version 4]. Registration from the app is not built: the owner decided on 2026-11-21 that main registers a project only after a confirmation main shows, and that a new project is untrusted until the user trusts it (owner decisions §5).
- Messaging is built ahead of agents. Its tables key agents by an opaque id (`message_participants.principal`, `messaging_agent_settings.agent_id`), and its directory knows no agent until ticket PV-G3 lands, so every agent recipient is refused today [V, `messages-contract.md` "Directory"].
- The shell has a workspace dashboard, a workspace view with a file tree and terminals (A1), a Changes view (A5) and approval cards (A4) [V]. The side-panel editor spike (PV-V0) recommends embedding the editor widget, with no upstream patch [V, `pv-v0-editor-embed.md` §1].
- The pull request list runs the user's `gh pr list` in the pty process and parses its output behind a planned `axis.forge/1` contract (PV-D2 slices 1a and 1b) [V].

## Options

| | Option | Main problem |
|---|---|---|
| A | Keep the workspace as the unit; agents stay runs | Does not meet the owner direction: an agent has no name, no type, no group and no lasting identity for messaging or usage |
| B | **Agent as a stored entity with one home workspace**, grouped, inside a project; the project home is the landing surface | A new table, contract and shell surfaces; the workspace becomes one level down in the UI |
| C | Agent as an entity with no fixed workspace (several workspaces, or none) | Every run path needs a worktree as working directory; drift, review and the commit lock are per workspace; one agent writing in several worktrees breaks WT-4 |

## Decision

Adopt **Option B**.

### 1. Hierarchy

```text
Space (personal in v1)
└── Project (one repository; its local checkout is listed, never an agent home)
    ├── Project home (landing surface)
    ├── Agent groups (optional, one level, ordered)
    │   └── Agents ── home workspace (one worktree + branch + base SHA) ── runs
    ├── Ungrouped agents
    └── Workspaces that no agent calls home (from before 1c, or detached)
```

Tasks, pages, plugins and integrations hang off the project when their phases ship (2a, 4a; decision 9).

### 2. Space

- The top container is a **Space** (O-1). "Workspace" keeps meaning one agent worktree (ADR 0004 terminology, unchanged).
- v1 has one personal Space per Axis data directory. **There is no Space record in 1c** *(engineering default)*: nothing in 1c is scoped by Space, so a table would only add a migration. Team Spaces (Phase 5) add the record, its membership and its scopes (`CONTEXT.md`).
- The Space level of the UI is the project list (name, repository, agents running, needs-attention count) and **Add project**.

### 3. Project

- A project is **one repository** in 1c (O-2). Multi-repository projects need their own design first, because worktrees, review and push are per repository.
- A project is registered only through the user's explicit **Add project** action: main registers it after the trust decision and a confirmation main shows, naming the folder, its repository root and its remote. Opening a folder in IDE view does not register it. A new project is **untrusted** until the user trusts it, and read-only surfaces (status, diff, review) work while it is untrusted.
- Trusted means both conditions of owner decisions §5: the folder is trusted in the Code OSS Workspace Trust model (ADR 0004 decision 12, unchanged) **and** a main-owned run-trust record, which renderers cannot write, says so; that record is set only from a native dialog main shows ("Trust to run"), never from a renderer message. The same dialog is the user-only, audited mark-trusted step, and `trust.check` answers `true` only when both hold.
- The user's own checkout is listed on the project home as the *local checkout*. No agent runs in it, and no agent can name it as a home (ADR 0004 decision 6).

### 4. Agent

An **agent** is a persistent, named record inside one project:

| Field | Rule |
|---|---|
| id | Opaque, generated by the daemon. Messaging, audit and usage refer to the agent by this id, never by its name |
| name | Chosen by the user; unique among the project's agents that are not archived; shown as escaped text |
| type | `composer` or `cli`, fixed at creation |
| launch | Composer: a provider connection id, a model and a default mode. CLI: the id of an `axis.cliAgents` entry (user scope, ADR 0004 amendment item 3). **Never a command, a path or a credential**: the daemon resolves the entry when a run starts, and a run whose entry is gone is refused with a reason |
| home workspace | Exactly one (decision 5) |
| group | At most one (decision 6) |
| archived | An archived agent starts no run and receives no message; its queued messages wait (`messages-contract.md`). The user can restore it while its home workspace exists |
| created by | The user (decision 10) |

### 5. Agent, workspace and run

| Rule | Decision | Source |
|---|---|---|
| Home workspace | **Each agent has exactly one home workspace.** New agent creates it (`axis.worktrees/1.create`, under the project mutex, idempotent) unless the user picks an existing workspace of the same project | O-3 |
| Several agents in one workspace | Only by the user's explicit choice ("attach to workspace"). The existing concurrent-writer rules apply: one active composer run per workspace, and Axis commit and push are refused while a CLI run is active there (ADR 0004 deferred item 4, amendment item 4) | O-3 |
| Agents without a workspace | **Not in 1c.** Revisit with the Phase 3 planner | O-4 |
| Project consistency | An agent, its home workspace and its group belong to the same project. The daemon checks this on every write and at run start, from its own records, never from the payload | engineering default |
| Run start | From 1c the shell starts composer and CLI runs **from an agent**: the daemon resolves the agent's home workspace and launch entry, and the caller cannot supply a command (PV-G4). An agent runs only while its home workspace is `READY` | engineering default |
| Run identity | Runs keep their ids. `agent_runs` gains `agent_id`; runs from before 1c keep a null agent and stay valid records under their workspace. A run with no agent takes part in no messaging (unchanged, `messages-contract.md`) | vision §3.2 |
| Archive | Archiving an agent never removes its workspace. Removing a workspace stays the existing tier-4 `remove` with native confirmation | vision §3.2 |
| Removing a home workspace | The confirmation names every agent whose home it is; those agents are archived in the same daemon transaction that starts the removal. No new destructive path | engineering default |
| Workspaces with no agent | Workspaces from before 1c, or whose agents were detached, are listed under the project's Workspaces. "Create agent here" makes the workspace that agent's home (an explicit choice) | engineering default |

### 6. Agent group

- One level, user-defined, ordered, inside one project. An agent is in at most one group (folder semantics). Deleting a group ungroups its agents; it never archives them.
- Uses: the side-panel tree, bulk actions (stop all runs, pause messaging), the messaging scope `accepts_from: group` (`inter-agent-communication.md` §4), and later per-group budgets.
- **A group is not a security boundary** for files, credentials or processes. It is an Axis policy scope for messages and bulk actions only, and UI copy must not suggest isolation.
- Because group membership feeds the send policy, assigning an agent to a group is a user-only write and is audited (decision 10).

### 7. Project home (landing surface)

Opening a project shows its **project home**. It follows `UX.md`: dense, actionable, text-first, no metric walls, no sample data. Sections, top to bottom (`product-vision-v2.md` §3.4):

| Section | Contents | Phase |
|---|---|---|
| Needs attention | approvals waiting (count per agent; opens the agent), failed runs, quiet CLI runs, drift and Git-config flags; unread messages to the user from 2a | 1c |
| Agents | one row per agent, grouped: type, state, current step, branch, changed files, last activity | 1c |
| Pull requests | "Your pull requests": **your** open pull requests (opened by the account `gh` is logged in as) on this project's confirmed GitHub repository whose head is an `axis/*` branch of that repository, as `forge-pr-list.md` §1 decides; number, title, branch, author, draft, checks, review state | 1c |
| Usage and cost | per agent and per project against the run budget (PRV-6); **CLI agents: "not available"** | 1c (needs J2, merged) |
| Run status | the last runs with state and reason | 1c |
| Tasks; pages and integrations | | 2a; 2a and 4a |

- The project home **never resolves an approval**; it opens the agent, where the full request is shown (ADR 0004 implication 4).
- Pull request data comes from the user's `gh`, read-only, with **no stored token** (O-5). The output is untrusted: parsed with a strict schema, bounded and escaped (`forge-pr-list.md`). If `gh`'s author narrowing fails its version gate, the fallback lists every same-repository `axis/*` pull request and the section is titled "Pull requests on axis/ branches" (`forge-pr-list.md` §1). A vault-token GitHub integration comes only in 4a, and only if the owner reverses D-9 ("Axis stores no forge credentials").
- Updates are polled first and pushed through server events (E1) once the shell consumes them.

### 8. Agent view layout

| Region | Contents |
|---|---|
| Top bar | unchanged (ADR 0004, `UX.md`); breadcrumb Project › group › agent |
| Navigation rail | direction C's labelled rail (decision 11): one icon and one word per destination. It shows **only destinations whose phase has shipped**: 1c has Home, Agents, Workspaces and Settings; 2a adds Threads, Tasks and Pages; 4a adds Plugins and Integrations. There are no "coming soon" entries |
| Side panel (left, collapsible) | **Agents** tab: groups and agents as a tree with state glyphs, New agent, New group. **Code** tab: the focused agent's worktree file tree, Changes and the embedded editor. A user-only switch shows the local checkout instead |
| Main area | **Home** (decision 7), **All agents** (one lane per agent: state, current step, waiting reason, changes) or **Agent** (the focused agent: activity stream, composer or terminal panes, diff review, its threads) |

- **Focus.** One agent is in focus at a time, and the focused workspace is its home workspace. Two agents attached to one workspace focus the same workspace, so the per-workspace view state (`axis.view.mode`) is reused as it is.
- **Side-panel editor: quick edits only** (O-8; `product-vision-v2.md` §3.5): the same text model as IDE view; its saves are user edits and mark "files changed outside the agent"; Open in IDE hands off at the same file and selection under the active view mode; no debugger, multi-group layout or extension UI; files of an untrusted repository open read-only. PV-V0 recommends the embed within the footprint budget; if PV-V2 exceeds ADR 0002 criterion 2, the Code tab opens files in the IDE split half instead.
- In `split` mode the side panel stays in the Agent half and file clicks open in the IDE half. The project home is never shown in the IDE half. New commands (`axis.sidePanel.toggle` and the tab focus commands) get bindings only after the check against the pin (`axis-agent-shell.md` §9.2).

### 9. Phases and extensions

- **Phase order** (O-7): Phase 1c "Agent home" is inserted after 1b; Phase 2 splits into **2a, agent collaboration** (messaging, tasks, pages) and **2b, IDE-view AI**; Phase 4 splits into **4a, extensibility** (plugins, integrations, MCP) and **4b, intelligence**. Gates 0, 1a and 1b do not change. `ROADMAP.md` carries the text.
- **No plugins before Phase 3** (O-6). Declarative and sandboxed-UI plugins stay in 4a; plugins that run code come only after the Phase 3 OS sandbox. Until then a project lists no plugin destination.

### 10. Who can change what

- Creating, renaming, archiving and restoring agents, and creating, renaming, reordering, deleting and assigning groups, are **user-only** writes, each with an audit event. No agent, plugin or message can make them. A composer agent has no tool that creates an agent or changes a group.
- No agent or group payload carries a path, a command or a credential; the daemon derives paths from its own records (ADR 0004 implication 2).
- The contracts are `axis.agents/1` and `axis.agent-groups/1` (PV-G2), with policy rows under the coverage check like every other contract.

### 11. UI direction

**Direction C** (`ui/directions.md` §4, §7): calm and precise, with a timeline axis in the activity stream, glyph statuses with text labels, keyboard hints and a lifted layer only for pending decisions and overlays. Two elements of direction B, the workspace spine and the activity trace, stay candidates for a later density setting. The token and UX changes C implies are listed in `ui/directions.md` §8 and are applied to `UX.md` by their own change.

## Owner decisions recorded here

Decided on 2026-11-21 under the owner's delegation (`docs/design/owner-decisions-2026-11-21.md` §1, §2). Each can be reversed by a new row in that record.

| # | Decision | Taken |
|---|---|---|
| O-1 | Name of the top container | **Space**. "Workspace" keeps meaning one agent worktree |
| O-2 | One repository or several per project | **One** in Phase 1c. Multi-repository projects later, with a design |
| O-3 | Agent to workspace | **One home workspace per agent**; attaching several agents to one workspace only by explicit user choice |
| O-4 | Agents without a workspace | **Not in 1c**; revisit with the Phase 3 planner |
| O-5 | PR data source | The user's `gh`, read-only, **no stored token**. A vault-token GitHub integration only in 4a, and only if D-9 is reversed |
| O-6 | Plugins before Phase 3 | **No.** Declarative and sandboxed-UI plugins stay in 4a; code-running plugins only after the OS sandbox |
| O-7 | Insert Phase 1c and split 2 and 4 | **Yes** |
| O-8 | Side-panel editor scope | **Quick edits only** (`product-vision-v2.md` §3.5 rule 4); fall back to the IDE split half if the PV-V0 spike exceeds the footprint budget |
| UI | Design direction | **Direction C**; B's workspace spine and activity trace stay candidates for a later density setting |

## Amendment to ADR 0004

ADR 0004's decisions are not rewritten; where wording differs, this section governs.

1. **Landing surface (decision 1).** The app opens on the **project home** of the last focused project, or on the Space's project list when there is none. Selecting an agent focuses it and its home workspace. "Workspace dashboard" in ADR 0004 now means the project home's Agents section and the Workspaces destination.
2. **Row unit.** The dashboard row is the **agent**, not the workspace. Workspace state (branch, changes, terminals, flags) appears on its agent's row and in the agent's view. A workspace that no agent calls home is listed under Workspaces (decision 5).
3. **Focus (decision 5).** "One workspace is in focus" becomes "one agent is in focus"; the focused workspace is that agent's home workspace, and everything ADR 0004 drives from the focused workspace (file tree, changes, terminals, composer, IDE view) follows it unchanged.
4. **Terminology (resolved question 6).** Confirmed by O-1: **Space** above projects, **Workspace** for one agent worktree. New terms: **Agent** (a stored, named, typed entity with one home workspace), **Agent group**, **Project home**. A run is still a run (`agent_runs`); the old phrase "the workspace's agents" means the agents whose home it is.
5. **Concept mapping.** Add: Agent (`agents` table, `axis.agents/1`), Agent group (`agent_groups`, `axis.agent-groups/1`), Project home (an Axis part over agents, runs, worktrees, the forge list and usage). The `agent_tasks` table named in ADR 0004's mapping does not exist; tasks arrive in 2a (`axis.tasks/1`).
6. **Unchanged.** Decisions 2 to 4 and 6 to 14, every security implication, the Phase 0 gate and the validation criteria.

## Security implications

1. **No new privilege.** Agents and groups are records over existing services. Creating an agent composes the existing worktree create; removing a workspace stays tier 4. The agent record holds no command, path or credential, so it cannot widen what a run can do (decision 4).
2. **Groups are not boundaries** (decision 6). Every agent runs with the user's privileges as before (ADR 0004 implication 1); a group changes only Axis's messaging and bulk-action scope. Group membership is a user-only write because the send policy reads it.
3. **Agent identity for messaging.** The agent id becomes the addressable principal that messaging already expects. Agent writes being user-only means no agent can mint a new principal, join a group or widen its own `accepts_from` scope.
4. **CLI agents keep ADR 0004's rules.** The launch entry is resolved from user-scope settings at run start (CFG-1, CLI-1); PTY-5, the Git snapshot and "governed by its own permissions, can push" apply to every CLI agent's runs unchanged.
5. **Untrusted inputs on the project home.** The pull request list is untrusted output of a user binary (`forge-pr-list.md`). Agent and group names are user text, and run reasons can carry agent text; all are shown escaped, with control and bidirectional characters made visible (as for dashboard rows in the 1a gate).
6. **Trust.** Project trust gates runs as ADR 0004 amendment item 2 does today, with trust meaning Workspace Trust **and** the main-owned run-trust record set only from main's native dialog (owner decisions §5, decision 3); an untrusted project's agents can be created and viewed but not run, and its side-panel editor is read-only.

## Consequences

- **Positive:** the product's unit matches the owner's model; messaging, usage and audit get a lasting agent identity; groups give bulk actions and a messaging scope without a new security concept; the shell keeps one focus rule because an agent maps to one workspace.
- **Negative:** a journal migration, two contracts, handlers and new shell parts (project home, side panel, All-agents surface) before Phase 2b. The IDE-view AI work (inline edit, checkpoints) moves later by the length of 1c.
- **Product:** the side-panel editor stays a quick-edit surface; anything more opens IDE view. CLI usage stays "not available" by design.

## Validation criteria

**Accept** this ADR when the Phase 1c gate in `ROADMAP.md` passes, including:

1. A project is added through main's confirmation, starts untrusted, and is trusted only from main's native dialog, which writes the main-owned run-trust record (owner decisions §5).
2. A composer agent and a CLI agent are created in two groups; each gets its own home workspace; both appear on the project home and the All-agents surface with live state.
3. An agent, group or assignment write from any actor other than the user is refused, and every accepted write is audited.
4. Removing a home workspace names its agents in the confirmation and archives them; archiving an agent removes no workspace.
5. A side-panel edit shows the drift indicator; hand-off to IDE view works keyboard-only in all three view modes; the footprint stays within ADR 0002 criterion 2.

**Revisit** if the side-panel editor cannot stay within criterion 2 (then the split-half fallback, O-8), if the owner reverses any of O-1 to O-8, or if Phase 3's planner needs agents without a workspace (O-4).

## Rollback

Before 1c ships, rollback is reverting this ADR and the docs that cite it: no code depends on it yet. After 1c, agents and groups are journal records behind contracts; dropping the UI leaves them in place, and the workspace dashboard can return as the landing surface without a data change.

## Tickets this unblocks

PV-R2 (the `ROADMAP.md`, `PRODUCT.md` and `UX.md` edits), PV-R3 and PV-R7; then PV-G1 to PV-G4, PV-D1 to PV-D4, PV-V1 to PV-V4 (`product-vision-v2-tickets.md` §3), and the project registration and trust slice (owner decisions §5).
