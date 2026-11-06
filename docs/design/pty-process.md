# Axis pty process (ticket B9)

Status: built as `@axis/pty-process`, without a native dependency. Sources: threat model PTY-3, PTY-5, PTY-6, PTY-7, gate G-2 and G-14; `docs/design/daemon-host-plan.md` question 18; runs review 2 (N4). The fake `LocalPty` of the headless slice stays until the shipped entry exists.

## What runs where

- The **pty process** is a separate utility process that main forks. It holds no secrets and no privileged port. `createPtyService` is its logic. The only thing it needs from outside is a `SpawnFn`: a synchronous function that starts a child in its **own session or job** and returns a `PtyChild`. In the shipped entry that function is the native pty binding.
- The **daemon host** talks to it with `createPtyProcessPort` (a `PtyPort`, the shape `@axis/runs` uses) over one **control channel**. `composeDaemonHost` already takes `pty: PtyPort`, so the only wiring is passing this port instead of `LocalPty`; no composition code changes in this ticket.
- The **renderer** reaches terminals over **data channels** that main brokers after the ADR 0003 window-identity checks. A data channel can only `attach`, `write` and `resize`. A `spawn`, a `kill` or any other message on it is refused and never acted on (`refused unsupported`).
- The package imports no `node:child_process` (ADR 0005: only the listed packages may), so the spawn function is injected. `testing/helpers.ts` holds a pipe-based POSIX reference (`pipeSpawn`) that the conformance tests run against.

## Contracts

| Requirement | How it is met | Test |
|---|---|---|
| PTY-5 deny-list, no editor handles | The daemon builds the environment with `@axis/pty-policy`. The service **re-checks** it with `classifyDeniedName` and `isValidName` and **refuses** the spawn (`env_denied`, names never echoed) rather than editing it. The child gets the environment exactly as given; `SSH_AUTH_SOCK` stays | `env-scrub.test.ts` |
| PTY-6 `VSCODE_NONCE` absent in CLI runs | `VSCODE_*` is on the deny-list, so a nonce cannot reach a child; the service adds nothing. SI-ENV for plain terminals is B10 | `env-scrub.test.ts` |
| PTY-7 child fds | The spawn function owns inheritance; the reference gives the child stdio only. `child-fds.test.ts` is the conformance test the native binding must pass (Linux, via `/proc`) | `child-fds.test.ts` |
| PTY-7 spawn only from the daemon; attach only to issued ids; G-2 | Two schemas, one per channel. One control channel at a time. Ids are `pty_` plus 128 random bits. An id binds to the first data connection that attaches and is released when it closes; another connection gets `foreign_terminal` for attach, write and resize and receives no output | `foreign-terminal.test.ts` |
| Output never in the daemon | Output goes only to the attached data channel; the control channel carries `spawned`, `spawn-failed`, `exit`, `group-empty` | `foreign-terminal.test.ts` |
| PTY-3 / PTY-7 OSC 633 `Cwd=` | A CLI run has integration off and no nonce, so every OSC 633 in its output is forged. The service strips them (`Osc633Filter`, across chunk boundaries, 4096 characters held at most; other sequences pass byte for byte). Splits already open in the worktree root through `ICreateTerminalOptions.cwd` (controls, UI side) | `osc.test.ts` |
| `groupAlive` (plan Q18) | The pty process reports the group on `spawned`. POSIX: the host probes `kill(-pgid, 0)` **itself**, so it is synchronous, survives the leader's exit and the pty process dying. Success or `EPERM` is alive, `ESRCH` is gone, anything else throws (alive by contract). Windows: a job group is alive until `group-empty` arrives. A leader that is not its own group leader (`pgid !== pid`, pgid below 2) is killed and refused (`bad_group`) so `-pgid` can never be 0, 1 or "every process" | `group-alive.test.ts` |
| Every spawn settles within a bound (review 2 N4) | `spawnTimeoutMs` (default 10 s) on an injected clock; also settles on channel close, on a send failure, on `spawn-failed` and on dispose. At most 64 spawns wait. A `spawned` that arrives after its timeout is an orphan and is sent `kill SIGKILL` | `spawn-settle.test.ts` |
| Process-group kill | `kill` signals `-pgid`, after a probe so a reused pgid of a finished group is not hit blind. If the pty process is gone the host signals the group itself. `service.dispose()` SIGKILLs every group and closes the channels. A job group is ended by `PtyChild.kill` | `group-kill.test.ts` |

## Limits and platform notes

- A child that calls `setsid` or double-forks leaves the group and is invisible. A pgid can be reused after its group empties: `groupAlive` then reports alive (fails closed); the probe-before-kill narrows but cannot close the window for a signal.
- After a daemon restart the host has no handles, so `discardInterrupted` must not lift a blocked row without its own group check (plan Q18).
- Tests that need real processes run on Linux and macOS (`node:test` skip reasons name the missing capability). `child-fds.test.ts` needs `/proc`. The Windows job-object path is exercised only against a fake child; it is unverified on Windows.
- If the leader is gone the host reports an unknown exit (`null`, `null`) when the channel closes; the supervisor treats that as a failed run with an unknown exit, and the group probe still blocks finalisation while members live.

## Open questions

1. **Native pty dependency.** A real terminal needs a native binding (`node-pty` or the Code OSS fork of it). ADR 0005 D4 allows no runtime dependency beyond zod and `node:child_process` only in listed packages, so nothing was added. The shipped entry must supply a `SpawnFn` that (a) starts the child in a new session (`setsid`) or a job object with breakaway disallowed, (b) closes every descriptor except the pty, (c) uses the environment as given. Decision needed: reuse Code OSS's own `node-pty` from the overlay entry (no new dependency for `packages/*`), which is the proposal here.
2. **Channel transport.** `Channel` is a minimal interface; the entry adapts `MessagePort` (control from main's fork handshake, data ports from the brokered attach). Not built here.
3. **Git in the pty context.** The `pty` git runner (`commit-tree`, `push`, hooks) is a separate control message family and stays with H9-hooks; the fake runner remains.
4. **Id binding.** Binding is first-attach-wins and released on close. If main should assign the connection when it brokers the port, add a `grant` message from the control channel; the schemas leave room.
