# The production exec function of the pty process (ticket PV-X1a)

Status: BUILT (PV-X1a). Design inputs: `forge-pr-list.md` §1 and §9 (feat/pv-d2), design reviews 1 and 2 of that note (SF-6, SF-7, SF-8, N-d), `daemon-host-hooks.md` §4, ADR 0005 D3, `scripts/code-oss/egress-rules.mjs`.

## Split

PV-X1 is split (master, 2026-11-21):

- **PV-X1a (this note, packages only):** `exec-node.ts`, the exec contract changes, the pty entry's git configuration, the daemon entry's acceptance of the control port (section 5a), the ADR 0005 amendment and lint entry, and an end-to-end push through the real exec function.
- **PV-X1b (main and overlay only):** main resolves `git` and `gh`, forks the pty utility process, supervises it and hands one control channel to both processes; plus the patch 0200 entry lines. Section 6 is the self-contained hand-over contract X1b is built from.

Until X1b lands nothing in a shipped build reaches this code: the daemon entry still refuses with `pty_required`.

## 1. `createNodeExec`

`packages/pty-process/src/exec-node.ts` exports one function:

```ts
export function createNodeExec(programs: ReadonlySet<string>, platform: NodeJS.Platform): ExecFn;
```

- **One instance per consumer** (design review 2, N-d). The git exec path gets `createNodeExec(new Set([gitPath]), platform)`; `forge-list` gets its own `new Set([ghPath])`. A bug in the git path that passes `ghPath` is refused.
- **The program check is in this file, before `spawn`.** `argv[0]` must equal one member of `programs` as an exact string: no prefix match, no case folding, no normalisation. Every member must be absolute at construction, or the factory throws. The check is the enforceable half of the lint entry (section 4): the lint sees the call shape, not a program given by value.
- **Fixed options, nothing injectable:** `shell: false`, `detached: true` on POSIX (the child leads a new process group), `windowsHide: true`, `stdio: ["pipe", "pipe", "pipe"]`, `env` a copy of exactly `request.env` on a **null prototype** (Node's `spawn` walks inherited keys, so a key planted on `Object.prototype` would otherwise reach every child: review 1 SF-1; a name that is empty or holds `=` or NUL, or a value that is not a NUL-free string, is `start_failed`), no merge with `process.env`, nothing added; `cwd` exactly `request.cwd`, which must be absolute (`start_failed` otherwise). No spawn function is exported or taken as a parameter.
- **stdin** is always a pipe, written with `request.stdin` when given and ended at once. Nothing is inherited.
- **Windows:** the returned function throws `ExecStartError("unsupported_platform")` before `spawn` on `win32`. Windows has no process group, and `taskkill /T` would be a second program given by value. A job-object kill (native pty binding or a small addon) is its own ticket, **PV-X1w**.

## 2. Contract changes (`ports.ts`)

```ts
export interface ExecRequest {
  // ...as today
  /** Bytes of stderr kept; default `maxOutput`. Each stream stops being held at its own cap. */
  readonly maxStderr?: number;
}

export interface ExecOutcome {
  // ...as today; `truncated` keeps meaning "either stream" (the git path is unchanged)
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type ExecStartFailure = "program_refused" | "unsupported_platform" | "not_found" | "not_permitted" | "start_failed";
/** Code only: never a path, an argv or OS text. */
export class ExecStartError extends Error { readonly code: ExecStartFailure; }
```

- `program_refused` and `unsupported_platform` are synchronous throws from the `ExecFn`, before `spawn`.
- A start that fails after `spawn` (Node reports it through the `error` event) rejects `done` with `ExecStartError`: `ENOENT` → `not_found`, `EACCES` or `EPERM` → `not_permitted`, anything else → `start_failed`.
- The service keeps mapping any throw or rejection of an exec to `spawn_failed` for git; `forge-list` maps the codes itself (c6, agreed: `not_found` → `gh_missing`, `unsupported_platform` → `unsupported_platform`, the rest → `gh_failed`).
- `pipeExec` (testing) gains the same fields, so consumers can build against it first.

## 3. Kill and settle

- **The group id.** A group's id (the leader's pid) stays reserved while any member of the group lives; once the group is empty the id is free and a new process may take it (as its own group leader). A probe (`kill(-pgid, 0)`) only skips a group that does not exist; it cannot tell this group from a newer one (review 1 SF-2). So:
  - **at the leader's exit** (Node's `exit`, after the reap) the rest of the group is sent `SIGKILL` at once: a member still alive keeps the id ours;
  - **a latch:** once a probe finds the group gone, its id is never probed or signalled again;
  - **`kill()`** sends `SIGKILL` to the group unless the latch is set. Idempotent.
