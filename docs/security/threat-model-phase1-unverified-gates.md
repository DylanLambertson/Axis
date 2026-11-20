# Threat model: Phase 1 gate items that Linux cannot verify

- **Status:** Draft for review. Refreshed 2026-11-20 against `origin/main` `76575e4`; this lists gate evidence still missing after the merges since `74cd12e`.
- **Merged components:** B9 (`86247ab`), X1b/X1c (`2a0acff`), E1 (`116ef22`), A3 (`cc087cb`), C8/S4 (`5e4e797`), C4 (`6b5d50f`), J2/C10 (`d47fb8a`), REF1-SCAN library (`6293443`) and H13 (`13b036f`). Their package tests do not replace real-app or cross-platform gate runs.
- **Why this list exists.** The Phase 1a and 1b gates are stated "on macOS, plus Windows/Linux CI smoke" (`docs/ROADMAP.md`). What runs today is the `Axis packages` job on `ubuntu-24.04` (`docs/ci.md`): typecheck, build and `npm test`, which includes the headless slice of `@axis/daemon-host`. There is no Windows job. A macOS job for the slice exists on branch `ci/macos-headless-slice` and is not on main (plan question 12). The pinned Code OSS build has been validated natively on Linux x64 (`docs/feasibility/linux-build-validation.md`) and measured on macOS x64 (`docs/design/axis-shell-stage1-built.md`); no Windows build has been run.
- **Every Windows or macOS behaviour below that is not cited to a measurement is [I] (inferred, not run).**
- **Claims here are limits of this revision's evidence**, not findings about the code. "Linux evidence" names the test or document that exists; where none is named, there is none. Platform behaviour that is not measured is marked **[I]**.
- Gate-line numbers are those of `threat-model-phase1-controls.md` §5.1. Tickets are those of the residual register.

## 1. Open implementation or integration work

A merged package can still leave a gate open when its host wiring or required test is absent.

| Gate | What is missing | Ticket |
|---|---|---|
| 1a/L2, L10, L17, L24 | B9 merged (`86247ab`) and POSIX group-liveness tests exist in `packages/pty-process/test/group-kill.test.ts` and `test/code-oss/node-pty-real.test.mjs`. Windows job-object acceptance and a real app run are missing; detached children and restart tracking remain limits. | B9; RR-2 |
| 1a/L3, L14, L18 | H13 run snapshotter merged (`13b036f`), but the commit and push drift gate still uses the separate worktrees snapshot path; H13b and the complete CLI drift scenarios remain open. | RR-3 |
| 1a/L15 | Pty scratch, exec and hook primitives merged (`2497928`, `7fe8311`); the host still does not run commit hooks, and push hook integration is incomplete. | H9-hooks; RR-4 |
| 1a/L32 | REV2-FIX git-ops attribute reader merged (`0b69378`), but review does not yet use it; the attribute-swap gate remains open. | RR-13 |
| 1a/L13 | Workbench registration of the four `axis.*` settings with user, application or machine scope. | RR-15 |
| 1a/L33 | Refusal of `--remote-debugging-port` and `--inspect*` in a packaged build. | RR-19 |
| 1b/L1 to L16 (daemon side) | C1/C2/C4/C5/C8/C9/C10/C11, J2 and REF1-SCAN library are merged. C3 command and broker-git wiring, C6 Anthropic/vault integration, host snapshot-scanner wiring, app recovery and full acceptance are still open. The individual gate lines need their own merged tests. | RR-20 to RR-29 |

## 2. Built, but verifying needs an Electron or Code OSS run (macOS and Windows as much as Linux)

Much package logic is tested on Linux with injected fakes. The gate wording needs the real shell, window or process.

