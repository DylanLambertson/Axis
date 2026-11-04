# `@axis/runs`: CLI run lifecycle (ROADMAP Phase 1a, ticket 6)

- **Status:** Proposed. Implemented in `packages/runs`.
- **Scope:** the daemon-side lifecycle of a CLI agent run (design `axis-agent-shell.md` §4.5): launch, status, stop, restart recovery, the "run active" query for commit and push, and the disclosure copy. Pure TypeScript over injected ports, so it runs without Electron.
- **Threat model rows:** TRU-2, PTY-4, PTY-5, CLI-1, DMN-6, DMN-7, WT-2 and the REV-1 and GIT-SNAP-1 rule "commit and push are refused while a CLI run is active".
- **Not in scope:** the real `node-pty` or Code OSS pty host (a `PtyPort` adapter plugs in later), the GIT-SNAP-1 and run-base implementation (`@axis/git-snapshot`, injected as `RunSnapshotter`), the worktree manager (injected as `WorktreeLocator`), the bridge contract `axis.cliRuns/1`, BEL "attention", and drift attribution (B11).

## 1. Layering

`@axis/runs` depends on `@axis/audit` (`AxisError`, `Redactor`, `AuditSink`, `InstanceLock`), `@axis/journal` (`Journal`, the run states) and `@axis/pty-policy` (`resolveLaunch`). Errors are `AxisError` with a code from the closed `@axis/protocol` set; messages are fixed strings and never carry a cause, a path, an environment value or CLI output.

The run state machine is **the journal's** (`RUN_TRANSITIONS`). This package adds no states and no migration. It maps the lifecycle onto it:

| Lifecycle | Journal state | Reason code |
|---|---|---|
| starting | `QUEUED` (process not yet confirmed) | |
| running, quiet | `RUNNING` | |
| finished (exit 0) | `REVIEWING`, then `COMPLETED` by the user's diff-review accept | `PROCESS_EXITED` |
| failed (exit non-zero or signalled) | `FAILED` | `EXIT_NONZERO`, `SIGNALLED` |
| killed by the user | `CANCELLED` | `USER_KILLED`, `KILL_UNCONFIRMED` |
| stopping (a process may still live) | any row held by this daemon after the row ended (a hung spawn, an unconfirmed kill), or `RUNNING` while the stop ladder runs | shown as `stopping`; the workspace counts as running |
| failed before a process existed | `CANCELLED` (the journal has no `QUEUED -> FAILED`) | `SPAWN_FAILED`, `SPAWN_TIMEOUT`, `SNAPSHOT_FAILED`, `AUDIT_FAILED` |
| interrupted by restart | `BLOCKED` | `INTERRUPTED_BY_RESTART` |

The dashboard status is derived from `(state, reason, live process, last output time)` by one pure function (`deriveStatus`): `starting`, `running`, `quiet` (shown as "quiet (may be waiting for input)"), `finished`, `failed`, `killed`, `interrupted`. A journal `RUNNING` row with no live process in memory is `interrupted`, never `running`: Axis does not claim a process it cannot see. A workspace summary adds `idle` when it has no live or recent run.

## 2. Ports

All injected; none is imported from Node globals.

- `PtyPort.spawn(spec) -> Promise<PtyHandle>`; `PtyHandle` has `write`, `resize`, `kill(signal)` (the port signals the process group), `onData`, `onExit` (each returns a disposable). The supervisor never calls `write`: keystrokes go renderer to pty directly and Axis never answers a CLI prompt (CLI-2).
- `Clock`: `now`, `setTimeout`, `clearTimeout`. Every timer in the package goes through it (tests use a fake clock and assert zero pending timers).
- `WorktreeLocator.locate(workspaceId) -> { workTree, gitDir }`: the daemon's realpath-checked answer from the journal and worktree manager. The supervisor only validates its shape (`resolveLaunch` re-checks the root is normalised and absolute).
- `RunSnapshotter.before(ctx)` and `after(ctx)`: GIT-SNAP-1 around every run. A failed or hung `before` refuses the launch (fail closed); `after` is bounded by a timeout and its failure is recorded, not fatal.
- `EnvSource.get()`: the resolved shell environment main passed to the daemon (input to PTY-5).

## 3. Launch

`start({ workspaceId, agent, actor, trust, idempotencyKey? })`:

