# Prototype B: `@codingame/monaco-vscode-api` (Phase 0 M4)

- Date: 2026-11-01 to 2026-11-02 (local time, UTC-5). Time-boxed to about 3 hours of work.
- Question (ADR 0002, revisit trigger 3): can option B meet the ADR 0002 feature checklist with **materially lower maintenance cost** than option A?
- Library: `@codingame/monaco-vscode-api` **38.1.3** (2026-10-29), built on VS Code **1.142.0**, commit `d956e8a6ac5d904486557eea07e1d6bd62a4d36f`, client product quality `stable`. Option A's baseline is Code OSS 1.144.0 (`code-oss-build.md`).
- Code: `prototypes/monaco-vscode-api/` (self-contained, not wired into anything else).
- Status words: **works**, **partial**, **not possible** (without a Code OSS server), **not tested**. Every number below was measured on this machine; nothing is estimated unless it says "estimate". Screenshots are kept outside the repository.

**Answer in one paragraph.** In a browser, B delivers the editor-centric part of the checklist (editor, explorer, TypeScript diagnostics, search, command palette, web extensions from Open VSX, themes) inside a React shell that owns the whole layout, for about 700 lines of Axis code and no Axis-owned upstream patches. The same build runs in Electron. Everything that needs Node (Node extension host, real terminal, debugger, Git, the M5 extension matrix) requires a Code OSS `reh` server built at the commit monaco-vscode-api pins. So B on desktop still needs the M2 Code OSS build pipeline and Axis's server-side patches, now on a pin chosen by a third party, plus a 578-file upstream patch series that has one core maintainer. B does not lower the maintenance cost materially for the full checklist, and **no ADR 0002 revisit trigger is met**. Recommendation: keep option A, and record B as the fallback for a server-less web target or an embedded editor (§8).

---

## 1. What was built

