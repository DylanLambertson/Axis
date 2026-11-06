# The daemon entry and the main seam (ticket X1)

Companion to `docs/design/daemon-host.md` (sections 3, 6.3 and 8), `docs/design/daemon-host-compose.md`, ADR 0003 D1 and D6 and ADR 0005 D3.

## What was built

| Piece | File | Runs in |
|---|---|---|
| Entry logic `runDaemonEntry` | `packages/daemon-host/src/entry.ts` | the utility process; tested without Electron (`test/entry*.test.ts`) |
| Overlay entry (hands over the real `process`, `process.parentPort`, env) | `code-oss/overlay/src/vs/axis/daemon/node/axisDaemonMain.ts` | the utility process |
| Parent side `DaemonSupervisor` (spawn, restart policy, exit codes, shutdown) | `packages/daemon-host/src/supervisor.ts` | Electron main; tested with a fake child and manual timers |
| Main seam (Electron `utilityProcess` adapter, paths, lifecycle) | `code-oss/overlay/src/vs/axis/code/electron-main/axisMainSeam.ts` | Electron main |
| Hook in `CodeApplication.startup` | `code-oss/patches/0210-axis-main-seam.patch` (8 added lines in `app.ts`: a 3-line import block and a 5-line call block, both with the Axis markers) | Electron main |
| `ComposeOptions.portSource` (a `connect` that carries a transferred port reaches the connect router) | `packages/daemon-host/src/compose.ts` | the utility process |

## Startup of the entry (fails closed, exit code 78, a closed `fatal` message, before any directory, lock or file exists)

1. No `parentPort`, a debugger or inspector flag in `execArgv` (`--inspect*`, `--debug*`, `--remote-debugging*`), or a non-empty `NODE_OPTIONS`: refused.
2. The parent port is adapted before anything awaits, so the single `init` cannot be lost.
3. One `init` within 10 s, else refused. A second `init` is ignored.
4. `HostConfig` is parsed strictly; a `platform` different from the process's own is refused.
5. `composeDaemonHost` runs with the real clock, `createNodeStorage`, one copy of the environment main gave the process (the single git path is resolved from it once, by the host), and the real `process` for signals and crashes.

**Placeholders.** The pty port and pty git runner (B9) and the run snapshotter (GIT-SNAP-1, plan question 10) are not defaults anywhere in `src/`. `runDaemonEntry` takes them from `deps.ports`; the overlay entry passes none, so `composeDaemonHost` throws `pty_required` and the process exits 78 after `init`. Until B9 and GIT-SNAP-1 land, the production daemon never reaches `ready`. This is intended. The tests that start a host fully use `testing/fake-pty.ts` and are the only place those fakes meet the entry.

## Security properties kept

- Minters: only `compose.ts` loads them. `compose.ts` may now be loaded by the public index and by `entry.ts` (nothing in `src/` may import the index, so the entry cannot go through it); `entry.ts` calls `composeDaemonHost` and exports no minter. This widens one rule in `test/packages/imports.test.mjs` and `RESTRICTED_MODULES` in `scripts/code-oss/stage-scan.mjs` by exactly that file, with tests for both the allowed and the refused importers.
- No renderer-supplied trust: identity comes only from the attestation main signs with a per-spawn key (32 random bytes made by the supervisor, sent in `init`, never logged); the port arrives only on `parentPort`, which only main can write. Extra ports in one message are closed.
- No listener: no socket, no `--inspect`, no reh listener. The reh server build bundles the entry file (patch `0200`) but nothing starts it there; run alone it refuses (step 1).
- The daemon gets an allow-listed environment (`daemonEnvironment`), no `NODE_OPTIONS`, empty `execArgv`, piped stdio.
- Errors and logs are closed: `fatal` carries a code and a reason code only; the supervisor logs closed event names and exit codes, never child text. Child stderr reaches only the trace log, cut to 512 characters, after the daemon's own redaction.

## Supervision (decided, conservative)