1. Validate the input (strict schema; `actor` is the authenticated principal, never from a payload).
2. **Trust (TRU-2).** `trust` must be a `TrustAttestation`: an unforgeable object (private-field brand, like the journal's `UserPrincipal`) that only the daemon's connection layer can mint, through the restricted subpath `@axis/runs/daemon-attestation`, from main's window-verified attestation. It is bound to a workspace id and the project id the journal recorded for it, expires after a short TTL (default 30 s), and is **single use**. A plain object, a clone, a stale, reused or mismatched attestation, or `trusted: false`, is refused with `E_POLICY_DENIED` and an audit row. The TTL is checked again immediately before spawn, after the snapshot await. A revoked trust therefore refuses the next start, because main would not mint a new attestation.
3. Locate the worktree, then **in one synchronous block**: check the supervisor is open, check the per-device limit, reserve a slot, register the run as active for its worktree and consume the attestation. There is no `await` between the limit check and the reservation (TOCTOU).
4. `resolveLaunch` (PTY-5 deny-list, Axis resolves `command[0]` outside the worktree and every managed root). A refusal creates no journal row and is audited.
5. `journal.createRun({ kind: "cli" })` (`QUEUED`), the `cli_run.start` audit row (fail closed: no audit row, no process), `snapshotter.before`.
6. Resolve the launch again and spawn in the same tick, with a start timeout. The tick refuses if the executable differs from the one the start audit row names, or if the workspace is no longer `READY`. On timeout the run is cancelled as `SPAWN_TIMEOUT`, **but the slot and the active flag stay held** until the port settles: a late-arriving handle is killed on arrival and its exit awaited. A slot is released only when no process can exist.
7. Subscribe, `QUEUED -> RUNNING`. An exit delivered synchronously during subscription is queued and handled after the transition.

An idempotent replay (the journal returns `replayed: true`) never spawns a second process: it returns the live summary or `E_CONFLICT`. A run id that the journal hands out twice while the first is live is refused (`E_INTERNAL`, no spawn).

The per-device limit counts every run that can still own a process: starting, running, stopping, a hung spawn and an unconfirmed kill. Default 4, configurable from 1 to 32. Over the limit: `E_BACKPRESSURE`.

## 4. Exit, stop, restart

- **Exit** (`onExit`) is handled once; a second event is ignored and counted. Data after exit is ignored. An exit code outside the journal's range is stored as no code with reason `SIGNALLED`. The journal transition is written first (journal-first), then `snapshotter.after`, then the audit row, then listeners are disposed and the slot released, all in `finally`, so a journal or audit failure cannot leak the slot. Failures go to `onInternalError`, never into a user message.
- **Stop** (`stop(runId, actor)`): `SIGINT`, then after `graceMs` `SIGTERM`, then after `graceMs` `SIGKILL` (PTY-4). Each step is a clock timer cleared on exit; a throwing `kill` is caught and the next signal is still sent. Stop during start sets a flag: when the handle arrives it is killed at once and the run ends `CANCELLED / USER_KILLED`. If no exit arrives within `killTimeoutMs` after `SIGKILL`, the journal records `KILL_UNCONFIRMED` but the slot and active flag stay held until an exit event, so commit and push stay refused while a process may live. Stopping an already-stopped run is a no-op that returns the summary. After `KILL_UNCONFIRMED` the run shows as `stopping` and a repeated `stop` sends `SIGKILL` again and re-arms the kill timeout.
- **Recovery** (`recover(lock)`, DMN-7): calls `Journal.recover(lock)` (`RUNNING -> BLOCKED / INTERRUPTED_BY_RESTART`), then moves any `QUEUED` run of kind `cli` to `CANCELLED / INTERRUPTED_BY_RESTART` (it was a launch that never reached a process; the journal has no `QUEUED -> BLOCKED`). `REVIEWING`, `BLOCKED`, terminal runs and composer runs are untouched. Nothing is resumed or re-adopted: this package never calls `BLOCKED -> RUNNING` or `-> QUEUED`, and `PtyPort.spawn` is not called by recovery. `recover` is a startup step: it refuses (`E_CONFLICT`) after it has run once, after the first `start`, and while any run is live, so it can never interrupt a live composer run. `discardInterrupted(runId, actor)` moves a `BLOCKED` run to `CANCELLED` when the user dismisses it.
- **`dispose()`**: refuses new starts, `SIGKILL`s live handles, clears every timer and listener. Journal rows stay as they are, so the next start's recovery marks them interrupted. Nothing watches the processes afterwards, so `isCliRunActive` answers `true` for every worktree once the supervisor is shut down (fail closed).

## 5. Commit and push versus a running CLI

`isCliRunActive(worktree)` has the shape `@axis/git-ops` expects (`WorktreeRef -> boolean`). It is true while any run for that worktree can own a process (section 3 list), compared on the path with case and Unicode normalisation folded (a false positive only refuses a commit), and also on `gitDir`. A reference it cannot read counts as active (fail closed). Journal reads and writes are wrapped: a failing journal yields a closed-set error (`E_UNAVAILABLE`/`E_INTERNAL`) and an `onInternalError` label, never the raw error, and never an unhandled rejection. It never reads the journal, so a stale `RUNNING` row alone does not decide it. Exited and hand-started CLIs do not count, as the design specifies.

A query alone leaves a gap: "no run is active" can be true, then a run starts, then git executes. `acquireGitOperation(worktree, { maxMs })` closes it: it throws `E_CONFLICT` if a run is active, otherwise holds the worktree against new starts (`E_CONFLICT`, reason `GIT_OPERATION_ACTIVE`) until `release()` or `maxMs` (at most 10 minutes, bounded table of 64), so an Axis commit or push wraps its git call in a lease. The lease is checked in the same synchronous block as the slot reservation.

A lease does not silently expire: at `maxMs` it is marked lapsed and reported, the worktree stays closed to new runs until `release()`, and `assertHeld()` throws `E_CONFLICT` for a lapsed or released lease. **Contract for `@axis/git-ops` callers** (the change itself belongs to the daemon-host work, not this package): replace the boolean `isCliRunActive` check with `acquireGitOperation(worktree, { maxMs })` before the first git step, call `lease.assertHeld()` immediately before each git execution (commit, push), and `release()` in `finally`. Set `maxMs` above the git-ops hard timeout so a lapse means something is wrong.

## 6. Output and event bounds, and secrets

- Output goes to a ring buffer (default 64 KiB, hard maximum 1 MiB). A chunk larger than the buffer is cut to its tail and the tail is copied into a fresh string before it is stored, so the original is never retained; the cost of a data event is bounded by the buffer size whatever the flood. `tail(runId, maxChars)` returns the recent text of a live run **redacted on read** by the injected `Redactor` (so a secret split across two chunks is still caught) with lone surrogates repaired and the result bounded. `tail(runId, n, { plain: true })` also removes terminal escape sequences (OSC and CSI) and stray control characters, for consumers that are not terminals.
- No regex runs per data event. Output never goes to the audit log. Audit rows hold ids, state names, reason codes, the executable's base name, argument and removed-variable counts and a snapshot flag; the action allowlist is exported (`RUN_AUDIT_ALLOWLIST`) for the daemon to merge into `AuditLog`'s `payloadAllowlist`, and without it the log stores only a content summary. Everything passes through `AuditLog`'s own redaction as well.
- Status listeners are bounded (32); a throwing listener is dropped from that event and counted, never allowed to break the run. There is one quiet timer per live run, re-armed lazily, not per data event.

## 7. Disclosure copy

`src/copy.ts` is the only place Agent-view run strings live, as a deep-frozen object: the launch dialog statements ("governed by the CLI's own permissions", "runs with your credentials and can push to your remotes"), the run row label, the status labels and the "Stop the agent run to commit" refusal text. The environment statement says exactly what the launch does: Axis removes its own editor variables (`VSCODE_*`, `ELECTRON_*`, askpass and editor hooks) and the login environment, tokens included, passes through (`stripSecretNames` is off). `DISCLOSURE_VERSION` is 2; a test ties the wording to the real spawn environment. A test walks every string and fails on `sandbox` or `secur` (so `secure`, `security`, `insecure`), case-insensitively. `buildLaunchDialog` returns plain data (title, statements, executable name, argument count, worktree path, confirm label) from those strings; the agent label is stripped of control and bidirectional characters and bounded. Arguments are shown as a count, not verbatim, because a configured argument may hold a token.

## 8. Test plan

Hostile cases (each a test): stop during start (before and after the handle arrives); double exit; data after exit; synchronous exit during subscription; spawn rejects; spawn throws synchronously; spawn hangs (timeout, slot held, late handle killed); `kill` throws; a process that ignores every signal; run id collision (journal `newId`) and idempotent replay; the limit under 20 concurrent starts; restart recovery from every journal state, repeated, with no spawn; a 50 MB flood; secrets split across chunks; every timer and listener gone after finish, stop and `dispose`; untrusted, forged, expired, reused and mismatched attestations; commit refusal through the real `isCliRunActive` shape while starting, running, stopping, hung and after exit; copy words; every `(state, reason)` status mapping.

The post-run snapshot verdict is `RunSummary.snapshotAfter`: `pending` until the run ends, then `ok`, `drift` or `unknown`. A failed or timed-out snapshot is `unknown` (the audit row carries `drift: null`), never "no drift". Verdicts are kept in memory (bounded to 512) and read `unknown` after a restart; persisting them needs a journal column.

## 9. Open questions

1. A hung `spawn`, or a handle whose exit cannot be subscribed to, holds its slot until the port settles and shows as `stopping`; a repeated `stop` re-sends `SIGKILL` once a handle exists. Is a manual "abandon" action wanted, or does the pty process's own liveness report settle it?
2. `QUEUED -> FAILED` is missing from the journal, so failures before a process exist are `CANCELLED` with a failure reason. Adding the edge would be cleaner but changes a merged package.
3. `recover` writes its audit row for a cancelled launch after the journal transition, in a separate step from `Journal.recover` (which is atomic). A crash between the two leaves a cancelled launch without an audit row; the journal does not expose its database handle for one transaction.
4. The default concurrency limit (4) and quiet interval (60 s) are placeholders until the A8 baseline.
5. Attestation lifetime: `issuedAt` comes from the minter, and an attestation minted just before a revoke stays usable once for up to the TTL. A `trustStillHolds()` port checked in the spawn tick would close it; it needs the daemon connection layer.
6. `list` and `workspaceStatus` read every run of the workspace before slicing; the journal has no limit parameter.
7. An idempotent replay over the limit returns `E_BACKPRESSURE` rather than the live run.
