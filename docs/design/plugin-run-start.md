# Runs started by a plugin (ticket PV-K1e)

- **Status:** PV-K1e-a built (service level, inert). PV-K1e-a2 (approval routing) and PV-K1e-b (the handler) are not built.
- **Date:** 2026-11-22. Implements ADR 0008 decision 6, rules 1 and 2, and criterion 14 in three slices.

## 1. PV-K1e-a: the service (built)

- `ComposerStartInput.initiator` is `{ kind: "user" }` or `{ kind: "plugin", pluginId, generation }`. The handler builds it from the
  attested identity only; the wire schema of `axis.runs/1.start` has no such field, so a request cannot name one (tested). Absent
  means the user, and a user start is unchanged.
- A plugin start is recorded with `createdBy` `plugin:<id>` (the journal's actor rule is now the audit log's `ACTOR_PATTERN`); no
  transition of the run is the user's.
- **Taint first.** The run is tainted with source `plugin_output` (IAC-T source 6) inside the journal transaction that creates it,
  before its activity opens and before any model call. The mark and its `message.taint` audit row go to the journal's own
  database: if either fails, nothing is created and the start is refused (`taint_unrecorded`). Without the host's
  `taintAtStart`, a plugin start is refused (`plugin_starts_unavailable`). Source 6 stays PV-K4's for every other plugin output.
- **Inert.** The `axis.runs/1` handler still refuses every actor but the user (`E_NOT_FOUND`), so nothing reaches this from the wire.

## 2. PV-K1e-a2: the approval card (a2-1a built; a2-1b and a2-2 not built)

A tier-3 challenge is bound to the requesting connection's window today, so a plugin start's challenge would sit on `p<n>`, which
the plugin cannot resolve and the user cannot see, and a listed challenge carries only a 192-character summary. PV-K1e-a2 sends the
challenge to the attested host window, adds a bounded, daemon-escaped `detail` with the full prompt, and amends ADR 0003 D4.

**Tier 3 is resolved in the renderer.** Native confirmation exists only at tier 4, so the protection of a plugin start is the taint,
the full prompt on the card and an approval for each side effect of the run, not a native dialog.

Slices, released in this order (each inert until the next):

- **a2-1a (built): the issue counter**, journal schema version 17, `plugin_challenge_issues` and `journal.pluginIssues`. At most 6
  challenges per plugin and project in any hour (OI-2, OI-10), counted in SQL, so a disable and enable, a revoke or a restart does
  not reset it. The newest row is the table's clock: inserts older than it are refused and the store clamps its time to it, so a
  system clock that steps back opens no fresh hour. Rows never change; the one delete is the prune of rows more than 24 hours older
  than the newest, which can never remove a row that still counts. At most 16,384 rows (`issue_cap`). Nothing calls it yet.
- **a2-1b: the gate.** A plugin's challenge goes to the attested host window, the plugin learns only its id, one pending per plugin,
  four open per host window, the counter above, the binding (grant generation, host window) re-checked at resolve, detail and
  consume, the optional closed `requester` on listed challenges and `axis.approvals/1.detail`. The gate refuses every plugin
  challenge until PV-K1e-b wires its plugin dependency.
- **a2-2: the renderer** reader (accepts the optional `requester`, strict `detail` reader) and the card.
- **PV-K1e-b must not merge before a2-2**: it is the first producer of plugin challenges, and today's strict listing reader would
  refuse a listing carrying `requester`.

### 2.1 The counter's residual (RR-94) and what an operator does

- **A row dated in the future.** The newest row is the counter's clock, so if the host clock is stepped forward (days or years)
  for one call and then corrected, every later issue of every plugin is recorded at that future time: each plugin and project gets
  at most 6 more challenges, and then none until the real time passes the future row. This fails closed: plugins are blocked,
  user approvals are not. No plugin can move the host clock.
- **The shared row cap.** The 16,384 rows are shared by every plugin and project, so about 114 plugin-project pairs at the full
  rate for a day hold every other plugin at `issue_cap` until the prune catches up. Also fail closed.
- **No in-product repair, on purpose.** The triggers refuse to delete or change a row that may still count, so no code path (and no
  bug) can reopen a plugin's hour. Recovery is the operator's: wait until the real time passes the future row (or a day passes for
  the cap); or, with the daemon stopped, repair the journal offline (a copy of the database, the issue table's rows deleted with
  its triggers dropped and recreated from the v17 migration). That offline step is not shipped in the product and is not a
  supported command.

## 3. PV-K1e-b: the handler (waits for a2)

`forcedScope` in the same PR, the project trust gate through the host window, the grant's generation bound into the challenge, the
OI-2/OI-10 bounds, and `axis.review/1.diff`'s `acknowledged` still refused for plugins. CLI starts never.

## 4. Open for the owner

Whether a plugin run start should be tier 4 (cost, side effects): see the tickets table, row PV-K1e-T4.

## 5. What K1e-a does not enforce (review F-notes)

- **A stale grant generation is not refused here.** K1e-a checks that `generation` is a positive integer and that the plugin id has the attested shape; it does not compare the generation with the stored grant. K1e-b's handler reads the K1b grant and binds the generation into the challenge (a2 adds the host-window binding), so a disable, revoke or generation change refuses the start there. Nobody should assume the service checks it.
- **`initiator` is required** in `ComposerStartInput`: a caller that forgets it does not compile, so a missing initiator can never mean "the user" by default. Today the runs handler passes `{ kind: "user" }`; K1e-b builds a plugin initiator from the attested identity only.
- **The initiator is read once** into locals before any check, and the taint hook must finish inside the creation: a missing hook or a hook that returns a promise refuses the start with nothing created.
