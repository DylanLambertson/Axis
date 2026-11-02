# Prototype C: Eclipse Theia (Phase 0 M4)

- Date: 2026-11-01 to 2026-11-02 (local time, UTC-5). Time-boxed to about 2 hours for this pass, plus an earlier interrupted session that built the prototype.
- Question (ADR 0002, revisit trigger 3): can option C meet the ADR 0002 feature checklist with **materially lower maintenance cost** than option A?
- Framework: Eclipse Theia **1.76.0** (2026-09-24), every `@theia/*` package pinned exactly, browser target. Editor core `@theia/monaco-editor-core` **1.108.201**; declared VS Code API level **1.139.0** (`DEFAULT_SUPPORTED_API_VERSION` in `@theia/application-package`). Option A's baseline is Code OSS 1.144.0 (`code-oss-build.md` on the M2 branch).
- Code: `prototypes/theia/` (self-contained, not wired into anything else).
- Status words: **works**, **partial**, **fails**, **not possible**, **not tested** / **not run**. Every number below was measured on this machine unless it says "estimate". Screenshots are kept outside the repository (`~/.cache/project-axis/reviews/m4-theia/`).

**Answer in one paragraph.** Theia gives Axis a working IDE in a browser with a Node backend: editor, explorer, search, terminal, SCM/Git, diagnostics, command palette, an Open VSX extensions view and a Node plugin host. Axis customises it with 363 lines of additive contributions and patches nothing. Nine of the 13 M5 matrix scenarios pass unchanged, covering 14 pinned extensions: TypeScript, Python (Jedi and basedpyright), rust-analyzer, clangd, ESLint, Prettier, YAML, GitLens and a theme. **Debugging fails with all three debug adapters tried** (js-debug, debugpy, CodeLLDB): sessions start but never stop at a breakpoint, and the cause was not isolated in the time box. Build cost is a small fraction of A's (install 20 s against 956 s; production build 7–13 s against a 119 s compile). One minor-version swap (1.76.0 → 1.75.0) needed **0 source changes**. Against that: the editor core is VS Code 1.108, 36 weekly minors behind A's baseline; 8.6% of the VS Code API is stubbed (M1); the framework is EPL-2.0 (LEGAL REVIEW); and Electron was not tested. **Revisit trigger 3 is not met as measured**, because the debugger is part of the checklist. It is the closest of the M4 options, and §9 lists what would flip it.

---

## 1. What was built

| Piece | Files | Notes |
|---|---|---|
| Theia application (browser target) | `browser-app/package.json` | 31 `@theia/*` packages at 1.76.0 (core, editor, monaco, filesystem, navigator, search-in-workspace, terminal, scm, debug, task, plugin-ext, plugin-ext-vscode, vsx-registry, preferences, keymaps, notebook, …). Built by `theia build --mode production`, which uses esbuild since 1.75. Default theme `axis-dark`, workspace trust off for the test runs. The plugins directory is `../plugins`. |
| Axis shell extension | `axis-shell/src/browser/*` (363 lines of TS, TSX and CSS) | Everything is an Inversify contribution; **no Theia package is patched**. `AxisTopBarWidget` is a `ReactWidget` added to the shell's `top` area: brand mark, workspace switcher, "Search or run a command", "Agents: idle", "Model: not configured". `AxisAiPanelWidget` is a `ReactWidget` in the right area, collapsed on first start. A command toggles it. The first-run layout lives in `initializeLayout`. |
| Axis Dark theme | `axis-shell/src/browser/axis-theme.ts` | Registered through `MonacoThemingService`, so one token set drives both the workbench CSS variables (`--theia-*`) and the editor. Colours are the `docs/UX.md` dark tokens: canvas `#111214`, surface `#181A1D`, raised `#202227`, border `#2B2E34`, text `#E8E9EB`/`#9A9EA7`/`#70757F`, accent `#5823F6`, accent-on-dark `#9776F9`. |
| Plugins | `builtins.json`, `scripts/prepare-plugins.sh` | Two sources, both sha256-verified before unpacking. (1) The pinned Open VSX extensions via `test/extension-matrix/fetch.sh`. (2) 21 VS Code built-ins (TypeScript language features, Git, grammars, themes, js-debug) from the `eclipse-theia/vscode-builtin-extensions` **1.108.2** release (2026-03-25); Theia ships none of these itself. Everything is unpacked into the ignored `plugins/` directory. |
| Matrix harness | `scripts/run-scenario.sh`, `probe-plugin/` | Runs one `test/extension-matrix/scenarios.json` scenario with the **unchanged** probe (`probe/runner.js`, `logic.js`), wrapped as an `onStartupFinished` plugin because Theia has no `--extensionTestsPath`. Theia also has no `--disable-extension`, so `disableExtensions` entries are left out of a per-scenario plugins directory. Fixture copy, setup steps and settings merging mirror `run.sh`. |
| Measurement and smoke | `scripts/run-app.mjs`, `scripts/smoke.mjs` | `run-app.mjs` starts the built backend, opens headless Chrome through `puppeteer-core`, and records start-up marks, process-tree RSS and the JS heap. `smoke.mjs` drives the feature checklist (11 steps) by keyboard on a Git copy of the TypeScript fixture and prints one JSON line per step. |

