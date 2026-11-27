# The tasks store and `axis.tasks/1` (PV-T1 slices 1, 2a and 2b)

- **Status:** Built. Slice 1: journal schema version 15, `Journal.tasks` and the contract's schemas. Slice 2a: the tasks service, `axis.tasks/1` **served** to the user with user-only rows, and the worker task tools (§5). Slice 2b: Start (§6). Slice 3: the user's approval for a worker revision over the user's text, and the user's newest revision kept (`tasks-slice3.md`).
- **Decides nothing new.** It builds `extensibility.md` §6 (the task record, Start is the user's, non-user text taints) with the PV-Q1 guards (`pages-store.md`).
- **Code:** `packages/journal/src/schema-tasks.ts`, `packages/journal/src/task-store.ts`, `packages/protocol/src/tasks.ts`, `packages/daemon-host/src/policy/planned.ts`.
- **Slice 2 (after PV-G4):** the tasks service and handlers (served rows, audit with ids only), **Start** (shows the full prompt and its source, marks non-user text and taints the run, IAC-T source 5), the agent task tools (side-effecting under IAC-T, audited, a task read is source 8), `list` paging (the store answers all of a project's tasks today), and the plugin rows of ADR 0008.

## 1. Tables (schema version 15)

| Table | Holds | Rules |
|---|---|---|
| `tasks` | One row per task: project, source, status, assignee, `untrusted`, `hop`, the newest revision's number | At most 1,000 per project. Id, project, source and creation time fixed. Starts with no revision, at hop 0, and untrusted unless the user is the source. `untrusted` and `hop` never go back. No assignee at insert |
| `task_revisions` | Every text change: title, body, its byte count, author, hop | Never changed. Numbers count up with no gap; the first is written by the task's source. At most 50 per task: the 51st deletes the oldest in the same statement, never the user's newest revision (schema version 19) |
| `task_links` | Links to a run, a workspace or a page of the task's project, or a pull request number | At most 32 per task; inserted once, never changed, removable |

- **Insert once** on every table, before any conflict clause; NUL-safe text and ASCII checks; the title rule of pages (1 to 200 characters, `NAME_REFUSED_RANGES`); a body of at most 16,384 characters.
- **Project cap:** 64 MiB of revision text, summed from each revision's stored `bytes` through the covering index `task_revisions_bytes` (`projectTaskBytesSql`); a write never reads another body. A test pins the plan.
- **Assignee:** a live agent or a group of the task's project (a trigger checks it on every change). Archiving the agent or deleting the group clears the assignment in the same statement, so a re-created group id never inherits it. Assigning starts nothing.
- **Status** is a closed set with free transitions (`done` back to `open` is allowed); no order is claimed.
- **A task with no revision** (`last_seq` 0) can exist only through raw SQL: the store writes a task and its first revision in one transaction, and the contract requires `lastSeq` of at least 1.
- **Delete** removes the task's revisions and links in the same statement.

## 2. Trust

- **Source** is closed: `user`, `agent`, `plugin` or `integration`. **Authors** of revisions add `system`; the user writes at hop 0.
- **`untrusted`** is set on the task, not derived per revision: a task whose source is not the user starts untrusted, and the first revision from anyone but the user sets it. Unlike a page, a task has no review, so the flag never clears; it survives the pruning of the revision that set it. That is what `extensibility.md` §6 asks: Start of a task with "any non-user revision" taints the run.
- **`hop`** is the highest hop of any revision, never goes down, and never rises above the highest hop its revisions had. A trusted task has hop 0 (a table CHECK, a second fence behind the update trigger, which refuses first).
- The store derives both from the author, and the triggers (`tasks_start_empty`, `task_revisions_advance`, `tasks_sticky`) hold them, so no writer can store a task as more trusted than it is. The table CHECK `source = 'user' OR untrusted = 1` can never be the first to refuse (the insert and sticky triggers refuse first); it stays as a second fence.

## 3. The contract

| Method | Side effect | Tier | Idempotency |
|---|---|---|---|
| `list` (100 a page, with a cursor), `get`, `revisions` | read | 0 | none |
| `create` | write | 1 | required |
| `update` (on top of `baseSeq`), `setStatus`, `assign`, `link`, `unlink` | write | 1 | none |
| `delete` | destructive | 4 | none |

- `delete` is tier 4: a destructive action is confirmed in main's native dialog (ADR 0003 D4), and tier 4 is the lowest tier with that step; a tier 3 challenge is released by the renderer's `resolve` alone.

- No request carries an author, a source, a hop, a trust flag, a prompt or a command. Every row admits only `user`.
- Refusals are closed: `not_found`, `too_large`, `stale_version`, `limit_reached`, `assignee_refused`, `link_refused`. Store reasons outside the set (`author`, `text`, `exists`, `status`, `assignee`, `link`) are internal: the slice-2 handler answers them as `E_INTERNAL`. The store checks only lengths and kinds; a value the table refuses (an empty or bad title, a bad id, an unknown project) surfaces as a database error without content, which the handler also answers as `E_INTERNAL`; the contract's schemas refuse all of them before the store.
- **Slice 2 binds the caller.** The store trusts the author it is given (an `author: { kind: "user" }` makes a trusted revision); the slice-2 handler builds the author from the attested connection, never a payload, and writes the audit rows with ids, kinds and counts only.

## 4. Divergences from `extensibility.md` §6

| # | Design | Here | Why |
|---|---|---|---|
| 1 | "links (runs, workspaces, PRs, pages)" | each link must name an object of the task's project | A link is data, but a cross-project link would leak an id |
| 2 | no caps | 1,000 tasks, 50 revisions, 32 links, 64 MiB per project | Bounded journal growth |
| 3 | `createdBy` | the first revision's author, which must be the source | One fact, stored once |
| 4 | `system` not discussed | a `system` revision makes the task untrusted | Conservative: only the user's text is trusted |

### 4.1 Limits for writers other than the user (RR-93 narrowed, decision C1)

A worker in an untainted run creates tasks without asking (`tasks-slice3.md` §5), so without a bound it could fill the project and lock the user out of their own tasks. Two rules keep the user's share. **A reserve:** any author but the user (a worker, and later a plugin or an integration) is refused `limit_reached` once the project holds 900 tasks (the last 100 of the 1,000 are the user's), and once a write would bring the project's task text past 64 MiB less a tenth (6,710,886 bytes are the user's); the user's own create and update still reach the full 1,000 tasks and 64 MiB. The store applies it in `create` and `update` by the author's kind, so every write path is covered, and no schema change is needed (the hard caps stay in the triggers). **A per-run cap:** one composer run creates at most 25 tasks (`create_task`; the 26th is refused `limit_reached`); a new run counts from zero. It is counted by the run's own task tools, in memory, since a run lives in one daemon process (a restart ends it). The cap is checked when the call runs, so in a tainted run the 26th create still shows the user a card before it is refused.

