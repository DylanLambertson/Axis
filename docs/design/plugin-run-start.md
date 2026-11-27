# Runs started by a plugin (ticket PV-K1e)

- **Status:** PV-K1e-a, a2-1a, a2-1b and PV-K1e-b built. a2-2 (the card) on hold for the own-shell plan (ADR 0011). No plugin can be granted
  `runs.start` in production yet: the grant contract is PV-K2's, so the path is open in code and unreachable in practice.
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

## 2. PV-K1e-a2: the approval card (a2-1a and a2-1b built; a2-2 on hold)

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
- **a2-1b (built): the gate** (`daemon-host/src/gate/plugin-approvals.ts`). A plugin's challenge is issued with the plugin as
  requester on its own connection (only it consumes the approval) and the attested `hostWindowId` as its window (only the user's
  connection there lists, reads and resolves it; another window of the same user is refused, as for every challenge). The
  plugin's `E_APPROVAL_REQUIRED` carries `{ challenge: { challengeId } }` only; every other requester's details are unchanged.
  The binding the daemon builds (`PluginChallengeDeps.bind`: the full request and a `valid()` check of the grant generation and the
  host window) is checked at issue, at resolve, at each detail read and before the approval is spent (an approved plugin challenge
  keeps its binding until then); one that no longer holds ends the challenge. Bounds: one open challenge per plugin, four per host
  window, then the hourly counter (a refusal by a bound spends nothing of the hour); tier 4 is refused. Listed challenges carry
  the optional closed `requester`; `axis.approvals/1.detail` (tier 0, user rows only, never a web client or a plugin, the same
  `E_NOT_FOUND` for every refusal, audited by reference) returns the request, the prompt escaped and whole up to 65,536 units
  (a longer one is refused at issue). The challenge manager accepts `plugin:<id>` as a requester (the audit log's rule); only
  `user` resolves. **Inert:** without `PluginChallengeDeps` (the host composition passes none until PV-K1e-b) every plugin
  challenge is refused before it exists, which is stricter than before (the challenge used to be issued to the unresolvable
  `p<n>`).
- **a2-2: the renderer** reader (accepts the optional `requester`, strict `detail` reader) and the card. **On hold** (owner
  direction, 2026-11-26): the product gets its own shell instead of Code OSS (ADR 0011), so the card waits until that plan names
  where it lives. The design assumed Code OSS in two places only: the strict listing reader to update is the Code OSS overlay's
  (`axisDaemonReplies.ts` `readPendingChallenges`), and the "renderer" that resolves a tier-3 card is the Code OSS workbench. The
  daemon, protocol and journal parts do not depend on the shell.
- **PV-K1e-b must not merge before a2-2** (or its own-shell replacement): it is the first producer of plugin challenges, and
  today's strict listing reader would refuse a listing carrying `requester`.

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

## 3. PV-K1e-b: the handler (built: `gate/plugin-run-start.ts`, `handlers/composer-runs.ts` `startPluginComposerRun`)

PV-K1e-b opens `axis.runs/1.start` to a plugin connection, and nothing else of `axis.runs/1`. It is daemon work only: it does not
need the renderer, but it must not merge before the card exists (a2-2 or its own-shell replacement, section 2).

**First commit: the a2-1b review follow-ups (mandatory before anything produces plugin challenges).**

1. **S1, fail closed at the spend.** In the gate's `execute`, a spend from a plugin connection (`identity.clientKind === "plugin"`)
   whose challenge has no tracked binding is refused with `E_CONFLICT` before `manager.consume`. Today the binding check passes
   silently when no entry exists. That is unreachable only because the entry outlives the manager's token, and no test pins it.
   Test: approve near the end of the challenge's life, then spend. That kills the reviewer's mutant O2, which sets the entry's
   lifetime to the challenge TTL alone.
2. **N4, free the slot sooner.** A spend the manager ends without running (a request or content mismatch, an expired token)
   forgets the plugin entry at once, so a failed spend does not hold the plugin's one open slot for about 90 s.
3. **N6, the window quota.**
   - Option one: a withdrawn plugin challenge leaves no manager tombstone against the host window's quota of 16. With four
     plugin challenges per window and several granted plugins, withdrawals can briefly crowd out the user's own approvals there.
   - Option two: if the manager cannot exempt it cleanly, record the crowding as a residual.
4. **N1.** A test of the `input.actor !== input.identity.actor` refusal, or a comment that it is defence in depth behind the
   bind check.
5. **N3.** The `endUnbound` comment says that any call on the id may trigger it (a bystander included) but the withdraw always
   uses the requester's identity, and that this ends only a challenge whose binding already failed.
6. **Docs.**
   - The status line of this file says which slices are built.
   - The ADR 0003 amendment adds that any code in the host window's renderer can resolve a tier-3 challenge, so the protection
     is the taint, the card and an approval per side effect, not proof of the user's intent.

**As built, beyond the plan below.**

- `axis.runs/1.start` takes an optional `approval` reference, as any method the policy can raise to tier 3 must; a user's
  tier-2 start never sends one.
- The run's own approvals (its tool calls) go to the host window: the plugin view cannot answer one.
- The service checks the grant once more in its synchronous creation step (`ComposerStartInput.grantHolds`), after every wait of
  the start (the trust gate, the provider's model list). A plugin start without that check is refused.

**Order of the checks.** The pipeline runs the policy first, then the approval step (with a content hook), then the handler. For
a plugin each step does this:

1. **Policy** (built in PV-K1b): the plugin's own branch. `runs.start` must be granted in the pinned project and the plugin must be
   enabled; the tier is raised to 3. A disabled or ungranted plugin is refused here, before any challenge or card.
2. **Content hook** (new, `axis.runs/1.start`, plugin callers only; a user start keeps its tier-2 path with no hook). It runs
   `forcedScope` first: the workspace must belong to the project the connection is pinned to (`identity.workspaceId`), else
   `out_of_scope`, with nothing issued. Its target is `workspace:<id>`. Its content digest covers the plugin id, the grant
   `generation` read now from `journal.plugins.state`, the host window, the workspace, mode, provider, model and the prompt's
   SHA-256. A disable, a revoke, or anything else that moves the generation therefore fails the spend (the manager's digest check,
   OI-3) even if every other check were missed.
3. **Gate** (a2-1b): `PluginChallengeDeps` is wired here for the first time, in `compose.ts`.
   - `bind` builds the detail from the journal (the project's and workspace's display names) and the request: the prompt escaped,
     and refused at issue if it would not fit.
   - `valid()` re-reads `journal.plugins.state`: still enabled, `runs.start` still granted, the same generation.
   - `issues` is `journal.pluginIssues` and `now` is the daemon clock.
   - The host window needs no check of its own. Main destroys a plugin view with its host window (`plugin-views.ts`
     `destroyHost`), so the plugin connection closes and `withdrawConnection` ends its challenges. K1e-b adds a test that a host
     close withdraws them.
4. **Handler**, inside the project mutex:
   - `forcedScope` is run again on the parsed request, so the gate's answer is never trusted alone.
   - `valid()` is re-read under the mutex, the TOCTOU check, before the run is created.
   - The trust gate is called with `trustCallOf(identity)`. For a plugin that is T3 on the host window and T4 on both windows
     (PV-K1c), refused unless the identity is attested.
   - The initiator is built from the attested identity only: `{ kind: "plugin", pluginId, generation }`, with the generation read
     under the mutex. Any request field that names an initiator is refused by the schema (a test).
   - The service then creates the run, tainted inside its creation (K1e-a).

**Bounds** (OI-2, OI-10): one open challenge per plugin, four per host window, six per plugin and project an hour. The hourly
count is in SQL, so a disable and enable or a restart does not reset it. All three are a2-1b's and are applied by the wired gate.
K1e-b adds no further bound.

**Still closed to plugins:**
- every other `axis.runs/1` method;
- `axis.agents/1.start`, which shares `startComposerRun` (the deny list keeps it closed: "every agent and group write");
- CLI starts, never;
- `axis.review/1.diff`'s `acknowledged`, which a plugin can never set (K4 opens review reads, and must refuse or strip it).

**Shell independence (ADR 0011).** Nothing above names Code OSS. K1e-b depends on three things from the shell:
- main mints the plugin identity with a `hostWindowId`;
- main destroys a plugin's views with their host window;
- a card in the host window reads `axis.approvals/1.detail` and resolves the challenge.

The own-shell plan must keep the first two as they are (today `daemon-host/src/main/plugin-views.ts`) and say where the third
lives.

**Tests:**
- out-of-scope workspace (by id and through a workspace of another project), refused before any challenge;
- disabled, ungranted and unknown plugin, refused by the policy;
- spoofed initiator field, refused;
- full flow (issue, the user resolves in the host window, the plugin consumes, the run is created as `plugin:<id>` and tainted);
- generation change after issue, after resolve, and under the mutex, each refused with nothing created;
- host window close, which withdraws the challenge;
- a seventh start in an hour, refused across a disable and enable;
- a CLI start and an agents start by a plugin, refused.

**Mutants:**
- forcedScope dropped from the hook, and from the handler;
- generation left out of the content digest;
- `valid()` not re-read under the mutex;
- the initiator taken from the request;
- the gate dependencies passed to a non-plugin call;
- the content hook applied to user starts (their tier-2 flow must be unchanged, as a fixed vector).

## 4. Open for the owner

Whether a plugin run start should be tier 4 (cost, side effects): see the tickets table, row PV-K1e-T4.

## 5. What K1e-a does not enforce (review F-notes)

- **A stale grant generation is not refused here.** K1e-a checks that `generation` is a positive integer and that the plugin id has the attested shape; it does not compare the generation with the stored grant. K1e-b's handler reads the K1b grant and binds the generation into the challenge (a2 adds the host-window binding), so a disable, revoke or generation change refuses the start there. Nobody should assume the service checks it.
- **`initiator` is required** in `ComposerStartInput`: a caller that forgets it does not compile, so a missing initiator can never mean "the user" by default. Today the runs handler passes `{ kind: "user" }`; K1e-b builds a plugin initiator from the attested identity only.
- **The initiator is read once** into locals before any check, and the taint hook must finish inside the creation: a missing hook or a hook that returns a promise refuses the start with nothing created.
