# Trust-registry revocations reach terminals (DC-3c)

- **Status:** Proposed. Security review. Follows DC-3a (`terminals-contract.md`). Until this lands, DC-3a's `open` is refused by a capability check (that contract, section 2 step 5).
- **Builds on:**
  - the trust registry (`packages/daemon-host/src/policy/trust-registry.ts`), fed only by the supervisor's `trust.set`;
  - DC-3a's terminal registry, its monotonic lifecycle, the per-terminal revoke in the pty process, and the definitive-outcome and late-spawn reporting of the pty client;
  - DC-3a's fan-out of project untrust and binding loss (section 2 step 4), whose abandonment, never-publish and kill-and-track rules are reused here unchanged.
- **Not here:**
  - whether a registry revoke stops a running CLI run (Q6 in `daemon-host.md`, still open; section 5 below says what this note does to a run's terminal);
  - main's side of the data port (DC-3b).

## 1. The gap

The trust registry records a revoke for a window (`w:<windowId>`) or for a subject id (`s:<id>`). `isRevoked` is read at the next decision: the policy row, the project trust gate's T4, and DC-3a's synchronous final admission. Nothing is told when a revoke is recorded, so:
- an `open` whose spawn is already dispatched publishes its terminal;
- a live terminal keeps running;
- a data connection keeps its grant.

The registry has no project identity and no event. This note adds both, as far as terminals need them.

## 2. The event

- **`InMemoryTrustRegistry` gains `onRevoked(listener)`.** It returns a disposer.
- **When it fires:** synchronously inside `set`, after a revoke (`trusted: false`) is recorded, with the level that was revoked: `{ kind: "window", windowId }` or `{ kind: "subject", id }`. It fires on every recorded revoke, including a repeated one. Listeners are idempotent.
- **Saturation:** a revoke that latches the registry saturated fires `{ kind: "all" }`. Every subject is then revoked (the registry's existing rule), so every terminal is affected.
- **Grants do not fire.** A grant never ends anything.
- **Order and failure:**
  - the registry's state is changed first, so a listener that reads `isRevoked` sees the revoke;
  - a throwing listener does not stop the others, and does not undo the record or turn `set` into a throw;
  - listeners run in registration order. The terminal registry registers when the host composes the terminal service; until then nothing is open.
- **Who may set:** unchanged. Only supervisor control messages (`trust.set`) reach `set`.

## 3. The mapping: which terminals a revoke reaches

A terminal's record (DC-3a section 4) gains the trust subjects it was reached through:
- `workspaceId` and `projectId`, fixed at open (a CLI run's terminal: its run's);
- **windows:** the window of the connection that opened it, and the window of every connection that attached it.

The registry's subject ids are not typed: the gate checks `s:<workspaceId>`, and a plugin's rule checks `s:<projectId>`. So:

| Revoked level | Reaches |
|---|---|
| `window W` | every terminal with W among its windows |
| `subject X` | every terminal whose `workspaceId` or `projectId` is X |
| `all` (saturated) | every terminal |

**The mapping fails closed when it saturates.**
- At most 8 windows are kept per terminal. A ninth attach marks the terminal `anyWindow`, and any window revoke then reaches it.
- A record whose subjects cannot be read (a malformed id) counts as reached by every revoke.

**What is never a reason to skip:** an unknown terminal kind, a record missing from one index, or a listener that threw earlier. The routing scans the registry itself (at most 8 plain terminals per workspace, and the runs' terminals), so no secondary index can disagree with it.

## 4. What a revoke does to a reached terminal

These are the same rules as DC-3a section 2 step 4. All of them are synchronous inside the listener, before any queued work.

- **A pending open** (dispatched, no answer yet) is marked abandoned. Its operation identity and slot stay charged until the spawn is definitively settled. A handle reported later, on time or late, is never published or granted: it is killed and tracked, and the slot is freed only when its group is gone.
- **An open that has not reached its final admission** needs nothing new. The final admission re-reads `isRevoked` synchronously (DC-3a section 2 step 3) and refuses.
- **A live plain terminal** is closed: it goes to `closing`, its grant is revoked in the pty process, then its group is killed. A kill that throws leaves it `closing`, and the slot waits for the group to be gone.
- **`attach` after a revoke.** `attach` is trust `none` in DC-3a's policy table, so DC-3c adds a handler check: `isRevoked({ windowId: caller, workspaceId })` or `isRevoked({ windowId: caller, workspaceId: projectId })` refuses with `not_found`. The same check runs again synchronously immediately before the grant is sent.

## 5. A CLI run's terminal

Q6 is not decided here: a registry revoke does not stop a run. Its terminal, when reached:
- **is revoked in the pty process.** Every data connection loses it, and the revoke is permanent there (DC-3a's monotonic rule), so no later attach reaches it;
- **leaves the run running.** It ends as before: its own exit, `axis.cli-runs/1.stop`, or a project untrust (DC-3a step 4).

**Decision for review:** the alternative is to revoke only the grants of the reached windows and let another, unrevoked window attach later. That needs a non-permanent revoke in the pty process, which DC-3a deliberately does not have. The note proposes the permanent revoke: it is simpler, it fails closed, and the run's state is still visible through the runs view.

## 6. Composition: the capability

DC-3a registers `axis.terminals/1` only when the terminal port's four parts AND this routing are present (DC-3a section 8). The routing is present when the composed trust registry offers `onRevoked`, and the terminal service has registered its listener before the handlers are registered. A test drops each condition and must see `open` refused before a spawn. A mutant that registers the handlers without the listener must fail.

## 7. Audit

- `terminal.revoked`: the terminal id, the workspace and project ids, the revoked level's kind (`window`, `subject`, `all`), and the outcome (`closed`, `abandoned`, `grant_revoked`).
- No window id. The window id is a connection identity, and the audit's subject is the terminal.
- One row per reached terminal. A repeated revoke of an already ended terminal writes nothing.

## 8. Tests (each with a mutant)

- **Registry event:**
  - fires after the record, for window and subject;
  - fires on saturation as `all`;
  - grants do not fire;
  - a throwing listener changes neither the record nor the other listeners.
- **Mapping:**
  - opener window, attaching window and a ninth attach (`anyWindow`);
  - subject as workspace and as project;
  - `all`.
- **With real control and composition** (supervisor `trust.set` over the control client), for a window revoke and a workspace revoke, each:
  - during the final lookup: no spawn;
  - during a pending reply: the late handle is never published, and is killed and tracked, with the slot charged until the group is gone;
  - during live use: the viewer loses output and input, the group is killed, and a kill that throws leaves the terminal `closing`, never granted again.
- **Removing each routing** (the event, the window mapping, the subject mapping, `all`) must let a late handle publish or a live terminal survive, and so fail.
- **CLI run terminal:** reached, it is revoked in the pty process, and the run stays RUNNING.
- **`attach`:** refused after a revoke of the caller's window or of the terminal's workspace or project, including one recorded between the handler's check and the grant.
- **Capability:** as section 6.
