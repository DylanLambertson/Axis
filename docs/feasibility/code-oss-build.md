# Code OSS 1.144.0: pinned baseline build (Phase 0 M2)

- Date: 2026-11-01 (local time, UTC-5).
- Upstream: `microsoft/vscode` tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` (`code-oss/upstream.json`).
- Scope: the mechanism from ADR 0002 decision 1 (pinned checkout, patch series, overlay; upstream code is never committed) and an **unmodified** baseline build with measurements. Branding, the Axis shell and Copilot removal are M3 work.
- Status words: **passed**, **failed**, **not run**, **not applicable**. "Not measured" means no number was taken; no number below is estimated.

> **Not a distributable build.** This is a local development build of unmodified Code OSS. It still contains the Copilot packages, `extensions/copilot` and the GitHub Copilot `defaultChatAgent`, and it shows Microsoft branding. ADR 0002 decision 5 requires all of that to be removed or replaced, together with the other licensing guardrails, before any build is distributed. Nothing built here may be shared outside the developer's machine.

---

## 1. Layout

| Path | Tracked | Purpose |
|---|---|---|
| `code-oss/upstream.json` | yes | Pin: `repository`, `tag`, `commit`, `node`. |
| `code-oss/patches/NNNN-short-name.patch` | yes | Patch series, applied in lexical order. Blocks: `0001`–`0999` shell, `1000`–`1499` rebrand and licensing guardrails, `1500`–`1999` Copilot and agent-host removal, `2000`–`2999` security hardening. See its `README.md`. Empty. |
| `code-oss/removals.txt` | yes | Upstream paths deleted after the patches (ADR 0002 decision 6). Comments only. |
| `code-oss/replace/**` | yes | Files that replace existing upstream files (icons, assets). Empty. |
| `code-oss/overlay/**` | yes | New Axis-owned files, such as `src/vs/axis/**`. Empty. |
| `code-oss/hooks/post-apply.d/*` | yes | Executables run after apply, for example to regenerate lockfiles. Empty. |
| `scripts/code-oss/*.sh` | yes | `fetch`, `apply`, `build`, `run`, `footprint`, `test` and the shared `lib.sh`. Bash 3.2 compatible; shellcheck-clean. |
| `vendor/code-oss/` | no (ignored) | Upstream checkout and build output. |
| `vendor/code-oss.applied` | no | Stamp written by `apply.sh`: commit, patches with SHA-256, removals, replacements, overlay files, hooks, tree fingerprint, `status complete` or `status incomplete`. |
| `vendor/logs/build-times.tsv` | no | One row per timed build step. |
| `vendor/run/` | no | Isolated profile used by `run.sh`. |
| `.tools/node-v<version>-<os>-<arch>/` | no (ignored) | Checksum-verified Node.js used when no suitable Node 24 is installed. |

`AXIS_CODE_OSS_VENDOR_DIR` and `AXIS_CODE_OSS_TOOLS_DIR` move `vendor/` and `.tools/` elsewhere. That is **required when the repository path contains whitespace** (§6, problem 1). `AXIS_CODE_OSS_RUN_DIR` moves the run profile. `AXIS_CODE_OSS_ROOT` is used only by `test.sh`.

## 2. How to use it

```bash
# Only if the repository path contains whitespace (true for this machine's worktrees):
export AXIS_CODE_OSS_VENDOR_DIR="$HOME/.cache/project-axis/vendor"
export AXIS_CODE_OSS_TOOLS_DIR="$HOME/.cache/project-axis/tools"

scripts/code-oss/fetch.sh      # shallow-fetch the pinned commit; idempotent; --force to discard local edits
scripts/code-oss/apply.sh      # reset to the pin, then patches, removals, replace/, overlay, hooks; --force as above
scripts/code-oss/build.sh      # Node 24 check, npm ci, npm run compile, Electron, built-in extensions
scripts/code-oss/run.sh        # launch the dev build with an isolated profile; extra args go to Code OSS
scripts/code-oss/footprint.sh  # upstream files/lines changed per patch block (--tsv for machine output)
scripts/code-oss/test.sh       # offline tests of fetch/apply/footprint against a fake upstream
```

- After the first full build, `build.sh --skip-install` recompiles without `npm ci`. `apply.sh` keeps ignored build output (`node_modules/`, `out/`, `.build/`), so re-applying patches does not force a reinstall. A patch that changes dependencies does need a full `build.sh`.
- `fetch.sh` and `apply.sh` refuse to discard edits made inside `vendor/code-oss` by hand. Changes recorded in the stamp are treated as their own. To keep a manual edit, export it with `git -C vendor/code-oss diff > code-oss/patches/NNNN-name.patch`.
- A failed `apply.sh` writes `status incomplete`. The next `apply.sh` may still reset that tree, but `build.sh`, `run.sh` and `footprint.sh` refuse it.

### Script behaviour

| Script | Behaviour |
|---|---|
| `fetch.sh` | `git init` plus `git fetch --depth 1 origin <commit> refs/tags/<tag>`. Checks that `HEAD` equals the pinned commit and that the tag peels to it. If the pin changes, it moves the tree, refusing when there are foreign local modifications unless `--force`. Network: GitHub only. |
| `apply.sh` | Validates all inputs first: patch names and blocks, duplicate numbers, unsafe paths (`..`, absolute, `.git`), symlinks, non-executable hooks. Then `git reset --hard` and `git clean -fd` (ignored files kept) and the steps in order. Each step fails loudly, naming the patch, path or hook. Removals must exist and may not be ignored build output. Replacements must exist at the pinned commit. Overlay files must not exist, and their parents may not be upstream symlinks. |
| `build.sh` | Node lookup: `$NODE24_BIN`, then `/usr/local/opt/node@24/bin`, then the official `node-v24.22.1-<os>-<arch>.tar.gz` from nodejs.org, SHA-256 checked against that release's `SHASUMS256.txt` and unpacked into `.tools/`. Requires major 24 and at least the manifest version, and npm < 13 (upstream rule). Refuses whitespace in the tree or tools path. Runs upstream steps only inside `vendor/code-oss`. |
| `run.sh` | `./scripts/code.sh --user-data-dir … --extensions-dir … --shared-data-dir …`. The third flag is needed: without it Code OSS writes `~/.vscode-oss-shared` (problem 3). |
| `footprint.sh` | Per block (shell, guardrails, copilot, security), from `git apply --numstat`: patches, upstream files touched, lines added and deleted in upstream files, added `--- Start/End Axis ---` marker lines, and new files. A `shell-c2` row counts the shell block as ADR 0002 criterion 2 does, without `product.json` and `resources/**`. Also rows for removals and replacements (`git diff --numstat` on those paths) and the net total (`git diff --numstat` against the pin, which includes hook edits). Refuses a stale stamp or a tree edited after apply. |

## 3. Toolchain

| Item | Version used | Source / note |
|---|---|---|
| Node.js | 24.22.1 (darwin-x64 tarball, SHA-256 `d132557e…dc83b035`) | Pinned by upstream `.nvmrc` and `code-oss/upstream.json`. Homebrew `node@24` was not installed yet, and the system `node` is 25.9.0, which upstream's preinstall check would reject. |
| npm | 11.19.1 | Bundled with Node 24.22.1. |
| node-gyp | 12.4.0 | Bundled with npm. Electron headers 43.8.3 from `artifacts.electronjs.org`. |
| Electron | 43.8.3 | Upstream `.npmrc`; downloaded by `npm run electron`. |
| Python | 3.15.2 (Homebrew) | Picked up by node-gyp; no issues seen. |
| C/C++ | Apple clang 17.0.0 (clang-1700.0.13.5), GNU Make 3.81 | Xcode Command Line Tools 16.4 only, no Xcode. |
| Git | 2.39.5 (Apple Git-154) | |
| Bash | 3.2.57 (macOS `/bin/bash`) | Scripts avoid bash 4 features. |
| shellcheck | 0.11.0 | Same version pinned in CI (release asset SHA-256 `8c3be12b…4e227198`). |

Network access: the Axis scripts contact only GitHub (`git fetch`) and nodejs.org. Upstream's install and build steps also contact the npm registry, `artifacts.electronjs.org` (Electron headers), and GitHub releases (the Electron binary and three built-in extensions: `ms-vscode.js-debug` 1.140.0, `ms-vscode.js-debug-companion` 1.1.3, `ms-vscode.vscode-js-profile-table` 1.0.11).

## 4. Machine

| | |
|---|---|
| Model / CPU | Intel Core i9-9980HK @ 2.40 GHz, 8 cores / 16 threads, x86_64 |
| Memory | 16 GB |
| OS | macOS 15.7.9 (24G830) |
| Disk | APFS, 466 GiB, about 100 GiB free at start |
| Other load | Other development sessions and a Homebrew source build ran at the same time. The upstream `perfBaseline` CPU benchmark read 21–24 ms in most launches and 137 ms in one (run 7, §5.2), so timings carry noise. |

## 5. Results (macOS, x86_64)

### 5.1 Checks

| Check | Result | Evidence |
|---|---|---|
| `fetch.sh`: exact commit, `HEAD == commit`, tag peels to commit | passed | `vendor/code-oss HEAD = 2c33b50b… (1.144.0)` |
| `fetch.sh` idempotent (second run) | passed | `Pinned commit already checked out; nothing to fetch` |
| `apply.sh` with the empty series | passed | Stamp `status complete`; fingerprint `7bfb3d67…`, equal to the pinned commit's tree |
| `apply.sh` / `fetch.sh` / `footprint.sh` on the built tree | passed | The build leaves `git status` clean; re-apply took 1.8 s and kept `node_modules` and `out`; footprint all zero |
| `build.sh`, attempt 1 (tree under a path containing a space) | failed | `npm ci` failed in `@vscode/fs-copyfile` (problem 1) |
| `build.sh`, attempt 2 (relocated to a path without spaces) | passed | All four steps exit 0; `compile` reports 0 errors |
| Launch: workbench window opens | passed | Window "hello.ts — sample-ws" with explorer and editor; screenshot taken (not committed) |
| Standard start reached (upstream definition) | passed | All 7 runs report `standard_start` |
| `test.sh` (107 checks, macOS bash 3.2) | passed | `107 passed, 0 failed` |
| Linux x64 build in Docker | failed | Compile OOM-killed in a 7.75 GiB VM; `npm ci` passed (766 s); §7 |
| shellcheck 0.11.0 on `scripts/code-oss/*.sh` | passed | No findings |
| CI job `Code OSS scripts` on GitHub | not run | Runs on the first push or PR |
| Terminal, debugger, Git, search, extensions in the dev build | not run | Not exercised beyond startup; M3 |
| Packaged build (`vscode-darwin-x64-min`) | not run | Out of scope; dev build only |
| Copilot removal | not applicable | M3 (ADR 0002 decision 6) |

### 5.2 Measurements

| Metric | Value | Method |
|---|---|---|
| Fetch (shallow, one commit) | 38 s; 51 s on a second fresh fetch | `fetch.sh` wall-clock; network-bound |
| Checkout size after fetch | 440 MiB | `du -sh vendor/code-oss` (includes `.git`, 72 MiB) |
| Apply, empty series | 4.0 s on a fresh tree; 1.8 s on the built tree | `time apply.sh`; most of it is `git reset`/`clean` and the fingerprint |
| Node tarball download and verify | about 32 s | `build.sh` total minus the step times |
| `npm ci` | **956 s** (15 min 56 s) | `build-times.tsv` |
| `npm run compile` (`compile-client` and `compile-copilot` in parallel) | **119 s** | `build-times.tsv`; gulp `compile` 1.85 min, `compile-src` 94 s |
| `npm run electron` | 27 s | `build-times.tsv` |
| Built-in extensions download | 3 s | `build-times.tsv` |
| `build.sh` total | 1,137 s (18 min 57 s) | log timestamps 19:33:20–19:52:17 |
| `vendor/code-oss` after build | **7.6 GiB** | `du -sh`. Of that: `extensions/` 3.8 GiB (including their `node_modules`), root `node_modules` 1.6 GiB, `out` 534 MiB, `build` 489 MiB, `.build` 314 MiB (Electron, built-in extensions), `.git` 72 MiB |
| `.tools/` (Node 24.22.1 unpacked) | 205 MiB | `du -sh` |
| Caches outside the tree | not measured | `~/.npm`, `~/Library/Caches/node-gyp/{43.8.3,24.22.1}` |
| Cold start: first launch after the build, fresh profile | **12,765 ms** | upstream `ellapsed` (below) |
| Startup, later launches | 9,659 / 9,804 / 9,802 / 9,897 / 9,962 ms | runs 2–6 (below) |
| Startup, fresh profile under heavier load | 13,331 ms | run 7, `perfBaseline` 137 ms |
| RSS after startup | **2,778 MiB summed over 11 processes** | `ps` 45 s after launch (below) |
| Peak memory during build | not measured | |
| Keystroke latency, indexing | not measured | |

**Startup method.** Each run launches `run.sh` with the sample workspace (`README.md` and `src/hello.ts`) and `hello.ts` open, using `--disable-workspace-trust`, `--prof-append-timers <file>` and `--prof-duration-markers`. Upstream's `NativeStartupTimings` then writes `ellapsed`, which is `code/didStartMain` → `code/didStartWorkbench`, the restored and usable workbench. It also checks the "standard start" conditions: new window, trusted workspace, explorer visible, one text editor, no panel. Then it waits 15 s and quits. The time before `didStartMain` (process spawn, `preLaunch.ts`) is not included. The wall-clock of a whole `run.sh` invocation (36–46 s) includes that fixed 15 s wait and is not a startup metric.

| Run | Profile | `ellapsed` | didStartMain → willOpenNewWindow | willOpenNewWindow → didStartWorkbench | perfBaseline |
|---|---|---|---|---|---|
| 1 | fresh; first launch after the build | 12,765 ms | 1,905 ms | 10,860 ms | 22 ms |
| 2 | fresh | 9,659 ms | 701 ms | 8,958 ms | 22 ms |
| 3 | reused from run 2 | 9,804 ms | 701 ms | 9,103 ms | 24 ms |
| 4 | reused | 9,802 ms | 683 ms | 9,119 ms | 21 ms |
| 5 | reused | 9,897 ms | 700 ms | 9,197 ms | 22 ms |
| 6 | reused | 9,962 ms | 682 ms | 9,280 ms | 21 ms |
| 7 | fresh, with `--shared-data-dir` | 13,331 ms | 835 ms | 12,496 ms | 137 ms |

Profile freshness made little difference (runs 2 and 3–6). The first launch after a build costs about 3 s more, mostly in the main process (1.9 s vs 0.7 s to open the window); presumably cold OS file and code caches. These are **development-build** numbers: `out/` is unbundled, transpiled ESM, so the renderer loads thousands of modules individually. A packaged, bundled build will differ. Do not use these numbers as a product budget; use them only to compare against later dev builds of the Axis shell.

**Memory method.** `ps -o rss` over the main process and all its descendants, 45 s after an interactive launch with the same workspace. The first-run "Sign in to use GitHub Copilot" dialog was open. Summed RSS overcounts shared pages; proportional or `footprint`-style numbers were not measured.

| Process | RSS |
|---|---|
| renderer (workbench window) | 1,252 MiB |
| main | 466 MiB |
| Node utility process (not identified) | 243 MiB |
| extension host (Node utility; parent of the TS servers) | 181 MiB |
| `tsserver` (syntax), `tsserver` (semantic) | 134 MiB, 135 MiB |
| Node utility process (not identified) | 110 MiB |
| GPU process | 105 MiB |
| `typingsInstaller` | 64 MiB |
| Node utility process (not identified) | 61 MiB |
| network service | 28 MiB |
| **Total (11 processes)** | **2,778 MiB** |

The three unidentified Node utility processes are among the shared process, pty host, file watcher and agent host; they were not told apart. The crash-pad handler (3 MiB, reparented to launchd) is excluded.

## 6. Problems and resolutions

1. **`npm ci` fails when the tree path contains a space** (attempt 1, after 297 s). The Superset worktree path is `…/worktrees/Project Axis/…`. node-gyp's `make` build of `@vscode/fs-copyfile@2.0.0` split the `node-addon-api` include path:

   ```text
   npm error clang++: error: no such file or directory: 'Axis/spike-code-oss-build/vendor/code-oss/node_modules/@vscode/fs-copyfile/node_modules/node-addon-api'
   npm error make: *** [Release/obj.target/vscode_fs/src/copyfile.o] Error 1
   npm error gyp ERR! stack Error: `make` failed with exit code: 2
   ```

   Resolution, in our scripts with no upstream patch: `AXIS_CODE_OSS_VENDOR_DIR` and `AXIS_CODE_OSS_TOOLS_DIR` relocate the tree and toolchain, and `build.sh` now fails at once, before any download, if either path contains whitespace. The baseline was built in `~/.cache/project-axis/m2/{vendor,tools}`. `fetch.sh` and `apply.sh` work under paths with spaces; `test.sh` covers both.
2. **No suitable Node on `PATH`.** The system Node is 25.9.0, and Homebrew's `node@24` was still compiling and absent from `/usr/local/opt/node@24/bin`. `build.sh` fell back to the official tarball as designed.
3. **The dev build writes outside `--user-data-dir`.** The first launches created `~/.vscode-oss-shared/sharedStorage/state.vscdb` (from `product.json` `sharedDataFolderName`; `src/vs/platform/environment/common/environmentService.ts` `appSharedDataHome`). Resolution: `run.sh` passes `--shared-data-dir`. Run 7 verified that the directory is not recreated, and the stray directory was deleted. Remaining writes outside the profile, accepted for a dev build: `~/Library/Preferences/com.visualstudio.code.oss.plist` (macOS defaults for the bundle id), `~/Library/Caches/typescript/` (tsserver typings cache), and the npm and node-gyp caches from the build.
4. **First-run Copilot sign-in dialog.** On a fresh profile the workbench opens behind a modal titled "Welcome to VS Code" ("Sign in to use GitHub Copilot", with GitHub, Google, Apple and GHE buttons). No sign-in was attempted. The main process also logs `Unknown channel: agentHostClientByokLm` and `Unknown channel: agentHostClientProxy`, and the renderer logs `[AgentHost] No signed-in session resolved for resource: https://api.github.com`. This is expected for unmodified Code OSS; it is input for the M3 guardrail patches.
5. **npm configuration warnings.** npm 11 warns 47 times per key: `Unknown env config "disturl"` (also `target`, `runtime`, `ms-build-id`, `build-from-source`, `timeout`), as well as `Unknown project config …` for upstream's `.npmrc` keys, with "This will stop working in the next major version of npm". These are harmless with npm 11 (upstream requires npm < 13), but a risk for a future npm major.
6. **Dependency audit output.** `npm ci` printed audit summaries without failing, for example `68 vulnerabilities (2 low, 49 moderate, 17 high)` at the root and `10 vulnerabilities (5 low, 2 moderate, 2 high, 1 critical)` in `extensions/markdown-language-features`. Not triaged here; input for the security track (ADR 0002 decision 7).
7. **Node deprecations** during the build: `[DEP0180] fs.Stats constructor is deprecated` and `[DEP0190] Passing args to a child process with shell option true …`. Harmless today.
8. **Measurement-script mistake, corrected.** A zsh loop did not word-split `set -- $r`, so runs 2–6 shared one profile directory instead of separate ones. The table in §5.2 records which profile each run really used.
9. **Docker Desktop stopped once** about 1 minute after `open -a Docker` reported it ready (the socket disappeared, no error in the supervisor log). A second `open -a Docker` started it within 10 s, and it stayed up.

## 7. Linux x64 (Docker): failed, deferred to M8

**Result: failed.** The compile step was OOM-killed in the Docker Desktop VM (7.75 GiB); `npm ci` passed (766 s). A Linux build is deferred to the M8 GitHub Actions Linux runner. Alternatively, raise the Docker Desktop memory limit to at least 12 GiB and rerun.

- **Setup.**
  - Docker Desktop 29.9.2 on the same Mac; the VM had 16 CPUs and 7.749 GiB RAM, left at the owner's settings.
  - Image: `ubuntu:24.04` (`sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852`) plus the upstream CI build packages (`build-essential pkg-config libx11-dev libx11-xcb-dev libxkbfile-dev libnotify-bin libkrb5-dev`), Python 3, Git and runtime libraries for a headless `xvfb` launch.
  - Non-root user. The worktree was mounted read-only, and the tree lived in a Docker volume via `AXIS_CODE_OSS_VENDOR_DIR`/`AXIS_CODE_OSS_TOOLS_DIR`.
  - Ran after the macOS build, never concurrently.
- **Attempt 1, the unchanged scripts:**

  | Step | Result | Time |
  |---|---|---|
  | `fetch.sh` | passed | 20 s |
  | `apply.sh` | passed | < 1 s |
  | Node 24.22.1 linux-x64 tarball (SHA-256 `eb6728e7…6002d7c`) | passed | |
  | `npm ci` | passed | 766 s |
  | `npm run compile` | failed after 290 s | `[compile-client ] Error: tsgo exited with code unknown`, `'compile' errored after 4.65 min`; `docker inspect` reported `OOMKilled=true` |
- **Attempt 2, a diagnostic run outside `build.sh`:** `compile-client` and `compile-copilot` run one after the other to lower peak memory. Container memory stayed at 7.3 of 7.75 GiB, and `compile-client` had not finished after about 10 minutes. It was stopped on the owner's decision, so the result is **not run to completion**.
- **Not run on Linux:** Electron download, built-in extensions, launch, startup timing, RSS.
- The `/work` Docker volume (`axis-m2-linux-work`) and image (`axis-m2-linux`) remain on this machine and can be removed with `docker volume rm` / `docker rmi`.
- On macOS the same compile ran on a 16 GB host without memory trouble. Upstream's gulp task sets `--max-old-space-size=8192`, so 8 GiB of heap alone can exceed this VM. The M8 Linux runner needs well over 8 GiB of RAM; check the runner size for this repository's plan before relying on the default runner.

## 8. Known limitations

- **Development build only.** `scripts/code.sh` runs Electron on the unbundled `out/` directory. No packaging (`vscode-<platform>-<arch>[-min]`), signing or notarization; startup and memory numbers are not representative of a release build.
- **Copilot and Microsoft branding still present** (see the note at the top).
- **Single machine, small samples:** 7 startup runs, 1 memory sample, 1 successful build; other workloads ran concurrently.
- **`SHASUMS256.txt` is not signature-checked.** The Node tarball is verified against `SHASUMS256.txt` fetched over HTTPS from the same origin; the GPG signature (`SHASUMS256.txt.sig`) is not checked. A stronger option is to pin the tarball SHA-256 in `upstream.json`.
- **`npm ci` runs every dependency's install scripts as the current user.** This is required by upstream: native addons, Electron headers, built-in extensions. Treat the tree as untrusted code; CI builds (M8) should use a disposable runner or container.
- **Untested paths:** darwin-arm64 and linux-arm64 tarball selection (implemented, not run); `NODE24_BIN` and Homebrew `node@24` lookup (implemented and unit-tested for the version rule only).
- **The default `vendor/` location is unusable in this machine's worktrees** because of the space in the path; contributors there must set the two relocation variables.
- **Removal manifest semantics are minimal:** exact paths only, no globs; a removed path cannot also be replaced.
- **Hooks have no sandbox** and run with the user's environment. They get Node only if `build.sh` (or `NODE24_BIN`/Homebrew) already provided one; `apply.sh` never downloads it.

## 9. What M3 needs from this

- **Build reuse.** The built tree at `~/.cache/project-axis/m2/vendor/code-oss` (7.6 GiB, unmodified 1.144.0) can be reused by M3 on this machine with the same two environment variables. `apply.sh` plus `build.sh --skip-install` gives about a 2-minute compile cycle; `npm run watch` inside the tree is faster for iteration.
- **Where changes go:**
  - shell seams: patches `0001`–`0999`, with Axis code in `code-oss/overlay/src/vs/axis/**`;
  - rebrand, licensing and service endpoints: patches `1000`–`1499`, with `replace/` for icons;
  - Copilot and agent-host removal: patches `1500`–`1999` together with `removals.txt`;
  - lockfile regeneration: a hook in `hooks/post-apply.d/`;
  - security hardening: patches `2000`–`2999`.
- **Differences from `docs/design/axis-shell.md`** (§2.6, §7.3), following the M2 instructions:
  - icon and asset replacements go in `code-oss/replace/`, not `code-oss/overlay/` (the overlay stays new-files-only);
  - the scripts live in `scripts/code-oss/*.sh`, not `code-oss/scripts/*`;
  - `footprint.sh` runs after `apply.sh`, not as a post-apply hook, because it needs the completed stamp.
- **Budget tracking.** `footprint.sh` produces the numbers for ADR 0002 criterion 2 (shell block: ≤ 12 upstream files, ≤ 300 lines) and criterion 3 (the guardrail and Copilot-removal footprint is measured; the two blocks are reported separately).
- **Guardrail inputs from this run:**
  - the Copilot sign-in dialog and "Welcome to VS Code" text;
  - the agent-host channels and the `api.github.com` lookups;
  - bundle id `com.visualstudio.code.oss`;
  - `product.json` `dataFolderName` `.vscode-oss` and `sharedDataFolderName` `.vscode-oss-shared`;
  - `compile` builds `extensions/copilot` (`compile-copilot`).
- **Baseline for comparison:**
  - dev-build `ellapsed` about 9.7–10.0 s warm and 12.8 s on the first launch after a build;
  - about 2.8 GiB summed RSS with one TypeScript file open;
  - re-measure the Axis shell with the same method (`--prof-append-timers`, the same sample workspace) on the same machine.
- **Still open:**
  - Linux: deferred to the M8 CI runner (§7);
  - a packaged build;
  - CI build (M8);
  - Windows (not attempted).
