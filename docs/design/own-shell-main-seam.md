# Own shell: main's seam to the daemon and the pty process (OS-3)

- **Status:** proposed. The split and slice 1's contract were agreed before coding; slice 1 is built test-first on a stacked branch while this note is reviewed.
- **Decides nothing new.** It ports the overlay's main seam (`code-oss/overlay/src/vs/axis/code/electron-main/axisMainSeam.ts`, `axisMainPorts.ts`, `axisMainPty.ts`) to the own shell's main (`apps/desktop/main`), over the modules that already exist in `packages/daemon-host/src/main/` and `src/supervisor.ts`. It builds ADR 0011 Decision 2 and ADR 0003 D1 and D6.
- **Related:**
  - `docs/design/own-shell-plan.md` (the OS-3 and OS-3b rows);
  - `docs/design/own-shell-main-hardening.md` (OS-2: the window, session and fork hardening this builds on);
  - `docs/design/main-answers.md` (the answers and the ordered sender checks);
  - `docs/design/daemon-host-entry.md`;
  - `docs/design/pty-exec-node.md` §8 (the pty supervisor and hand-over);
  - `packages/daemon-host/test/process-main.test.ts` (the forked-file shape and its pins).

## 1. Who talks to whom

```
                       ┌──────────────────────── Electron main (apps/desktop/main) ────────────────────────┐
 renderer window       │                                                                                    │
 (axis-app://shell,    │  entry.ts ── G-28 check ── import() ──▶ main.ts                                   │
  partition axis-shell)│                                          │                                         │
      │  preload       │   slice 2: ipcMain axis:connect ─▶ checkAppSender ─▶ ConnectBroker ─┐               │
      │  (4 functions) │   DC-3b:   ipcMain axis:terminalPort ─▶ checkAppSender ─▶ data broker   ┐          │
      └───────────────▶│                                                                       │  │          │
                       │   DaemonSupervisor ── control channel (parentPort) ── answers:        │  │          │
                       │     anchor.get/put, settings.get (slice 1)                            │  │          │
                       │     native.confirm, trust.check (closed refusal in slice 1; slice 2)  │  │          │
                       │   PtySupervisor ─── control channel ──────────────────────────────────┼──┘          │
                       └──────┬──────────────────────────────────────────┬────────────────────┼─────────────┘
                              │ utilityProcess.fork (fixed file)         │ utilityProcess.fork (fixed file)
                              ▼                                          ▼                    │ slice 3.2: one end of a
                    daemon.cjs: guard ── import() ── daemon-entry   pty.cjs: guard ── import() ── pty-entry  MessageChannelMain to
                              │                                          ▲                    │ the renderer, the other
                              └──────── control hand-over (a fresh channel SENT per (re)start)──┘   in the daemon's signed
                                                                                                  connect. Terminal data
                                                                                                  (pty-data): DC-3b; until
                                                                                                  then a closed refusal
```

- The renderer never reaches a process directly. Three trust edges, each with its own port and its own minting:
  - **Daemon connect** (slice 3.2). Main checks the sender, mints a fresh identity, and signs a `connect` to the daemon carrying one end of a new `MessageChannelMain`. The renderer gets the other end. The daemon verifies the signature, the age and the replay before it serves anything.
  - **Terminal data** (DC-3b, after OS-3). Main checks the sender and mints a fresh data `conn`. The daemon, over its control channel, decides whether to grant that `conn` a terminal. Main sends only the data end to the renderer, as `pty-data`, and tears it down on refusal or when its lifetime ends. The pty process verifies no daemon signature on a data end: the grant decides, and only the daemon-owned control channel can grant. Until DC-3b lands, `axis:terminalPort` answers a closed refusal. DC-3c's capability refusal holds on its own: an installed terminal backend and an available data port do not enable a terminal open before revocation routing exists.
  - **PTY control** (slice 3.1). Main makes a channel between the daemon and the pty process (§3a). It never reaches a renderer, and a renderer or data port can never become a control port.
- Main forks exactly two files, both from the bundle, and nothing else. No path, argument or environment comes from a renderer.
- The daemon and the pty process are joined by a control hand-over that main brokers: when either (re)starts, both are SENT a fresh channel. Sending is not acceptance: until OS-3h, nothing confirms that both ends adopted it (§3a).

