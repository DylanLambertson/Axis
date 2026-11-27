# PV-T1 slice 3: worker revisions over the user's text (design note)

- **Status:** Built (journal schema version 19; `update_task.raise` in `bindings/agent-tasks.ts`; tests `migration-v19.test.ts` and `composer-tasks-guard.test.ts`).
- **Closes:** RR-93: a worker in an untainted run can rewrite the user's own task without asking, and after 50 of its own revisions the user's original text is gone for good (the store keeps the newest 50).
- **Builds on:** `tasks-store.md` §5 (the worker task tools) and §6 (Start). It decides two things: when `update_task` asks the user, and which revision the store never evicts.

## 1. What is wrong today

- `create_task` and `update_task` are tier `write`, below the broker's approval floor. A run that has received nothing untrusted writes without asking (IAC-T raises them to approval only once the run is tainted).
- A worker revision on top of the user's makes the task untrusted for good. That keeps Start safe: its dialog says UNTRUSTED and the started run is tainted. But the user's own words can be overwritten silently, and they are a step from being lost: 50 worker revisions evict the user's last one.

## 2. Options considered

| | Option | For | Against |
|---|---|---|---|
| A | `update_task` always asks, as `write_page` does | Simple; same rule as pages | A worker revising its own task asks every time; tasks are meant to be worked on, so this is heavy |
| B | A per-run cap on worker revisions (say 10 per task per run) | No new approval | Overwriting the user's text still needs no approval; the original is still lost after 5 runs |
| C | **Ask only when the revision replaced is the user's**, and never evict the user's newest revision | The user is asked exactly when their own words would be replaced; worker-over-worker edits stay free | Two changes (binding and journal) |

**Recommendation: C.**

## 3. The design (option C)

1. **`update_task` raises itself to `network` when it replaces the user's text.** The broker already lets a tool raise its tier from its arguments (`ToolDefinition.raise`, as git calls do). `update_task.raise(args)` reads the revision at `args.baseSeq`. If that revision's author is `user`, the call is raised to `network`, so it needs the user's approval in every run, tainted or not. Otherwise the tier stays `write`, as today.
   - The card is the existing one (`updateTaskPreview`: the revision it edits and the changed lines) and must be whole (`content-not-reviewable` otherwise).
   - `baseSeq` must be the newest revision, or the store refuses `stale_version`. A user edit between the raise and the write is therefore refused, never written over unasked.
   - The raise reads through the run's own scoped read (`readForRun`), so it can never tell the run more than a call would: a task the run cannot see, or a revision that does not exist, gives no raise. What the call then gets depends on the case, as today:
     - an untainted run, a task of its project, a positive `baseSeq` that names no revision: `stale_version` from the store;
     - an untainted run, a task it cannot see (another project's, or unknown): `not_found`;
     - a tainted run, a task it cannot see: `content-not-reviewable` before the call runs, with no card (the card has nothing to show).
   - The broker records the raised tier in `broker.decision`, so the audit says why the user was asked.
2. **The store never evicts the user's newest revision.** The eviction trigger (`task_revisions_advance`) deletes the oldest revision past the cap of 50 *other than* the newest revision whose author is `user` (`max(seq)` among the user's rows, never `min`). `task_revisions_kept` allows exactly that deletion. The comparison is written `seq IS NOT (SELECT max(seq) … author_kind = 'user')`, so a task with no user revision (the subquery is NULL) is pruned as before rather than never. A task therefore keeps the user's last words however many worker revisions follow. It still holds at most 50 revisions.
   - This is a journal schema change at the next free journal version at merge time (not fixed here: other slices hold versions in flight). The migration replaces the two triggers only; no data changes, and deleting a task still removes all its revisions.
3. **Nothing else changes.**
   - `create_task` stays tier `write`: a new task replaces no one's text.
   - The user's own edits (`axis.tasks/1.update`) are unchanged.
   - Taint, Start and the `untrusted` flag are as in §5-§6 of `tasks-store.md`.

## 4. Tests (mutation-proof)

The raise:

- An untainted run, `update_task` over a user revision: asks the user. Denied: nothing written. Approved: written, with `broker.decision` at tier `network`. The card must be whole: an untainted run's raised update too long to show is refused `content-not-reviewable` with no card.
- Over a worker revision: writes without asking.
- **Base, not newest.**
  - A worker base with a newer user revision (revision 1 by a worker, revision 2 by the user, `baseSeq` 1): no approval request, `stale_version`, nothing written, the last seq stays 2. The "no approval request" assertion kills the newest-author mutant (it would ask here) and the any-author mutant.
  - A user base with a newer worker revision (revision 1 by the user, revision 2 by a worker, `baseSeq` 1): exactly one card, `broker.decision` at tier `network`. Approved: `stale_version`, nothing written, the last seq stays 2. Denied: `approval-declined`, nothing written. The card assertion kills the newest-author mutant (it reads revision 2, a worker's, and does not ask) and the no-raise mutant. The store checks staleness only when the call runs, so the card comes first.
  - A race on the non-raised path: a user edit lands between the call and the write; `stale_version`, nothing written.
- A user edit between the card and the write: `stale_version`, nothing written.
- A user revision that kept a worker's text (it is the user's revision, so it still asks): the raise follows the author of the revision, not the trust of the text.
- The refusals of §3.1, each by its case: `stale_version`, `not_found` and `content-not-reviewable`, with no card for an invisible task.
- A tainted run: unchanged (it always asks).