- **`done` settles only after** the leader exited, the group was killed at that exit, and stdout and stderr closed (Node emits `exit` before `close`). No member of the group outlives a settled `done`, and output written before the leader exited is read to the end.
- A process that left the group (`setsid`) and holds the pipes keeps `done` pending until the service's timeout calls `kill()`; by then the group id is latched gone, so nothing is signalled, and `done` settles when that process lets go of the pipes. The timeout stays in the service (its clock).
- **Residual:** a process that leaves the group itself (`setsid`) is not covered. Same-user class, closed by the Phase 3 sandbox (`forge-pr-list.md` §8).
- **Caps:** each stream stops being held at its own cap (`maxOutput`, `maxStderr`); the bytes past it are read and dropped, so a flood never sits in memory and never blocks the child on a full pipe.

## 4. Lint entry and ADR 0005 amendment

`SPAWN_FILES` gains:

```js
["pty-process/exec-node.ts", { names: new Set(["spawn"]), program: null, runs: "git or gh: exactly the configured gitPath or ghPath, checked in this file before the call" }],
```

A unit test reads `egress-rules.mjs` and asserts that entry verbatim, so the text cannot drift from the code.

ADR 0005 D3, the built-ins sentence, gains (wording from `forge-pr-list.md` §1, Windows corrected to this ticket):

> `node:child_process` is also loaded by `pty-process/exec-node.ts` (`spawn`), the pty process's one exec function: its program is one of the absolute `gitPath` and `ghPath` fixed when the process starts, checked in that file before every call; no shell; the process group is killed on timeout and close (POSIX; Windows refuses until a job-object kill exists).

`daemon-host.md` 2.1 gains the spawn-file row, and the PTY-2 boundary note names this file.

## 5. The pty entry's configuration

`runPtyEntry` reads the hand-over from its own environment (`deps.env`, what main gave the process at fork), so the overlay file `axisPtyMain.ts` needs no change:

| Name | Value | Unset |
|---|---|---|
| `AXIS_PTY_GIT` | absolute, real path (no symlink in it: the string checked is the file run) of a regular executable file no group or other may write (review 1 N-1) | git off: every exec, scratch step, hook and push answers `spawn_failed`; terminals work |
| `AXIS_PTY_GH` | as `AXIS_PTY_GIT` (read and checked now; `forge-list`, PV-D2, uses it) | `forge-list` off |
| `AXIS_PTY_SCRATCH` | an existing directory (not a symlink), this user's, mode without group or other bits | required when `AXIS_PTY_GIT` is set |

- A name that is set and fails its check refuses the start (exit 78, one closed line: `git_path_refused`, `gh_path_refused`, `scratch_refused`), before any port is served. The line names no path.
- With git: `createNodeExec(new Set([gitPath]), platform)` and `git: { exec, gitPath, hooksOff: "/dev/null", scratchParent, baseEnv }` to `createPtyService`; `baseEnv` is the entry's environment without the three names (PTY-5 drops `AXIS_*` from every child anyway).
- Windows: the names are not read; no exec exists there (§1).
- `readPtyExecConfig(env)` is exported for main's own pre-check (6.2).

## 5a. The daemon entry's control port

`packages/daemon-host/src/entry.ts` accepts, on `process.parentPort` only, the message `{ type: "pty-control" }` carrying exactly one port:

- It wraps the port with `adaptMessagePort(port, { shape: "electron" })`, builds `createPtyProcessPort({ channel })`, and from it `createPtyGitRunner` (exec and push). These become `ports.pty` and `ports.ptyGitRunner` of `composeDaemonHost`.
- **Before ready.** `init` is checked when it arrives (an invalid one still ends the start at once). A `pty-control` that arrives before the host is composed is held (one slot; a later one replaces it, and the earlier port is closed). The host is composed only once both arrived; the entry's start bound (`initTimeoutMs`, default 10 s) covers both, and a port that never comes ends the start with `pty_required` (exit 78), as before.
- **Routing.** The parent port has one port handler (`adaptParentPort`); the entry owns it. `pty-control` goes to the slot (`bindings/pty-control.ts`, `createPtyControlSlot`), any other port message to the composition's connect router through a `portSource` wrapper. A port without the listener API Electron's `MessagePortMain` has is closed.
- **Import boundary.** The rule judges the host's own specifiers; a host dependency that imported the package root would not be caught by it (none does: review 1 walked the built graph), so the staged bundle check is the backstop to add if one ever must. `bindings/pty-control.ts` is the host's one importer of `@axis/pty-process`, and only of its `./client` subpath (`createPtyProcessPort`, `adaptMessagePort`, the error classes), so the daemon's module graph never reaches `exec-node.ts`, the service or the native spawn adapter (`test/packages/imports.test.mjs`).
- **Tests inject ports.** `deps.ports.pty` (tests) replaces the slot; a `pty-control` is then closed.
- **Wrong shape.** Any other key, a missing port, several ports, or a port on a message of another type: every port in it is closed and the message dropped. Nothing changes.
- **A second `pty-control` after ready (the pty process restarted).** The host's pty port is replaced: the old port is disposed, so every pending spawn, exec and push on it settles (`channel_closed`, fail closed) and its runs end as `E_UNAVAILABLE`; new requests use the new port. A run is never moved to the new channel.
- **The port closes mid-run.** Pending calls settle `channel_closed`; later requests answer `E_UNAVAILABLE` until a new `pty-control` arrives. The daemon does not exit.
- **Source.** Only `process.parentPort` is listened to, and only main can write it. No other channel (a renderer connection, a data port) can carry `pty-control`.

## 6. Hand-over contract for PV-X1b

What main must do. Everything here is main's or the overlay's; the packages side is built in X1a and tested without Electron.

**6.1 Resolve the programs.** Main resolves `git` and `gh` once at start with the trusted resolver over main's **resolved shell environment** (so a Finder-started app finds `/opt/homebrew/bin/gh`). Each result is an absolute, real path (symlinks resolved), a regular executable file, outside every registered worktree. Not found: the field is omitted.

**6.2 Fork the pty process.** `utilityProcess.fork(<app>/vs/axis/pty/node/axisPtyMain.js, [], { serviceName: "axis-pty", env, execArgv: [] })`:

- `env`: main's resolved shell environment through PTY-5 (`daemonEnvironment`-style clean), **plus** `AXIS_PTY_GIT`, `AXIS_PTY_GH`, `AXIS_PTY_SCRATCH` (absolute paths). `AXIS_*` names are dropped from every terminal and exec environment by PTY-5 (`classifyDeniedName`: `axis-internal`), so they never reach a child.
- `AXIS_PTY_SCRATCH`: a directory main creates per start, mode 0700, under the Axis data root (not Electron's userData), removed on stop.
- `axisPtyMain.ts` already passes `env: { ...process.env }`; the entry reads the three names from it (§5). No overlay change is needed in that file. Main may call `readPtyExecConfig` on the values first, so a wrong resolution is logged in main rather than as the pty process's exit 78.
- stdout drained and dropped; stderr lines logged at trace, cut to the same bound as the daemon's.

**6.2a The same git string on both sides (review 1 N-5).** The daemon's git path (`HostConfig`, used as `argv[0]` of every pty git request) and `AXIS_PTY_GIT` must be the **identical string**: the pty process compares `argv[0]` exactly, so `/usr/bin/git` against its realpath makes every git request `spawn_failed` with no other reason. Main resolves once and passes the same realpath to both; it can check its own value with `readPtyExecConfig` before the fork.

**6.3 The control channel.** Whenever either process (re)starts, main creates one new `MessageChannelMain` and sends:

- port A to the pty process: `ptyChild.postMessage({ type: "pty-control" }, [A])`;
- port B to the daemon: `daemonChild.postMessage({ type: "pty-control" }, [B])`.

Both messages have exactly that one key and exactly one port; both entries drop anything else (section 5a and `pty-process/src/entry.ts`). Main may send B before the daemon's `init` answer: the daemon entry holds it. Everything after the hand-over (the port, the git runner, the composition) is the daemon entry's, built in X1a. Main never sends a `pty-control` on any other channel. Data connections (`pty-data`, `grant`) stay as `pty-process.md` describes; X1b wires them for the renderer.

**6.4 Supervision.** What each side does (the packages side is built and tested in X1a; main's side is X1b's):

- Main starts the pty process before the daemon and hands both ends of the channel only once both are up.
- **Pty process exits:** the daemon's port sees the channel close; every pending spawn, exec and push settles (`channel_closed`) and the daemon's runs fail closed. Main restarts the pty process with backoff (the daemon supervisor's policy), then creates a **new** channel and sends `pty-control` to both. The daemon entry replaces its port; a run started on the old one is not resumed.
- **Daemon exits:** the pty process's control channel closes and the service kills every terminal group and exec (`serveControl` close). The pty process keeps running; the restarted daemon gets a new channel.
- **Shutdown:** main ends the daemon first, then the pty process (SIGTERM, then kill after the daemon's bound).
- **Residual (review 1 N-8):** exec groups lead their own process groups (`detached`), so they survive a SIGKILL or crash of the pty process (SIGTERM is handled: the service kills every group). A git step already running may then finish after the daemon answered `E_UNAVAILABLE`; the operations it serves are the approved ones, and the next request starts from the repository's actual state.
- Restart counts, backoff and the give-up state reuse `DaemonSupervisor`'s; the reason codes are closed strings, never paths.

**6.5 Build entry.** Patch 0200 gains `vs/axis/pty/node/axisPtyMain` in the entry lists of `build/next/index.ts` (master's patch).

**6.6 What X1b imports.** `readPtyExecConfig` and the three name constants (`PTY_ENV_GIT`, `PTY_ENV_GH`, `PTY_ENV_SCRATCH`) from `pty-process`, the daemon supervisor's restart policy (`daemon-host/supervisor`), and main's trusted resolver. `axisDaemonMain.ts` needs no change: the daemon entry takes `pty-control` itself; its placeholder comment ("the pty process does not exist yet") is X1b's to update.

**6.7 Tests X1b owns.** A packaged-shape GUI run (Xvfb) that pushes to a local bare remote through main, the pty process and the daemon; a pty-process crash mid-push answers `E_UNAVAILABLE` and a later push succeeds on the new channel.

## 7. Tests (X1a)

| What | Where |
|---|---|
| Program check (another path, relative name, trailing or leading space, another case, a prefix, dot and double slash, empty argv, relative member at construction), nothing started | `pty-process/test/exec-node.test.ts` |
| Environment and cwd exactly as given (a canary in `process.env` absent), stdin ended, shell syntax literal | same |
| Caps: 5 MiB stdout and 1 MiB stderr under 4 MiB and 64 KiB, each flag alone, the `maxStderr` default, exactly-the-cap not a cut, bad caps | same |
| Start failures: missing program, non-executable file, missing cwd; no path in the error | same |
| Group kill with a grandchild that ignores SIGTERM and holds the pipes; a grandchild that let go of the pipes dies when `done` settles; Windows refuses before anything starts | same |
| The `SPAWN_FILES` runs text, pinned | `pty-process/test/exec-node-lint.test.ts`; count in `test/packages/egress-process.test.mjs` |
| Entry hand-over: each refusal (exit 78, closed line, no port served, no path), unset (terminals on, exec `spawn_failed`), Windows ignores it, a real `write-tree` through the production exec | `pty-process/test/entry-exec.test.ts` |
| Slot: calls before a port fail closed; a replacement fails in-flight closed and closes the old port; a port closing mid-run; after dispose | `daemon-host/test/pty-control.test.ts` |
| Daemon entry: wrong shapes closed; two ports before init (the first closed); start only with init and a port; connections still routed; a renderer `pty-control` changes nothing; the bound ends at `pty_required` | `daemon-host/test/pty-control.test.ts`, `entry.test.ts` |
| Import boundary of the host | `test/packages/imports.test.mjs` |
| End to end: a confirmed push to a local bare remote with the pty entry in a **child node process** (control channel relayed over IPC), git through the real `createNodeExec`; control: the same process without `AXIS_PTY_GIT` refuses `E_UNAVAILABLE` and the remote does not move | `daemon-host/test/pty-push-child.test.ts` |
| Every H9-hooks S4 real push test now runs on `createNodeExec` instead of a test exec | `daemon-host/test/pty-process-rig.ts` |

The push itself is a terminal: in tests the node:child_process terminal stand-in, in the product Code OSS's node-pty (X1b's GUI run). What the exec function carries in a push is the service's remote check before it, and every other git command.