## 2. The three slices

Each slice is its own PR with its own security review. **OS-3h** (the acknowledged control hand-over, §3a) and **OS-3p** (the terminal backend, §6a) are their own tickets between slices 3.1 and 3.2. OS-3b (project actions and trust without Code OSS) follows slice 2.

| Slice | Holds | Proves | Defers |
|---|---|---|---|
| **3.1 Process spine and control answers** | The daemon and pty forked by main from fixed bundle files in the signal-guard shape; the narrow `@axis/daemon-host/main` subpath that shrinks `main.cjs`; supervisor start, restart and shutdown order; the pty control hand-over; the answers that need no window (anchor, read before the first spawn, and settings); `native.confirm` and `trust.check` answered with the closed refusal | §4 | All renderer IPC, every dialog, the secret store |
| **3.2 Renderer connect and window lifetime** | `axis:connect` (`checkAppSender` before any payload parse, `ConnectBroker` rate and identity, the `MessageChannelMain` hand-over); `window.gone` on `destroyed`, `render-process-gone` and a main-frame `did-start-navigation` (a reload included); per-window state pruned on `closed`; `native.confirm` with the dialog acceptance rules; the orphaned openExternal dialog aborted on close; `trust.check` answered as "the window is live"; `axis:terminalPort` answers a closed refusal (the terminal data broker is DC-3b's) | Once `window.gone` is sent, the old document's `axis:connect` is refused; the dialog rules on every OS; no state outlives its window | Project actions (OS-3b), the secret store |
| **3.3 Secret store and main's SecretBackend (N0c-2)** | `safeStorage` behind `secret-store.ts` and `secret-files.ts`; main's side of the vault's `SecretBackend` | The seven guarantees the N0c-1 slice 2a review handed to the real main (§6) | Nothing of OS-3 |

## 3. Slice 3.1: the contract

1. **The narrow subpath.** `@axis/daemon-host` gains a `./main` export. It holds the supervisor (`DaemonSupervisor`, `axisDataRoots`, `daemonEnvironment`, `shouldStartDaemon`) and the main-side modules slice 1 uses: `pty-supervisor`, `pty-launch`, `pty-handover`, `anchor-file`, `anchor-store`, `settings-scope` and `answers`. Their imports are the control messages, `attest-sign`, `@axis/pty-policy` and `@axis/pty-process/config` only. If one of them drags in the composition root, it is split. Main imports only `@axis/daemon-host/main`, never the package root. The OS-2 import of `axisDataRoots` moves there.
2. **The forked files.** `apps/desktop` holds two files that `scripts/bundle.mjs` builds as `dist/app/daemon.cjs` and `dist/app/pty.cjs`. Each file's ONE static import is its package's signal guard (`@axis/daemon-host/signal-guard`, `@axis/pty-process/signal-guard`). The guard installs its `SIGUSR1` listener with `on`, never `once`. Main forks nothing else.
   - **The forked file is tiny** (about 1.4 KB). V8 parses a whole script before its first statement runs, so a 2.8 MB bundle widens the window before the listener by its whole parse. The entry is therefore a separate bundle beside it (`daemon-entry.cjs`, `pty-entry.cjs`), which the forked file loads by `import()` after the guard.
   - **Each forked artifact must stay under 4 KiB**, pinned on the built files and independent of `main.cjs`'s budget. A `Module._load` trace of the built files shows the listener first, then exactly the entry bundle. The fork targets are pinned too (the seam's unit tests).
   - A tiny file shortens the window before the listener; it does not remove Node's or Electron's own bootstrap before any script runs. The packaging fuses and the launch test (OS-21, RR-83) stay the control for packaged builds, including Windows, whose debugger attach does not depend on a signal.
   - Once the guard is first, the trace cannot tell a static entry import from `import()`. The source text pin is what catches that.
