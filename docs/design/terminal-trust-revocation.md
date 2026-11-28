# Trust-registry revocations reach terminals (DC-3c)

- **Status:** Proposed. Security review. Reviews 1 and 2 folded. Follows DC-3a (`terminals-contract.md`). Until this lands, DC-3a's `open` is refused by a capability check (that contract, section 2 step 5).
- **Builds on:**
  - the trust registry (`packages/daemon-host/src/policy/trust-registry.ts`), fed only by the supervisor's `trust.set`;
  - DC-3a's terminal registry, its monotonic lifecycle, the per-terminal revoke in the pty process, and the definitive-outcome and late-spawn reporting of the pty client (section 6 names them);
  - DC-3a's fan-out of project untrust and binding loss (section 2 step 4), whose abandonment, never-publish and kill-and-track rules are reused here unchanged.
- **Not here:**
  - main's side of the data port (DC-3b);
  - sending `window.gone` (OS-3).

## 1. The gap

The trust registry records a revoke for a window (`w:<windowId>`) or for a subject id (`s:<id>`). `isRevoked` is read at the next decision: the policy row, the project trust gate's T4, and DC-3a's synchronous final admission. Nothing is told when a revoke is recorded, so:
- an `open` whose spawn is already dispatched publishes its terminal;
- a live terminal keeps running;
- a data connection keeps its grant.

The registry has no project identity and no event. This note adds both, as far as terminals need them.

## 2. The event