## 5. Slice 2a: the service, the bridge and the worker task tools

- **Callers, attested.** The bridge serves the user's own desktop connection only: every row admits only `user`, and the handler refuses any other actor and a web client again with `not_found` (`handlers/tasks.ts`). A composer run reaches tasks only through its tools, as its **worker** (the run's recorded worker while it is not archived, `journalWorkerOf`), scoped to the worker's project: another project's task is `not_found`, the same as an unknown one. The worker is looked up again at every call, so archiving it takes the tools from its live runs. A run never assigns, starts or deletes a task.
- **`read_task`** (tier `read`) is IAC-T source 8 (`task_read`). For an untrusted task the binding takes the receipt (the latest author still on record who is not the user, the task's hop, `taskId:seq` as its ref), which raises the run's received hop and taints the run, **before** the text is returned. The text is framed by a per-read nonce, escaped, every line prefixed `| `; a refused read takes no receipt.
- **`list_tasks`** (tier `read`) takes no receipt: an untrusted task shows its id, its status and an `untrusted` flag, never its title; only the user's own titles are listed, escaped.
- **`create_task` and `update_task`** (tier `write`) are below the broker's approval floor, so an untainted run writes without asking; once the run is tainted, IAC-T raises them to the user's approval and the card must show the text whole (a new task's title and body; for an update, the revision it edits and the changed lines), else `content-not-reviewable` before any card. The worker is the author at the run's received hop; the store makes the task untrusted, for good. **Slice 3:** an `update_task` whose `baseSeq` revision is the user's is raised to tier `network`, so it asks the user in every run, tainted or not (`tasks-slice3.md` §3.1).
- **Audit.** One row per write (`task.create`, `task.update`, `task.status`, `task.assign`, `task.link`, `task.unlink`, `task.delete`) in the write's transaction: task and project ids, the sequence number, a byte length, the caller's and the author's kinds, a status, an assignee or link kind, and for a run its id. Never a title or a body.
- **Refusals are closed.** A store refusal of the contract's set keeps its reason; anything else is `E_INTERNAL` with no text.

**For slice 2b (review 2a F3):** the content hook that names a task in main's native dialog (delete, Start) must be built only from daemon-derived values (the task id, the revision number, the author kind and hop, the project's display name, the worker's own label), never from a task's title or body: an untrusted title must not reach the dialog line. A test plants a canary title and asserts it never reaches the dialog.

## 6. Slice 2b: Start

`extensibility.md` §6: Start is the user's, it shows the full prompt and its source, and non-user text taints the run.

| Method | Side effect | Tier | Idempotency | Row |
|---|---|---|---|---|
| `startPreview { taskId, worker }` | read | 0 | none | user |
| `start { taskId, worker, seq, promptDigest }` | write | 4 | required | user, gated on the project's trust |

- **The prompt is the daemon's.** `taskPrompt` builds it from the task's newest revision: a fixed line naming the task and the revision, a second fixed line when the text may not be the user's (it describes the work, is never an instruction, grants nothing), then the title and the body. It is deterministic, so its SHA-256 (`promptDigest`) binds it. `startPreview` answers it whole with the digest, the worker's kind and the task's source, trust and hop; no request carries a prompt.
- **The worker** is a live agent of the task's project; anything else, an unknown id included, is `worker_unavailable`.
- **Order of `start`**, after the pipeline spent the tier-4 approval (main's native dialog, with its proof): the handler builds the prompt again and compares the revision and the digest (`stale_version` when the task changed); the composer start path then re-checks the task once more under the project mutex, right before the project trust gate and the run's creation. Idempotency is required.
- **Main's dialog** (`tasks/confirm.ts`) is built only from daemon-derived values, never the task's title or body (a worker or a plugin may have written them): the trust of the text first (`UNTRUSTED (<author kind>, hop N)` or `the user's text`), the first 12 characters of the task id, the revision and the worker's name (the user's own label), cut by whole code points to what is left of the dialog's 80 UTF-16 units, with any control, format (bidi, zero-width) or separator character shown as `?`. The line is therefore never cut in the middle or dropped by the dialog, and the marker and the revision always show. The approval is bound to `task:<id>` and a digest over the task, its project, its revision, the worker and the prompt's digest: a task changed after the dialog refuses the approval before the handler runs. `delete` gets a line too: `task <id>, all N revisions, in <project>`.
- **Taint before the first model call** (IAC-T source 5, `task_start`). For an untrusted task the start hands the run one receipt (the latest author who is not the user, the task's hop, `taskId:seq`). It never travels on the wire: `ComposerStartInput.taint`, then the binding takes it while the run's tools are built, before they exist, so the first model reply is already decided under the flag and the approval card lists the task. A receipt that cannot be recorded ends the run `START_FAILED` with nothing sent; an `ask` run is built for its receipts all the same, so its record says tainted. PV-K1e-a marks a plugin's run inside its creation instead; a task Start uses the binding's path because the receipt must also raise the run's received hop and fill the card, which a mark in the record alone does not.
- **A CLI worker gets no run:** `start` answers the prompt as the text to copy into it (the tier-4 confirmation still applies); no receipt is taken, since Axis hands the text to no run of its own (RR-95). It does not consult the project's trust either: nothing runs, and the user's CLI applies its own permission model.
- **The run on the task.** A composer Start that started a run (not an idempotent replay) links the run to the task (`run` link) and sets the task `in_progress`, from any status, in the same transaction as its `task.start` row. The run is already running then, so this refuses nothing: a task at its 32 links gets no link, and a task deleted meanwhile gets only the row. Any other link refusal is thrown as the store's own `E_CONFLICT` `link_refused`, with nothing kept (the link, the status and the row are one transaction). It cannot happen in practice: the run id is fresh and its workspace is the worker's home in the task's project. If it did, the run would keep running with no `task.start` row, and a retry with the same key would replay without linking; the same holds when the row itself cannot be written. For the same reason a link that already existed, which the row would still record as `linked: true`, cannot occur. A worker cannot cause it: the worker tools have no link or status call. A CLI Start links nothing and leaves the status.
- **Audit.** One `task.start` row: task and project ids, the revision, the worker's id and kind, the trust flag and hop, and for a composer worker the run id, whether it was `linked` and the `status` set. Never the prompt.