3. **The forks** go through OS-2's `forkUtility`:
   - The entry is the fixed absolute bundle path, joined from `app.getAppPath()`. It never comes from a renderer, argv or the environment.
   - The service names are `axis-daemon` and `axis-pty`.
   - The environment is `daemonEnvironment()` for the daemon and the pty launch environment for the pty process. The fork options' refusals hold: no `NODE_*`, `ELECTRON_*`, `LD_*` or `DYLD_*` name reaches a child.
   - The `cwd` is the bundle directory, **in an unpackaged build**: a real directory, read-only, never the data roots or a worktree. Both children must run with a read-only `cwd` (no relative-path writes anywhere). Every shell the pty process spawns gets its own explicit `cwd`, never the bundle directory.
   - **A packaged build cannot use it.** An `app.asar` archive is virtual, and Electron cannot set a working directory inside one. Today the packaged start gate starts neither child. OS-21 chooses a physical, absolute, read-only directory outside the archive (the resources directory) and proves it with packaged-layout launch tests. The script path's check stays separate from the `cwd` choice, and there is no fallback to the inherited `cwd`, a worktree or the data roots.
   - stdio is piped and drained. A child's stderr reaches main's log (development builds only) split into lines, with every character outside printable ASCII escaped and each line cut to 512 characters BEFORE it is escaped (so a flood line costs main a bounded amount of work) and tagged `[axis-daemon stderr]` or `[axis-pty stderr]`, at most 20 lines per chunk. A bare CR also splits a line, which is harmless: a child can neither forge one of main's own lines nor send an escape sequence to the terminal.
   - The daemon is killed by `SIGKILL` on its exact pid when the supervisor kills it (its ready timeout, its stop grace), as the pty process is: `utilityProcess.kill()` sends `SIGTERM`, which a daemon with a blocked event loop never handles.
   - **esbuild's interop helpers** (`__toESM` and its helpers, a few hundred bytes) sit before the guard in each built forked file. They define functions and run no effectful statement; measured harmless, and the size pin bounds them.
   - **The pty file's spawn refuses** in slice 3.1. It is the entry's existing refusal path ("no terminal backend"), so it fails closed and is tested. The terminal backend is OS-3p. The daemon needs only the pty process's control hand-over to reach ready, not a terminal backend.
4. **Order and lifetime.** The anchor store is read before the first spawn, so a keychain prompt cannot use up the daemon's 5 s anchor wait. The pty process starts first, then the daemon, under the start gate. `shouldStartDaemon` starts both only in a development build until the owner's packaging ADR. The own shell's equivalent of Code OSS's `isBuilt` is `app.isPackaged`, so a packaged build starts neither process, with a test. Each daemon child is reported to the pty hand-over, so both get a fresh control channel when either restarts. Restarts follow the supervisor's bounded policy. Shutdown runs on `before-quit`, bounded: the daemon first, then the pty process. `app.exit` comes only after both settled or timed out.
5. **The control hand-over ships with a known defect** (§3a), fixed by OS-3h before slice 3.2.
6. **One instance per profile.** Main sets its internal name and its profile path FIRST, then takes `app.requestSingleInstanceLock()`, before it forks anything. Electron keeps its lock files in the current `userData`, so a lock taken earlier would sit in Electron's default profile, and a second launch on our profile would not be refused. `claimSingleInstance` refuses to lock unless `userData` already is main's profile. Measured on the real profile path (no `--user-data-dir`): the lock files are in `<config>/axis-shell`, and the second launch quit with exit 0 in about 0.9 s, forking nothing. The second launch's argv and working directory are never read. A second launch on the same profile asks the first to show its window and quits at once (measured: exit 0 in about 0.4 s, one closed line). A second main with another profile but the same data roots is stopped by the daemon's own instance lock: its daemon exits 75 and its supervisor ends `failed` with reason `lock_held`, without a restart loop (measured). That main's pty process keeps running until it quits; slice 3.2 shows the state to the renderer.
7. **Orphans.** Measured on Linux under WSLg: after `kill -9` of main, both utility processes were gone within 1 s (they end when their connection to main closes). Not verified on macOS or Windows; OS-21 measures it on the packaged builds.
8. **The answers in slice 1.** `anchor.get` and `anchor.put` are answered from the anchor store; `settings.get` with "unset" (`null`) for both keys, since there is no settings store before OS-4, so the daemon applies its own defaults (`axis.git.runHooks` off; no `axis.cliAgents` entry, so a CLI run is refused). A quit during start never spawns the daemon. No app window can be named yet, so `native.confirm` is refused at once with the native queue's closed reason, and `trust.check` answers `false` (fail closed). Neither can hang. No renderer IPC is added, so no tier-4 operation is reachable from a page in slice 1. **Tier 4 is refused until slice 2**, and the PR says so.

