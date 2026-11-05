# Linux x64 build validation (native, WSL2)

- Dates: 2026-11-03 and 2026-11-04.
- Upstream: `microsoft/vscode` tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`, with the patch series, `replace/`, overlay and hook as at `origin/main` `dc29b38` (15 patches, 16 replaced files, 9 overlay files, 1 hook). Every build, package and matrix number below covers that commit. `origin/main` has since moved (it was `2e30f4b` at the last check; docs, packages and daemon changes); the build was not repeated on it, and the patch series was not re-checked.
- Scope: `docs/feasibility/code-oss-build.md` §7 recorded the Linux build as failed in Docker (compile OOM-killed at 7.75 GiB) and deferred it. This document validates it natively on a Linux host, runs the checks CI runs on Linux, runs the Open VSX extension matrix headless against the packaged build, and checks the reh-web output and loopback listeners.
- Status words follow `code-oss-build.md`: **passed**, **failed**, **not run**, **not applicable**. Every number below was measured, not estimated; the memory rows are readings of a 15-second sampler on a shared host. A failure is a recorded result.
- Nothing recorded in `docs/feasibility/extension-compatibility.md`, `scenarios.json` or `extensions.json` was edited. This document records outcomes next to them; moving them into that matrix is a separate change.

> **Not a distributable build.** Same caveat as `code-oss-build.md`: a local validation build, run only on this machine.

## 1. Summary

| Area | Result |
|---|---|
| Pinned build, native Linux | **Passed on the second attempt.** The first attempt failed in `npm ci` on missing host packages (§4, problem 2). With them supplied in a user-space sysroot, `build.sh` completed in 6 min 14 s (§5). |
| Packaged targets | `vscode-linux-x64-min` **passed** (4 min 46 s). `vscode-reh-web-linux-x64-min` **failed once** on a network error while fetching Node, then **passed** on retry (3 min 31 s). |
| CI-equivalent checks on Linux | Every check that could run **passed** once `jq` was available. Without `jq`, 8 of 43 extension-matrix unit tests **fail** (§6). The gitleaks step was **not run** in the original session; a later run of gitleaks 8.30.1 over this branch found no leaks (§6). |
| SC-3 artifact check (`check-artifacts.sh`) | **Passed** on the packaged desktop and reh-web outputs. The reh (non-web) server was not built, so the script's default all-three requirement was not exercised (§7). |
| Extension matrix, packaged desktop, headless | Probe verdicts: 9 passed, 4 blocked (Rust, Go and clangd toolchains absent), 0 failed. Counting the activation scan too: **6 clean, 3 passed the probe but have scan findings (S02 to S04), 4 blocked**. In S04 `ms-python.debugpy` **fails to activate in a normal window** because proposed APIs are stripped, so Python debugging is broken for users even though the probe passed (§8). The normal-window check of S04 is a **failure**. |
| reh-web | The built server still serves `frame-src 'self' https://*.vscode-cdn.net data:` (H2 open, expected), no Trusted Types requirement (H1) and a token cookie without `Secure` (H3) (§9). |
| Loopback listeners | The desktop build with no extensions opened **no listening socket**. With the pinned set installed, GitLens opened `127.0.0.1:<port>` (§10). The reh-web server listens on loopback by design. |
| Bootstrap | `apply.sh` fails on a fresh host before Node exists, and `build.sh --toolchain-only` refuses to run on an unapplied tree (§4, problem 1). |

## 2. Host

| | |
|---|---|
| OS | Ubuntu 26.04.1 under WSL2, kernel 6.18.54.1-microsoft-standard-WSL2, x86_64 |
| CPU / memory | 16 cores; 31 GiB total, about 25 GiB free at the start; 8 GiB swap |
| Disk | 1007 GB volume, 942 GB free at the end |
| Other load | Other processes shared the host throughout. One unrelated test run elsewhere on the host briefly held about 25 GB of RSS while this build was idle; it is not part of any number below. |
| Display | None. All Electron runs used Xvfb. |
| Privileges | No `sudo`. Nothing was installed system-wide. |

Toolchain used by the runs:

