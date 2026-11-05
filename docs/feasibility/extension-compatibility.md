# Axis: Extension Compatibility Matrix (Phase 0, Code OSS 1.144.0)

- Upstream baseline: `microsoft/vscode` tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`, the baseline proposed in ADR 0002.
- Registry: Open VSX (`https://open-vsx.org`). The Microsoft Marketplace is excluded; see `licensing-and-marketplace.md` §3.
- Research date: 2026-11-01. Registry data comes from the Open VSX API (`/api/{namespace}/{name}`, `/{version}`, `/{target}/{version}` and `/api/-/query`).
- Source citations (`path:line`) point into the 1.144.0 tree. It was read only; no upstream script was run.

## Status

**No scenario has been run.** No Axis build exists yet; M2 is producing one. Every result column below is `not run`, and nothing in this document is a compatibility claim.

This matrix is the input to ADR 0002 validation criterion 6 (`docs/adr/0002-code-oss-integration-strategy.md`, "Validation criteria (M3–M6)"): "the M5 matrix of 10 representative Open VSX extensions runs on the Axis build, with every failure recorded. Failures caused by Axis changes must be fixable within the patch budget." The 12 core Open VSX extensions in §2 are that set. Until it runs on an Axis build, criterion 6 is unmet.

This milestone delivers the following:

| Deliverable | Location | State |
|---|---|---|
| Pinned selection (id, version, license, artifacts, sha256) | `test/extension-matrix/extensions.json` | Done. Every hash was computed locally and cross-checked (see §8). |
| Download and verification script | `test/extension-matrix/fetch.sh` (+ `lib.sh`) | Done. Tested against the live registry, including a mismatch case. |
| Scenario definitions | `test/extension-matrix/scenarios.json` | Done. |
| Fixture workspaces | `test/extension-matrix/fixtures/*` | Done. Go, Rust and C++ fixtures checked with the local toolchains; the web-tooling fixture has a committed lockfile, and its Prettier and ESLint outputs were checked with the pinned packages. |
| Probe test runner (runs inside the extension host) | `test/extension-matrix/probe/` (`runner.js`, pure helpers in `logic.js`) | Written. `node --check` and unit tests against a stand-in `vscode` module pass (§8). **Needs a build to run against real extensions.** |
| Unit and consistency tests | `test/extension-matrix/tests/` | Done. `node --test 'test/extension-matrix/tests/*.test.js'` runs 43 tests: probe logic, manifest/scenario/fixture consistency, `run()` with a stand-in `vscode` module, the scan analysis, and `run.sh` driven by a stand-in app (§8). |
| Pinned install into an isolated extensions dir | `test/extension-matrix/install.sh` | Written; tested against a stub CLI only. **Needs a build.** |
| Desktop scenario runner and log scans | `test/extension-matrix/run.sh`, `test/extension-matrix/scan-report.js` | Written; tested against a stand-in app only. **Needs a packaged build.** |
| Web (reh-web) runner | — | **Designed (§7.4); built and executed in M6** (decision D6). |
| UI smoke layer (`test/automation`) | — | **Pending.** Design in §7.3. |

VSIX files are never committed. `fetch.sh` writes them to `test/extension-matrix/.vsix-cache/`, which is ignored, as is the run output in `test/extension-matrix/.work/`.

## 1. Selection rationale

`ARCHITECTURE.md` asks for 10 representative extensions covering language servers, a debugger, a formatter, a theme and Git. The selection has 12 core Open VSX extensions, one supporting pack member, and the built-in TypeScript/JavaScript baseline. Two optional extensions, Jupyter and Java, can be run with `--tier optional`.

The selection followed these rules:

1. **Breadth of extension-host surface.**
   - Language servers over LSP: rust-analyzer, gopls, clangd, basedpyright, YAML, JDT LS.
   - A non-LSP language extension: Python, with its Jedi fallback.
   - Debug adapters, both Python (debugpy) and native (CodeLLDB), plus the built-in js-debug.
   - A linter that runs workspace code (ESLint).
   - A formatter (Prettier, plus Go formatting through gopls).
   - A declarative-only theme.
   - A large webview- and SCM-heavy extension (GitLens).
2. **Packaging diversity.** The set mixes universal VSIXs, platform-specific VSIXs with bundled native binaries (rust-analyzer, debugpy, Java), a bootstrap VSIX that downloads its platform package at runtime (CodeLLDB), and extensions with `browser` entries (Python, Prettier, GitLens, YAML, Jupyter).
3. **Open replacements for Microsoft-only extensions.** basedpyright replaces Pylance, and clangd plus CodeLLDB replace C/C++ (cpptools). See §3.
4. **Only stable releases, only verified namespaces.** Every pinned version is a non-pre-release from a verified Open VSX namespace. Where Open VSX `latest` is a pre-release, the newest stable release was pinned instead.
5. **Licenses that allow use in a third-party Code OSS product.** Git Graph (`mhutchie.git-graph`) was rejected: its license states "Permission is NOT GRANTED to publish, distribute, sublicense, and/or sell derivative works", Open VSX shows no license field for it, and it was last published on 2021-04-17. GitLens is used instead, with the caveat noted in §4.

## 2. Matrix

The Node/web column gives the manifest entry points. `node` means `main` and `browser` means `browser`. For an Axis web build served by `reh-web`, extensions with `extensionKind: workspace` run in the server's Node extension host, so `node` alone does not mean web is out of scope. A `browser` entry only matters for a pure static web build without a server, which ADR 0002 does not plan.

Platforms are the targets Axis builds for. "universal" means one VSIX for all of them.

Publisher is the Open VSX account that uploaded the pinned version (decision D4). "vendor" is the extension's own publisher or maintainer account; "open-vsx service account" means the file was uploaded by the Open VSX publishing service on the vendor's behalf. `extensions.json` records it as `openVsx.publisherType` and `openVsx.publishedBy`. None of the pinned versions used trusted publishing.

Python has two rows of results by decision D3: S02 is the default configuration (Jedi fallback), S03 is basedpyright with `python.languageServer: None`.

