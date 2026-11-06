# The composition root and the headless slice (ticket H12)

Companion to `docs/design/daemon-host.md` and `docs/design/daemon-host-plan.md` (section 1, the slice; question 19, construction order).

## What `composeDaemonHost` does

`packages/daemon-host/src/compose.ts` is the one place that builds the `Daemon` and every binding. It wraps `createDaemonHost` (startup, design section 3) and uses two hooks the host gained for it: `afterStorage` (journal, audit log, idempotency store exist, recovery has not run: the worktrees binding behind `reconcile` is built here) and `beforeReady` (recovery and the coverage check are done, `ready` is not sent: the `Daemon`, every handler and the lifecycle are built here, so no connection can reach a half built host). A throw from either fails startup (exit 70, no `ready`, nothing held). `afterStorage` is skipped when the host is degraded.

- **Registrar only.** Handler code receives the `HandlerRegistrar` (frozen, tier 3 and above guarded structurally) and nothing else: not the `Daemon`, not `register`, not the database, not the discard minter. The run trust minter goes to the cli-runs handlers alone (TRU-2, ticket H10). `src/gate/worktrees-confirm.ts` and `src/gate/run-trust.ts` may be loaded by `src/compose.ts` (and the public index) and by no other file in `src/`; `src/compose.ts` itself may be loaded only by the public index, and exports only `composeDaemonHost` (`test/packages/imports.test.mjs`, the staging scan, `compose.test.ts`).
- **Fails closed without a pty.** `commit-tree` and `push` run in the `pty` git context and runs spawn in the pty process, so `composeDaemonHost` throws `E_INVALID_ARGUMENT` (`pty_required`, `pty_git_runner_required`, `snapshotter_required`; exit 78) before a lock or a file exists when any of the three is absent. A missing snapshotter is refused too: a run with no GIT-SNAP-1 check must be a decision, not a default.
- **Anchor preflight.** The one approval gate is `createWorktreesApprovals` (the discard capability is closed over in it) with `preflight: anchorPreflight(services.anchors)`, so a stalled anchor refuses tier 3 and above before a challenge, a dialog or a spend. This is what stops `worktrees.remove` (its content hook has no anchor check); the git push content hook and the registrar guard repeat it.
- **Question 19.** The worktrees binding is built first with `createActiveRunForwarder()`, which answers `true` ("a run may be active", never `false`) until the runs binding is bound, and fails closed on a service that throws or answers anything but `false`. The binding's one `ProjectMutex` is the instance the git handlers and the runs binding receive (the slice probes it).
- **Coverage.** `checkCoverage({ ...surface, also: { handlers } })`: every served method has a handler and every handler is a served method, or startup fails. A degraded host registers only the audit reads and `axis.projects/1.list`, over a registry that holds nothing else, with a sink that accepts and drops (nothing can be written).
- **Control messages.** `trust.set` feeds the `TrustRegistry` (it fails closed by itself); `projects.register` registers a project in the journal (actor `daemon`, id generated here, answer is the id or a closed code); `connect` goes to the limiter, the router and `daemon.accept`.
- **Shutdown.** `installHostLifecycle` runs before `ready` on the `process` the caller passes. Its `finalize` does design 8 step 3 (the connect listener goes, the anchor manager stops putting by itself via `haltAnchor`, the runs binding kills live process groups and stops listening to them) and then step 4: it flushes the final anchor (`flushAnchor`, synchronous) and waits, bounded (1.5 s), for the acknowledgement; an unacknowledged final anchor throws and the lifecycle exits 1. `stop` closes the daemon, the approvals, the runs binding (SIGKILL of live processes) and then the host (timers, database, lock). A released host ends by draining.
- **Review temp indexes** live in `<dataDir>/review-index` (0700, emptied at start). The review audit sink and the challenge sink notify the anchor manager of each write.

## The slice (`packages/daemon-host/test/slice/`)