| Item | Version | Source |
|---|---|---|
| Node.js | 24.22.1 (linux-x64 tarball, SHA-256 `eb6728e7…6002d7c`) | The pinned tarball, verified by the repository's own `download_node` against the manifest pin and the release `SHASUMS256.txt` |
| npm | 11.19.1 | Bundled |
| node-gyp | 12.4.0 | Bundled. Electron headers 43.8.3 |
| Python | 3.14.4 | Host |
| GCC | 15.2.0 | Host |
| Git | 2.53.0 | Host |
| shellcheck | 0.11.0 | The release pinned in `.github/actions/install-shellcheck`, SHA-256 checked |
| actionlint | 1.7.12 | The release pinned in `ci.yml`, SHA-256 checked |
| jq | 1.8.1 | Ubuntu package, unpacked into a user directory (§3) |
| Xvfb | 21.1.22 | Ubuntu package, unpacked into a user directory (§3) |
| gitleaks | not installed | A manual diff scan was done before the push instead |
| cargo, rustc, go, gopls, clangd | not installed | Their scenarios report `blocked` |

## 3. Environment set-up

Paths without whitespace, as `build.sh` requires:

```bash
export AXIS_CODE_OSS_VENDOR_DIR=$HOME/.cache/project-axis/lx
export AXIS_CODE_OSS_TOOLS_DIR=$HOME/.cache/project-axis/lx-tools
```

The CI package list for Linux is `build-essential pkg-config libx11-dev libx11-xcb-dev libxkbfile-dev libnotify-bin libkrb5-dev python3`. This host had `build-essential` and Python but none of the others. Without `sudo`, they were fetched with `apt-get download` (works without root), unpacked with `dpkg -x` into `$AXIS_CODE_OSS_TOOLS_DIR/sysroot`, and made visible through environment variables only:

```bash
export PATH=$SYSROOT/bin:$PATH                       # wrapper for pkgconf, jq
export CPATH=$SYSROOT/usr/include:$SYSROOT/usr/include/x86_64-linux-gnu
export LIBRARY_PATH=$SYSROOT/usr/lib/x86_64-linux-gnu
export PKG_CONFIG=$SYSROOT/bin/pkg-config             # sets PKG_CONFIG_PATH and PKG_CONFIG_SYSROOT_DIR
```

Dangling `.so` symlinks left by the `-dev` packages (`mit-krb5/*.so`) were re-pointed at the system runtime libraries. Xvfb and its runtime libraries (NSS, ALSA, Xss) were unpacked the same way. The build scripts themselves were not modified.

Parallelism: `npm_config_jobs=16` for the native module compiles. The Node heap was left at upstream's `--max-old-space-size=8192` in the gulp tasks, so the numbers are for the shipped settings. A heap sweep of the compile step alone is in §5.

## 4. Problems found, with a recommended change for each