The store:

- One user revision, then 60 worker revisions: the user's revision is still there and readable by `seq`; 50 revisions in all; the oldest worker revisions went first.
- **Two user revisions separated by worker revisions, then 60 worker revisions:** the LATER user revision is kept; the earlier one is pruned in turn as the oldest eligible; exactly 50 are kept.
- A task with no user revision (a worker's task), then 60 updates: pruned to 50 as before.
- The `kept` trigger refuses any other deletion; deleting the task still removes every revision.
- The migration over an existing populated journal: both triggers replaced, the data unchanged, the rules above hold on the migrated tasks.

Mutants:

- no raise; raise on any author; raise read from the newest instead of `baseSeq` (killed by both base-not-newest cases above);
- the eviction that ignores the author; **pin the oldest user revision** (`min` for `max`); `<>` for `IS NOT` (pruning off for tasks with no user revision);
- the `kept` trigger loosened.

## 5. What it leaves (RR-93, narrowed)

- A worker in an untainted run can still **create** tasks without asking (up to the project's 1,000). That is noise, not an overwrite: every task it creates is untrusted and attributed.
- The user can approve an overwrite without reading it. The card shows the change whole, as for every write.

## 6. What PV-T2 (the shell side of Start) needs from the daemon

For the own-shell plan. Most of it is served already. The gaps are marked.

1. **Task list and detail:**
   - `axis.tasks/1.list`, `get` and `revisions`, served.
   - Titles and bodies are untrusted text: show them as text only, never as markup.
   - Show `untrusted`, `hop` and each revision's author.
2. **The worker picker:** `axis.agents/1.list` for the task's project, served.
   - Show each worker's kind (composer or CLI) and name, and hide archived ones.
3. **Preview:** `axis.tasks/1.startPreview { taskId, worker }`, served. It returns:
   - the whole prompt, to show before anything starts;
   - its digest;
   - the worker's kind;
   - the task's source, `untrusted` and `hop`.
4. **Confirm:** `axis.tasks/1.start { taskId, worker, seq, promptDigest }` with an idempotency key, served.
   - The first call answers `E_APPROVAL_REQUIRED` with a tier-4 challenge (its id, digest, method, tier, target summary, expiry and `nativeConfirmationRequired: true`). **Main's native dialog is launched when the challenge is issued**, not when the user answers the card.
   - **The card is the shell's own, built from the `startPreview` answer it kept** (the whole prompt, the worker, the trust of the text) and the challenge. `axis.approvals/1.detail` serves plugin challenges only; it answers `not_found` for a task Start, and no new endpoint is planned. The card is bound to what it shows: `start` names the preview's `seq` and `promptDigest`, which are part of the request the challenge covers.
   - The user answers the card (`axis.approvals/1.resolve`). For a tier-4 challenge that answer is `approved, nativeRequired: true`, which is **not yet a grant**: the challenge waits for main's dialog.
   - The shell then retries `start` with `approval` and the same key. A retry before main's dialog has confirmed is refused `E_CONFLICT` and spends nothing, so the shell may retry after the dialog closes. The daemon sends no event that says the dialog's confirmation has completed (the other `axis.events/1` topics still flow, and the confirmation's audit row may raise a generic audit hint, which says nothing about this challenge). A confirmed challenge must be used within its short window, or it expires and the shell starts again from the first call.
   - On `stale_version`, preview again and ask again.
   - Refusals are the contract's closed reasons.
5. **The result:**
   - A composer worker returns `{ runId, workspaceId }`. Follow the run with `axis.runs/1` events (served).
   - A CLI worker returns `{ text }` for the user to copy (RR-95). The shell offers a copy button and opens the worker's terminal through the existing agent start.
6. **Status: built** (`tasks-store.md` §6, "The run on the task").
   - A composer Start adds a `run` link and sets `in_progress` in the same transaction as its `task.start` row.
   - The task view shows its run with no extra call.
   - A worker cannot trigger it. It happens only inside `axis.tasks/1.start`, the user's own tier-4 action that main's dialog confirms. The worker tools have no link or status call, and runs reach no `axis.tasks/1` row.
7. **Freshness: built.** The `tasks` topic of `axis.events/1` (`events.md` §1 and §4): an invalidation hint per project, `{ topic: "tasks", projectId }`, carrying no text; the shell then calls `list`, as for the other topics.