`headless.test.ts` runs the composition in a child process (real lock, signals and exit code) under `testing/test-supervisor.ts`, over a fixture repository and a bare remote (`testing/git-fixture.ts`; feature-detected git, no `-b`, skipped with a reason below `MIN_GIT_VERSION`). `headless-race.test.ts` (run start racing finalise and push, one mutex) and `headless-warn.test.ts` (scan mode `warn`) run on their own hosts. They run in `npm test` (the `Axis packages` job, ubuntu only; a macOS job is the follow-up of plan question 12).

| Plan step | Test | Notes |
|---|---|---|
| 1 start, second host exits 75 | `1.` | ready not degraded; welcome lists the nine contracts (`axis.events` since E1) |
| 2 create, replay, conflict | `2.` | principal comes from the attestation; a payload `createdBy` is refused |
| 3 run, PTY-5 environment | `3.` | the fake CLI dumps env NAMES; seeded denied names are absent |
| 4 review | `4.` | an `agent:*` connection gets `E_POLICY_DENIED` on `complete` |
| 5 commit | `5.` | stale worktree refused; interim: the planted pre-commit hook does not run (H9-hooks) |
| 6 push | `6.` | challenge, `native.confirm`, approved retry, one ref moves, reuse, replay, second connection |
| 7 secret path | `7.`, `headless-warn` | refuse: `secrets_found` before any challenge; `plan_changed`; warn: confirmation required |
| 8 audit chain | `8.` | SIGTERM (control `shutdown` on Windows), exit 0 by draining, final anchor equals the last event |
| 9 tamper, truncation | `9.` | `audit_chain_invalid`, `database_behind_anchor`; only audit and projects served; nothing created |
| 10 kill and recover | `10.` | stale lock taken over, run BLOCKED `INTERRUPTED_BY_RESTART`, worktree intact |
| 11 anchor stall | `11.` | `git.push` and `worktrees.remove` refused `anchor_stalled` before any challenge, with and without an approval; resumes |

Deviations from plan section 1.2, found while building it: (8c) the journal shares the database and stores worktree and project paths, and `worktrees.status` returns a `path` by contract, so absolute temporary paths are asserted absent from the audit rows and the host log only; the canary and the key are asserted absent from every byte of the database, the host log and every response; (8d) each of the three commits has one success row, one push has one; (9) a degraded host serves no worktrees method because its registry does not contain it (the answer is `E_METHOD_NOT_FOUND`, not `E_UNAVAILABLE`, and `welcome` offers only audit and projects); (10) a start that returned before the kill has its stored result replayed (the same run, nothing runs twice); only a key in flight at the kill answers `outcome-unknown`.

## Fakes and what replaces them

| Fake | Where | Replaced by |
|---|---|---|
| `LocalPty` (`PtyPort`): a plain child process; `groupAlive()` is "not exited" | `testing/fake-pty.ts` | the Axis pty process (B9), with the process-group contract of plan question 18 |
| the `pty` git runner: a local node runner pinned to the git path | `testing/fake-pty.ts` | the control-channel runner of the pty process (B9) |
| run snapshotter: no-op, no drift | `testing/slice-host.ts` | the GIT-SNAP-1 snapshot (question 10) |
| `TestSupervisor`: anchors, trust, settings, native answers, attestations | `testing/test-supervisor.ts` | main (X1) |

Other records: `axis.providers/1.list` is composed with an empty provider list until a ticket wires the real provider registry; the registered repositories join the git `excludeDirs` only after the journal opens, so the one-time git lookup at startup does not exclude them (X1: main should pass them in `ports.registeredRepoRoots` at `init`); `projects.register` is recorded with actor `daemon` because main's control message carries no attestation (`user` is reserved for attested connections); the macOS slice job is its own ticket.

Real in the slice: the process, the composition root, `@axis/worktrees` over a real repository, the run supervisor, `@axis/review` and `@axis/git-ops`, the secret scanner, the audit chain, the idempotency store and the anchor protocol. `@axis/review` is merged, so no fake review service remains.
