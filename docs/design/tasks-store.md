# The tasks store and `axis.tasks/1` (PV-T1 slice 1)

- **Status:** Built (slice 1): journal schema version 15, `Journal.tasks`, and the **planned** contract `axis.tasks/1` with user-only planned policy rows. Nothing is served yet.
- **Decides nothing new.** It builds `extensibility.md` §6 (the task record, Start is the user's, non-user text taints) with the PV-Q1 guards (`pages-store.md`).
- **Code:** `packages/journal/src/schema-tasks.ts`, `packages/journal/src/task-store.ts`, `packages/protocol/src/tasks.ts`, `packages/daemon-host/src/policy/planned.ts`.
- **Slice 2 (after PV-G4):** the tasks service and handlers (served rows, audit with ids only), **Start** (shows the full prompt and its source, marks non-user text and taints the run, IAC-T source 5), the agent task tools (side-effecting under IAC-T, audited, a task read is source 8), `list` paging (the store answers all of a project's tasks today), and the plugin rows of ADR 0008.

## 1. Tables (schema version 15)

| Table | Holds | Rules |
|---|---|---|
| `tasks` | One row per task: project, source, status, assignee, `untrusted`, `hop`, the newest revision's number | At most 1,000 per project. Id, project, source and creation time fixed. Starts with no revision, at hop 0, and untrusted unless the user is the source. `untrusted` and `hop` never go back. No assignee at insert |
| `task_revisions` | Every text change: title, body, its byte count, author, hop | Never changed. Numbers count up with no gap; the first is written by the task's source. At most 50 per task: the 51st deletes the oldest in the same statement |
| `task_links` | Links to a run, a workspace or a page of the task's project, or a pull request number | At most 32 per task; inserted once, never changed, removable |

- **Insert once** on every table, before any conflict clause; NUL-safe text and ASCII checks; the title rule of pages (1 to 200 characters, `NAME_REFUSED_RANGES`); a body of at most 16,384 characters.
- **Project cap:** 64 MiB of revision text, summed from each revision's stored `bytes` through the covering index `task_revisions_bytes` (`projectTaskBytesSql`); a write never reads another body. A test pins the plan.
- **Assignee:** a live agent or a group of the task's project (a trigger checks it on every change). Assigning starts nothing.
- **Delete** removes the task's revisions and links in the same statement.

## 2. Trust

- **Source** is closed: `user`, `agent`, `plugin` or `integration`. **Authors** of revisions add `system`; the user writes at hop 0.
- **`untrusted`** is set on the task, not derived per revision: a task whose source is not the user starts untrusted, and the first revision from anyone but the user sets it. Unlike a page, a task has no review, so the flag never clears; it survives the pruning of the revision that set it. That is what `extensibility.md` §6 asks: Start of a task with "any non-user revision" taints the run.
- **`hop`** is the highest hop of any revision, and never goes down.
- The store derives both from the author, and the triggers (`tasks_start_empty`, `task_revisions_advance`, `tasks_sticky`) hold them, so no writer can store a task as more trusted than it is. The table CHECK `source = 'user' OR untrusted = 1` can never be the first to refuse (the insert and sticky triggers refuse first); it stays as a second fence.

## 3. The planned contract

| Method | Side effect | Tier | Idempotency |
|---|---|---|---|
| `list` (100 a page, with a cursor), `get`, `revisions` | read | 0 | none |
| `create` | write | 1 | required |
| `update` (on top of `baseSeq`), `setStatus`, `assign`, `link`, `unlink` | write | 1 | none |
| `delete` | destructive | 3 | none |

- No request carries an author, a source, a hop, a trust flag, a prompt or a command. Every row admits only `user`.
- Refusals are closed: `not_found`, `too_large`, `stale_version`, `limit_reached`, `assignee_refused`, `link_refused`. Store reasons outside the set (`author`, `text`, `exists`, `status`, `assignee`, `link`) are internal: the slice-2 handler answers them as `E_INTERNAL`.

## 4. Divergences from `extensibility.md` §6

| # | Design | Here | Why |
|---|---|---|---|
| 1 | "links (runs, workspaces, PRs, pages)" | each link must name an object of the task's project | A link is data, but a cross-project link would leak an id |
| 2 | no caps | 1,000 tasks, 50 revisions, 32 links, 64 MiB per project | Bounded journal growth |
| 3 | `createdBy` | the first revision's author, which must be the source | One fact, stored once |
| 4 | `system` not discussed | a `system` revision makes the task untrusted | Conservative: only the user's text is trusted |