| Exit | Meaning | Action |
|---|---|---|
| 75, 78, 79 | lock held, configuration or required port refused, degraded stop | never restarted; state `failed` with a closed reason |
| 0 (no stop requested), 1, 70, other codes, signal, no `ready` in 60 s, spawn throws | crash | restart with delay 1 s doubling to 30 s; more than 5 crashes in 10 minutes is `failed` (`crash_loop`) and stays down; a run that was `ready` for 60 s forgets earlier crashes |
| any, after `shutdown()` | requested stop | never restarted |

On app quit (`onWillShutdown`, joined) the supervisor posts `{ type: "shutdown" }` first (the only graceful path on Windows) and kills after 20 s (the host's own drain is 10 s, settle 2 s, flush 5 s, final anchor 1.5 s). A kill that produces no exit event still ends the stop.

## Choices made where the design was open

- **Data paths (D-3, per platform; `axisDataRoots`).** `dataDir = <base>/daemon` and `worktreeRoot = <base>/worktrees`, where `<base>` is `~/Library/Application Support/Axis` (macOS), `$XDG_DATA_HOME/Axis` or `~/.local/share/Axis` (Linux; a relative or empty `XDG_DATA_HOME` is ignored) and `%LOCALAPPDATA%\Axis` (Windows, never Roaming). Not Electron's `userData`: on Linux that is the config directory, on Windows Roaming AppData (a domain profile would sync worktrees and the database), and it follows `--user-data-dir`. Both roots share one base so the check that the worktree root is not inside a registered repository has one anchor. `devDiagnostics` is `!app.isPackaged`.
- **Spawned in unpackaged builds only (`shouldStartDaemon`).** ADR 0003 D1 says main forks the daemon at startup. Until the pty process and the snapshotter exist the daemon only refuses to start (exit 78, two `error` log lines: `fatal_reported` and `failed`), which would give every user an extra process for nothing. Unpackaged builds still fork it, which exercises `fork`, `init` and the refusal. The condition is removed in the change that wires the real ports, and X1c (below) must land before or with that change.
- **Answers (X1c, built).** The seam now passes `onRequest` (`main/answers.ts`): `anchor.get`/`anchor.put` through a `safeStorage`-encrypted record next to the data directory, `native.confirm`, `trust.check` and `settings.get`; see `docs/design/main-answers.md`. "No anchor" is answered only when the record is definitively absent and the backend is secure; anything unreadable is silence (degraded).
- **Electron `utilityProcess.fork` directly, not upstream's `UtilityProcess` class** (ADR 0003 D1.1 names the class): the class injects `VSCODE_*` variables and the `bootstrap-fork` entry, which this daemon must not have. Recorded as a deviation.
- **No restart on 79** even though the seam does not set `exitOnDegraded`: a degraded host that was asked to stop is a decision, not a crash.

## Not done (follow-ups)

- **X1b** (built: the handshake, the window checks and the signing, `docs/design/main-answers.md`); still open: `trust.set` and `projects.register` from main (until main registers projects, every `trust.check` answers `false`).
- **X1c** (built, `docs/design/main-answers.md`); the Electron adapters (`axisMainPorts.ts`) are verified on macOS and Windows only.
- Verify on macOS and Windows: that an unref'd init timer when `parentPort` does not keep the process alive (it would exit 0, which the supervisor counts as a crash, instead of 78), `init` posted right after `fork` is queued until the child attaches its listener (the entry also bounds the wait at 10 s), the ESM entry path under a packaged app, and `kill()` semantics.
- An ESLint import-patterns target for `vs/axis/code/electron-main` and `vs/axis/daemon/node`.

## Review r1 changes

`entry.ts` is a composition point that only the overlay may load (import test, restricted-module table, reachability walk, each with refused cases). `test/code-oss/overlay-entry.test.mjs` pins the overlay entry (one import, no `ports`) and the seam guard. The init timer is injectable and a test fails if it is not cleared. Any non-empty `execArgv` is refused. The key is made before the fork. Child stdout is drained. The environment allow-list gained the non-secret Windows names (`PATHEXT`, `WINDIR`, `COMSPEC`, `USERNAME`, `HOMEDRIVE`, `HOMEPATH`) and is pinned by a test. The seam is also an entry of the staged graph check. Minified desktop `main.js` mangles the supervisor's `#` fields (it is not a `vs/axis/` output); no brand module reaches main, so this is accepted and listed under platform checks.