The scenario rows record each scenario's own extensions only. Proposed-API stripping is recorded once per extension, in the table in §2.1.

| # | Extension | Version | License | Open VSX status | Publisher | Node/web | Platforms | Scenario | Desktop result | Web result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Built-in TypeScript/JS (`vscode.typescript-language-features`) and `ms-vscode.js-debug` | 1.144.0 built-in; js-debug 1.140.0 | MIT | n/a (built-in; js-debug pinned by sha256 in upstream `product.json`) | n/a (built-in) | node + browser (TS) | all | S01 | not run | not run | Baseline. Covers diagnostics, hover, definition and a Node breakpoint. |
| 1 | `ms-python.python` | 2026.4.0 (2026-03-13) | MIT | verified; stable is latest | open-vsx service account | node + browser | universal | S02 | not run | not run | `extensionPack` includes Pylance, which is absent from Open VSX. Declares 9 proposed APIs. Without Pylance it falls back to the bundled Jedi server. |
| 2 | `detachhead.basedpyright` | 1.40.2 (2026-10-04) | MIT | verified; stable is latest | vendor (`DetachHead`) | node | universal | S03 | not run | not run | Pylance replacement. |
| 3 | `ms-python.debugpy` | 2026.6.0 (2026-05-01) | MIT | verified; stable is latest | open-vsx service account | node | darwin-x64, darwin-arm64, linux-x64, win32-x64 (no universal) | S04 | not run | not run | Depends on `ms-python.python`. Declares 3 proposed APIs. |
| 3a | `ms-python.vscode-python-envs` (supporting) | 1.40.0 (2026-10-15) | MIT (VSIX `LICENSE.txt`; Open VSX field empty) | verified; stable is latest | open-vsx service account | node | universal | S02, S04 | not run | not run | Pack member of Python. Declares 3 proposed APIs. Engine `^1.110.0-20260204`. |
| 4 | `rust-lang.rust-analyzer` | 0.3.3097 (2026-10-26) | MIT OR Apache-2.0 | verified; **latest is pre-release 0.4.3103** | vendor (`rust-lang-owner`) | node | darwin-x64, darwin-arm64, linux-x64, win32-x64 | S05 | not run | not run | Platform VSIXs bundle the server; the universal VSIX does not. |
| 5 | `vadimcn.vscode-lldb` (CodeLLDB) | 1.12.3 (2026-08-23) | MIT | verified; stable is latest | vendor (`vadimcn`; platform packages from the vendor's GitHub releases) | node | Open VSX: universal bootstrap only. Pinned platform packages come from GitHub releases. | S06 | not run | not run | The bootstrap downloads the platform package from GitHub on activation (§4). |
| 6 | `golang.go` | 0.58.0 (2026-10-21) | MIT | verified; stable is latest | open-vsx service account | node | universal | S07 | not run | not run | Needs `gopls` on the host. Engine `^1.110.0`. |
| 7 | `llvm-vs-code-extensions.vscode-clangd` | 0.6.0 (2026-05-21) | MIT | verified; stable is latest | vendor (`sam-mccall`) | node | universal | S08 | not run | not run | cpptools replacement. Needs a `clangd` binary. |
| 8 | `dbaeumer.vscode-eslint` | 3.0.34 (2026-07-17) | MIT | verified; stable is latest | open-vsx service account | node | universal | S09 | not run | not run | Uses the workspace `eslint` (fixture pins 9.39.5). |
| 9 | `esbenp.prettier-vscode` | 12.4.0 (2026-03-16) | MIT | verified; stable is latest | vendor (`ntotten`) | node + browser | universal | S10 | not run | not run | S10 installs the lockfile, so the workspace Prettier 3.9.10 is under test. The extension bundles 3.7.4, which gives the same output for the fixture. `.prettierrc.json` pins every option, including `useTabs` and `endOfLine`. |
| 10 | `GitHub.github-vscode-theme` | 6.3.5 (2024-10-04) | MIT | verified; stable is latest | open-vsx service account | declarative (no entry point) | universal | S11 | not run | not run | Not updated for two years, but needs no API. |
| 11 | `eamodio.gitlens` | 19.5.0 (2026-10-27) | MIT core + proprietary GitLens Pro terms for `plus/` | verified; **latest is a daily pre-release** | vendor (`eamodio`) | node + browser | universal | S12 | not run | not run | The Open VSX license field is the unresolved placeholder `%gitlens.license%`. |
| 12 | `redhat.vscode-yaml` | 2.0.0 (2026-10-16) | MIT | verified; **latest is a pre-release** | vendor (`rhdevelopers-ci`) | node + browser | universal | S13 | not run | not run | Has its own telemetry (`redhat.telemetry.enabled`; off in the scenario). |
| O1 | `ms-toolsai.jupyter` (optional) | 2025.9.1 (2025-10-14) | MIT | verified; stable is latest | open-vsx service account | node + browser | universal | S14 | not run | not run | The Open VSX copy is more than a year old. Declares 13 proposed APIs. Pack members are not pinned. |
| O2 | `redhat.java` (optional) | 1.58.0 (2026-10-19) | EPL-2.0 | verified; **latest is a pre-release** | vendor (`rhdevelopers-ci`) | node | darwin-x64, darwin-arm64, linux-x64, win32-x64 (+ universal without JRE) | S15 | not run | not run | Platform VSIXs embed a JRE (about 130 MB each). |

### 2.1 Proposed-API stripping (decision D1)

This table comes from one `run.sh --proposed-api-scan` per gating platform: one normal window of a packaged build with the full installed set (`proposed-api.tsv`, §7.2). The scan is valid only when its positive control passes, that is, when every extension below is reported as restricted. If the control fails, the scan status is `inconclusive` and nothing is recorded.

| Extension | Declared proposals | Stripped (macOS x64) | Stripped (Linux x64) | Effect observed in the scenarios | Notes |
|---|---|---|---|---|---|
| `ms-python.python` | 9 | not run | not run | not run (S02, S04) | Positive control for every core install |
| `ms-python.debugpy` | 3 | not run | not run | not run (S04) | |
| `ms-python.vscode-python-envs` | 3 | not run | not run | not run (S02, S04) | |
| `ms-toolsai.jupyter` (optional) | 13 | not run | not run | not run (S14) | Only in `--tier optional` installs |

**Engine check.** Every pinned `engines.vscode` range is satisfied by 1.144.0. VS Code reads `^1.x.y` as "at least 1.x.y within major 1", and a date suffix such as `-20260204` only matters when the minor version is equal (`src/vs/platform/extensions/common/extensionValidator.ts:124-236`, notably `:180` and `:233`). The VSIX installer enforces the same check (`src/vs/platform/extensionManagement/node/extensionManagementService.ts:153`).

## 3. Microsoft-licensed exclusions and open alternatives

These extensions are not on Open VSX (the API returns "Extension not found") and their licenses restrict use to Microsoft products. Evidence, and the complete list of restricted extensions, is in `licensing-and-marketplace.md` §4.

| Excluded | Why | Open alternative in this matrix | Gap to verify |
|---|---|---|---|
| Pylance `ms-python.vscode-pylance` | Microsoft license, Microsoft products only; not on Open VSX | `detachhead.basedpyright` (S03). The Python extension's Jedi fallback is also tested (S02). | Notebook IntelliSense inside Jupyter; Pylance-only settings |
| C/C++ `ms-vscode.cpptools` | Proprietary binaries in the official VSIX; not on Open VSX | `llvm-vs-code-extensions.vscode-clangd` (S08) for language features, `vadimcn.vscode-lldb` (S06) for debugging | MSVC debugging on Windows has no equivalent here |
| C# Dev Kit / C# (`ms-dotnettools.*`) | Proprietary; both absent from Open VSX | Not covered. Candidates outside this matrix need their own license check. | — |
| Remote-SSH / Dev Containers / WSL | Microsoft pre-release terms; not on Open VSX | Not covered. Axis remote workspaces are a separate design topic. | — |
| Live Share | Microsoft products only | Not covered | — |

## 4. Risks found during selection

1. **Proposed APIs are stripped in normal windows and allowed in test hosts.**
   - Python (9 proposals), debugpy (3), python-envs (3) and Jupyter (13) declare `enabledApiProposals`. All 22 distinct names exist at 1.144.0 (`src/vs/platform/extensions/common/extensionsApiProposals.ts`).
   - The OSS `product.json` has no `extensionEnabledApiProposals` allowlist. In a built, non-development window, a non-built-in extension's proposals are therefore cleared, and the host logs "CANNOT USE these API proposals" (`src/vs/workbench/services/extensions/common/extensionsProposedApi.ts:43-55,104-114`).
   - In an extension test host, proposals are allowed for every extension unless `product.quality` is `stable` (`:34-36`). The probe runs in a test host, so it **cannot** see this gap.
   - A development build allows every proposal too: `!isBuilt` (`:35`), and `isBuilt` is `!VSCODE_DEV` (`src/vs/platform/environment/common/environmentService.ts:231`), which `scripts/code.sh:41` sets. The normal-window scans (§7.2) therefore refuse a dev launcher and check a positive control before they report anything.
   - **Decision D1:** no allowlist by default. M3 runs the matrix without one and records which extensions degrade in normal windows (§2.1, §7.2). Any allowlist entry is decided per extension, with justification, in a later ADR.
2. **The Python extension without Pylance.**
   - `ms-python.python` lists Pylance in its `extensionPack`. When a gallery is configured, a pack member that cannot be found or installed is skipped without failing the install (`src/vs/platform/extensionManagement/common/abstractExtensionManagementService.ts:652-692`, log message at `:691`).
   - With `python.languageServer: Default`, the extension uses "Pylance if installed and available, otherwise fallback to Jedi" (its `package.nls.json`). The VSIX bundles `python_files/lib/jedilsp`.
   - With basedpyright also installed, two Python language servers may run (Jedi and basedpyright) unless `python.languageServer` is `None`. S03 sets `None`; S02 disables basedpyright. **Decision D3:** no Axis default yet; the matrix runs and records both configurations.
   - Jupyter 2025.9.1 still contributes Pylance-specific commands (`jupyter.replayPylanceLog`). Notebook IntelliSense without Pylance is untested.
3. **CodeLLDB downloads native code from GitHub at runtime.**
   - On Open VSX it is a 94 KB universal "bootstrap" VSIX. Its `package.json` `config.platformPackages.url` is `https://github.com/vadimcn/codelldb/releases/download/v${version}/${platformPackage}`, and it activates `onStartupFinished`.
   - So a stock install fetches about 45–55 MB of native code from GitHub, outside the registry, on first start. That breaks offline or policy-restricted setups and sidesteps registry governance.
   - The pinned GitHub platform VSIXs carry the same id and version (`vadimcn.vscode-lldb@1.12.3`, `TargetPlatform` set). The harness installs those directly. Their sha256 values match the GitHub release asset digests.
   - **Supply-chain note (threat EXT-3, `docs/security/threat-model-phase0.md` §5.2).** In a stock install, the native code that runs comes from GitHub at activation, not from the registry. Registry-side controls (Open VSX signatures, a namespace allow-list, a mirror) do not cover it, and the extension does the download itself.
   - **Decision D2:** Phase 0 tests pre-install the pinned, hash-verified GitHub platform VSIX. The product default is deferred.
4. **Other runtime downloads and host toolchains.**
   - Go needs `gopls`; the extension otherwise offers to `go install` its tools.
   - clangd needs a `clangd` binary and can download one from GitHub.
   - ESLint runs the workspace's `eslint` package.
   - The Python scenarios need a host interpreter.
   - Scenarios declare `requires`, and `run.sh` reports `blocked` (never `failed`) when a tool is missing.
5. **Pre-release `latest` on Open VSX.**
   - rust-analyzer (0.4.x nightlies), GitLens (daily builds), YAML and Java all have a pre-release as `latest`.
   - The `allVersions` map in the Open VSX extension response lists only about 100 entries. The stable rust-analyzer and GitLens versions had to be found by paging `/api/-/query?...&includeAllVersions=true`.
   - Any Axis gallery or recommendation logic must request stable versions explicitly.
6. **Stale registry copies.** The Jupyter Open VSX copy is dated 2025-10-14 and the GitHub theme 2024-10-04. Open VSX copies of Microsoft-namespace extensions may trail their upstream releases. Upstream Marketplace versions were not checked (the Marketplace is out of scope).
7. **Provenance.**
   - Seven of the fifteen pinned extensions were uploaded by the `open-vsx` service account rather than by the vendor: Python, debugpy, python-envs, Go, ESLint, the GitHub theme and Jupyter.
   - None of the pinned versions used trusted publishing (`publishedWithTrustedPublishing: false`).
   - The harness pins sha256 values taken at selection time but does not verify Open VSX `.sigzip` signatures. A curated, sha256-pinned set matches the planned control for threat EXT-1.
   - **Decision D4:** M3 tests signature handling per threat EXT-3 (the suspected `vsce-sign` inversion: signed extensions blocked, unsigned ones accepted) by installing a signed, an unsigned and a tampered extension on an Axis build. Phase 0 dev builds may install unsigned extensions. The matrix records the publisher type (§2). The signature and service-account policy is set after the M3 results.
8. **Licenses needing care.**
   - GitLens combines MIT with proprietary GitLens Pro terms for its `plus/` directories. It can be installed by users but should not be bundled; S12 avoids Pro features.
   - The python-envs Open VSX record has no license field (the VSIX contains MIT `LICENSE.txt`).
   - `redhat.java` is EPL-2.0 (weak copyleft); it is fine for user installs, but bundling needs review.
   - Red Hat's YAML and Java extensions collect their own telemetry (`redhat.telemetry.enabled`), outside `telemetry.telemetryLevel` (threat EXT-5). The scenarios turn it off.
9. **Install determinism.**
   - Installing a VSIX normally also installs its `extensionDependencies` and `extensionPack` members from the gallery, at whatever versions the gallery serves. For VSIX installs, failures are only logged as warnings (`abstractExtensionManagementService.ts:399-433`).
   - `install.sh` passes the hidden `--do-not-include-pack-dependencies` flag (`src/vs/platform/environment/node/argv.ts:206`, `src/vs/code/node/cliProcessMain.ts:323`). It then compares `--list-extensions --show-versions` with the pins and fails on any difference.
10. **Fixture reproducibility.** `fixtures/web-tooling/package.json` pins `eslint` 9.39.5 and `prettier` 3.9.10, and the committed `package-lock.json` (lockfile v3) pins all 87 packages to `registry.npmjs.org` with sha512 integrity hashes. `run.sh` installs it with `npm ci --ignore-scripts`. ESLint 10 (current `latest`) is not covered.
11. **Web runner gaps upstream.**
   - The upstream browser integration runner always passes `--enable-proposed-api` to the server and `["enableProposedApi",""]` in the page payload (`test/integration/browser/src/index.ts:135,194`), which would hide risk 1.
   - It also creates a fresh `--server-data-dir` on every run (`:182-194`), so pinned extensions cannot be pre-installed. Axis needs its own small web runner (§7.4).
12. **Extensions that plug into the upstream chat stack.** Python, CodeLLDB and Jupyter contribute `languageModelTools`, and GitLens contributes `mcpServerDefinitionProviders`. When Axis removes or replaces the upstream chat stack (ADR 0002 guardrails), these contribution points may have no host. If Axis wires them into its own agent features, they become a path from extensions into those features. Threat EXT-2 requires that Axis privileged operations are not exposed as commands. The activation scan records any errors from these contribution points; how Axis surfaces them is an M3 question. The removal is M3 task S1.3 in `docs/design/axis-shell.md`, and its SC-3 artifact check (`check-artifacts`) confirms that the Copilot and agent-host code is gone. Results for these extensions are only comparable before and after S1.3 when that check has passed on the build under test.

## 5. Test procedure

Each scenario in `scenarios.json` names a fixture, setup steps, required host tools, user settings, extensions to disable, and a list of checks. Lines are 0-based. A `token` places the cursor inside the first occurrence of that text on the line, so fixtures can change without anyone recomputing columns.

| Check type | What the probe does (vscode API) | Observable result |
|---|---|---|
| `activate` | `extensions.getExtension(id).activate()` with a timeout | The extension is active; its version is recorded |
| `diagnostics` | Opens the file and polls `languages.getDiagnostics(uri)`, filtering on line, severity, source, code and message | A squiggle and a Problems entry on the expected line |
| `hover` | `vscode.executeHoverProvider` at the token | The hover text contains the expected signature or description |
| `definition` | `vscode.executeDefinitionProvider` at the token | The target file and line match one of `expectAnyOf` |
| `format` | `editor.action.formatDocument` (respects `editor.defaultFormatter`), then compares with a golden file and reverts | The document equals the golden file byte for byte (CRLF normalized) |
| `breakpoint` | Adds a `SourceBreakpoint`, `debug.startDebugging(folder, name)`, watches DAP `stopped` events via a tracker, then reads the `stackTrace` top frame | The debugger stops at the expected file and line |
| `theme` | Sets `workbench.colorTheme`, then polls `window.activeColorTheme.kind` | The kind changes to the theme's kind. `HighContrastLight` is used so that a fallback to a default theme cannot pass. |
| `commandsRegistered` / `command` | `commands.getCommands(true)` / `executeCommand` | The commands exist and run without error |
| `gitRepositories` | Built-in Git API `getAPI(1).repositories` | The fixture repository is detected |
| `openNotebook` | `workspace.openNotebookDocument` + `showNotebookDocument` | The notebook opens with the expected type |

Fixtures (`test/extension-matrix/fixtures/`):

| Fixture | Contents | Setup | Validated here |
|---|---|---|---|
| `typescript` | `src/main.ts` (TS2322 on line 4), `src/math.ts`, `debug.js` + `launch.json` (node) | — | positions checked by script |
| `python` | `app.py` (type error on line 4), `helpers.py`, `debug_me.py`, `pyproject.toml` (basedpyright `standard`), `launch.json` (debugpy) | — | `ast.parse` |
| `rust` | `src/main.rs`, `examples/broken.rs` (E0308; `cargo check --all-targets` reports it, while `cargo build --bin` stays clean), `launch.json` (lldb with cargo); an empty `[workspace]` table keeps it its own Cargo root when copied inside another tree | — | `cargo build`, `cargo check`, `rustfmt --check` |
| `go` | `main.go`, `add.go`, `broken.go` (type error), `fmtcheck/format_me.go` + `testdata/format_me.golden` | — | `gofmt` produced the golden file; `go vet` shows the expected error |
| `cpp` | `main.cpp` (pointer init error on line 5), `math.hpp`, `math.cpp`, `compile_flags.txt` | — | `clang++ -fsyntax-only` shows the expected error |
| `web-tooling` | ESLint flat config, `src/lint-me.js`, `src/format-me.js` + `format-me.expected.txt`, pinned `package.json` + `package-lock.json`, `.prettierrc.json` with every option pinned, and a `root = true` `.editorconfig` | `npm-install` (S09, S10; `npm ci --ignore-scripts`) | The Prettier 3.9.10 (lockfile) and 3.7.4 (bundled in the extension) CLIs both produce exactly `format-me.expected.txt`, also under a parent `.editorconfig` that sets tabs and CRLF. The ESLint 9.39.5 CLI reports exactly `no-unused-vars` and `prefer-const` on line 1 of `lint-me.js` and nothing else. |
| `yaml` | `schema.json`, `service.yaml` with a `$schema` modeline and a type error | — | JSON validity |
| `git` | Two files | `git-init`: two commits with a fixed author and fixed dates | `run.sh` setup exercised |
| `jupyter`, `java` | Minimal notebook; two-class Java project without a build file | — | JSON validity |

Each scenario's `observe` list says what a person should see when running it by hand. That covers what the probe cannot check, such as rendering, webviews and status bar items.

## 6. Running it (once a build exists)

```bash
# 1. Fetch and verify the pinned VSIXs for this machine (no build needed).
test/extension-matrix/fetch.sh                      # core tier, host platform
test/extension-matrix/fetch.sh --platform all --tier all

# 2. Install into an isolated extensions dir and verify the installed set.
AXIS_CLI=<axis-build>/bin/axis test/extension-matrix/install.sh                 # core
AXIS_CLI=<axis-build>/bin/axis test/extension-matrix/install.sh --tier optional # core + optional

# 3. Run scenarios (desktop). AXIS_APP is the Electron binary of a packaged build.
AXIS_APP=<electron-binary> test/extension-matrix/run.sh --proposed-api-scan 60 --all --activation-scan 60
AXIS_APP=<electron-binary> test/extension-matrix/run.sh --all --tier optional    # uses extensions-<platform>-optional
AXIS_APP=<electron-binary> test/extension-matrix/run.sh --scenario S06-codelldb-rust
```

Each run writes `.work/runs/<timestamp>-<pid>/` containing `summary.tsv` with one row per scenario. The row gives the probe status (`passed`, `failed`, `blocked`, `timeout` or `error`) and, with `--activation-scan`, the scan status. With `--proposed-api-scan` there is also a `proposed-api-scan` row. Each scenario directory holds `result.json` (rewritten after every check, so a timeout leaves partial evidence), the workspace copy, isolated user data, logs and `scan/`.

The probe-only path also accepts a dev launcher such as `scripts/code.sh`, because test hosts allow proposed API anyway. The scans do not (§7.2).

## 7. Automation approach

### 7.1 Layer A — probe in an extension test host (implemented, pending build)

Code OSS runs a test module inside the extension host when launched with `--extensionDevelopmentPath` and `--extensionTestsPath` (`argv.ts:167,169`):

- The host loads the module and calls `run()`. A rejected promise or a callback failure maps to exit code 1 (`src/vs/workbench/api/common/extHostExtensionService.ts:732-790`).
- The workbench forwards that code to the process exit when the run came from the CLI (`src/vs/workbench/services/extensions/common/abstractExtensionService.ts:585-612`, `src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts:474-486`).
- Upstream uses exactly this for its API and built-in extension tests (`scripts/test-integration.sh:269-321`).

Installed extensions in `--extensions-dir` stay enabled in a test host unless `--disable-extensions` is passed. `--disable-extension <id>` disables a single one (`src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts:522-530`). The probe therefore exercises the real pinned extensions.

`run.sh` passes the same isolation flags as upstream's runners: `--user-data-dir`, `--extensions-dir`, `--logsPath`, `--skip-welcome`, `--skip-release-notes`, `--disable-telemetry`, `--disable-updates`, `--disable-workspace-trust`, `--disable-experiments` and `--no-cached-data` (compare `test/automation/src/electron.ts:25-36`).

The probe is plain CommonJS with no dependencies, so it needs no build step. Its pure logic lives in `probe/logic.js`, which does not import `vscode`, so it can be unit-tested with plain Node. `run()` validates the scenario file before running any check.

### 7.2 Layer B — normal-window scans (implemented, pending build)

This layer covers what Layer A cannot see: proposed-API stripping (§4.1) and activation failures in a normal window. `scan-report.js` reads every `*.log` file the window wrote and recognizes four messages:

- `Extension '<id> CANNOT USE these API proposals '...'` (`extensionsProposedApi.ts:112`);
- `Activating extension <id> failed due to an error` (`src/vs/workbench/api/common/extHostExtensionActivator.ts:450`);
- `Cannot activate the '<name>' extension because ...`, for a missing or failed dependency (`:313`, `:404`). These name the extension by display name; `scan-report.js` maps names to ids through the installed `package.json` files, including `package.nls.json` placeholders.

**Packaged builds only.** A development build allows every proposed API (§4.1). `run.sh` therefore refuses `--activation-scan` and `--proposed-api-scan` when `VSCODE_DEV` is set or `AXIS_APP` is a `scripts/code*` launcher.

**Positive control.** Restriction is applied while extensions are registered, before enablement filtering: `checkEnabledAndProposedAPI` calls `updateEnabledApiProposals` and then `filterEnabledExtensions` (`src/vs/workbench/services/extensions/common/abstractExtensionService.ts:1441-1446`). So every installed extension that declares `enabledApiProposals` must log a `CANNOT USE` line in every scan, even when the scenario disables it. `ms-python.python` is in every core install. If any such extension is missing from the logs, the scan reports `inconclusive`: the window may not restrict proposed API (a dev build, `--enable-proposed-api`, a product allowlist), or its logs are incomplete. Once Axis adopts an allowlist (D1), the control must exclude the allowlisted extensions.

**Attribution.** Because of the same ordering, Python's `CANNOT USE` lines appear in every scenario's scan. A scenario's scan status therefore counts only findings that name one of that scenario's `extensions` (case-insensitive):

- `clean`: the control passed, and nothing names the scenario's extensions;
- `findings`: the control passed, and at least one line names them;
- `inconclusive`: the control failed;
- `no-logs`: the window wrote no logs;
- `error`: the logs or manifests could not be read.

The full extract is kept as `scan/activation-scan-full.txt`, with the parsed report in `scan/activation-scan.json`. Findings that name no installed extension are listed as `unattributed` and do not change the status. The per-extension proposed-API table for D1 (§2.1) comes from `run.sh --proposed-api-scan <s>`: one normal window with the full installed set and an empty workspace. It writes `proposed-api.tsv` and has the status `complete` or `inconclusive`.

**What the scan exercises.** The window opens the scenario workspace plus every file its checks use, with the scenario's `--disable-extension` arguments. That covers the activation events `*`, `onStartupFinished`, `workspaceContains:*` and `onLanguage:*` for the opened files. It does not cover `onDebug*`, `onCommand:*`, `onView:*`, `onUri` or `onWebviewPanel:*`. An extension that activates only through those events is still checked for stripping by the positive control, but its activation errors cannot appear. In the core set, every extension with code declares at least one exercised event (debugpy, for example, declares `onLanguage:python`). The GitHub theme has no code and needs no activation.

**Limits.** The window is closed after `<s>` seconds by signalling the `AXIS_APP` process. Use the Electron binary, not a wrapper script, so that the timeout reaches the app.

### 7.3 Layer C — UI smoke through `test/automation` (pending)

For results that need the rendered UI, such as theme colours, the GitLens views, blame decorations and the Variables view, the upstream automation driver applies:

- `--enable-smoke-test-driver` (`argv.ts:183`) registers a window driver (`src/vs/workbench/electron-browser/window.ts:710-711`, `src/vs/workbench/browser/window.ts:343-344`). The driver exposes element queries, editor typing, terminal access and log retrieval (`src/vs/workbench/services/driver/common/driver.ts:35-48`).
- `test/automation` launches Electron through Playwright `_electron.launch` with that flag (`test/automation/src/playwrightElectron.ts:21-59`). For the web it starts the server with `--enable-smoke-test-driver` and opens a Playwright browser (`test/automation/src/playwrightBrowser.ts:33-98`).
- The package already has helpers that map to the observations in §5. These include the Problems selectors for squiggles and the markers panel (`test/automation/src/problems.ts:35-41`), debug helpers such as `setBreakpointOnLine`, `startDebugging` and `waitForStackFrame` (`test/automation/src/debug.ts:70-117`), and quick access and SCM helpers. Upstream's own language smoke test follows the same pattern (`test/smoke/src/areas/languages/languages.test.ts`).
- Upstream's gallery-install smoke test is skipped (`test/smoke/src/areas/extensions/extensions.test.ts:19`). Axis should install from pinned VSIXs (§7.5) rather than from a gallery.

The plan is to build `test/automation` from the Axis tree (an M2 output) and add an Axis smoke suite that reuses the fixtures and `observe` expectations. This needs the built tree, Playwright and Node, so nothing was written for it yet.

### 7.4 Web (reh-web) runner (designed; executed in M6)

The browser path supports the same test protocol:

- The page payload can carry `extensionDevelopmentPath` and `extensionTestsPath` (`test/integration/browser/src/index.ts:132-139`).
- The workbench reports the exit code to a Playwright-exposed `codeAutomationExit` (`src/vs/workbench/services/extensions/browser/extensionService.ts:211-219`).
- With `--enable-smoke-test-driver`, the server disables the web-worker iframe wrapper that would otherwise need a CDN (`src/vs/server/node/webClientServer.ts:366-369`).

Because the upstream runner forces proposed API on and uses a throwaway server data dir (§4.11), Axis needs its own runner. It will:

1. Install the pins with the server CLI. `install.sh --server` supports `--install-extension` and `--list-extensions` (`src/vs/server/node/remoteExtensionHostAgentCli.ts:152-159`), with `--extensions-dir` honoured (`src/vs/server/node/server.main.ts:40-51`).
2. Start the Axis server with `--server-data-dir`, `--extensions-dir`, `--enable-smoke-test-driver`, `--accept-server-license-terms` and `--disable-workspace-trust`, and **without** `--enable-proposed-api`.
3. Open the workbench URL in Playwright with a payload that has `extensionDevelopmentPath` and `extensionTestsPath` pointing at the probe as `vscode-remote` URIs, and **no** `enableProposedApi`.
4. Record `codeAutomationExit` and read `result.json`. It is written by the probe on the server side, because `AXIS_MATRIX_*` is set in the server's environment.

This is a Node script with a Playwright dependency. Per decision D6 it is built and run in M6, against the Axis reh-web build on Linux x64, so the repository does not take on a Playwright dependency before there is a consumer. The probe, scenarios, fixtures and `install.sh --server` are shared with the desktop path unchanged.

### 7.5 Installation path

The desktop CLI installs VSIX paths through `--install-extension` (`argv.ts:130`, `cliProcessMain.ts:322-325`, `src/vs/platform/extensionManagement/common/extensionManagementCLI.ts:263-274`). Gallery availability depends only on `product.json` `extensionsGallery.serviceUrl` (`src/vs/platform/extensionManagement/common/extensionGalleryManifestService.ts:31-33`); without it, dependencies and pack members are never resolved (`abstractExtensionManagementService.ts:653-655`). An Axis build pointed at Open VSX would resolve them, which is why `install.sh` disables that resolution explicitly (§4.9).

## 8. Verification performed for this milestone

| Check | Result |
|---|---|
| Open VSX metadata and manifests fetched for all 15 extensions and for Pylance and cpptools | done; Pylance and cpptools: "Extension not found" |
| VSIX download and local sha256 against the Open VSX `.sha256` file (24 Open VSX files: one per universal extension, four per platform-specific one) | passed (all match) |
| CodeLLDB GitHub platform VSIXs (4) against the GitHub release asset `digest` | passed (all match) |
| `fetch.sh` (core tier, host platform; and optional tier, all platforms) | passed |
| `fetch.sh` with a tampered manifest hash, a corrupted cached file, a bad platform, a missing option value | each exits 1 or re-downloads as designed; no partial file left behind |
| `install.sh` against a stub CLI (exact set; extra extension present) | passes and fails respectively |
| `run.sh` against a stub app (pass, fail, timeout, blocked tool, setup failure, unknown scenario, web mode) | statuses recorded as designed |
| `run.sh` scans against a stand-in app that writes log files (`tests/run-sh.test.js`): dev-build refusal, attribution, the inconclusive control, the opened fixture files, the full-set table, an unsafe `fixture`, and tier coverage | passed |
| `scan-report.js` unit and CLI tests (`tests/scan-report.test.js`): message parsing, display-name mapping, attribution, partial and absent controls, `no-logs`, `error` exit 2 | passed |
| Mutation check: disabling the `VSCODE_DEV` guard and the control in a scratch copy | 5 tests fail as expected |
| `shellcheck -x` on `lib.sh`, `fetch.sh`, `install.sh`, `run.sh` (ShellCheck 0.11.0, bash 3.2 compatible) | passed |
| `node --check` on `probe/runner.js` and `probe/logic.js` (Node 25.9.0) | passed |
| `node --test 'test/extension-matrix/tests/*.test.js'` (43 tests) | passed |
| Web-tooling lockfile from `npm install --package-lock-only --ignore-scripts`; `npm ci --ignore-scripts` from it, both in a scratch copy and through `run.sh` setup | passed |
| Prettier 3.9.10 and 3.7.4 and ESLint 9.39.5 CLIs on the fixture, also under a parent `.editorconfig` with tabs and CRLF | Prettier output matches the golden file for both versions; exactly the 2 expected ESLint errors. Without the pins, the parent `.editorconfig` changes the output (control). |
| Probe against real extensions | **not run** (needs an Axis build) |
| Any scenario against Code OSS or Axis | **not run** |

## 9. How M3/M6 execute the matrix

1. **Prerequisites.**
   - An Axis desktop build from M2. For web, a reh-web build.
   - Gating runners (decision D6): **macOS x64** (local) and **Linux x64** (Docker/CI, M8). Windows x64 is best-effort in M8 and does not gate Phase 0. macOS arm64 is pinned but not gating.
   - The host tools listed in each scenario's `requires`: node/npm, python3, cargo, go + gopls, clangd, git. Pin and record their versions.
2. **Desktop pass (M3), per gating platform.**
   - Run `fetch.sh`, then `install.sh`, then `run.sh --proposed-api-scan 60 --all --activation-scan 60`, with `AXIS_APP` set to the packaged Electron binary.
   - Both scans are required: they are how D1 is measured. Fill §2.1 from `proposed-api.tsv`, and only when the `proposed-api-scan` status is `complete`. Record what degraded in each affected scenario.
   - CodeLLDB is tested from the pre-installed GitHub platform VSIX (D2). Confirm no download happened.
   - Record Python twice (D3): S02 (Jedi default) and S03 (basedpyright, `python.languageServer: None`). S04 (debugpy) runs under the default configuration.
   - Then run each scenario's `observe` items by hand until Layer C exists, and record screenshots for theme and GitLens.
   - Optional tier (D5): if time allows, run `install.sh --tier optional` (it installs the optional extensions plus the core set, which S14 needs) and `run.sh --all --tier optional`. The results are recorded but do not gate Phase 0.
3. **When to run (M3, `docs/design/axis-shell-stage2-plan.md` §6).**
   - Run the desktop pass on the S1.7 packaged builds (stage 1 checkpoint) as the baseline. Then rerun it after S1.3 (decision 6 removal, with the SC-3 artifact check passing) and on the S2.9 Axis-shell builds.
   - A failure that first appears after S1.3 or S2.x is caused by an Axis change, for criterion 6.
   - S1.1 replaces `product.json` `defaultChatAgent` with an inert stub (design §2.5). Two extension-management paths read it unguarded: the extensions control manifest (`getExtensionsControlManifest`, `extensionGalleryService.ts:2047`) and pack uninstall (`getAllPackExtensionsToUninstall`, `abstractExtensionManagementService.ts:995`). `install.sh`'s VSIX installs may not reach either path. After S1.1, also run one gallery install against the configured registry and uninstall `ms-python.python` (a pack) through the CLI.
   - **Result (Stage 1b, 2026-11-02, development build, macOS x64, gallery Open VSX, `defaultChatAgent` stub): passed.** `--install-extension ms-python.python` resolved and installed `ms-python.python` 2026.4.0, `ms-python.debugpy` 2026.6.0 and `ms-python.vscode-python-envs` 1.40.0 from Open VSX (exit 0). `--uninstall-extension ms-python.python` took the pack path and removed all three (exit 0; `extensions.json` empty, all three marked obsolete). No error from either unguarded reader. With the stub, the control manifest adds a `deprecated['']` entry (an empty extension id), which matches no extension.
   - **Finding for step 4 (EXT-3):** the same CLI log shows `Could not load vsce-sign module` and `Extension signature verification is not done` for every gallery install. `@vscode/vsce-sign` is not a Code OSS dependency (Microsoft builds add it), so verification never produces a result. What happens next depends on the build:
     - **Development builds** (`scripts/code.sh`, `isBuilt` false) install Open VSX extensions **without signature verification**, as above.
     - **Packaged builds** (`isBuilt` true) **fail closed**: every gallery install fails with "Signature verification was not executed" (`src/vs/platform/extensionManagement/node/extensionManagementService.ts:348-363`, at Code OSS `1.144.0`). The check throws when there is no verification result, unless `extensions.verifySignature` is `false`. On the packaged macOS x64 build (2026-11-02), installing `ms-python.python` from Open VSX failed this way. With `extensions.verifySignature: false` in a throwaway profile, the same install and the pack uninstall passed.
     - A packaged Axis therefore cannot install from the gallery until verification is provided or the default is changed. The signature test must record this; the choice is the owner's (`docs/design/axis-shell-stage1-built.md` §2.9).
   - Check that the S1.7 build target matches the gating platform (D6: macOS x64). The design's example command builds `vscode-darwin-arm64-min`.
4. **Signature test (M3, D4).** Install a signed, an unsigned and a tampered extension on the Axis build, as specified by threat EXT-3, and record the outcomes next to the matrix. The pins provide the inputs:
   - signed: any pinned Open VSX extension, each of which has an Open VSX `.sigzip` (`files.signature` in the API), installed through the gallery;
   - unsigned: a CodeLLDB GitHub platform VSIX, which has no Open VSX signature;
   - tampered: a copy of a pinned VSIX with one byte changed, kept outside `.vsix-cache/` (because `fetch.sh` deletes files whose hash does not match).
   - Record whether a VSIX installed from a file is verified at all. That path was not checked here.
5. **Web pass (M6).** Build and run the reh-web runner from §7.4 on Linux x64, then do a manual browser session covering the same `observe` items.
6. **Recording.**
   - Copy each `summary.tsv` row into the matrix in §2, replacing `not run` with `passed`, `failed`, `blocked` or `timeout`, plus the build commit, platform and date.
   - A scenario's scan status covers only its own `extensions` (§7.2). Never mark a scenario `passed` when its scan status is `findings`; record it as `passed (probe) / findings (activation)` and link `scan/activation-scan.json`.
   - `inconclusive`, `no-logs` or `error` means the scan measured nothing. Record that status, fix the setup (packaged build, logs path), and rerun before recording `clean`.
   - Record proposed-API stripping only in §2.1, never per scenario.
   - File each failure with the scenario's `result.json` and logs.
7. **Exit criteria for Phase 0 (ADR 0002 criterion 6).**
   - All 12 core extensions plus the built-in baseline have a recorded desktop result on macOS x64 and Linux x64, and a recorded web result from M6.
   - Every failure is recorded, and either fixed or listed as a documented exception, as `DEVELOPMENT.md` §10 requires.
   - Each failure is classified as caused by an Axis change (shell layer, guardrail or hardening patches, rebrand) or not. Under criterion 6, failures caused by Axis changes must be fixable within the ADR 0002 patch budget. Record the estimated fix size against that budget.
8. **Upstream syncs (ADR 0002).** Re-run the matrix on each upstream sync. Re-pin extensions on a fixed cadence: refresh `extensions.json` from the API, re-hash, re-run the unit tests, and review the license and provenance diffs.

## 10. Decisions

Recorded on 2026-11-01.

| ID | Decision | Effect on the plan | Follow-up |
|---|---|---|---|
| D1 | **Proposed-API allowlist: measure first.** No `extensionEnabledApiProposals` allowlist by default. | M3 runs the matrix without an allowlist. `--proposed-api-scan` fills §2.1, and the per-scenario activation scans record which scenarios degrade (§7.2, §9 step 2). Both need a packaged build and a passing positive control. | A later ADR decides allowlist entries per extension, with justification. |
| D2 | **CodeLLDB: pre-install the pinned platform VSIX for Phase 0 tests.** | `install.sh` installs the hash-verified GitHub platform package for the host platform (§4.3). | The product default is deferred. The runtime download pulls native code from GitHub at activation; that supply-chain note is tracked against threat EXT-3. |
| D3 | **Python: no Axis default yet.** | The matrix runs and records both configurations: S02 (Jedi, default) and S03 (basedpyright with `python.languageServer: None`). | The default is chosen after the results. |
| D4 | **Signatures and service-account uploads: test in M3.** | Phase 0 dev builds may install unsigned extensions. M3 runs the threat EXT-3 test (the suspected `vsce-sign` inversion). The matrix records the publisher type (vendor or open-vsx service account; §2, `extensions.json`). | The signature and publisher policy is set after the M3 results. |
| D5 | **Jupyter and Java stay optional.** | They run if time allows (`--tier optional`); results are recorded but are not part of the Phase 0 gate. | — |
| D6 | **Platforms.** Phase 0 gates on macOS x64 (local) and Linux x64 (Docker/CI, M8). Windows is best-effort in M8. | §9 lists the gating runners. The web runner is designed here (§7.4) and built and executed in M6. | M8 sets up the Linux x64 (and best-effort Windows) runners. |

## Sources

- Open VSX REST API, `https://open-vsx.org/api/...`: extension, version, target-platform and `-/query` endpoints, plus each VSIX's `.sha256` file (accessed 2026-11-01).
- GitHub REST API, `repos/vadimcn/codelldb/releases/tags/v1.12.3` (asset digests, accessed 2026-11-01).
- Pinned VSIX manifests (`extension/package.json`, `extension.vsixmanifest`, license files), read as data from the downloaded files.
- Code OSS 1.144.0 source, read-only clone at commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` (paths cited inline).
- `docs/feasibility/licensing-and-marketplace.md`, `docs/feasibility/code-oss-inventory.md`, `docs/adr/0002-code-oss-integration-strategy.md` (validation criterion 6) and `docs/security/threat-model-phase0.md` (§5.2: EXT-1, EXT-2, EXT-3, EXT-5) and `docs/design/axis-shell.md` (S1.3 and the SC-3 checks, S1.7, S2.9).