- **`InMemoryTrustRegistry` gains `onRevoked(listener)`.** It returns a disposer.
- **When it fires:** synchronously inside `set`, after a revoke (`trusted: false`) is recorded, with the level that was revoked: `{ kind: "window", windowId }` or `{ kind: "subject", id }`. It fires on every recorded revoke, including a repeated one. Listeners are idempotent.
- **Saturation:** a revoke that latches the registry saturated sets the latch, then notifies `{ kind: "all" }`, then throws its `RangeError` as today. Every subject is then revoked (the registry's existing rule), so every terminal is affected.
- **Grants do not fire.** A grant never ends anything.
- **The registry's state is changed first,** so a listener that reads `isRevoked` sees the revoke.
- **Re-entrancy (review 1 S1; the code review's nit 1): a grant is refused, a revoke is deferred.**
  - A GRANT asked for while listeners are being notified throws (`RangeError`) and records nothing, so it cannot overtake the revoke being delivered.
  - A REVOKE asked for then is never dropped (dropping it would fail open). It is queued and, right after the current dispatch completes, recorded and dispatched in its own turn, so nothing recurses.
  - The queue holds at most 32. One more latches the registry saturated (every subject revoked) and delivers `all` right after the dispatch: fail closed.
  - No daemon listener calls `set`. The supervisor's `trust.set` arrives from the event loop, never inside a dispatch, so this path is reachable only by a bug.
- **The listener list:**
  - dispatch takes a snapshot of the listeners when it starts, in registration order;
  - a listener added during a dispatch first hears the next event;
  - a listener disposed during a dispatch, and not yet called, is skipped;
  - a disposer is idempotent.
- **Failure:** each listener call is caught on its own. A throw is logged (a fixed reason, never the error's text) and the dispatch continues with the next listener. It does not undo the record and does not turn `set` into a throw.
- **Latency is bounded by what a listener does, not by the catch.** A listener here may only make bounded synchronous authority changes: flags, a revoke message, a kill signal. Anything else, including the audit, is deferred (section 4). A `try/catch` cannot isolate a slow listener, so no listener may block.
- **Who may set:** unchanged. Only supervisor control messages (`trust.set`) reach `set`.

## 3. The mapping: which terminals a revoke reaches

A terminal's record (DC-3a section 4) gains the trust subjects it was reached through, set before the dispatch for a pending open:
- `workspaceId` and `projectId`, fixed at open (a CLI run's terminal: its run's);
- **windows:** the window of the connection that opened it, and the window of every connection that attached it.
  - A CLI run's terminal has no opening window: the run supervisor starts it, not a window (the code review's nit 2).
  - Its windows are the ones that attach it. That covers every grant, because a grant exists only through `attach`, which records the window before granting.
  - A subject revoke reaches it by its workspace or project in any case.

The registry's subject ids are not typed: the gate checks `s:<workspaceId>`, and a plugin's rule checks `s:<projectId>`. A subject revoke is global: one recorded through window B reaches window A's terminal in the same workspace.

| Revoked level | Reaches |
|---|---|
| `window W` | every terminal with W among its windows |
| `subject X` | every terminal whose `workspaceId` or `projectId` is X |
| `all` (saturated) | every terminal |

**The mapping fails closed when it saturates.**
- At most 8 windows are kept per terminal. A ninth attach marks the terminal `anyWindow`, and any window revoke then reaches it.
- A record whose subjects cannot be read (an id not of the journal's shape) counts as reached by every revoke. This is implemented in the scan, though the journal and the protocol never produce such an id.

**What is never a reason to skip:** an unknown terminal kind, a record missing from one index, or a listener that threw earlier. The routing scans the registry itself (at most 8 plain terminals per workspace, and the runs' terminals), so no secondary index can disagree with it.

## 4. What a revoke does

### 4.1 To the terminals it reaches

All of it happens in the listener, synchronously, and in three passes over every reached record. Each step for each record is caught on its own, so a failure on one record never stops another.

1. **Lower authority, for every reached record, first:**
   - a pending open (dispatched, no answer yet) is marked abandoned. Its operation identity and slot stay charged until the spawn is definitively settled. A handle reported later, on time or late, is never published or granted: it is revoked, killed and tracked, and its slot is freed only when its group is gone;
   - a live plain terminal goes to `closing`;
   - every reached live terminal (plain or a CLI run's) is revoked in the pty process.
2. **Then kill** each reached plain terminal's group. Revoke always comes before kill (DC-3a section 4). A kill that throws leaves the terminal `closing`, never granted again, and its slot waits for the group to be gone.
3. **Then the audit,** deferred to a microtask after the scan. An audit write that fails is logged with a fixed reason and does not change any state.

**Separate from project stop.** The project untrust and binding-loss fan-out (DC-3a step 4, which also stops CLI and composer runs under the project mutex) is a different event and is not routed through this listener. A failure in either path never prevents the other.

### 4.2 Admission: open and attach check both subjects (review 1 B1)

The routing above reaches existing and pending terminals only. A revoke recorded before a new `open` or `attach` must refuse that call too. The project trust gate's T4 checks `{ window, workspace }` only, and a project-subject revoke does not change the project's journal `trusted` flag. So DC-3c owns this terminal admission rule:

- **`open`:** the synchronous final admission (DC-3a section 2 step 3) reads `isRevoked` for each caller window (the connection's window, and its host window if any), with BOTH subjects: `{ window, workspaceId }` and `{ window, projectId }`. This happens after the last await, immediately before the ticket is consumed and the spawn dispatched.
- **`attach`:** the same four reads, synchronously, immediately before the grant is sent. `attach` is trust `none` in DC-3a's policy table, so this is a handler check.
- **A refusal is `not_found`.**

The gate itself is unchanged. Its other callers' scope is not this note's to widen.

## 5. A CLI run's terminal (Q6: decided)

**Accepted:** a registry revoke does not stop a run. A CLI run's terminal that a revoke reaches:
- **is revoked in the pty process.** Every data connection loses it, and the revoke is permanent there (DC-3a's monotonic rule), so no later attach reaches it;
- **leaves the run running.** The run is governed by its own gates. It ends as before: its own exit, `axis.cli-runs/1.stop`, or a project untrust (DC-3a step 4), which already stops the project's runs through the existing stop path.

**UI requirement (OS-16 and OS-8):** such a run is shown as "viewer detached", with its Stop action.

**No residual is added.** The run's process keeps the authority it was started with, under the gate that admitted it. The revoke takes nothing from it that a revoke takes from a run today, and the user keeps the Stop action.

## 6. Composition: the capability, and the pty handoff (review 1 S3)

### 6.1 The routing capability

- **`installTerminalRevocationRouting(trust, registry)`** registers the listener on the composed registry's `onRevoked`. It returns an owned **`TerminalRevocationRouting`** with `active(): boolean` and `dispose()`.
- **`active()` attests to the installed subscription itself:** it is true only between a successful registration and `dispose()`, and `dispose()` removes the listener. It is not an enable flag. A registry without `onRevoked` gives no routing object at all.
- **One predicate, `terminalsServable(port, routing, broker)`,** used by production, by the default composition and by every injected test composition. It requires five parts:
  - the terminal port's four parts (`PtyTerminalPort` in `ports/pty.ts`, merged with DC-3a's daemon side): `spawn(spec, onLate?)`, `grantTerminal(terminalId, conn)`, `revoke(terminalId)`, and `lateSpawnReports`;
  - `routing?.active() === true`;
  - **DC-3b's data-port broker attestation** (decided with DC-3c's code review): a `TerminalDataBroker` (`ports/terminal-broker.ts`, `readonly dataBroker: true`).
    - Main hands this capability object to the composition when it brokers the pty process's data ports: it mints each connection's name for the window that asked, and checks the sender.
    - Without it no data connection can reach a terminal, so an opened shell could never be viewed. It would only run the shell's start-up files with nobody watching, and could fill the pty process's shared bound.
    - So `composeTerminals` drops `axis.terminals` from what the host serves until a broker exists, exactly as for a port without its parts. The registry, the routing, the run wrapper and the guards still run.
    - It is a capability object, never a configuration flag. Only DC-3b makes one.

  The host advertises `axis.terminals/1`, holds its policy rows, and registers its handlers only when the predicate holds. Each handler checks `routing.active()` again per call, and answers `not_found` once the routing is disposed.
- **Tested distinctly:**
  - a registry without `onRevoked`;
  - a registry with it but no installed routing;
  - a disposed routing;
  - each missing port part.

  Each must refuse `open` before a spawn. A weakened predicate must fail its test.
- **The contract moves from planned to served in the change that lands this.** DC-3a's daemon slice keeps `axis.terminals/1` in `plannedContracts`.

### 6.2 The pty handoff

These are merged in `@axis/pty-process` (`client.ts`); DC-3a adapts them, and DC-3c only consumes them:
- `spawn(spec, onLate?)`;
- `PtySpawnError.definitive`: true for a refusal before sending, or `spawn-failed`; false for a timeout or an in-flight channel loss;
- `LateSpawn`: `{ kind: "spawned", handle }` or `{ kind: "failed", code }`;
- a handle's `terminalId`;
- `grantTerminal(terminalId, conn)` (the `grant` message; never named `grant` on a port, which the plugin-grant writer rule fences) and `revoke(terminalId): boolean`.

DC-3a's daemon side forwards all of them through the control slot (`bindings/pty-control.ts`) and declares them in the daemon's port (`ports/pty.ts`): `PtyTerminalPort`, `PtyTerminalHandle`, `PtyLateSpawn` (the client's `LateSpawn`, compared field for field by a compile-time test) and `isDefinitiveSpawnFailure`.

**`lateSpawnReports` (review 2 N1) is a DAEMON-port capability attestation, not a pty-process API.**
- Its shape is `readonly lateSpawnReports: true`, a member of `PtyTerminalPort` only (on main since DC-3a's daemon side).
- The control slot supplies it because it forwards both `onLate` and the client's `definitive`.
- `terminalPortOf` and `terminalsServable` read it as the literal `true`.
- The pty client has no such member. A self-asserted marker alone cannot prove forwarding, so the real-adapter test that drops `onLate` while spawn still works stays (`pty-control.test.ts`).

**Accounting rules:**
- a late `failed` releases the pending slot;
- a late `spawned` group (review 2 N2):
  - the merged client sends `revoke` and then `kill` for it (`client.ts`, since DC-3a's daemon side; before that, `kill` only);
  - the client tracks the group and hands the handle to `onLate`;
  - the daemon's registry also revokes and kills it, and keeps its slot charged until the group is gone;
  - it is never published or granted. The daemon's own revoke is required whatever the client does;
- a lost channel, or an evicted late callback with no authoritative outcome, keeps the slot charged.

### 6.3 Residual: the reused-group check (the code review's nit 5)

The pty client signals a tracked group by its id only while the id is ours: the pty process has not REPORTED its leader's exit, or the leader's pid is free (`/proc/<pid>` on Linux; elsewhere it is not signalled). An exit settled only because the channel closed or the port was disposed says nothing about the leader, which may still run, so the group stays ours.
- **The window:** between that read and the signal, the pid could be taken by a new process that makes it a group id. On Linux this is the only check.
- **Why it is accepted:** the window is a few microseconds, at dispose or once the pty process is gone. Pid reuse in that window is improbable, and the process would be the same user's. The pty process ends its own groups when its control channel closes anyway.
- **What would close it:** a pidfd for the leader (Linux), taken at spawn, would remove the window. It is not built.

### 6.4 A host-wide bound

At most **16 plain terminals** exist in the whole host, pending and live together (`MAX_PLAIN_TERMINALS`), besides the 8 per workspace. A plain terminal and a CLI run, a hook or a push all count against the pty process's own bound of 64. A flood of opens across many workspaces therefore stops at 16, leaving CLI runs and pushes their headroom. The refusal is `too_many_terminals`, as for a full workspace.

## 7. Every authority-loss event (review 1 S2)

| Event | Owner | Pending open | Live plain terminal | A CLI run's terminal | Slots and late answers |
|---|---|---|---|---|---|
| Registry revoke (window, subject, all) | DC-3c | abandoned (section 4) | closing, revoked, killed | revoked; run continues (section 5) | kept until definitive or gone |
| Project untrust, binding loss | DC-3a step 4 | abandoned | closing, revoked, killed | the run is stopped by the existing stop path | kept until definitive or gone |
| `window.gone` (close, crash, navigation). OS-3 sends it; DC-3c consumes it for terminals | DC-3c | that window's pending opens are abandoned (the caller is gone) | stays running: a terminal outlives a window and is re-attached by another (OS-16). Its data owner ends when main closes the window's ports (DC-3b), and the pty process then clears the grant and owner | unchanged | kept until definitive or gone |
| Data connection closes | pty process (merged) | none | the grant and owner are cleared; the terminal stays `open` and needs a new `attach` | same | none |
| Pty control channel closes (pty process restart) | DC-3a | the spawn rejects non-definitively: kept charged | the pty process ends every terminal; the daemon sees the unknown exit, so `exited`, and probes the group until gone | same | kept until the group probe answers gone |
| Workspace finalise or remove | DC-3a daemon slice | refused while the workspace has a charged slot (`active_run`, as for a run) | the workspace's plain terminals are closed first (closing, revoked, killed); the operation stays refused while any group lives | the run's own guard applies | released as groups go |
| Messaging pause of a project | none (explicit) | unaffected | unaffected: a pause is about messages, not the user's shells | unaffected | none |
| Daemon shutdown | DC-3a and DC-3c | the routing is disposed first (handlers answer `not_found`), then pending opens are abandoned | closed (revoked, killed); the pty process also kills every group when its control channel closes | ends with its run's shutdown | memory ends with the process |

**DC-3b deferral, stated:** if main cannot guarantee a window's data ports close with it, the remaining gap is a stale data owner until the port closes. It is DC-3b's, and DC-3c does not claim it closed.

## 8. Audit

- `terminal.revoked`: the terminal id, the workspace and project ids, the revoked level's kind (`window`, `subject`, `all`), and the outcome (`closed`, `abandoned`, `grant_revoked`).
- No window id. The window id is a connection identity, and the audit's subject is the terminal.
- One row per reached terminal, written after the scan (section 4.1). A repeated revoke of an already ended terminal writes nothing.

## 9. Tests (each with a mutant)

- **Registry event:**
  - fires after the record, for window and subject;
  - fires on saturation as `all`, before the throw, filling the real 4096-entry registry through control;
  - grants do not fire;
  - a throwing listener changes neither the record nor the other listeners;
  - a nested grant during dispatch is refused and records nothing; a nested revoke is recorded and dispatched right after it; an overflowing queue latches saturation;
  - a listener added during dispatch hears only the next event, and one disposed during dispatch is skipped.
- **Mapping:**
  - opener window, attaching window and a ninth attach (`anyWindow`);
  - subject as workspace and as project;
  - a workspace revoke through another window reaches the terminal;
  - a bare window revoke from a window that never attached reaches nothing;
  - `all`.
- **Passes and isolation:**
  - T1's revoke or kill throwing while T2 is pending and T3 live: T2 is abandoned and T3 closed;
  - authority is lowered for all records before any kill;
  - the project stop path still stops CLI and composer runs when terminal processing throws.
- **With real control and composition** (supervisor `trust.set` over the control client), for a window revoke and a workspace revoke, each:
  - during the final lookup: no spawn;
  - during a pending reply: the late handle is never published, and is killed and tracked, with the slot charged until the group is gone;
  - during live use: the viewer loses output and input, the group is killed, and a kill that throws leaves the terminal `closing`, never granted again.
- **Admission (B1):** a project-subject revoke before a new `open`, and one during its final lookup, each from the caller's window and from a different window, refuses with no spawn. `attach` is refused the same way. Deleting only the project-subject read must let a spawn through and fail the test.
- **Removing each routing** (the event, the window mapping, the subject mapping, `all`, the abandonment pass) must let a late handle publish or a live terminal survive, and so fail.
- **CLI run terminal:** reached, it is revoked in the pty process, and the run stays RUNNING.
- **Lifecycle (section 7):**
  - `window.gone` with a pending open: never published;
  - a pty control channel loss with a pending open: the slot stays charged;
  - a workspace remove with a live terminal: closed first, refused while its group lives;
  - shutdown with a pending reply: never published;
  - routing disposed before the handlers answer.
- **Capability:** as section 6.1.
- **The pty handoff:** through the real control slot, a timeout keeps the slot charged and a late spawned or failed outcome reaches the daemon; dropping `onLate` while spawn still works must fail.

**Must prove before the contract is served** (from DC-3a's daemon review):
1. `active()` reflects the live subscription: true only between registration and `dispose()`, and every method answers `not_found` after `dispose()`. A source without `onRevoked` gives no routing object.
2. Routing reaches pending and live terminals synchronously inside `set`:
   - a window revoke;
   - a subject revoke, workspace and project, from any window;
   - `all` on saturation.

   There is a mutant per mapping.
3. The move to served keeps the rows as they are:
   - user only, at tiers 2, 0, 2 and 2 (open per-start);
   - on the plugin deny list;
   - out of `WEB_ALLOWED`;
   - served only with both the four port parts and the installed routing, shown by a composition test.
4. DC-3a's review S1 and S2 repros stay as tests: a replaced control port settles its terminals, and a cancelled open never leaves a published shell.
5. The audit allow-list, through the host's own merged allow-list and the real audit log: ids and `conn` kept, no path, environment or data.
6. The both-subject admission tests, for `attach` as well as `open`.
7. With the real pty service: a terminal reached by a registry revoke stops getting output on its data connection, and other terminals on the same connection are unaffected.
8. **Residual, stated until DC-3b:** `conn` is a name the caller gives. Main mints it for a port it hands to the window that asked only with DC-3b. Until then, a caller that may attach (only the user's own desktop connection) could name any data connection it knows.