## 3a. The control hand-over: posting a port is not a completed hand-over (OS-3h)

**Fixed by OS-3h.** Slice 3.1 shipped with this defect, as recorded: after a restart the daemon could be left without a control channel, while the supervisor still showed it running and every pty-backed call failed closed with `channel_closed`. OS-3h implements the design below, in `@axis/daemon-host` (`src/main/pty-handover-acked.ts`, the entry, the supervisor) and `@axis/pty-process` (the entry, the service), and the seam uses it.

The inherited hand-over posts a new channel to both children and counts that as done. It is not done. The pty service serves one control channel at a time and closes a second one while the first is still registered. So if the replacement arrives before the pty process has seen its old channel close, the replacement is closed, the hand-over still counts success, and the old close then clears the old channel. Neither end is left with a working channel, and nothing retries. The design review reproduced this with the real modules.

OS-3h makes acceptance explicit:

- **Generations.** Main numbers every channel it makes. Each `pty-control` message carries its generation.
- **Latest wins, at both ends.** A child that receives a `pty-control` adopts it and closes the channel it held. Only main can post on a child's parent port, so the newest port is always main's own, and a renderer or data port can never become a control port. This matches the daemon entry, which already replaces its port after ready. The pty service's old rule, refusing a second channel while one is open, is what loses the replacement.
- **Acknowledgement.** Each child answers its adoption on its parent port: `{ type: "pty-control-adopted", generation }`. A hand-over is complete only when both children acknowledged the same generation.
- **Timeout and retry.** Without both acknowledgements within 5 s, main retires generation G and posts generation G+1, at most 3 generations per (re)start.
- **Retiring a generation after both ports were transferred.** Main holds no live endpoint once a port is transferred: Electron's `MessagePortMain` moves the endpoint, so closing main's references would disconnect nothing (the review reproduced this with real transferable ports). Retiring G is therefore done at the receivers, in three bounded layers:
  1. **A close instruction.** Main posts `{ type: "pty-control-close", generation: G }` on each child's parent port. A child closes its port of generation G (if it adopted it) and answers `{ type: "pty-control-closed", generation: G }`. An instruction for a generation the child never adopted, or already closed, is answered the same way and changes nothing else.
  2. **Child-side expiry.** A child that adopted a generation but has not been told it is acknowledged by main within 10 s (`pty-control-confirmed`, sent once both acknowledgements are in) closes that port itself. A channel cannot outlive a main that lost track of it.
  3. **Teardown.** If a child does not confirm the close within 2 s, main stops it by its exact pid (`SIGKILL`). Its supervisor restarts it under its restart policy, which counts the teardown. A child's exit ends every endpoint it held.