| Gate | What needs the real app | Linux evidence today |
|---|---|---|
| 1a/L1 | Scenarios 2 to 5 of `docs/PRODUCT.md` with an installed agent CLI; stub `gh` run with the expected arguments. | Push to a local bare remote and compare URL in slice step 6 and `@axis/git-ops` tests. No code that runs `gh pr create` was found in `packages/` at `74cd12e` (only the compare URL), so the stub-`gh` half of the line is **not built**. |
| 1a/L2 | PTY-5 with the git extension enabled, `git.terminalAuthentication` on and a test extension adding an environment collection. | `@axis/pty-policy` tests and slice step 3 (a plain child process, seeded names). The extension-collection half needs a real Code OSS run; B9 is merged. |
| 1a/L8 | Tier 4 confirmation through the native dialog (`dialog.showMessageBox`, main-built summary, APR-2). | Challenge manager and gate tests; the slice answers `native.confirm` from a test supervisor. |
| 1a/L9, L19, L25 | Restricted Mode, trust re-derived at mount/start, and main attestation in the real app. | Host registry and single-use attestation in the slice; X1c main answers merged (`2a0acff`) with `main-answers.test.ts`. App integration remains unverified. |
| 1a/L11, L30 | Keyboard-only run of all three view modes; screen-reader announcement of a view switch; typing after a switch reaches only the destination. | none (shell A1 has a workspace model test, no input-routing run). |
| 1a/L22 | Open VSX signed, unsigned and tampered install against a packaged build. | none; a packaged build refuses every gallery install today. |
| 1a/L23 | ADR 0003 criteria 1 to 7 (window identity, frame URL and main-frame checks, MessagePort hand-off); Trusted Types with no violation in the Axis React bundle. | Envelope, limits and handshake in `@axis/daemon` and `@axis/protocol`; X1b/X1c main checks are merged, but their packaged-app path remains unverified. Trusted Types was measured on a macOS reh-web build for the workbench only. |
| 1a/L27 (UI half) | Control and bidirectional characters escaped in diff review and dashboard rows; symlink display in the tree and preview; Open-in-IDE refusal outside the worktree. | `toDisplayPath` and protocol display rules are unit-tested; the rendering is not. |
| 1a/L28 | EL-5 on every platform; the renderer change in `window.ts`. | Main-process refusal measured on macOS; the renderer change has no complete real-app test and was not exercised in a running macOS or Windows app. |
| 1a/L29 | Loopback port scan during a desktop run, no reh-web start. | Linux: no listener with no extensions, one GitLens loopback listener with the pinned set (`linux-build-validation.md` §10). Not an automated gate. |
| Entry (X1, merged) | `utilityProcess` and `parentPort` behaviour: an `init` queued before the listener attaches; an unref'd init timer that must not let a process with no `init` exit 0 (read as a crash instead of 78); Electron adding no `execArgv`; the minified desktop `main.js` still running the supervisor after private-field mangling. | Entry and supervisor tests with fakes and manual timers, on Linux. |

## 3. Platform-specific behaviour that Linux cannot confirm

