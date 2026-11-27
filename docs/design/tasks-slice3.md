# PV-T1 slice 3: worker revisions over the user's text (design note)

- **Status:** Proposed, for review. No code until this note is accepted.
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
   - A task `baseSeq` does not name, or a task the run cannot see: no raise. The call is refused `not_found` as today, with no card.
   - The broker records the raised tier in `broker.decision`, so the audit says why the user was asked.
2. **The store never evicts the user's newest revision.** The eviction trigger (`task_revisions_advance`) deletes the oldest revision past the cap of 50 *other than* the newest revision whose author is `user`. `task_revisions_kept` allows exactly that deletion. A task therefore keeps the user's last words however many worker revisions follow. It still holds at most 50 revisions.
   - This is a journal schema change: the next free version after checking `main`, with a migration of the two triggers only. No data changes.
3. **Nothing else changes.**
   - `create_task` stays tier `write`: a new task replaces no one's text.
   - The user's own edits (`axis.tasks/1.update`) are unchanged.
   - Taint, Start and the `untrusted` flag are as in §5-§6 of `tasks-store.md`.

## 4. Tests (mutation-proof)

- An untainted run: `update_task` over a user revision asks the user. Denied: nothing written. Approved: written, with `broker.decision` at tier `network`. Over a worker revision it writes without asking.
- A user edit between the card and the write: `stale_version`, nothing written.
- A tainted run: unchanged (it always asks).
- The store: 60 worker revisions on top of one user revision. The user's revision is still there and readable by `seq`; there are 50 revisions in all; the oldest worker revisions went first. The trigger refuses any other deletion.
- Mutants: no raise, raise on any author, raise read from the newest instead of `baseSeq`, the eviction that ignores the author, the `kept` trigger loosened.

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
   - The first call answers `E_APPROVAL_REQUIRED` with a tier-4 challenge.
   - The shell shows its card: `axis.approvals/1.pending` and `detail`. The user resolves it, and main draws the native dialog.
   - The shell then retries with `approval` and the same key.
   - On `stale_version`, preview again and ask again.
   - Refusals are the contract's closed reasons.
5. **The result:**
   - A composer worker returns `{ runId, workspaceId }`. Follow the run with `axis.runs/1` events (served).
   - A CLI worker returns `{ text }` for the user to copy (RR-95). The shell offers a copy button and opens the worker's terminal through the existing agent start.
6. **Status: GAP.**
   - A Start does not link the run to the task or move it to `in_progress`. Proposed for the daemon: `start` adds a `run` link and sets `in_progress` in the same transaction as its `task.start` row.
   - Then the task view shows its run with no extra call.
7. **Freshness: GAP.** `axis.events/1` has no tasks topic, so the shell would have to poll `list`. Proposed: a `tasks` topic (an invalidation hint per project, no text).