- **The final state.** After 3 failed generations, main records `handover_failed` and tears the pty process down. The pty process is then held, and the daemon keeps running with no control port: every pty-backed call settles `channel_closed` at once, and nothing queues. With a healthy daemon that lasts until the app restarts. **The hold is released by the next daemon start attempt** (OS-3h review S1): if that daemon later crashes, its restart first resumes the pty process and waits for it, so nothing is stranded. A pty process that failed for good (its own crash loop) makes the waiting daemon start fail as `pty_unavailable`, reported at error level, never left waiting in silence. No endpoint remains usable, and none is charged without an owner.
- **A late exit, or one restart while the other holds a stale channel.** An exit makes main post the next generation to the survivor once its peer is back. An acknowledgement for an older generation is ignored.
- **The daemon's own wait.** The daemon refuses to run without a control port (exit 78, `pty_required`, after its 10 s initial wait). The pty process's restart backoff can exceed that wait, and the supervisor treats exit 78 as a configuration failure and does not restart it. So main does not spawn the daemon while the pty process is not running. If the daemon ended `pty_required`, main starts it again once the pty process is alive, once per pty generation. Infrastructure delay therefore never leaves the daemon permanently stopped.
- **Tests:** a replacement delivered before the old close; simultaneous restarts of both children; a late exit; a post that fails on one side; a child that never acknowledges (the bounded retries, then `handover_failed`); a pty backoff longer than the daemon's wait (the daemon is not stranded). Also, with REAL transferable ports (Node's `MessageChannel` between worker threads): a receiver adopts the last generation but withholds its acknowledgement and its close confirmation. After the final failure its endpoint must be unusable (a message sent on the peer end is never delivered, and the daemon's pending call settles `channel_closed`), and no request stays queued. Every case ends in a working channel or a defined failed state, never a silent one.
- This changes `@axis/pty-process` (the service's adoption and the acknowledgement) and `@axis/daemon-host` (the entry's acknowledgement, the hand-over's generations and retries, the supervisor's start gate on the pty process).
- **The legacy shape.** Both entries still accept `{ type: "pty-control" }` without a generation, adopted latest-wins and never acknowledged or expired: the Code OSS shell, which keeps `ControlHandover`, sends it until OS-22.
- **A replaced channel ends its terminals: a deliberate decision.** Adopting a newer generation retires the old channel exactly as if it had closed, so every terminal, exec and scratch attempt on it ends (a pty-process test pins this). The daemon owns the terminal registry, and a replaced or restarted daemon starts with an empty one, so a surviving shell would be an orphan nobody owns. There are no terminals before OS-3p and DC-3b.
- **A known consequence for slice 3.2 and DC-3b.** A hand-over RETRY replaces the control channel even when the daemon did not restart (only the channel was replaced, after a missing acknowledgement), and that also ends live shells. A retry is rare (it takes a missing acknowledgement). If terminals are ever to survive a channel-only replacement, DC-3b's design must say how; DC-3b keeps the data channels and their connection names valid across it.
- **A child still loading is waited on** (OS-3h review S2). Each side's acknowledgement window opens at the child's first message, or 30 s after its spawn. While it is closed, an unanswered generation waits (uncounted) and an unanswered close never tears the child down; the daemon's own 60 s ready timeout bounds its start. Measured on a warm cache, spawn to hand-over takes about 1 to 1.2 s.
- **Answers are bound to the child instance.** An acknowledgement or close answer counts only from the child that is current for its side; the pty answer listener goes with its child's exit.
- **The mutation runners run in CI** (OS-3h review): a `mutation` job runs `desktop-main`, `desktop-wiring` and `os-3h` on every change, so a stale anchor fails a check instead of going unnoticed.
- **Measured** on Linux under WSLg: generation 1 is posted and acknowledged by both before the daemon is ready. After a SIGKILL of the daemon by its pid, the daemon restarts and generation 2 is acknowledged by both; the seam smoke test pins both.

## 4. Slice 3.1: the test plan

- **Forked-file pins, on the BUILT `daemon.cjs` and `pty.cjs` alike** (as `daemon-host/test/process-main.test.ts` requires; the behavioural test alone catches neither a static entry import nor `once`):
  - A `Module._load` trace, as in `apps/desktop/test/entry-order.test.mjs`. Only the guard's modules load before the listener exists, and the entry's graph only after it.
  - A text pin of each source file: one static import (the guard); the entry by `import()`; no other code before it.
  - The guard's listener is `on`: `once` is refused by the pin and by a mutant.
- **Real-child tests**, saying what each can prove:
  - The built files under plain Node have no Electron parent port, so each entry reaches its own refusal (the daemon exits 78) instead of running. Those runs prove the load order, not survival, and they do not rely on Node honouring `--disable-sigusr1`.
  - A smoke-style Electron test, separate (display needed, not in the gate): main forks the real `daemon.cjs` and `pty.cjs` through `utilityProcess.fork`. `SIGUSR1` sent to both from 300 ms after each appears (past the band before any statement runs) until the daemon is ready leaves no inspector on `127.0.0.1:9229`, and both children alive.
- **Read-only `cwd`.** Both children start, reach ready and answer with their `cwd` set to a read-only directory: the smoke test runs the app from a read-only copy of its bundle. Every spawn the pty process accepts needs an absolute `cwd` of its own (`@axis/pty-process`'s tests). The terminal backend refuses in slice 3.1, so a real shell's `cwd` is proven by OS-3p's smoke test.
- **The interim tier-4 state, as far as slice 3.1 can prove it:** main's answers refuse `native.confirm` in the same tick and answer `trust.check` false. Daemon-host's own test proves that a native refusal is a refusal. The end-to-end proof, with a real client connection and a tier-4 operation that actually reaches `native.confirm` (so the trust-false path cannot make it pass vacuously), is slice 3.2's.
- **The no-backend refusal.** The pty process's spawn refuses with "no terminal backend"; a real shell and its explicit `cwd` are OS-3p's smoke test.
- **Bundle checks** (`apps/desktop/test/bundle.test.mjs`):
  - `main.cjs`'s inputs from `@axis/daemon-host` are only `src/main/*`, `src/supervisor.ts` and the two control-schema files main parses with (`src/control/messages.ts` and `src/control/secrets-messages.ts`, by name: not the whole `control/` directory). The test asserts that the supervisor, the answers and the control parser are actually included, so an empty graph cannot pass, and that handlers, storage, the composition root and `node:sqlite` are not.
  - A size budget for `main.cjs`, set from a measurement and enforced (the test fails when it is exceeded). The budget is on the code esbuild emits for main's inputs (the metafile's `bytesInOutput`), not the file size, which also holds a path comment per module and so grows with the checkout's depth. It was measured at 1,122,574 bytes; the budget is 1,180,000. The bundle script sets `absWorkingDir` to the app, so the file itself (1,132,537 bytes when measured) is the same whatever directory it is built from, which a test pins. The test also pins main's exact daemon-host input list, and the daemon host's exports map (`.`, `./main`, `./entry`, `./signal-guard`). Zod is about 751 KB of it, and main needs zod for the control messages, so the narrow subpath shrinks main only a little: from 1.22 MB in OS-2. Minifying `main.cjs` and `zod/mini` are out of scope for slice 3.1.
- **Unit tests with fakes**, in the style of `apps/desktop/test/hardening.test.ts`:
  - start order (pty, then daemon) and the anchor read before the spawn;
  - the exact fork arguments (entry, service name, environment, `cwd`, stdio), and a relative or renderer-derived entry refused;
  - a restart after a child exits;
  - the shutdown order, and its timeout path;
  - the closed refusals of `native.confirm` and `trust.check`.
- **Mutants.** `scripts/mutation/desktop-wiring.mjs` grows over the new main modules: start order, `cwd`, environment, the guard first, `on` not `once`, shutdown order and the refusals. Each test file lists its mutants.
- **Smoke.** The existing window and boundary tests stay green. A smoke check shows the daemon reaches ready, answers over its control channel, and exits cleanly on quit.

## 5. Slice 3.2: renderer connect and window lifetime (contract)

Built test-first on `feat/os-3-2-connect`. If it grows large it is reviewed in two slices: **3.2a** (the handlers, the epochs, the pruning and the answers) and **3.2b** (the native dialog queue).

**Sender first, on every channel.** Every `ipcMain` handler (`axis:connect`, `axis:projectAction`, `axis:terminalPort`, and `axis:openExternal` as already) runs the registry's sender check before it parses anything. A sender that fails gets **nothing back**: no reply at all.

**The document, not just the window** (the plan review's condition 1).
- The registry records, for each app window, the identity of its CURRENT main-frame document: the frame's process id and routing id, taken at `did-navigate` of the main frame.
- A request whose `senderFrame` is not that document's frame is refused as `stale_document` before parsing. Its window's epoch is not read for it.
- So a connect from an old document that is still in flight after a reload began can never be attributed to the new epoch.

**Epochs**, as agreed with DC-3b:
- Each window has an epoch, a safe integer from 1. `registry.epochOf(windowId)` reads it, and is undefined for an unknown or gone window.
- On `destroyed`, `render-process-gone`, or a main-frame `did-start-navigation` that is not same-document (reloads included), main ends the epoch: it bumps it, forgets the current document, and sends the daemon `window.gone { windowId, epoch }` with the epoch that just ENDED. A same-document navigation keeps the document, which then fails the exact-URL check anyway.
- The connect identity main signs (`MainWindowIdentity`) carries the current epoch. The daemon binds what it hands out to `{ windowId, epoch }` and refuses an epoch at or below the last `window.gone` it saw for that window.
- `window.gone` and the identity schema gain the field strictly: the old shapes are refused.

**The connect.**
- `ConnectBroker` is adapted, not pasted: a `connectApp(windowId, nonce)` path skips the Code OSS sender check and workbench URLs (the registry did that), and keeps the nonce check, the per-window rate limit, the window bound and the identity minting.
- `windowTrusted` goes: the identity carries `trusted: false`, as OS-3b decides.
- One `MessageChannelMain` per connect. The daemon end goes in the signed `connect`; the renderer end goes to that sender only, as `axis:connectResult { nonce, pty }` with the port.
- A refusal answers `{ nonce, error }` with a closed reason. A supervisor that stopped for good maps to `stopped_lock_held` and the like.
- `pty` is `"ok"`, `"handover_failed"` or `"unavailable"`: **informational, display only.** No daemon code and no authority decision reads it.

**Per-window pruning on `closed`:** the registry entry and its document, the epoch, the rate bucket, the openExternal opener's slot, and the native queue's waiting dialog (aborted).

**`native.confirm`** (3.2b).
- `dialog.showMessageBox(win, { type: "warning", message: <fixed>, detail, buttons: ["Cancel", "Confirm"], defaultId: 0, cancelId: 0, noLink: true, signal })`.
- `detail` is the daemon's summary, **re-sanitised by main** whatever the daemon claims (condition 2): control, bidirectional and format characters removed, whitespace collapsed, and truncated to 192 characters.
- The signal aborts on the challenge's expiry and on the window's close. Main never destroys a dialog's window from outside (GTK).
- One dialog per window; it is modal on that window, a sheet on macOS.
- The orphaned openExternal confirmation is aborted the same way on close.

**`trust.check` is "the window is live"** (condition 3): true only for a registered, live app window. **It is not an authorization.** The daemon's own gate still requires T1, the repository and worktree binding, and T4. The window the daemon trusts is the one in the identity main signs, never a value a renderer sends.

**Closed refusals until their tickets:**
- `axis:terminalPort` answers `{ nonce, error: "not_available" }` until DC-3b;
- `axis:projectAction` does the same until OS-3b.

Both run the sender check first: a bad sender gets nothing, and a good sender gets the refusal (condition 5).

**When the daemon cannot run** (its supervisor ended `lock_held`, or any other final failure), main stops its own pty process, which has nobody to serve.

**Tests**
- Unit tests with fakes:
  - each handler's sender check comes before any parse (a spy on the parser);
  - a bad sender gets no reply;
  - the refusals' exact shape;
  - `connectApp`'s nonce, rate limit and identity, the epoch included;
  - the epoch bump on each of the three events, and none on a same-document navigation;
  - the stale-document refusal with fake frames that differ in routing id, dispatched after the navigation started;
  - the pruning, each item;
  - the dialog options exactly (Cancel the default and the cancel answer, the button order, no link);
  - a hostile summary (bidirectional, control, over-long) re-sanitised;
  - the abort on expiry and on close, and never a window destroy;
  - `trust.check` true only for a live window;
  - the `pty` field.
- Schema tests: `window.gone` with its epoch and the identity's epoch, both strict, and the daemon's verifier.
- Real Electron (smoke style, no window manager on CI):
  - a real renderer connects and speaks over its port;
  - after a reload the old document's connect is refused and the new one is served;
  - `forcefullyCrashRenderer()` sends `window.gone`;
  - `terminalPort` and `projectAction` are refused;
  - a `native.confirm` dialog is open when main closes the window, which cancels it ("closing the window cancels it").
- **The tier-4 end-to-end:** before launch, a seeding tool under `testing/` runs daemon-host's own composition offline to register and trust a fixture repository in a fresh data directory. It uses a throwaway key, never a real attestation key, and is never imported by main. The bundle test proves no `testing/` path reaches `main.cjs`. Then a real renderer starts a tier-4 operation that reaches `native.confirm`, so a false trust answer cannot make it pass.
- **Mutants** for every handler order, epoch step, pruning item and dialog option, run by the CI mutation job.
- macOS and Windows dialog behaviour (the sheet, focus return) stays unverified until OS-21's jobs.

**Slice 3.2 and OS-3p must also prove**, from the OS-3h review: a real shell survives a confirmed hand-over and ends on a replacement; a SIGKILL teardown ends the shell's process group; a hand-over retry during a live terminal behaves as §3a says; and the hand-over state, the `handover_failed` and `pty_unavailable` end states included, is shown to the renderer.

**Slice 3.2 must prove**, from the slice 3.1 reviews:
- a real tier-4 call from a renderer reaches `native.confirm`, with the dialog rules on every OS, in a test a false trust answer cannot pass;
- `axis:connect` checks the sender before it parses, with `window.gone` and the per-window pruning;
- `trust.check` as above;
- `axis:terminalPort` refuses until DC-3b;
- the hand-over's acceptance, if OS-3h has not landed;
- `lock_held` shown to the renderer, and main's unneeded pty process stopped when its daemon cannot run;
- the single-instance lock order kept, and a packaged name that keeps Chromium's lock files out of the data roots.
- **The end-to-end interim proof slice 3.1 could not give:** a daemon started by main answers a tier-4 operation from a real client connection with its closed refusal, not a hang. Slice 3.1 proves only main's side: its answers refuse `native.confirm` in the same tick and answer `trust.check` false. Daemon-host's own test proves that a native refusal is a refusal. Main carries no test-only connect hook: it would be an attack surface of its own.

## 6a. OS-3p: the terminal backend

`node-pty` is the only new dependency OS-3 needs. Code OSS shipped it, and nothing in this repo depends on it yet. It is its own ticket and its own review: a supply-chain and documentation review, plus a review of the build step. Its requirements:

- **Where it lives.** In `apps/desktop`, never in `packages/*`. ADR 0005 D4 keeps the packages to `zod` as their only runtime dependency ("No other runtime dependency without an ADR amendment"). The pty process's spawn function is injected (`createNodePtySpawn`), so `@axis/pty-process` stays free of it.
- **The pin.** The exact newest release that is at least 14 days old (checked with `npm view node-pty time`), with its integrity in the lockfile. Its licence must be compatible with `docs/LICENSING.md`, and every new package, transitive ones included, is listed with any install script it carries.
- **The Electron 45.3.2 ABI.** Prebuilt binaries or a rebuild step, whichever is safer and reproducible, and the note says what runs at install time. The repo installs with `--ignore-scripts`, so the native build is an explicit, pinned, auditable step in the bundle or CI script, never a `postinstall`.
- **The notices.** `THIRD-PARTY-NOTICES.txt` generation includes it, and its test still passes.
- **CI.** The desktop smoke job, and any macOS and Windows jobs: what builds the native module on each runner, and what happens on a runner without a toolchain.
- **A smoke test.** A real pty spawns `/bin/sh` in the packaged-shaped layout, with its own explicit `cwd` (never the bundle directory). Slice 3.1 could not show this: its spawn refuses.
- **Alternatives considered** are recorded with the ticket: `node-pty` against a PTY through a small helper process, and why `node-pty`.

## 6. Slice 3.3 in outline: the handoff from N0c-1

The real main's `SecretBackend` must guarantee what the fake in N0c-1 assumes:

- **H-1:** one operation per name; a running operation keeps its name until its work settles, even after it answered `failed` at the budget.
- **H-2:** a request answered `failed` while still waiting never runs afterwards.
- **H-3:** `failed` is the only put answer that can mean "maybe written"; `refused`, `corrupt` and `not_found` mean nothing was written.
- **H-4:** a put whose `meta.backend` or `meta.protection` differs from where it would write is refused.
- **H-5:** the budget starts at accept: at most 4 queued and 8 outstanding, counting timed-out operations that have not settled; `info` never queues; plus the thread-pool bound of N0c §3.4.
- **H-6:** `get` reports `meta.protection` from the ciphertext, not from the stored meta.
- **H-7:** no shared object references inside an answer.

The contract is agreed with the N0c work before slice 3.3 is coded, and it depends on N0c-1 being merged.

## 7. Deferred, and where

| Item | Where |
|---|---|
| The acknowledged control hand-over (§3a) | OS-3h |
| The terminal backend (`node-pty`), its native build and its notices | OS-3p |
| The terminal data broker (`axis:terminalPort`) | DC-3b |
| Project actions, the folder picker, trust without Code OSS | OS-3b |
| The packaging fuses and the launch test (G-28) | OS-21 |
| Stripping the smoke hooks from packaged builds | OS-21 |
| Monaco's Trusted Types policy for its workers | OS-18 |
| The openExternal rate limit and loopback flagging | after OS-3 |