**How to run.**

```bash
cd prototypes/theia
npm ci --ignore-scripts && npm rebuild   # rebuild runs the native install scripts (see §5)
scripts/prepare-plugins.sh               # fetch and verify extensions into plugins/
npm run build
npm start                                # http://127.0.0.1:3000/
scripts/run-scenario.sh S05-rust-analyzer
node scripts/smoke.mjs <work-dir> <shots-dir>
```

## 2. Extension results (M5 matrix on Theia)

Run 2 was on 2026-11-02, 09:15–09:32 local, against the build of 2026-11-02 00:04, with every scenario run at a 1-minute load below 6. Run 1 was on 2026-11-01, about 21:14–21:32 local, against an earlier build of the same sources; its load was not recorded. **Both runs gave identical results.** Each scenario ran with the full prepared plugin set minus its `disableExtensions` entries, so every extension below was loaded next to about 33 others.

| Scenario | Extension(s), version | Result | Evidence |
|---|---|---|---|
| S01 | Built-in TypeScript 1.108.2; js-debug 1.105.0 | **partial**: language features work, the debugger fails | activate, `ts2322` diagnostic, hover `add(a: number, b: number): number`, definition → `src/math.ts` all **passed**. Breakpoint: "timed out after 60000 ms waiting for a stop at debug.js:3; no stopped event". The backend logs `Failed to set exception breakpoints: Error: Connection is closed`. |
| S02 | `ms-python.python` 2026.4.0 + `ms-python.vscode-python-envs` 1.40.0 (Jedi) | **works** | Both activate; hover contains `greet`; definition → `helpers.py`. |
| S03 | `detachhead.basedpyright` 1.40.2 | **works** | `reportAssignmentType` diagnostic, hover `def greet(name: str) -> str`, definition. |
| S04 | `ms-python.debugpy` 2026.6.0 | **fails** (debugging) | Activates. No stop at `debug_me.py:2` within 120 s. The debugpy adapter log shows `setBreakpoints`, `setFunctionBreakpoints`, `setExceptionBreakpoints` and `threads` all failing after "Server[1] disconnected unexpectedly", then `Request 'configure' timed out after 30000ms`. |
| S05 | `rust-lang.rust-analyzer` 0.3.3097 (darwin-x64) | **works** | `E0308` diagnostic, hover `fn add(a: i32, b: i32) -> i32`, definition. |
| S06 | `vadimcn.vscode-lldb` 1.12.3 | **fails** (debugging) | Activates; the cargo build task is created. No stop at `src/main.rs:2` within 240 s. The backend logs `Could not handle breakpoints … Malformed message, disabling...`. |
| S07 | `golang.go` 0.58.0 | **not run** (blocked) | `gopls` is not installed on this machine (the scenario's `requires`). |
| S08 | `llvm-vs-code-extensions.vscode-clangd` 0.6.0 | **works** | `init_conversion_failed` diagnostic, hover `add`, definition → `math.hpp`. |
| S09 | `dbaeumer.vscode-eslint` 3.0.34 | **works** | Exactly `no-unused-vars` and `prefer-const` on `lint-me.js`. |
| S10 | `esbenp.prettier-vscode` 12.4.0 | **works** | Formatted `format-me.js` matches `format-me.expected.txt`. |
| S11 | `GitHub.github-vscode-theme` 6.3.5 | **works** | "GitHub Light High Contrast" applied, kind `HighContrastLight`. |
| S12 | `eamodio.gitlens` 19.5.0 | **works** (probe) / **partial** (UI) | 1 repository open, activates, 3 commands registered, `gitlens.showCommitsView` runs. In a UI session GitLens throws `TypeError: Cannot read properties of undefined (reading 'startsWith')` in `StatusBarController.onActiveLinesChanged` on cursor moves, so the status-bar blame is suspect. It also takes over the side bar on first start (screenshot `startup-full-2.png`). |
| S13 | `redhat.vscode-yaml` 2.0.0 | **works** | Schema diagnostic "Incorrect type. Expected "integer"" and hover text. |

**Summary.** 14 extensions exercised: 9 scenarios pass, 3 fail (all on the breakpoint check, S01 only on that check), and 1 was not run.

**The debugger failure.** It is one problem, not three: three unrelated adapters (JavaScript, Python, LLDB) all lose or never use their breakpoint connection, while everything else about the same extensions works.

- To rule out the probe, a scratch diagnostic set a breakpoint through the UI (F9 on `debug.js:3`) and started `matrix: debug.js` with F5.
- With only the built-ins and js-debug installed, the Debug view shows the session as **RUNNING**, with the breakpoint listed, and it never pauses. There are no errors in the backend log.
- With the full plugin set, the session stays at "Activating JavaScript Debugger" after 60 s.
- The cause is **not isolated**. Candidates not excluded in the time box:
  - Theia's breakpoint and launch ordering against these adapter versions;
  - the debuggee runtime: Node 25.9.0 for js-debug 1.105.0, which predates it;
  - the headless-browser environment.
- The M5 matrix has not yet run on the Code OSS build either (`extension-compatibility.md` §1), so there is no option-A control on this machine yet.

**Other compatibility signals from the logs.**

- Theia warns "Unsupported activation events" for `onEditSession:file`, `onTerminal:*`, `onWalkthrough:*` and `onLanguageModelTool:*` (Python's chat tools). Those activation paths are inert.
- No extension failed to load because of its `engines.vscode` range. The highest range in the set is `^1.110.0-20260204` (python-envs), under Theia's 1.139.0.

## 3. Feature checklist

The checklist is ADR 0002 validation criterion 1, plus the M4 brief and `docs/design/axis-shell.md` §1 (the Axis top bar, AI panel and theme).

- Evidence is `scripts/smoke.mjs` (11 steps, keyboard-driven, headless Chrome 156) and the matrix in §2.
- Final smoke runs: **11 of 11 passed on 1.76.0, and 11 of 11 on 1.75.0** (§6.2).

| Feature | Browser target (Node backend) | Electron | Evidence |
|---|---|---|---|
| Custom shell: Axis top bar, AI panel, first-run layout | **works** | not tested | The top bar renders `◆ · workspace · Search or run a command · Agents: idle · Model: not configured`; "Axis: Toggle AI Panel" opens the React panel. Added through `ApplicationShell.addWidget` with no patches. |
| Axis Dark theme from UX.md tokens | **works** | not tested | `--theia-editor-background` is `#111214`; the screenshots show the token palette on the workbench and the editor. |
| React for Axis UI | **works** | not tested | Both Axis widgets are `ReactWidget`s compiled in the normal build. React 19 is Theia's own UI technology, so no pipeline change is needed. CSP and Trusted Types were **not tested** (criterion 5 asks for both). |
| Editor (open, edit, save) | **works** | not tested | Quick open `main.ts`, typed a line, Cmd+S; the file on disk contains the edit. |
| Explorer | **works** | not tested | Lists `.vscode`, `src`, `debug.js`, `tsconfig.json`. |
| Diagnostics, problems count | **works** | not tested | The status bar shows 1 error for `main.ts`; matrix S01, S03, S05, S08, S09 and S13. |
| Search (Find in Files) | **works** | not tested | "3 results in 2 files" for `add`. |
| Command palette (F1) | **works** | not tested | "View: Toggle Bottom Panel ⌘J" is listed. |
| Terminal | **works** (real pty via `node-pty`) | not tested | `echo hi-$((40+2)) > file` wrote `hi-42`. |
| SCM / Git | **works** | not tested | Built-in Git 1.108.2 lists `src/math.ts` as modified; GitLens adds its views. |
| Debugger | **fails** | not tested | The Debug view renders the launch configuration, threads, call stack and breakpoints, but no adapter stops at a breakpoint (§2). |
| Node extension host (VS Code API) | **works** | not tested | 9 matrix scenarios pass, including LSP-based extensions with native binaries (rust-analyzer, clangd, basedpyright). |
| Open VSX extensions view | **works** | not tested | The extensions view lists 34 installed and built-in plugins. Installing from the registry at run time was **not tested**; the matrix uses pre-fetched, hash-verified VSIXs. |
| Settings, keybindings editors | not tested | not tested | Packages included (`@theia/preferences`, `@theia/keymaps`). |
| Linux / Windows | not tested | not tested | macOS x86_64 only. |

**Summary.** Works: shell customisation, theme, React UI, editor, explorer, diagnostics, search, palette, terminal, SCM/Git and the Node plugin host. Fails: debugger. Not tested: Electron, Linux, CSP/Trusted Types, run-time Open VSX installs, settings UI.

ADR 0002 criterion 7 (web) differs in shape for C. The browser target *is* Theia's web deployment: a Node backend serving the frontend, like `reh-web`. So the web column here is the same evidence.

## 4. Measurements

Machine: the M2 machine (Intel Core i9-9980HK, 8 cores, 16 GB, macOS 15.7.9).

- Node 25.9.0 and npm 11.12.1. The prototype's `engines` says Node 24, but npm does not enforce it and the M4 sibling used the same Node.
- Chrome 156.0.8078.74, headless, through `puppeteer-core` 25.1.0.
- Other sessions ran builds at the same time. The 1-minute load average (`sysctl -n vm.loadavg`) is recorded before and after each measurement. Runs above 14 are marked and not used for comparison.

### 4.1 Install, build and disk

| Metric | Value | Load (1 min, before → after) | Method |
|---|---|---|---|
| Install, cold | **20.4 s**, 920 packages | 10.6 → 9.4 | `npm ci --ignore-scripts` from the committed lockfile, in a scratch copy with an empty `--cache` |
| Native install scripts | **46.9 s** | 9.4 → 8.9 | `npm rebuild` on the same copy (§5) |
| Production build, 3 runs | **13.3 s, 7.3 s, 7.7 s** | 8.9 → 9.4 | `npm run build` (`tsc` for `axis-shell`, then `theia build --mode production`). esbuild reports about 1–1.4 s for the browser bundle and under 1 s for the node bundle; the rest is CLI and `tsc` overhead |
| `node_modules` | **431 MiB** | n/a | `du -sh` on the scratch install |
| Build output (`browser-app/lib`) | 85 MiB on disk | n/a | `du -sh` |
| Unpacked plugins | 410 MiB (CodeLLDB 149 MiB, TypeScript built-in 56 MiB, rust-analyzer 40 MiB); the 21 built-ins alone 83 MiB | n/a | `du -sh` |

For comparison, option A (M2): `npm ci` 956 s, compile 119 s, tree 7.6 GiB after build.

### 4.2 Bundle size (production build)

| Part | Raw | Notes |
|---|---|---|
| Frontend | **37.7 MiB** (JS 32.9 MiB) | `bundle.js` 14.9 MB (3.9 MB as the precompressed `.gz` Theia emits), `secondary-window.js` 12.6 MB, `plugin-worker.js` 4.4 MB, `editor.worker.js` 2.6 MB, CSS 2.5 MB. Precompressed `.gz` copies add 10.8 MiB. No source maps in production mode |
| Backend | **34.6 MiB** (JS 29.6 MiB) | `main.js` 11.9 MB, `plugin-host.js` 5.8 MB, plus native prebuilds (`pty.node`, `spawn-helper`) |

### 4.3 Startup

The workspace is the TypeScript matrix fixture with `src/main.ts` opened through quick open, with a fresh config directory and Chrome profile per run.

- "Backend" is the time from process spawn to "listening on".
- "Shell ready" is the moment Theia removes its preload overlay and `#theia-app-shell` exists, which is after layout restore.
- Both are wall clock from `run-app.mjs`.

| Plugins | Backend listening | Navigation → shell ready | Spawn → shell ready | Load (before → after) |
|---|---|---|---|---|
| none | 1.8, 1.6, 1.6 s | 4.4, 4.3, 4.3 s | **8.0, 7.1, 7.0 s** | 9.3→9.0, 9.0→6.9, 6.9→24.3 |
| full set (34 plugins) | 1.5, 1.7, 1.5 s | 7.4, 7.7, 7.4 s | **10.0, 10.5, 9.9 s** | 6.2→6.0, 6.0→5.0, 5.0→4.1 |
| full set, first attempt (**load above 14, not used**) | 1.6, 1.4, 1.7 s | 9.5, 7.4, 12.3 s | 12.4, 9.9, 15.3 s | 24.3→21.1, 21.1→26.2, 26.2→20.6 |

M2 baseline (option A, dev build): `ellapsed` 9.7–10.0 s warm, 12.8 s on the first launch. **The numbers are not equivalent.** M2 measures an unbundled Electron dev build from `didStartMain` to `didStartWorkbench`. Theia's numbers are a bundled production build in headless Chrome, measured from backend spawn. Use them only as an order of magnitude.

### 4.4 Memory

Sampled about 30 s after shell ready, as summed RSS (`ps`) of the backend and all descendants, plus the headless Chrome tree.

| Plugins | Backend tree | Chrome tree | Page JS heap | Load |
|---|---|---|---|---|
| none | 257, 178, 266 MiB (3 processes) | 957, 635, 965 MiB | 60 MiB | 6.9–9.3 |
| full set | **1,132, 1,128, 1,109 MiB** (9 processes: the backend and its Node children, i.e. plugin host, language servers and `tsserver`, plus one shell) | **1,184, 1,180, 1,179 MiB** | 130 MiB | 4.1–6.2 |

The full-set total is about **2.3 GiB**. M2 baseline (option A): 2,778 MiB summed over 11 Electron processes. Again not equivalent: Chrome stands in for Electron, and the plugin sets differ. The M4 sibling report found headless-Chrome RSS unstable; here the three low-load runs agree within 2%.

## 5. Licensing and supply chain

- **Theia: EPL-2.0 OR GPL-2.0 with Classpath exception.** That covers 46 of the 47 `@theia/*` packages installed. `@theia/monaco-editor-core` is MIT.
- Other runtime and dev licences in `node_modules`: mostly MIT (722 packages), ISC (65), Apache-2.0 (28) and BSD (30). Also:
  - `jschardet` (LGPL-2.1+; upstream VS Code ships it too);
  - `@vscode/codicons` (CC-BY-4.0, the icon font);
  - `argparse` (Python-2.0);
  - `dompurify` 3.2.7 and 3.4.17 (MPL-2.0 OR Apache-2.0);
  - two packages with no licence field: `buffers` 0.1.1 and `union` 0.5.0. These need checking before any distribution.
- **Install scripts are required.** `npm ci --ignore-scripts` alone gives a tree that builds but cannot run a terminal or watch files. `npm rebuild` must run the native steps:
  - `node-pty` (prebuild, or `node-gyp`; needed for the terminal);
  - `@parcel/watcher` (file watching);
  - `drivelist` and `keytar` (prebuild, or `node-gyp`);
  - `msgpackr-extract` (optional);
  - `@theia/ffmpeg` (`binding.gyp`, compiled locally);
  - the `esbuild` binary.
  - `puppeteer`'s `postinstall` (a Chrome download) is not needed by the app; the scripts use `puppeteer-core` with the system Chrome.
  - npm 11 reports "9 packages have install scripts not yet covered by allowScripts", so an Axis build needs an explicit allow-list.
- VS Code built-ins come from a third-party (Eclipse) re-packaging (`eclipse-theia/vscode-builtin-extensions`), pinned by sha256. They are MIT, as upstream.
- Extensions are pinned, hash-verified VSIXs (M5). Nothing is vendored in the repository.

### 5.1 EPL-2.0 notes (LEGAL REVIEW)

These are engineering notes, not legal advice; `licensing-and-marketplace.md` already lists EPL-2.0 as an open item. The paraphrases are from EPL-2.0 §1 and §3.

1. **Obligations attach to Theia's own files and to modifications of them.**
   - Distributing Theia in object code (a desktop app, or a web app whose JavaScript is sent to browsers) requires making the Source Code of the EPL-2.0 "Program" and of any "Modified Works" available. It also requires keeping the licence and notices.
   - Option A has no equivalent obligation (MIT).
2. **Separate modules can stay proprietary, which is the point to verify.**
   - EPL-2.0 excludes from "Modified Works" any works that contain only declarations, interfaces, types or classes of the Program "solely in each case in order to link to, bind by name, or subclass" it.
   - The prototype's Axis code is in that shape: a separate package that imports, binds and subclasses `ReactWidget` and contributions, with no edits to Theia files.
   - **LEGAL REVIEW** must confirm that an `axis-shell`-style extension, **bundled by esbuild into the same `bundle.js`** as the EPL code, is not a Modified Work. It must also say how to give source access for the EPL parts of a bundled web app.
3. **Patching Theia is the risky path.** Any change to a Theia file becomes EPL-2.0 source Axis must publish, and so does any copied-and-edited Theia file. An Axis on C should keep to "contributions only", which this prototype shows is enough for the shell.
4. **The secondary licence (GPL-2.0 with Classpath exception)** is available to recipients. It does not change Axis's obligations if Axis distributes under EPL-2.0. Confirm with counsel.
5. Patent and trademark: EPL-2.0 includes a patent grant from contributors, and Eclipse Foundation trademark rules apply to "Eclipse" and "Theia" names (not used in the Axis product name). **LEGAL REVIEW.**

## 6. Maintenance

### 6.1 Theia release cadence (GitHub releases, `eclipse-theia/theia`)

- **Monthly minors.** 1.67.0 2025-12-10, 1.68.0 2026-01-29, 1.69.0 02-26, 1.70.0 03-26, 1.71.0 04-30, 1.72.0 05-28, 1.73.0 06-25, 1.74.0 07-31, 1.75.0 08-27, 1.76.0 09-24. That is ten minors in about ten months. 1.77.0 is not released as of 2026-11-02; a `next` pre-release was published that day.
- **Patch releases** on selected minors. 1.74 is still receiving them (1.74.3 on 2026-10-23, after 1.76.0), which matches Theia's quarterly community-release line.
- **Breaking-change entries** in `CHANGELOG.md` per minor (counted as bullets under each "Breaking Changes" heading). About a third are in the AI packages, which Axis does not use:

| Minor | Breaking entries | Of which `ai-*` only |
|---|---|---|
| 1.73.0 | 24 | 9 |
| 1.74.0 | 8 | 2 |
| 1.75.0 | 18 | 2 |
| 1.76.0 | 16 | 7 |

**1.75 → 1.76 upgrade notes**, for the APIs Axis would touch:

- `TabBarToolbarItem.isVisible` now needs a context matcher.
- `DecorationsProvider.onDidChange` widened.
- The Electron `CHANNEL_WC_METADATA` reply shape changed, which affects custom preload scripts.
- `@theia/plugin-ext` gained a `@theia/telemetry` dependency and a new `createAPIFactory` argument.
- `PluginPaths` moved.
- Getting-started walkthrough API renames.

**1.74 → 1.75:**

- webpack support removed (esbuild only);
- **React 18 dropped** (React 19 peer dependency);
- `ILogger` injection in many classes;
- concurrent plugin deployment;
- an SCM history tooltip type change.

None of the 1.75 or 1.76 entries names an API the prototype uses (`ApplicationShell.addWidget`, `ReactWidget`, `WidgetManager`, `FrontendApplicationContribution.initializeLayout`, `CommandContribution`, `MonacoThemingService`).

**Editor core and API level.**

- Monaco moved from 1.96.3 (Theia 1.58, 2025-01) to 1.108.201 (Theia 1.70, 2026-03), about 14 months between bumps.
- The declared API level tracks VS Code closely: 1.134.0 in 1.75 and 1.139.0 in 1.76.
- The built-in extensions lag with the editor core (1.108.2).

### 6.2 Upgrade experiment (adjacent minor)

The prototype was rebuilt on **1.75.0**: all 35 `@theia/*` version strings were changed, in a scratch copy without the lockfile.

| Step | 1.75.0 | 1.76.0 (baseline) |
|---|---|---|
| Prototype source changes needed | **0 lines** | baseline |
| `npm install --ignore-scripts` (warm cache) | 39.1 s (load 3.0) | 20.4 s cold `npm ci` |
| `npm rebuild` | 15.2 s | 46.9 s |
| Build | 9.7 s, 0 errors | 7.3–13.3 s |
| `smoke.mjs` | **11 of 11** | 11 of 11 |
| Monaco core | 1.108.201 (unchanged) | 1.108.201 |

This is a downgrade by one minor on a 363-line surface. It shows that the contribution APIs Axis needs are stable across adjacent minors. It does not measure a Monaco bump, which is when editor-level behaviour changes.

### 6.3 Maintenance estimate

| Cost item | Option C (measured or inferred) | Option A (ADR 0002 / M2 / M3 design) |
|---|---|---|
| Axis shell code | 363 lines of TS/TSX/CSS as Theia extensions; React native | `src/vs/axis` overlay plus about 10 upstream files / about 45 lines (design estimate, `axis-shell.md` §3.10) |
| Axis-owned upstream patches | **0** (and patches would carry EPL source obligations, §5.1) | shell `0001–0999` ≤ 12 files / 300 lines; plus the guardrail, Copilot and hardening ranges |
| Copilot removal and rebrand | **not needed**: Theia has no Copilot dependency in core. Its AI packages are optional and were not installed. Rebrand is `applicationName` plus Axis theme and icons | The largest patch set (ADR 0002 decision 6) |
| Build pipeline | `npm ci` + `npm rebuild` + `theia build`: about 81 s cold in total (§4.1: 20.4 + 46.9 + 13.3 s) | M2 pipeline: 956 s install, 119 s compile, 7.6 GiB tree |
| Per upgrade | **Measured: 0 source lines for one adjacent minor**, about 1 minute of install and build plus a 2-minute smoke run. **Estimate** for a product-sized surface: 0.5–2 days per monthly minor, mostly reading the breaking-change list and fixing the APIs used. A Monaco bump is a larger, rarer event (estimate: several days of regression testing, every 12–14 months at the historical rate) | Rebase of all patch ranges every 2–4 weekly minors; criterion 4 target ≤ 1 working day per sync (not yet measured) |
| Inherited third-party maintenance | Theia's own team (365 contributors, 43 PR authors in 3 months, M1). Axis cannot pick a newer editor core than Theia ships | none: Axis is the maintainer of its patches; upstream is Microsoft |
| Extension compatibility work | Theia's plugin host is its own implementation: 8.6% of the API stubbed and 30 items unsupported (M1). Fixes go upstream to Theia or are waited for. The debugger gap (§2) is the open example | Upstream's own extension host; failures caused by Axis patches only |

**Inferred conclusion.** On build and upgrade cost, C is **materially cheaper** than A: about an order of magnitude less build time, no patch series, no Copilot removal, and a measured zero-change minor swap. C's costs sit elsewhere:

- compatibility gaps Axis does not control (the stubbed API surface, the editor core lag, and now the debugger);
- EPL-2.0 compliance.

## 7. Findings and risks

1. **Debugging does not work in this setup** (§2). It is a checklist item and a core IDE capability. It may be environmental, but until it is shown working, C fails criterion 1.
2. **Editor core lag.** Monaco 1.108 against A's 1.144 baseline is 36 weekly minors behind, and bumps come roughly yearly. The VS Code built-ins Theia uses (TypeScript, Git, js-debug) lag the same way. Newer editor features (inline-edit and diff UI, recent TypeScript-extension behaviour) arrive late or not at all. The matrix did not hit a blocker from this.
3. **API gaps are silent.** Stubbed APIs no-op, and unsupported activation events are only logged (`onLanguageModelTool:*`, `onTerminal:*`, `onEditSession:*`). An extension can "work" in the matrix and still degrade, as GitLens's status-bar `TypeError` shows.
4. **EPL-2.0** (§5.1). It is weak copyleft at the file and module level. It is fine for additive extensions if counsel agrees, but it forbids quiet patching and needs a source-offer process for distributed web and desktop builds.
5. **Native install scripts.** The terminal, file watching and keychain need native builds or prebuilds (§5), so supply-chain review and an `allowScripts` list are needed, unlike the M4 sibling's zero-script install.
6. **Not tested: Electron** (`@theia/electron`, Electron 44.9.1 per M1), Linux, CSP and Trusted Types, and run-time Open VSX installs. Each is a criterion input.
7. **Precedent risk.** The main adopter cited in M1 (Arduino IDE) sits about 18 months behind Theia. That suggests adopters do not always keep up with monthly minors in practice, even though one minor cost nothing here.
8. **Measurement noise.** The load reached 26 during one startup series, which was discarded (§4.3). Install and build ran at load 9–10.

## 8. Not done

- No Electron build, and no Linux or Windows run.
- The debugger root cause was not found (see §2 for the candidates). The matrix was not run against a Code OSS build for a control.
- S07 (Go) was not run: `gopls` is missing on the host.
- Run-time installs from the Open VSX registry, the settings and keybindings editors, CSP/Trusted Types and accessibility (F6 cycle, screen readers) were not exercised.
- The upgrade experiment covers one adjacent minor on a 363-line surface; no Monaco bump was exercised.
- Proposed-API handling (`enabledApiProposals`; D1 in `extension-compatibility.md`) was not checked on Theia.

## 9. Recommendation against ADR 0002's criteria

- **Revisit trigger 3** ("M4 prototypes meet the same checklist with materially lower maintenance cost"): **not met**.
  - The maintenance half is met on the evidence: §4.1, §6.2 and §6.3.
  - The checklist half is not, because the debugger fails with all three adapters tried (criteria 1 and 6).
  - Electron and Linux are untested.
- **Criteria 2 and 5:** C is strongest here. The shell needs zero upstream patches, and React is the framework's own UI technology. CSP/Trusted Types are unverified.
- **Compared with option B** (`prototype-monaco-vscode-api.md` on the B branch): C already runs the Node extension host, terminal, Git and 9 of 13 matrix scenarios without a Code OSS server. So C, not B, is the realistic alternative if A hits a revisit trigger.
- **Decision input:** keep ADR 0002 **option A** as proposed. Record C as the **primary fallback**. Before Phase 0 exits, spend one day on these:
  1. **Root-cause the debugger.** Run S01/S04/S06 headful, with Node 24 for the debuggee, and with DAP tracing on (`debug.trace` / adapter logs). Then compare with the same scenarios on the M2 Code OSS build once M5 runs there. If the M2 build also fails, the problem is environmental and C's checklist gap closes.
  2. **Build `@theia/electron`** for the same app and run `smoke.mjs` against it.
  3. **Send the EPL-2.0 questions in §5.1 to LEGAL REVIEW.**

  If (1) and (2) pass and (3) clears contributions-only use, trigger 3 would be met. That warrants a superseding ADR comparing A's measured sync cost (criterion 4) against C's monthly minors.