| Gate | Mac or Windows difference | Why Linux misses it |
|---|---|---|
| 1a/L5 (DMN-2) | macOS: case-insensitive and normalising file systems, so `Repo` and `repo`, and NFC against NFD names, can name one folder. Windows: case folding, 8.3 short names, junctions, drive-relative and `\\?\` paths. | The registered-worktree check compares `realpath` results; Linux file systems are case-sensitive and do not normalise. The gate names "macOS case and Unicode-normalisation variants", so the line is open until run on APFS. |
| 1a/L31 (CLI-1, CFG-1) | Windows searches the current directory first for a bare command and resolves through `PATHEXT` (`.cmd`, `.bat` shims); executable bits do not exist. The rule "ignore the cwd and empty or relative `PATH` entries" must be shown there. | `@axis/pty-policy` exec and symlink tests assert POSIX semantics only [I]. |
| 1a/L10, L24 | Windows has no `SIGTERM` for the host (the control `shutdown` message is the path) and no process groups (job objects, breakaway disallowed) **[I]**. macOS needs the same group test as Linux. | Slice step 8 uses SIGTERM; step 10 uses SIGKILL. The Windows `shutdown` message path and job objects are not run. |
| 1a/L7, L20 (DMN-5) | Anchor store and key storage: macOS Keychain, Windows DPAPI-backed storage, Linux libsecret or `basic_text` (PRV-1). The anchor is only as strong as its store (plan question 3). Single-instance lock and database file replacement semantics differ on Windows [I]. | The slice anchors in memory; the lock is a file lock on POSIX. |
| Data directory | Design D-3 (implemented in #454, merged; not run off POSIX) puts worktrees and the database under `$XDG_DATA_HOME` on Linux, `~/Library/Application Support` on macOS and `%LOCALAPPDATA%` on Windows. Electron `userData` is `~/.config` on Linux and **Roaming** `%APPDATA%` on Windows, which a domain profile can sync (the defect raised against the entry branch; #454 follows D-3 instead). 0700 and 0600 modes do not apply on Windows; ACLs are not set. | Not run off POSIX. |
| 1a/L26, L1, L18 (git) | Apple's and Windows' git builds, `core.autocrlf`, `core.ignorecase`, `core.symlinks=false` on Windows, case collisions between `axis/<slug>` refs on case-insensitive volumes. | Tests must not assume a git version or OS, and run against the Ubuntu git only; the macOS job is unmerged. |
| 1a/L27 (FT-1) | Creating a symlink on Windows needs a privilege; junctions and reparse points follow other rules. | Symlink fixtures run on POSIX. |
| 1b/L4, L6, L8 | Process-group kill, output cap and environment allow-list for broker children on Windows (`PATH` and `Path`, case-insensitive names, `SystemRoot`, the Windows variables missing from the daemon allow-list noted on the entry branch). | `@axis/broker` tests are POSIX. |
| 1b/L10, L11, PRV-3 | `basic_text` refusal is a Linux case; macOS keychain labelling and `ELECTRON_RUN_AS_NODE` reuse of a signed binary are macOS and Windows effects. | Vault tests use the in-memory backend and fake backend ids. |
| 1b/L15 (ANT-1) | System roots and proxy interception (A7). | Contract tests against a local fake server. |

## 4. Follow-ups to schedule

Tickets are proposed ids unless a row exists; the plan owners add them.

| ID | Follow-up | Closes |
|---|---|---|
| UV-1 | Merge the macOS slice job (branch `ci/macos-headless-slice`) and make it a required check; add a Windows job that at least runs the packages typecheck and the non-POSIX suites. Plan question 12. | the CI half of "on macOS plus Windows/Linux" |
| UV-2 | A macOS run of the DMN-2 fixtures on APFS (case and NFC/NFD variants, a symlinked worktree root) and a Windows run of the same cases (junction, short name). | 1a/L5, L19 |
| UV-3 | A Windows run of CLI resolution (`PATHEXT`, a planted `.cmd` in the worktree, cwd search) against `@axis/pty-policy`. | 1a/L31 |
| UV-4 | Run the merged B9 group-liveness test on macOS and validate the Windows job-object path; Linux POSIX coverage exists in `packages/pty-process/test/group-kill.test.ts`. | 1a/L10, L24 |
| UV-5 | Electron smoke on each platform: handshake and window-identity criteria 1 to 7, native dialog content, `utilityProcess` entry exit codes, the minified-main supervisor, a packaged-build debugging-port refusal and a port scan. | 1a/L8, L23, L29, L33 |
| UV-6 | The Open VSX install test on a packaged build, with the outcomes recorded in `docs/feasibility/extension-compatibility.md`. | 1a/L22 |
| UV-7 | Run the data-directory roots that #454 implements per design D-3 on Windows and Linux (no Roaming profile, XDG data) before real ports are wired. | RR-6 |
| UV-8 | A keyboard-only and screen-reader pass of the three view modes on macOS (VoiceOver) and Windows (a Windows screen reader). | 1a/L11, L30 |

## 5. What a Linux-only reviewer can still sign off

- The daemon half of 1a/L7, L8, L10 and L20: authentication of principals, challenges, the audit chain with a tail anchor, degraded mode, restart recovery of runs and the idempotency states, as the headless slice shows them, **with the fakes of the compose doc**.
- Pure-function controls: PTY-5, SI-ENV, GIT-ENV-1, CFG-1 scope logic, GIT-7 argument rules, the compare-URL host match, the push scan and its closed refusals, the reviewed-tree binding.
- Not signed off by Linux evidence: anything in sections 1 to 3.