| Piece | Files | Notes |
|---|---|---|
| React 19 shell | `src/App.tsx`, `src/PartHost.tsx`, `src/styles.css`, `src/main.tsx` | React owns the DOM grid: a custom top bar (brand, workspace name, search box, buttons), and boxes for activity bar, sidebar, editor, panel, auxiliary bar and status bar. `PartHost` calls `attachPart(part, element)` in `useLayoutEffect` and follows `onPartVisibilityChange`. Runs under `StrictMode`, so every part goes through attach, dispose and attach again on mount. |
| React view inside a VS Code part | `src/AgentView.tsx` | `registerCustomView` in the auxiliary bar; renders a React root that subscribes to `vscode.languages.onDidChangeDiagnostics`. This is the reverse direction: React leaf UI hosted by a VS Code part. |
| Service setup | `src/vscode/setup.ts` | `initialize()` once, before React renders, with 28 service overrides (views, files, configuration, keybindings, quick access, search, explorer, extensions with the web-worker host, extension gallery, textmate, theme, languages, model, markers, terminal, status bar, storage, lifecycle, log, notifications, dialogs, preferences, environment, output, remote agent, working copy, debug, SCM) and 8 built-in extensions (TypeScript language features, TypeScript/JavaScript/JSON/Markdown grammars, default and Seti themes, search result). The gallery points at Open VSX. |
| Workspace | `src/vscode/workspace.ts` | Browser: an in-memory TypeScript project at `file:///workspace`. Electron: a `file://` overlay provider backed by Node `fs` in the main process, limited to one folder. |
| Terminal | `src/vscode/terminal.ts` | Browser: an echo backend (no shell exists without a server). Electron: `/bin/sh` over pipes in the main process; not a pty. |
| Electron host | `electron/main.cjs`, `electron/preload.cjs` | Electron 45.2.1, `contextIsolation`, `sandbox`, no `nodeIntegration`. The production build is served from a privileged `axis://` scheme with cross-origin-isolation headers. The IPC surface checks the sending `webContents` (not the frame) and lexically confines paths to the opened folder (`..` and absolute paths are rejected; symlinks are followed). Top-level navigation and new windows are blocked. **Prototype-grade security; not for reuse, see §6 findings 9–14.** |
| Test tooling | `scripts/cdp.mjs`, `scripts/smoke.mjs`, `scripts/open.mjs` | A Chrome DevTools Protocol driver with no dependencies (Node's built-in `WebSocket`). `smoke.mjs` walks the checklist (16 steps) in headless Chrome or in Electron and prints one JSON line per step; `open.mjs` takes startup marks. |

Axis-written code: **699 lines** across `src/` (TypeScript, TSX and CSS), plus 584 lines of Electron host and test scripts. The manifest pins every package exactly and `package-lock.json` is committed (145 entries, all from `registry.npmjs.org` with integrity hashes).

**How to run.**

```bash
cd prototypes/monaco-vscode-api
npm ci --ignore-scripts                    # no package needs an install script (see §5)
npm run dev                                # http://127.0.0.1:5174/
npm run build && npm run preview           # production build on http://127.0.0.1:5175/
npm run electron:install                   # downloads the Electron binary (checksum-verified by @electron/get)
npm run electron:dist -- --workspace=<dir> # Electron, production build, real folder
node scripts/smoke.mjs http://127.0.0.1:5175/ <shots-dir>      # checklist in headless Chrome
node scripts/smoke.mjs --electron <workspace-dir> <shots-dir>  # checklist in Electron
```

## 2. Feature checklist

The checklist is ADR 0002 validation criterion 1 (editor, explorer, search, SCM/Git, terminal, debugger, diagnostics, command palette, extension host) plus the M4 brief (folder, TypeScript diagnostics, an Open VSX web extension, a theme) and `docs/design/axis-shell.md` §1 (the shell owns the layout; React for Axis leaf UI). Evidence is the `smoke.mjs` output. "Chrome" means the production build under `vite preview`; the dev server gives the same results. "Electron" means the production build over `axis://`. Final runs: **16 of 16 steps passed** in Chrome production, Chrome dev (38.1.3 and 37.6.1) and Electron production.

| Feature | Browser (no server) | Electron (no server) | With a Code OSS `reh` server | Evidence |
|---|---|---|---|---|
| React shell owns the layout; VS Code parts mounted with `attachPart` | **works** | **works** | not tested | All 6 parts render in React boxes; the top bar is React. `StrictMode` double mount produced no errors. |
| React view inside a VS Code part | **works** | **works** | not tested | The auxiliary-bar view shows `Workspace diagnostics: 4`, equal to the extension API count, and updates live. |
| Editor (edit, dirty state, save) | **works** | **works** | not tested | Typed a line; the editor became dirty; after save, `workspace.fs.readFile` returned the new content. In Electron that read went through the IPC provider to the file on disk. |
| Open a folder / explorer | **works** (in-memory) | **works** (real folder through IPC) | not tested (`vscode-remote://`) | The explorer lists `src`, `index.ts`, `math.ts`, `messy.ts`, `README.md`, `tsconfig.json`. A browser-local folder through the File System Access API is supported by the library (`createHTMLFileSystemProvider`) but **not tested**: it needs a native picker. |
| TypeScript diagnostics (cross-file) | **works** | **works** | not tested | `tsserver.web` in a worker reports `ts2345` and `ts2322` on `index.ts` lines 4–5 (the type comes from `math.ts`). After an edit, the Problems badge reads 3. The extension API reports 4: the fourth is `ts6133`, an "unnecessary" hint the badge does not count, as in VS Code. |
| Problems panel and status bar counts | **works** | **works** | not tested | Badge and status bar show 2, then 3 after the edit. |
| Search (Find in Files) | **works** | **works** | not tested | "Found 5 matches in 3 files" for `add`. |
| Quick open (Cmd+P) | **works** | **works** | not tested | `math.ts` is found. |
| Command palette (F1 keybinding) | **works** | **works** | not tested | A real F1 key event opens it; "toggle panel" lists `View: Toggle Panel Visibility ⌘J`. |
| Built-in themes | **works** | **works** | not tested | Switching to Default Light Modern changes the body classes to `vs …light_modern-json`. |
| Theme from Open VSX (`dracula-theme.theme-dracula` 2.25.1) | **works** | **works** | not tested | Installed 1.1–1.4 s after upstream's "Trust Publisher & Install" prompt (2.4 s in one run at load 42); the Dracula theme then applies. |
| Web extension from Open VSX (`esbenp.prettier-vscode` 12.4.0, `browser` entry) | **works** | **works** | not tested | Prompts: publisher trust, then upstream's "limited functionality … for the Web" notice ("Install Anyway"). Install took 0.8–2.7 s. After 2–3 attempts (3.2–4.0 s from the install command, while Prettier registers its formatter) Format Document produced Prettier output: double quotes, semicolons, line breaks. |
| Web-worker extension host | **works** | **works** | n/a | It runs TypeScript language features and Prettier. Note: `vscode.extensions.all` in the main-thread "local" host does not list worker-host extensions, which matches upstream behaviour. |
| Node extension host (M5 matrix: rust-analyzer, clangd, debugpy, Java, GitLens Node parts …) | **not possible** | **not possible** | not tested | The library bundles only web services. Node extensions need the server's extension host (maintainer, issue #719). |
| Terminal | **not possible** (UI works; echo backend) | **partial**: `/bin/sh` over pipes | not tested (remote pty) | Chrome: the terminal UI echoes input. Electron: `echo hi-$((40+2))` prints `hi-42`, so a real shell evaluated it, but there is no pty: no job control, line editing or full-screen programs. A pty needs `node-pty` (a native build) or the server. **Security (found by code reading, not exercised):** in Electron any installed Open VSX web extension can drive this `/bin/sh` through `createTerminal().sendText` or `workbench.action.terminal.sendSequence`; workspace trust is disabled, and the child inherits the full Electron environment (contrast PTY-2's allow-list). See §6, finding 11. |
| Debugger | **not possible** | **not possible** | not tested | The Run and Debug view renders "All debug extensions are disabled". No debug adapter can run without Node. The library demo uses a separate Docker-based debug server. |
| SCM / Git | **not possible** | **not possible** | not tested | The SCM view renders "No source control providers registered". The built-in Git extension is Node-only. |
| Settings and keybindings editors | not tested | not tested | not tested | Overrides are included; not exercised. |
| Production bundling | **works** (after a fix) | **works** | n/a | See §6, finding 1. |
| Upstream security prompts (publisher trust, web limitation) | **works** | **works** | n/a | Both dialogs appear and block the install until answered. |
| Linux | not tested | not tested | not tested | macOS x86_64 only. |

**Summary.** Works: 15 rows in the browser and Electron (shell, React in both directions, editor, folder, diagnostics, problems, search, quick open, palette, themes, Open VSX theme and web extension, web extension host, bundling, security prompts). Partial: terminal in Electron. Not possible without a server: Node extension host, terminal in the browser, debugger, SCM/Git. Not tested: everything through a `reh` server, settings UI, browser-local folders and Linux.

## 3. Measurements

Machine: the M2 machine (Intel Core i9-9980HK, 8 cores, 16 GB, macOS 15.7.9). Other workloads on the machine ran heavy builds at the same time. The 1-minute load average is recorded next to timings, because it swung between 3 and 87 during this work. Runs taken above load 14 are marked; they were used only for functional results unless stated. Node 25.9.0, npm 11.12.1, Chrome 156.0.8078.74 (headless), Electron 45.2.1.

### 3.1 Install and disk

| Metric | Value | Method |
|---|---|---|
| Install, cold (38.1.3) | **33.3 s**, 102 packages | `npm install --ignore-scripts` with an empty, isolated `--cache`; load 6.8 |
| Install, cold (37.6.1 variant) | 41.6 s, 102 packages | same; load 3.5 |
| Install scripts needed | **none** | No dependency declares `preinstall`/`install`/`postinstall` or a `gypfile`. Electron 45's package has no install script; its binary is fetched by `npm run electron:install` |
| Electron binary download | 36.3 s; 262 MiB unpacked | `node node_modules/electron/install.js`; `@electron/get` checks it against `checksums.json` |
| `node_modules` | **241 MiB** before the Electron binary (`@codingame/*` 125–127 MiB, 44 packages); 576 MiB with the Electron binary and Vite's dependency cache | `du -sh` |
| Typecheck (`tsc` 7.0.2) | 1.2 s | `time npx tsc --noEmit` |
| Production build | **6.3–8.3 s** wall | `time npx vite build`, 3 builds, load 5–13 |

For comparison, option A (M2): `npm ci` 956 s, compile 119 s, tree 7.6 GiB after build.

### 3.2 Bundle size (production build, after the worker fix)

| | Raw | gzip -6 |
|---|---|---|
| All 135 files | 55.5 MiB | 13.9 MiB |
| Without `.map` files | **37.9 MiB** | **10.0 MiB** |
| JavaScript only | 27.4 MiB | 7.9 MiB |

Largest items in the first build, before the fix: `tsserver.web.js` source map 14.1 MiB (shipped by the TypeScript extension package), the extension API chunk 7.5 MiB, `tsserver.web.js` 5.8 MiB, the setup chunk 4.0 MiB, and the `lib.dom.d.ts` text 2.2 MiB. Vite's own source maps are off; the maps come from library packages and could be excluded.

### 3.3 Startup

Marks are `performance.now()` from navigation start (browser) or process start (Electron, `process.hrtime` at the top of `main.cjs`). "Shell mounted" means services initialized and all parts attached. "Diagnostics" means the TypeScript errors are visible.

| Scenario | Shell mounted | Diagnostics | n | Load |
|---|---|---|---|---|
| Chrome, production build, fresh profile | **2.7, 3.0, 2.7 s** (wall from `Page.navigate`: 2,760 / 3,123 / 2,796 ms) | 5.5 s after navigation (one smoke run, load 5.7) | 3 | 6.0–6.1 |
| Electron, production build, fresh profile, from process start | **2.6, 2.8, 3.1 s** | **4.1, 4.2, 4.7 s** | 3 | 7.7 / 22.6 / 20.0 (**2 of 3 runs above load 14**) |
| Vite dev server start | 425 ms (Vite's "ready"); 1,662 ms from invoking `npx vite` | — | 1 | 11.6 |
| Dev, first page load with an empty dependency cache (pre-bundling) | 7.6 s (load 4.4); 16.8 s (load 11.6 rising to 29.9) | not measured | 2 | see column |
| Dev, warm reload | 3.7–4.1 s | 8.4 and 9.2 s after navigation (2 smoke runs) | 4 | 3.9–30 |

M2 baseline (option A, dev build): `ellapsed` (`didStartMain` to `didStartWorkbench`) 9.7–10.0 s warm, 12.8 s on the first launch. **The numbers are not equivalent:** M2 is an unbundled dev build that also starts the shared process, a Node extension host and two `tsserver` processes, while B's Electron build is bundled and starts no Node processes. Use them only as an order of magnitude.

### 3.4 Memory

| Scenario | Value | Method |
|---|---|---|
| Chrome, production, after startup / after the checklist | JS **198 / 216 MiB** | `performance.measureUserAgentSpecificMemory()` (page, iframes and workers; needs cross-origin isolation, which the prototype enables) |
| Chrome, dev server, after startup / after the checklist | JS 534–544 / 548–565 MiB | same; the dev server serves unbundled modules |
| Chrome process tree (headless) | 499–1,697 MiB across working runs | summed RSS of the launched Chrome and its descendants. **Unstable**: dev runs of the same build gave 499, 584 and 1,697 MiB, so it is not used for comparison |
| **Electron, production, 30 s after diagnostics** | **427, 567, 783 MiB** summed RSS (renderer 259–531 MiB, main 92–132, GPU 56–85, utility 19–34, the `sh` child ≤ 1) | summed `ps` RSS over the main process and descendants, the M2 method; 3 runs, the same runs as the Electron startup row in §3.3, so **2 of 3 were above load 14** |
| Electron JS heap | not available | `measureUserAgentSpecificMemory` is not exposed in Electron 45 |

M2 baseline (option A): 2,778 MiB summed over 11 processes, including the Node extension host, two `tsserver`s and the shared process. B has no Node processes, so the difference mostly reflects missing capability, not efficiency. A B desktop build with a `reh` server would add a Node server, a Node extension host and `tsserver` processes (not measured).

### 3.5 Upgrade experiment (previous major)

| Step | 37.6.1 (VS Code 1.138.0) | 38.1.3 (VS Code 1.142.0) |
|---|---|---|
| Prototype source changes needed | **0 lines** | baseline |
| `tsc --noEmit` | 0 errors, 3.9 s | 0 errors, 1.2 s |
| `vite build` | 14.2 s | 6.3–8.3 s |
| `smoke.mjs` in Chrome (dev) | **16 of 16** | 16 of 16 |
| Visible differences | View titles in upper case; no `modern-ui` body classes | `modern-ui*` classes (upstream 1.142 UI refresh) |

Total cost of the swap: changing 39 version strings, a 42 s install, a 4 s typecheck, a 14 s build and a 2.5-minute smoke run.

## 4. The Electron path

### 4.1 What works without a server (tested)

The unmodified web build runs in Electron 45 (§2). Node capabilities can be added piecemeal through Axis-owned IPC: the prototype adds a real-folder file system and a pipe-backed shell in about 310 lines, including the measurement hooks (`electron/main.cjs`, `preload.cjs`, `NodeBridgeFileSystemProvider`, `NodeTerminalBackend`). This only scales to features Axis implements itself. Extensions that call Node APIs (`child_process`, native binaries, language servers, debug adapters, Git) need a Node extension host, which the library does not provide: "monaco-vscode-api only bundles the web services of VSCode" (maintainer, issue #719). Issue #810 ("release electron app") is closed (2026-06-18); per `integration-alternatives.md` §B the maintainer wrote there that native services are "not really planned yet". The v37.0.0 and v38.0.0 release notes mention no Electron or native support.

### 4.2 What a full desktop build needs (documented, not built)

From the library's `docs/vscode_server.md` and source, at 38.1.3:

1. **Server commit.** `package.json` `config.vscode.commit` = `d956e8a6ac5d904486557eea07e1d6bd62a4d36f` (tag `1.142.0`). Client and server must match on commit **and** quality: every server URL is prefixed `<quality>-<commit>`, and the client's built-in product is `quality: 'stable'` with that commit. Either set `quality: stable` in the server's `product.json`, or override `productConfiguration.quality`/`commit` in `initialize()`. The library docs suggest downloading Microsoft's server build or a VSCodium `reh` release. Axis must build its own from Code OSS (Microsoft's server is under the Microsoft product licence; `licensing-and-marketplace.md`).
2. **Build target.** Reuse the M2 mechanism with `code-oss/upstream.json` re-pinned to `1.142.0`/`d956e8a…` instead of `1.144.0`. Then run the gulp task `vscode-reh-<platform>-<arch>-min` (for example `vscode-reh-darwin-x64-min`, `vscode-reh-linux-x64-min`), defined at `build/gulpfile.reh.ts:562` for that commit, with targets darwin/linux/win32/alpine × x64/arm64. Expected cost is at least M2's `npm ci` (956 s) plus compile; the `reh` packaging step was **not built or measured** (out of M4 scope). The Copilot-removal (`1500–1999`) and hardening (`2000–2999`) patch ranges would have to be rebased onto 1.142.0, and again onto each new library major.
3. **Wiring.**
   - Electron main spawns `bin/code-server --host 127.0.0.1 --port 0 --connection-token-file <random file>`. Do not use the doc's `--without-connection-token --host 0.0.0.0`, which the doc itself says is not for production.
   - Main reads the chosen port and passes `remoteAuthority=127.0.0.1:<port>` and the connection token to `initialize()` through the preload.
   - Keep `getRemoteAgentServiceOverride({ scanRemoteExtensions: true })` (already in the prototype).
   - Open the folder as `vscode-remote://127.0.0.1:<port>/<path>`; this replaces the prototype's IPC file system and pipe shell.
   - Terminals, the Node extension host, debug adapters and Git then run on the server. Set the server's `webEndpointUrlTemplate` to the app origin (here `axis://app/`).
   - The prototype accepts `?remoteAuthority=` (`src/vscode/params.ts`) but does not pass a connection token. **Not tested.**
4. **Version lock.** Each library major moves the required server commit (1.138 → 1.142 between v37 and v38). Upgrading B therefore means: bump the client packages, rebuild the server at the new commit, and rebase Axis's server-side patches. All three must ship together, because a mismatched commit or quality refuses the connection.

**Net:** B on desktop = B + an Axis-built Code OSS `reh`. That is option A's build pipeline and server patch ranges, minus Axis's own shell patches (`0001–0999`), plus a pin Axis does not choose.

## 5. Licensing and supply chain

- All `@codingame/*` packages, React, Vite, `@vitejs/plugin-react` and Electron: MIT.
- Non-MIT **runtime** dependencies (`npm ls --omit=dev`): `jschardet` (LGPL-2.1+, encoding detection; upstream VS Code ships it too), `dompurify` (MPL-2.0 OR Apache-2.0) and `lru-cache` (BlueOak-1.0.0, permissive). The other 63 production packages are MIT. LGPL-2.1+ in a bundled web app needs the same notice treatment upstream gives it (ThirdPartyNotices); flag it for the licensing review.
- Non-MIT **dev-only** dependencies: TypeScript 7.0.2 and `detect-libc` (Apache-2.0), `lightningcss` (MPL-2.0), and several ISC/BSD-3-Clause packages.
- Install scripts: none needed (`npm ci --ignore-scripts` is sufficient). Electron's binary is downloaded on demand and checksum-checked.
- Extensions were installed from Open VSX at run time (Dracula 2.25.1, Prettier 12.4.0, both MIT); nothing was vendored.

## 6. Findings and risks

1. **Production bundling trap (found and fixed).** Declaring worker URLs as `new URL('…/extensionHost.worker', import.meta.url)` works on the dev server. In `vite build` it ships the entry as a `data:` module whose relative import cannot resolve. The extension host then dies with "terminated unexpectedly. Code: 81", which silently turns off TypeScript diagnostics and every web extension; the shell still renders. The fix is the library demo's idiom: a stand-in `Worker` class so Vite sees `new Worker(new URL(…))` (commit `32454d3`). The README does not mention it. Axis would need a production smoke test in CI for this class of error.
2. **Global CSS.** `initialize(…, document.body)` adds `monaco-workbench` and theme classes to `<body>`, so VS Code's global styles apply to the whole host page, including Axis's React UI. In the first render the React top bar was laid out about 10,000 px wide until the grid used `minmax(0, 1fr)`. Isolation needs the library's Shadow DOM mode, which is marked beta.
3. **Initialize once, no unload.** `initialize` can run only once and services cannot be unloaded (README). The beta "sandbox mode" in an iframe is the workaround. That constrains hot-swapping workspaces or profiles in one window.
4. **Internal API surface.** Everything beyond `attachPart` (`Parts`, `IWorkbenchLayoutService`, `registerCustomView`, the service identifiers) is VS Code internal API re-exported from `@codingame/monaco-vscode-api/vscode/vs/...`. It is not versioned. The prototype's small surface survived 1.138 → 1.142 unchanged, but a larger Axis surface (custom parts, services) would absorb upstream internal churn every major.
5. **Inherited patch series and bus factor.** The library carries **116 patches touching 578 distinct upstream files (10,169 changed lines: 6,384 added and 3,785 removed, counting `+`/`-` lines inside diff hunks)** at v38.1.3, regenerated each major (v37.6.1 → v38.0.0 rewrote 109 patch files, +1,200/−1,245 lines). It has one dominant maintainer (617 commits against 41 for the next contributor; `integration-alternatives.md` §B). That is 48 times ADR 0002's shell budget of 12 files, and Axis would depend on someone else keeping it rebased.
6. **Upstream lag.** The library is on 1.142.0 while upstream is on 1.144.0 (1,650 commits ahead). Majors arrived 2026-06-16, 07-09, 07-22, 09-17 and 10-19 (gaps of 13–57 days). Axis on B cannot pick its own VS Code version.
7. **Minor library defects seen.** The library's `SimpleTerminalProcess` logs "cwd is not a string undefined" on every terminal creation, in both versions. Harmless here.
8. **Measurement noise.** Other workloads on the machine drove the load average up to 87. Runs above load 14 are marked; process-tree RSS in headless Chrome varied threefold between runs and is not used for comparisons.

**Prototype security shortcuts (not for reuse).** Findings 9–14 describe patterns in the prototype's Electron host that conflict with the Phase 0 threat model (`docs/security/threat-model-phase0.md`) and ADR 0003. They were acceptable for a throwaway prototype and are left in place, but none of them may be copied into Axis. Each one is also Axis-owned work on option B (§7).

9. **Symlink escape from the opened folder (WT-1).** `inWorkspace` (`electron/main.cjs:42-49`) is a lexical check: `path.resolve` plus a prefix comparison. `fs.readFile` and `fs.writeFile` follow symlinks, so a workspace entry `link -> ../outside/secret` reads and overwrites the outside file (reproduced in review with the function copied verbatim; `..` traversal is blocked correctly). A cloned repository is untrusted, so a planted symlink to `~/.zshrc` or `~/.ssh/…` gives anything that can call the fs bridge read and write access outside the folder. Axis must instead resolve `realpath` of the target (or of its parent, for new files) **at the time of use**, compare it against `realpath(workspaceRoot)`, and open with `O_NOFOLLOW`/`openat`-style semantics where available, so that a swap between check and use cannot escape (WT-1; test class PT).
10. **IPC sender check validates `webContents`, not the frame (EL-3, ADR 0003 D1).** `guard` (`main.cjs:57-60`) and the `shell:write`/`shell:kill` listeners (`:95-100`) only check `event.sender === win.webContents`. Every frame in the window shares that `webContents`, and there is no `senderFrame === sender.mainFrame` check and no `senderFrame.url` check. EL-3 and ADR 0003 D1 require all three (known window, expected frame URL, main frame). This matters more because the shell bridge is a raw primitive: spawn `/bin/sh`, then write arbitrary stdin. Any script running in the renderer's main world (for example XSS from extension-supplied strings, EL-1) therefore gets arbitrary command execution as the user. Axis must not expose a generic command-execution capability to the renderer.
11. **The `/bin/sh` terminal is reachable from untrusted extension code (PTY-2); found by code reading, not exercised.** In Electron, `NodeTerminalBackend` is used whenever `window.axisNode` exists (`src/vscode/setup.ts:147`). Any installed Open VSX web extension can call `vscode.window.createTerminal().sendText(…)` or run `workbench.action.terminal.sendSequence`, and either reaches a real `/bin/sh`. Workspace trust is disabled (`setup.ts:96-101`: `enableWorkspaceTrust: false`, `trusted: true`), so nothing gates this, and the child inherits the full `process.env` (`main.cjs:84`), tokens included, against PTY-2's allow-list. Upstream's install prompt tells the user a web extension has "limited functionality … for the Web"; in this host that sandbox does not hold. This matches upstream semantics (extensions are fully trusted in VS Code too), but it is a real difference from the browser build and a decision Axis must make deliberately. No path from workspace files alone was found: no tasks service is registered, and `createProcess` ignores the shell launch config, so `terminal.integrated.*` profiles in `.vscode/settings.json` have no effect.
12. **Electron hardening gaps.** `index.html` and the `axis://` handler set no Content Security Policy. There is no `session.setPermissionRequestHandler`, so Electron's default grants every permission request (media, notifications and so on). Only `will-navigate` and `setWindowOpenHandler` are guarded (`main.cjs:149-152`); `will-frame-navigate` and `will-redirect` are not.
13. **Webviews load from Microsoft's CDN (WEB-4, R12).** The library's built-in `product.json` (`node_modules/@codingame/monaco-vscode-api/vscode/product.json.js`) sets `webviewContentExternalBaseUrlTemplate` to `https://{{uuid}}.vscode-cdn.net/…/pre/`. Any extension webview, README view or markdown preview in B, in the browser and in Electron, is served from Microsoft. The same issue therefore applies to B: Axis would have to host the pinned commit's `pre/` assets on its own origin and override that key.
14. **Smaller prototype shortcuts.** `window.__axisTest` exposes `vscode` and `getService` in the production build, not only under test (`setup.ts:163`). `fs:delete` with `recursive` accepts the workspace root itself (`main.cjs:77`). `--workspace=/` makes every path except `/` fail the prefix check (`main.cjs:45`).

## 7. Maintenance estimate

| Cost item | Option B (measured or inferred) | Option A (ADR 0002 / M2 / M3 design) |
|---|---|---|
| Axis shell code | 699 lines of TS/TSX/CSS; React owns the layout | `src/vs/axis` overlay plus about 10 upstream files / about 45 lines (design estimate, `axis-shell.md` §3.10); React deferred because in-pipeline TSX breaks criterion 2 |
| Axis-owned upstream patches (client) | **0** | shell `0001–0999` ≤ 12 files / 300 lines; plus guardrail and Copilot ranges |
| Client upgrade per sync | **Measured: 0 source lines for 37.6.1 → 38.1.3**; about 3 minutes of install, typecheck, build and smoke. The library demo needed 4 files, +30/−7 lines (v37.6.1 → v38.0.0). Release notes list only "update vscode to 1.x" as breaking. | Rebase of all patch ranges; criterion 4 target ≤ 1 working day (not yet measured; M3) |
| Server for Node features (desktop, `reh-web`) | **Still required**: the M2 pipeline at the library's commit, plus the Copilot-removal and hardening ranges rebased per library major; **not measured** (estimate: of the same order as A's server work, because it is the same tree) | Same tree as the client; one pin |
| Inherited third-party maintenance | 116 patches / 578 files, one core maintainer | none (Axis is the maintainer) |
| Version choice | dictated by library majors (currently 2 minors behind) | Axis chooses (criterion 4 cadence) |
| Electron host security (§6, findings 9–13) | **Axis-owned**: frame-checked IPC, realpath confinement, an env allow-list for shells, CSP, a permission handler, and a self-hosted webview origin; the prototype has none of these | Mostly inherited from upstream; Axis adds the ADR 0003 handshake and the WEB-4 origin |

**Estimate (inferred).** For a **server-less web target**, B is clearly cheaper than A: no Code OSS build, no patches, minutes per upgrade. For the **ADR 0002 target** (Electron desktop plus web, with Node extensions, terminal, debugger and Git), B's client saving is real but A's dominant costs remain: the Code OSS build, the Copilot-removal and hardening ranges, and the server. B also adds a second version lock and a single-maintainer dependency. The expected per-sync cost is therefore about A's server-side cost, plus the client bump, plus coordination of the two pins. That is not materially lower than A.

## 8. Recommendation against ADR 0002's criteria

- **Revisit trigger 3** ("M4 prototypes meet the same checklist with materially lower maintenance cost"): **not met**.
  - B meets criterion 1 only for editor, explorer, search, diagnostics, command palette and the web extension host.
  - Terminal, debugger, SCM/Git and the Node extension host need a server (criteria 1, 6 and 7 untested on B). Making them work brings back A's build and server patch costs (§7).
- **Criteria 2 and 5:** B is strongest here. The shell has zero upstream patches, and React works natively in both directions (React-owned layout, and a React view inside a part) with no pipeline changes.
  - If M3 shows that A's shell exceeds 12 files / 300 lines, or that in-pipeline React is not viable, this result becomes the main argument for a hybrid. That hybrid would be an A-built `reh`/`reh-web` with a B client. It is not adopted now.
- **Decision input:** keep ADR 0002 **option A** as proposed. Record B as:
  1. the preferred approach for any **server-less web surface** (an embedded editor or review UI in the Axis web app), where its costs are minutes per upgrade;
  2. the **fallback shell** if M3 hits the shell-footprint or sync-cost revisit triggers. If that fallback is exercised, first run the one-day spike in §4.2: build `vscode-reh` at `d956e8a…` with the M2 scripts, connect the prototype with a connection token, and run the M5 desktop matrix through it.

## 9. Not done

- No `reh` server was built or connected (out of M4 scope). Everything in the server column of §2 is untested.
- No Linux or Windows run; macOS x86_64 only.
- The settings and keybindings editors, browser-local folders (File System Access API), Shadow DOM mode and sandbox mode were not exercised.
- The M5 extension matrix was not run on B; it requires a server for every entry except the TypeScript baseline, Prettier and the theme.
- No packaging, signing or CSP hardening of the Electron host; no Trusted Types policy was checked. The host's known security shortcuts are listed in §6, findings 9–14.
- The wiki upgrade guide was not read beyond the release notes and `docs/vscode_monaco_upgrade.md`; the upgrade cost is measured on this prototype's surface only.