1. **Bootstrap deadlock on a fresh host (fails).** `apply.sh` runs the post-apply hook `10-regen-locks`, which needs the pinned Node. On a host with no Node, `apply.sh` exits 1:

   ```text
   10-regen-locks: needs Node 24 and npm (run scripts/code-oss/build.sh once or set NODE24_BIN)
   error: post-apply hook 10-regen-locks failed; the tree is marked incomplete
   ```

   The advice does not work: `build.sh --toolchain-only` calls `require_applied_tree` first and fails with `patches and overlay are not (completely) applied`. The way out used here was to source `lib.sh`, call `load_manifest; download_node` (the repository's own pin-checked download), and rerun `apply.sh`. Cost: 10 s. The hook's other branch, `NODE24_BIN`, works only if the exact pinned Node 24.22.1 already exists on the host. **Recommended change** (`scripts/code-oss/build.sh`, `apply.sh`): resolve Node before the applied-tree check in `--toolchain-only` (`scripts/code-oss/build.sh:37-49`), or let `apply.sh` call the same pin-checked download when a hook needs it; correct the hook message to say what works.
2. **`build.sh` does not check host packages; `npm ci` fails late (fails).** Attempt 1 ran for 95 s and failed in `native-keymap`:

   ```text
   /bin/sh: 1: pkg-config: not found
   gyp: Call to '${PKG_CONFIG:-pkg-config} x11 xkbfile --libs' returned exit status 127 while in binding.gyp.
   ```

   Only the manual workflow installs the packages (`code-oss-build.yml`); `build.sh` and `DEVELOPMENT.md` do not list them. **Recommended change** (`scripts/code-oss/build.sh`, `DEVELOPMENT.md`): add a preflight that checks `pkg-config`, the X11, xkbfile and Kerberos headers and `jq`, fails in seconds with the package list, and document the same list in `DEVELOPMENT.md`.
3. **Upstream's `bin/axis` launcher prompts on WSL.** It asks `Do you want to continue anyway? [y/N]` and blocks any non-interactive use (`install.sh` hung on it). `DONT_PROMPT_WSL_INSTALL=1` skips it. Upstream behaviour, not an Axis change; the harness does not set it. **Recommended change** (`test/extension-matrix/lib.sh`): export `DONT_PROMPT_WSL_INSTALL=1` for every launcher call, and mention it in `DEVELOPMENT.md` for WSL users.
4. **The matrix harness fails in a long work path.** `run.sh` under the worktree path gave `S01: error (exit 1, no result.json)`. The cause is a path longer than 107 characters for the user-data IPC socket (`listen EINVAL … 1.14-main.sock`). `MATRIX_WORK_DIR` (read in `lib.sh`) fixes it; `/tmp/axm` was used. Anyone running from a deep worktree hits this. **Recommended change** (`test/extension-matrix/lib.sh`): default the work directory to a short path under `${TMPDIR:-/tmp}` (or fail early with a clear message when the path is over 100 characters).
5. **`gulp vscode-reh-web-linux-x64-min` needs the network late.** Attempt 1 ran 8 min 21 s, then failed at the `node` step with `TypeError: fetch failed` while downloading Node 24.22.1 from nodejs.org (a transient DNS failure on this host). The retry took 3 min 31 s and passed. A reproducible build should not depend on that fetch succeeding after eight minutes of work. **Recommended change** (`scripts/code-oss/build.sh` or the packaging docs): run the pin-checked `download_node` before the packaging targets, so the tarball is already in the cache.
6. **`jq` is an undeclared dependency of the matrix unit tests.** Eight tests fail with `error: required command not found: jq` instead of being skipped (§6). CI runners have `jq`. **Recommended change** (`test/extension-matrix/tests/`): skip those tests with a clear reason when `jq` is missing, and list `jq` in `DEVELOPMENT.md` and the preflight above.
7. **Direct launch of the Electron binary with `--version`** started the app and did not return within 60 s. Use `bin/axis --version`, which printed `1.144.0` and the pinned commit. Not a defect.
8. **Debugpy does not activate in a normal window** (§8). **Recommended change:** record it as a named exception in `extension-compatibility.md` and make it an input to the decision D1 follow-up ADR (proposed-API allowlist), owned by the Phase 0 extension-compatibility work; until then the S04 probe result alone must not be read as "Python debugging works".

## 5. Build baseline

Commands, in order, from the repository root:

```bash
scripts/code-oss/fetch.sh
scripts/code-oss/apply.sh            # after the Node bootstrap in problem 1
scripts/code-oss/footprint.sh
scripts/code-oss/build.sh            # sysroot environment from §3, npm_config_jobs=16
cd "$AXIS_CODE_OSS_VENDOR_DIR/code-oss"
npm run gulp vscode-linux-x64-min
npm run gulp vscode-reh-web-linux-x64-min
```

| Step | Result | Time | Note |
|---|---|---|---|
| `fetch.sh` | passed | 34 s | Network-bound; checkout 447 MiB |
| Pinned Node download and verify | passed | 10 s | SHA-256 matches the manifest pin and `SHASUMS256.txt` |
| `apply.sh` (first try, no Node) | **failed** | 2.4 s | Problem 1 |
| `apply.sh` (with Node) | passed | 5.8 s | 15 patches; the hook's lockfile hash matches |
| `footprint.sh` | passed | under 1 s | shell 3 files, +21/−1; guardrails 4 files, +97/−109; copilot 19 files, +190/−122; security 0; net 43 files, +931/−2670 |
| `build.sh`, attempt 1: `npm ci` | **failed** | 95 s | Problem 2 |
| `build.sh`, attempt 2: `npm ci` | passed | 283 s | `build-times.tsv` |
| `npm run compile` | passed | 69 s | |
| `npm run electron` | passed | 20 s | |
| `npm run download-builtin-extensions` | passed | 2 s | |
| `build.sh` attempt 2 total | passed | 6 min 14 s (374 s) | `/usr/bin/time -v`; largest single process **8.3 GiB** RSS |
| `gulp vscode-linux-x64-min` | passed | 4 min 46 s | Largest process 4.3 GiB RSS; output 901 MiB |
| `gulp vscode-reh-web-linux-x64-min`, attempt 1 | **failed** | 8 min 21 s | Problem 5 |
| `gulp vscode-reh-web-linux-x64-min`, attempt 2 | passed | 3 min 31 s | Largest process 3.6 GiB RSS; output 323 MiB |

Comparison with the macOS baseline in `code-oss-build.md` §5.2 (`npm ci` 956 s, `compile` 119 s) is **not like for like and is not a speed result**: that baseline measured an unmodified tree that still had the Copilot packages and ran `compile-copilot` beside `compile-client`, on a different machine and OS. This run's tree has the Copilot and agent packages and `compile-copilot` removed by patches 1500 and 1550.

The reh-web retry (3 min 31 s) was a second run of the same gulp target; whether it reused any output of the failed first run was not checked, so treat it as a possibly warm timing.

**Memory.** The largest single process was 8.3 GiB RSS over the whole `build.sh`, with the Node heap cap at 8192 MiB; the step that peaked was not recorded. The data does not establish a minimum, and says nothing about the 7.75 GiB Docker VM that failed in `code-oss-build.md` §7, because this host had about 25 GiB free and the cap equals that VM's size. One narrow sweep was run afterwards, on the compile step only (`gulp compile-client` re-run on the built tree, host shared). A first attempt was **invalid and is discarded**: it passed `--max-old-space-size=N` to the `gulp.js` process only. The heavy work runs in a `tsc` child that does not inherit that flag and kept its default limit (4288 MiB), which is why times and RSS were identical at every cap. The valid run sets the cap for both processes (`NODE_OPTIONS=--max-old-space-size=N` plus the same flag on `node … gulp.js`) and records `v8.getHeapStatistics().heap_size_limit` and `process.execArgv` in each process through a `--require` probe:

| Requested cap | Proven limit in `gulp.js` and in `tsc` | Result | Wall time | Max RSS, largest process (`time -v`) |
|---|---|---|---|---|
| 3072 MiB | 3264 MiB in both | passed | 72 s | 3.28 GiB |
| 2048 MiB | 2240 MiB in both | passed | 87 s | 3.33 GiB |
| 1536 MiB | 1728 MiB in both | passed | 118 s | 3.34 GiB |
| 1024 MiB | 1216 MiB in both | passed | 84 s | 3.32 GiB |
| 768 MiB | 960 MiB in both | passed | 122 s | 3.29 GiB |

Wall times are noisy and not monotonic (shared host; no trend is claimed); the invalid first sweep took 52 to 56 s. The proven limit is the requested size plus 192 MiB, because V8 on this Node adds a fixed 192 MiB (young generation) to the old-space size, so 1024 gives 1216. RSS did not change with the heap cap; the largest process was not identified and the likely cause (native or external memory) was not measured. So the compile step works with a V8 heap cap as low as 768 MiB (lower caps were not tried), but its resident size is still about 3.3 GiB, and which step reached the 8.3 GiB peak was not recorded. Reproduce: run `node --experimental-strip-types --max-old-space-size=N ./node_modules/gulp/bin/gulp.js compile-client` from the vendor `code-oss` directory with `NODE_OPTIONS="--max-old-space-size=N --require <probe>"`, where the probe appends `heap_size_limit` and `execArgv` to a file.

Not measured: `npm ci` and the two packaging targets under a lower cap, and any cgroup memory limit. The M8 runner decision should therefore size for the 8.3 GiB peak plus the OS, and treat anything smaller, including a 16 GiB runner, as unmeasured until the full build is run under that limit.

Memory and disk (15-second sampler over `free -m` and `du`):

| Metric | Value |
|---|---|
| Peak system memory in use during the build | about 14.5 GB, with about 7 GB already used by other processes on the host |
| Peak system memory in use during the matrix | about 14.1 GB |
| Swap | about 3 GB in use late in the session (sampler); not attributed to a process |
| `$AXIS_CODE_OSS_VENDOR_DIR` after `build.sh` | 5.0 GiB; 7.0 GiB after both packaged targets |
| Toolchain and sysroot | 263 MiB |
| Caches outside the tree | `~/.npm` 631 MiB, `~/.cache/node-gyp` 69 MiB |
| Peak RSS of a running packaged app, nine processes, no extensions, empty window | 1,140 MiB summed (`ps`, 55 s after launch, Xvfb; overcounts shared pages) |

Not measured: startup time of the dev build or the packaged build, and the dev launcher (`run.sh`). Nothing was run with `scripts/code-oss/run.sh`.

## 6. CI-equivalent checks on Linux

Run with Node 24.22.1, the sysroot `jq`, and the repository's pinned shellcheck and actionlint.

| CI job / step | Command | Result | Time |
|---|---|---|---|
| Code OSS scripts: shellcheck | `shellcheck -x scripts/code-oss/*.sh` | passed | 8.4 s |
| Code OSS scripts: fetch/apply tests | `bash scripts/code-oss/test.sh` | passed, 170 passed, 0 failed | 24.9 s |
| Code OSS scripts: theme contrast | `node --test test/theme-axis/*.test.mjs` | passed, 7 of 7 | 0.2 s |
| Code OSS scripts: icons | `scripts/code-oss/gen-icons.sh --check` | passed | 0.1 s |
| Code OSS scripts: SC-3 check test | `node --test test/code-oss/*.test.mjs` | passed, 11 of 11 | 0.9 s |
| Extension matrix: shellcheck | `shellcheck -x test/extension-matrix/*.sh` | passed | 1.1 s |
| Extension matrix: syntax | `node --check` on `probe/runner.js`, `probe/logic.js` | passed | 0.1 s |
| Extension matrix: unit tests, **without `jq`** | `node --test 'test/extension-matrix/tests/*.test.js'` | **failed**, 35 of 43 pass, 8 fail with `required command not found: jq` | 0.7 s |
| Extension matrix: unit tests, with `jq` | same | passed, 43 of 43 | 11.5 s |
| Axis packages (at `dc29b38`: three packages then; main now has more) | `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`, `npm test` | passed | 2.3 s, 1.5 s, 0.9 s, 3.0 s |
| Axis packages: test counts | four `node --test` runs inside `npm test` | 75, 31, 71 and 11 tests, all passed | |
| Workflow lint | `actionlint -shellcheck <pinned> -pyflakes=` over `.github/workflows/` | passed | 0.2 s |
| Secret scan (gitleaks) | `gitleaks git` | **not run** in the original session (not installed on this host); the manual diff scan stood in | |
| Secret scan, run afterwards | `gitleaks git --log-opts="origin/main..HEAD"`, gitleaks 8.30.1 from a shared tool directory | passed, no leaks, 1 commit scanned | 0.3 s |

`git diff --check origin/main..HEAD` was run before each push and was clean. `libnotify-bin` (in the CI list) was not installed here; nothing in the build or the headless runs needed it.

## 7. SC-3 artifact check

```bash
scripts/code-oss/check-artifacts.sh --expect desktop,reh-web --notices \
  "$AXIS_CODE_OSS_VENDOR_DIR/VSCode-linux-x64" "$AXIS_CODE_OSS_VENDOR_DIR/vscode-reh-web-linux-x64"
```

Result: **passed** for both artifacts (1 s). A name search for `*copilot*` outside `node_modules` in both outputs found nothing. Run without arguments, the script reported `no packaged artifacts found … pass directories explicitly`: it needs the packaged outputs, which `build.sh` does not create, and its default expects a `vscode-reh-linux-x64` directory too. That target was not built.

## 8. Extension matrix on the packaged build

Build under test: `VSCode-linux-x64` (`vscode-linux-x64-min`, the packaged build, no `VSCODE_DEV`), `AXIS_APP` set to its `axis` binary. Headless under Xvfb.

```bash
export DONT_PROMPT_WSL_INSTALL=1 MATRIX_WORK_DIR=/tmp/axm AXIS_APP=<build>/axis
test/extension-matrix/fetch.sh                                   # 13 artifacts, all hashes verified, 30 s
AXIS_CLI=<build>/bin/axis test/extension-matrix/install.sh       # 13 pinned extensions, installed set equals the pins, 38 s
test/extension-matrix/run.sh --proposed-api-scan 60 --all --activation-scan 60 --timeout 300
```

The full run took 741 s. The positive control passed (`verified`: `ms-python.python`, `ms-python.debugpy`, `ms-python.vscode-python-envs` all reported as restricted), so both scans are valid. One earlier single-scenario run of S01 also passed (12 s, probe only).

| Scenario | Probe | Activation scan | Notes |
|---|---|---|---|
| S01 TypeScript, built-in | passed | clean | Includes the Node breakpoint (stopped at `debug.js:3` in `pwa-node`) |
| S02 Python, default language server | passed | **findings** | `ms-python.python` and `vscode-python-envs` proposals stripped |
| S03 Python, basedpyright | passed | **findings** | `ms-python.python` proposals stripped |
| S04 Python, debugpy | passed | **findings** | `ms-python.debugpy` **activation failed**; its proposals stripped |
| S05 rust-analyzer | blocked: `missing: cargo` | | |
| S06 CodeLLDB | blocked: `missing: cargo` | | |
| S07 Go | blocked: `missing: go gopls` | | |
| S08 clangd | blocked: `missing: clangd` | | |
| S09 ESLint | passed | clean | |
| S10 Prettier | passed | clean | |
| S11 GitHub theme | passed | clean | |
| S12 GitLens | passed | clean | |
| S13 YAML | passed | clean | |

Not run: the optional tier (S14 Jupyter, S15 Java), and Layer C (UI smoke).

**Proposed-API stripping (§2.1 input, scan status `complete`).** Linux x64 results, to be copied into `extension-compatibility.md` §2.1 by a later change:

| Extension | Declared | Stripped |
|---|---|---|
| `ms-python.python` | 9 | all 9: `contribEditorContentMenu, quickPickSortByLabel, testObserver, quickPickItemTooltip, terminalDataWriteEvent, terminalExecuteCommandEvent, codeActionAI, notebookReplDocument, notebookVariableProvider` |
| `ms-python.debugpy` | 3 | all 3: `portsAttributes, debugVisualization, contribViewsWelcome` |
| `ms-python.vscode-python-envs` | 3 | all 3: `terminalShellEnv, terminalDataWriteEvent, taskExecutionTerminal` |
| every other pinned extension | 0 | none |

**Finding: `ms-python.debugpy` does not activate in a normal window.** The exthost log (`S04-python-debugpy/scan/logs/window1/exthost/exthost.log`, kept in the run directory, not committed) shows:

```text
Activating extension ms-python.debugpy failed due to an error:
Error: Extension 'ms-python.debugpy' CANNOT use API proposal: portsAttributes.
  at Object.registerPortAttributesProvider
  at t.registerDebugger (…/ms-python.debugpy-2026.6.0/dist/extension.js)
```

The S04 probe still **passed** (breakpoint stopped at `debug_me.py:2` in `debugpy`) because the test host allows every proposal (`extension-compatibility.md` §4.1). The probe cannot see this failure; only the scan does. This is the decision D1 effect, measured: with no allowlist, Python debugging through debugpy is broken in a normal window. It is not caused by an Axis patch (the allowlist is empty upstream too); it should be recorded as an exception or addressed by the D1 follow-up ADR. The other two Python extensions had their proposals stripped but logged no activation error in these scenarios.

## 9. reh-web

Built with `vscode-reh-web-linux-x64-min` (§5). Started headless on loopback:

```bash
vscode-reh-web-linux-x64/bin/axis-server --host 127.0.0.1 --port 0 --server-data-dir … --extensions-dir … \
  --accept-server-license-terms --disable-telemetry
```

Observed (tokens redacted):

| Check | Result |
|---|---|
| Binding | `Server bound to 127.0.0.1:<port> (IPv4)`; one listener, owned by the server's `node` process |
| Request without the connection token | `403` |
| Request with the token | `302` to `/`, then `200` |
| `Set-Cookie` | `vscode-tkn=…; Max-Age=604800; SameSite=Lax`. **No `Secure`, no `HttpOnly`** (H3 not applied) |
| CSP `frame-src` | `frame-src 'self' https://*.vscode-cdn.net data:;` (**H2 not applied**, as expected: ADR 0002 D9 and design S1.8 defer H2 to M6) |
| CSP Trusted Types | no `require-trusted-types-for` or `trusted-types` directive (**H1 not applied**; design S1.8 lists H1 for M3) |
| CSP `script-src` | includes `'unsafe-eval'` and the server's own `http://127.0.0.1:<port>` origin |
| CSP `connect-src` | `'self' ws: wss: https:` |
| Patches in the 2000 block | none exist (`ls code-oss/patches` shows no `2xxx` file) |

So the reh-web output still depends on Microsoft's `vscode-cdn.net` for webview content, as `docs/security/threat-model-phase0.md` WEB-4 and design R5 describe. No webview was loaded: no browser was driven, so the effect on a real webview, and the `codeAutomationExit` web runner (§7.4 of the compatibility document, planned for M6), are **not run**.

## 10. Loopback and network listeners

Method: `ss -ltnup` before launch and during a run of the packaged desktop build under Xvfb (55 s, isolated profile via `--user-data-dir`, `--shared-data-dir` and `--extensions-dir`, `--disable-workspace-trust`, `--disable-telemetry`), compared against every process in the Axis process tree.

| Run | Listening sockets owned by Axis processes |
|---|---|
| Empty extensions directory | **None.** The before and during listener lists are identical. |
| The 13 pinned extensions installed | **One:** `127.0.0.1:<port>` in the extension-host process. The GitLens log says `[IPC] CLI capability published on http://127.0.0.1:<port>`. It is the extension's own server, not an Axis listener. |
| reh-web server | One by design, `127.0.0.1:<port>`, behind the connection token (§9) |

Xvfb was started with `-nolisten tcp` and listens only on an abstract Unix socket. A pre-existing `node` listener on `127.0.0.1:35007` (not Axis) was present before and after every run.

Outbound traffic: with an empty extensions directory, an `axis` utility process (Chromium's network service) held two established HTTPS connections to Google addresses (`173.194.x.x:443` and `142.250.x.x:443`) for the whole run. The destination names and purpose were **not identified** (no DNS or TLS capture, and the log directories held no host names). This is an open question for the guardrail work, not a finding about the Axis shell.

## 11. Not done

- Rust, Go and clangd scenarios (S05 to S08): the toolchains are not installed and no `sudo` was available. They report `blocked`, as designed.
- Optional tier (Jupyter, Java), Layer C UI smoke, the signature test (D4), and the Playwright web runner (M6).
- The `vscode-reh-linux-x64` (non-web) target, so `check-artifacts.sh` ran with `--expect desktop,reh-web` rather than its all-three default.
- Dev-build launch with `run.sh`, startup timing of either build, packaged-build RSS under a real workspace.
- A full heap or parallelism sweep. Only the compile step was swept (§5); `npm ci` and packaging ran at upstream's 8192 MiB, and no cgroup limit was tried, so the minimum working memory of the whole build is unknown.
- Any browser session against reh-web.

## 12. Reproduce

```bash
export AXIS_CODE_OSS_VENDOR_DIR=$HOME/.cache/project-axis/lx
export AXIS_CODE_OSS_TOOLS_DIR=$HOME/.cache/project-axis/lx-tools
# Provide pkg-config, libx11-dev, libx11-xcb-dev, libxkbfile-dev, libkrb5-dev (§3), then:
scripts/code-oss/fetch.sh
# Fresh host: obtain the pinned Node first (problem 1), then:
scripts/code-oss/apply.sh && scripts/code-oss/build.sh
(cd "$AXIS_CODE_OSS_VENDOR_DIR/code-oss" && npm run gulp vscode-linux-x64-min && npm run gulp vscode-reh-web-linux-x64-min)
scripts/code-oss/check-artifacts.sh --expect desktop,reh-web "$AXIS_CODE_OSS_VENDOR_DIR"/VSCode-linux-x64 "$AXIS_CODE_OSS_VENDOR_DIR"/vscode-reh-web-linux-x64
```

The resource figures came from `/usr/bin/time -v` around each command and a 15-second sampler over `free -m` and `du`; the compile heap sweep is described in §5; the later secret scan was `gitleaks git --no-banner --redact --log-opts="origin/main..HEAD" .`. The sampler and the probe were scratch scripts and are not committed.
