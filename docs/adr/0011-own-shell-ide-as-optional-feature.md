# ADR 0011: Our own application shell, with the IDE as an optional feature module

- **Status:** Proposed. Becomes Accepted when the own-shell Phase 0 gate (section "Roadmap gate changes", item G0) passes on macOS and Linux.
- **Date:** 2026-11-26.
- **Decision owner:** Dylan Lambertson (product direction given 2026-11-26). The engineering choices below were made under the owner's delegation of 2026-11-21 and can be overridden by the owner.
- **Supersedes:** ADR 0002 (Code OSS integration strategy) in full, and the Code OSS parts of ADR 0004 (decisions 2, 3 and 5, the IDE view parts of decisions 4 and 12, the concept-mapping rows for IDE view, terminals, file tree and diff review, "What stays the same" for ADR 0002, and the Phase 0 gate impact).
- **Amends:** ADR 0003 (D1 handshake, D6 placement, D7, invariant I7, validation criteria 1 and 4 to 7), ADR 0006 (side-panel editor rule 1 and the O-8 fallback), ADR 0008 (where plugin views are placed). Their other decisions stand.
- **Plan:** `docs/design/own-shell-plan.md` (tickets, order, estimates, what stops).
- **Evidence tags:** **[V]** verified in this repository; **[I]** inferred, not verified.

## Context

### Owner direction (2026-11-26)

> "Lets make the IDE just like a feature, not like a core piece. Eventually this will branch off to other AI needs like social media management, etc. So just have it as a useful feature that can be used when needed, but don't build it around the IDE. This meaning lets make our own like thing instead of using Code OSS. I still want like a file manager, + and - for git changes, etc."

The owner also said the product will be rebranded later (new name, logo and colours).

What this changes:

1. The product is a home for AI work in general. Code is the first use case, not the frame. ADR 0004 already made Agent view primary, but kept the whole app inside a Code OSS workbench, so every surface still lived in an IDE's layout, build, DI and process model.
2. The IDE stops being "fully capable, never reduced" (`PRODUCT.md` §2, ADR 0004 decision 2). It becomes one optional module next to a file manager, a git changes view with stage and unstage (+ and -), a terminal and diff review.
3. A future non-code module (for example social media management) must plug in without touching the IDE module.

### What exists today

- **Product logic sits outside Code OSS already** [V]. 18 `@axis/*` packages under `packages/` (daemon, daemon-host, protocol, journal, audit, broker, challenge, git-ops, git-snapshot, review, worktrees, pty-process, pty-policy, providers, anthropic, vault, runs, secret-scan). Their tests run on plain Node and import only `node:*`, `zod` and `@axis/*` (ADR 0005).
- **Main's control plane is also a package** [V]. `packages/daemon-host/src/main/*` holds the connect broker, the attestation signer, the answers (anchor, native confirm, trust check, settings), the native dialog queue, project actions, the secret store, the pty launch and supervisor, and plugin view identities. They import no `electron`. The Code OSS overlay only adapts them: `code/electron-main/axisMainSeam.ts`, `axisMainPorts.ts` and `axisMainPty.ts`, about 510 lines [V].
- **The overlay** is 102 files and about 14.6k lines of TypeScript [V], plus 29 patches, `removals.txt` and `replace/`. Roughly half of it is pure logic with tests: the daemon client, reconnect, event frames and subscription, refresh drivers, the workspace model, approvals, project actions, the changes model and side-panel rules. The other half is DOM views built on Code OSS parts and services.
- **ADR 0002 was never accepted.** Its criteria 1 (full IDE in the custom shell), 4 (sync cost) and 6 (extension matrix) were never measured as passing. Criterion 2's budget was nearly spent: 10 of 12 shell files before React (`axis-shell-stage2-plan.md` §4). React was deferred because the Code OSS pipeline cannot build `.tsx` without about 9 more upstream build files [V, same section].
- **ADR 0003's bridge is built and tested** [V, `main-answers.md`, `renderer-daemon-client.md`]. That covers the main-brokered port, main-minted signed identity, daemon-side validation, the single policy pipeline, challenge approvals and native confirmation over the privileged port. Main-drawn dialogs for tier 4 and up, project add and trust, and the integrations device code (EL-4) are built as well. None of this needs Code OSS. What does need Code OSS is the glue: `IWindowsMainService`, `validatedIpcMain`, `FileAccess`, `IConfigurationService`, the application storage that holds the Workspace Trust model, `getResolvedShellEnv` and `acquirePort` [V].

## Decision 1: app technology

| | Option | For | Against |
|---|---|---|---|
| **A** | **Electron main + the existing daemon and pty utility processes + `axis.*` contracts; our own TypeScript/React renderer** | Keeps everything ADR 0003 proved: `utilityProcess.fork` with a fixed entry, only main can write `parentPort`, `MessageChannelMain` ports transferred with a payload, `safeStorage` for the audit anchor and the vault, modal `dialog.showMessageBox` for tier 4 and up, and sandboxed `WebContentsView` plugin views (ADR 0008). Only about 510 adapter lines are rewritten. One Chromium on every OS, so CSP and Trusted Types behave the same everywhere. node-pty and Node 24 are unchanged. | A large binary (Chromium; on the order of 100 MB+ [I]) and Electron's release cadence: a major roughly every 8 weeks, with security fixes we must follow. Electron becomes our direct dependency instead of something Code OSS pins for us. |
| B | Tauri 2 (Rust core, system webview) | Small binaries; a Rust core with a capability system; low memory use [I]. | Every main-side primitive ADR 0003 relies on would be re-proved in Rust: window identity, sender-frame checks, port hand-over, secret storage per OS, native modals. The daemon and the pty process are Node, so they would run as sidecars over stdio. The "only main can write the daemon's channel" property would then rest on a different mechanism that would need fresh review. Three web engines (WKWebView, WebView2, WebKitGTK) differ in Trusted Types support, `MessagePort` behaviour and devtools exposure, which triples renderer security testing. 18 packages of tests assume Node. Estimated cost: several weeks before parity with what exists [I]. |
| C | Pure web host (a local server, the UI in the user's browser) | No desktop packaging; the same UI could later be served remotely. | Needs a listening socket, which breaks DMN-4 (no listener in Phases 1 to 3) and puts WEB-1 (token on a local port) on the critical path. It has no native dialog that a compromised page cannot draw or click, so tier 4 and up (EL-4) loses its guarantee. Browser extensions can read the page. It stays a later remote target through `web-host-entry.md` (W1); not the desktop shell. |
| D | Keep Code OSS (ADR 0002) | The full IDE for free; work already done. | Contradicts the owner's direction. Weekly upstream sync cost, the closed workbench layout, Copilot removal patches, no React, and an IDE-shaped core. |

**Decision: A.** The renderer is our own single-page app in TypeScript with React, bundled by esbuild. It has no Code OSS DI, no `vs/*` imports and no Node. React is chosen for its accessible primitive libraries, virtualised lists and wrappers for Monaco and xterm.js. There is one component system; `DEVELOPMENT.md`'s "no competing component systems" still applies. Exact versions of Electron, React, Monaco and xterm.js are pinned in the first scaffold ticket and follow the supply-chain rules in `SECURITY.md`.

What ADR 0003's validation already settles for option A: the identity, signing, single-use, rate-limit and fail-closed behaviour of the connect path, and the answers, are tested on Linux at package level. Only the Electron adapters and the Mac evidence remain. Under option A that remaining work is the same size as before. Under options B and C the package-level proofs would no longer cover the real path.

## Decision 2: process and window model

- **Processes are unchanged:** main, the daemon utility process (`@axis/daemon-host` entry), the pty utility process (`@axis/pty-process`) and one sandboxed renderer per app window. Plugin views stay as ADR 0008 decides: one sandboxed `WebContentsView` each, minted and placed by main.
- **App window:** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`, no `remote`. Content is served from a privileged custom scheme registered by main (for example `axis-app://shell/`; the scheme name goes through the brand constant), never `file:`. Navigation, `window.open` and new windows are refused (`will-navigate`, `setWindowOpenHandler`). External links go through main's EL-5 path. Every permission request and check is denied. A `webRequest` filter in the window's session refuses every scheme except the app scheme, so the renderer has no network at all; egress stays the daemon's (NET-GATE, egress client).
- **One preload, fixed and small.** It exposes one frozen object with named functions only: `connect(nonce)` (the port hand-over that replaces upstream's `acquirePort` on the `vscode:axisConnect` channel), `projectAction(nonce, action)`, `terminalPort(nonce, terminalId)` and `openExternal(url)`. It has no generic `ipcRenderer`, no channel argument and no `send`. ADR 0003 D7's "no new `contextBridge` globals" becomes "exactly this one, pinned by a source test".
- **Sender checks move to our own window registry.** Main keeps a table of the windows it created (id, `webContents`, app URL, project id), which replaces `IWindowsMainService.getWindowByWebContents`. The ordered checks of `main-answers.md` §2 are unchanged in substance: a registered app window; `senderFrame.url` exactly equal to the app URL main computed; the main frame; not destroyed; the per-window token bucket; the supervisor state. The channel is renamed `axis:connect` because there is no shipped client. Plugin views still never use it.
- **Identity is unchanged:** a main-minted `connectionId`, `w<id>`, `actor: user`, signed with the generation key. The `trusted` field (the Workspace Trust answer at connect) is removed (Decision 5).

## Decision 3: module boundary

### Core shell (always loaded)

Window frame and top bar; the navigation rail and the agent home (project home, All agents); the Space's project list with Add project and trust; agents and groups (ADR 0006); workspaces (worktree list, create, finalise, remove); runs (CLI and composer) and their activity stream; approvals; messaging threads; tasks; pages; the audit view; settings; the plugin host (placement of ADR 0008 views); the command palette; notifications; the daemon connection and its states; theme tokens and brand.

### Feature modules (optional, each a lazily loaded chunk)

| Module id | What it is | Uses |
|---|---|---|
| `axis.files` | File manager: worktree tree, open a file in a read/edit viewer (single file), create, rename, delete | `axis.files/1` (missing, see the plan), the editor kit |
| `axis.changes` | Git changes: changed-files list, **+ / -** per file and per hunk, diff view, discard, commit, push, open a pull request | `axis.review/1`, `axis.git/1`, `axis.worktrees/1`, `axis.forge/1` |
| `axis.terminal` | Terminals bound to a workspace, split panes, attach to CLI runs | `axis.terminals/1` (missing), `axis.cli-runs/1`, the pty data channel |
| `axis.diff` | Diff review viewer shared by changes and run review | `axis.review/1` |
| `axis.code` | The code editor / IDE view: tabs, splits, find and replace, project search, go to line, outline, open at file:line | the editor kit, `axis.files/1`, `axis.search/1` (missing) |

The **editor kit** (`@axis/ui-editor`) is a shared, lazily loaded wrapper around Monaco (the standalone `monaco-editor` package, MIT; not the Code OSS workbench). It covers one buffer model per file per window, the theme bridge from tokens, workers bundled as files, and the Trusted Types policy names. The files viewer, the diff module and the code module use it. Disabling `axis.code` removes the IDE layout, tabs and search, not the single-file viewer.

Not in the code module, by decision: VS Code extensions and the extension host, the debugger, and the Open VSX registry. Language servers are a later item (Phase 2b). They run repository-chosen programs, so they would run in the pty process context, gated by run trust, never in the daemon. TypeScript, JavaScript, JSON, CSS and HTML diagnostics come from Monaco's built-in workers, which execute no repository code.

### The module contract

- A **manifest**: `{ id, version, title, requires: { contracts: ["axis.review/1", ...] }, contributes: { navItems, routes, workspaceTabs, projectHomeSections, commands, settings, intents } }`. `id` is a stable internal id (`axis.<name>`); titles go through the brand and localisation layer.
- `activate(ctx)` is loaded by dynamic `import()` the first time a contribution is used. `ctx` gives: a daemon client that refuses contracts outside `requires` (a convenience and lint target; **the daemon's policy stays the only authority**), the UI primitives, the router, the intent registry, scoped settings and a disposable store.
- **Intents decouple modules.** `openFile { workspaceId, path, line? }`, `openDiff`, `openTerminal`. A module registers as a handler with a priority. With `axis.code` enabled, `openFile` lands in the IDE view; without it, in the files viewer. The core never imports a module.
- **Enforced boundaries.** A lint rule (the repository's import scanner, moved from `scripts/code-oss/` to `scripts/lint/`; see Decision 4) allows a module to import only `@axis/shell-sdk`, `@axis/ui`, `@axis/ui-editor`, `@axis/protocol` types and its own files. The core may not import any module. A bundle-graph check on the production build confirms each module is its own chunk and the core chunk reaches none of them.
- **Enabling.** Modules are on by default and can be switched off per user (application scope). A project hides modules that do not apply to its kind (below).

### How a non-code module plugs in (for example social media management)

It is a first-party module (`axis.social`) with its own nav item, routes and project home section, its own daemon contract (`axis.social/1`) and integrations through ADR 0009's credential proxy. It never imports `axis.files`, `axis.changes` or `axis.code`. What it needs that does not exist yet is in the **core data model**, not the UI. Today a project is exactly one repository (O-2), and every agent has a home workspace that is a worktree (O-3, O-4). A non-code project therefore needs a later ADR introducing project kinds (`repository`, `general`) and agents without a worktree. This ADR only makes that later change local to the daemon and journal. The core shell's code paths must not assume a repository: project home sections that need one (pull requests, changes) are contributed by the code-oriented modules. Third-party extensions remain ADR 0008 plugins (sandboxed views), never modules: modules are first-party code in the trusted renderer bundle.

### + and - (stage and unstage)

| | Meaning of + / - | For | Against |
|---|---|---|---|
| **S1** | **Include in / exclude from the Axis commit**: a per-file and per-hunk selection that the daemon turns into a tree (review-core's accept and reject, REV-1), committed with `git commit-tree` and a compare-and-swap, as today | No new write path: the real index and worktree are untouched, so a running CLI and the user's own git are not disturbed. The commit is exactly the reviewed tree. It fits the existing `axis.git/1.commit` (it takes `reviewedTreeHash`). | Differs from `git add`: a `git status` in a terminal will not show Axis's staging. |
| S2 | Write the real git index (`git add`, `git apply --cached` per hunk) | Matches what users know from other tools | A new daemon write to `.git/index` while CLIs may be writing it (lock races). Hunk application on the real index needs a fresh hardened path. The commit would no longer be bound to a tree the user saw unless re-reviewed. |

**Decision: S1.** + and - are shown as "Staged for commit" and "Changes", with a one-line note that Axis's staging is separate from `git add`. A later setting can mirror the selection into the real index (S2) as a separate, reviewed ticket. Discard per file uses `axis.worktrees/1.discard`, which is tier 2 and backed up to a ref [V]. Discard per hunk and the hunk and selection reads are missing contracts (plan).

## Decision 4: what from the Code OSS work is reused

| Piece | Fate |
|---|---|
| All 18 `packages/*`, their tests and the daemon and pty entries | **Unchanged.** |
| `packages/daemon-host/src/main/*` (connect broker, attestation signer, answers, native queue, project actions, anchor store and file, secret store, settings scope, pty launch, supervisor and hand-over, plugin views) | **Unchanged**, except `trust-model.ts`, whose Workspace Trust reading goes (Decision 5). |
| **Main-drawn native dialogs**: `native.confirm` for tier 4 and up, project add and trust, the integrations device code (EL-4) | **Carry over unchanged**; they are Electron main code. Only the renderer-facing pieces (the buttons that ask main) are shell work. |
| Overlay Electron adapters (`axisMainSeam.ts`, `axisMainPorts.ts`, `axisMainPty.ts`) | **Rewritten** against our window registry, app scheme, settings store and our own shell environment resolver (replacing `getResolvedShellEnv`; written fresh, not copied, to avoid carrying upstream code). |
| Renderer logic with tests: daemon client, reconnect, replies, event frames, event subscription, event and refresh drivers, snapshot loader, workspace model and data, daemon notices (their copy), approvals and their text, project actions and service, changes model, ordered children, file tree text, reveal input, view state, focus memory, side-panel save and conflict rules | **Ported** to `@axis/shell-core` (renderer-safe, no `node:*`). `vs/base` `Emitter`, `Disposable` and `CancellationToken` are replaced by small own equivalents; tests move to `node:test`. |
| `@axis/protocol`'s `AxisPortClient` | **Unchanged**; it is already the renderer client. |
| Workbench, layout service, part navigation, Agent part, dashboard, workspace view, changes view, file tree, approval cards (DOM), workspace terminals on the upstream terminal service, `axisChangesSource` (built on the upstream git service), on-disk worktree discovery (the renderer will have no file system), the defaults, opener and about contributions | **Discarded.** Their behaviour specs (texts, states, keyboard order) are reused as requirements. |
| `theme-axis` | **Colour values reused** as the single token source (`@axis/ui` tokens, CSS variables, a generated Monaco theme). The extension is discarded. |
| Patches 0010 to 2060, `removals.txt`, `replace/`, `upstream.json`, `scripts/code-oss/` apply, fetch, build, footprint, brand-probe, gen-theme-syntax and check-artifacts, the extension matrix, the overlay-tests CI job | **Retired** once the own shell passes G0 (plan ticket OS-22). Until then they keep the interim Code OSS demo building. |
| `scripts/code-oss/stage-ast.mjs` (`scanModules`), `web-rules.mjs`, `egress-rules.mjs`, `egress-client-imports.mjs` | **Moved** to `scripts/lint/`. They are already the repository's own import lint, run by `test/packages/*` on the real tree, and keep the egress client's hash pin, the `node:https`/`node:dns` allowance and the "composition root only" reach rule as a **source check**. |
| `check-daemon-graph.mjs` (esbuild bundle graph on the Code OSS daemon entry) | **Re-targeted** to the own shell's daemon bundle, so the same rules also keep a **bundle check**. A renderer bundle-graph check is added (the renderer reaches only `@axis/protocol`, `@axis/shell-*`, `@axis/ui*`). |
| `stage-verify.mjs`, `check-staged.mjs` | **Retired** after the bundle checks above exist (they check the staged Code OSS tree). |
| `net-gate.md`'s packaged NET-GATE (`check-net-packaged.mjs`) | The listener-only statement stands. The **packaged half is re-done against the own shell's packaged build** (plan ticket OS-21). |
| `test/code-oss/*` source pins (renderer imports, daemon call rule, main seam, project actions renderer) | **Re-targeted** to the new renderer and main paths; same rules. |
| `prototypes/` and `docs/feasibility/` | Kept as history. `prototype-monaco-vscode-api.md` §2 is evidence that Monaco runs in Electron with Axis-owned IPC. |

## Decision 5: security consequences

1. **The renderer gets less authority, not more.** ADR 0003's accepted residual was that the upstream renderer holds `localFilesystem`, `localPty`, `encryption`, `nativeHost` and the `UtilityProcessWorker` spawn (threat model R1, PTY-1). Our renderer has none of these. That also closes the residual in `secret-broker.md` §2 (through upstream's `encryption` channel, any renderer can decrypt any `safeStorage` ciphertext of the app). Files, terminals and search reach it only through daemon contracts and main-brokered pty data ports. I1 to I6 stay; I7 becomes "Axis code lives in `apps/desktop` and `packages/*`; no upstream footprint". The renderer is still never trusted: a compromised renderer is the EL-3 actor, as before. **Rule:** no generic file, process or shell channel may be added to main or the preload to save time. Each capability is a contract with a tier, policy rows and the coverage check.
2. **Tier semantics are unchanged.** Main-drawn native confirmation exists **only at tier 4 and above** (`challenge/manager.ts`, `gate/approvals.ts` [V]). Tiers 1 to 3 are resolved in the renderer's approval UI by the user principal, and no UI copy may call that native. Approval cards are core-shell components; module content, messages, pages and plugin views cannot render or imitate them.
3. **CSP and Trusted Types are ours.** The app document sets: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types axis-shell <Monaco's policy names at the pin>`. `'self'` is the app scheme. Inline styles are kept for React and Monaco, as the Code OSS workbench allowed. Lint bans `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment, `eval` and `new Function` in the renderer. Zod runs `jitless` there (ADR 0003 criterion 5, now measured on our bundle). A Trusted Types smoke test under the production CSP fails on any violation.
4. **Workspace Trust is replaced by the run-trust record that already exists** (`project-registration-and-trust.md`). T3 (main's Workspace Trust half) is dropped: §4.2 of that note already records that it adds nothing an attacker cannot supply. `trust.check` becomes: the window is live in main's registry **and** main knows the project's repository path from its own registration. The daemon ANDs that with T1 (the journal record that only main's dialog writes), T2 (the repository binding) and T4 (no revoke), unchanged. Defaults stay fail closed: untrusted until the user picks "Add and trust to run" or "Trust to run" in main's dialog. "Restricted Mode" becomes "Untrusted: read only". Files of an untrusted project open read only in the files and code modules, and the daemon refuses `axis.files/1` writes there. Plain terminals stay ungated (§2 of that note), and CLI and composer runs stay gated.
5. **CFG-1 becomes structural.** Settings live in main's store under the app data directory, in user, application or machine scope only. No repository file is ever read for settings, so the `.vscode/settings.json` gate line becomes "a repository settings file has no effect". `axis.cliAgents` defines programs Axis runs, so a change to it needs main's native confirmation (recommended default; plan ticket OS-4).
6. **Removed classes:** extension-originated commands (ADR 0003 criterion 4, EXT-2), extension environment collections in PTY-5, the reh-web listener, Open VSX VSIX tampering, the minifier's `#private` mangling risk, and Copilot or agent-host code in the bundle. **Kept:** PTY-5 (applied by the pty process as now), G-28 (no debugging ports in a packaged build: `--inspect*` and `--remote-debugging-port` are refused by main at start), EL-5, CLI-1 and every daemon-side control.
7. **New surface to review:** the custom scheme handler (path traversal in the bundle root, MIME types), the preload, the window registry and the new contracts (`axis.files/1` in particular: WT-1-style canonicalisation, no symlink following out of the worktree (FT-1), size caps, control and bidirectional characters escaped). The threat model revision (ADR 0004 implication 7) covers these before G0.

## Decision 6: licensing and legal effect

- **No Code OSS code ships**, so the Code OSS row of `LICENSING.md` is replaced. The rebrand guardrails of ADR 0002 decision 5 (product.json identity, Microsoft strings, the extensions gallery, Copilot removal, Microsoft endpoints) are no longer needed, and the Visual Studio Marketplace and Open VSX questions go away with the extension host.
- **New third-party notices**, all MIT [I, to verify per exact version in the scaffold ticket]: Electron (which also ships Chromium's and its dependencies' licences in its distribution), React and React DOM, Monaco editor (built from VS Code sources: Microsoft's MIT notice and Monaco's third-party notices travel with it), xterm.js. node-pty stays. The notice file is generated from the lockfile at build time.
- **Trademarks:** we still say nothing that implies a Microsoft affiliation. "Monaco" is a component name in notices, never in product copy.
- **Copying upstream code** (for example the shell environment resolver) is avoided. Anything copied keeps its MIT header and gets a `NOTICE` entry.
- The proprietary Axis licence is unchanged. The `LEGAL REVIEW` items in `licensing-and-marketplace.md` shrink to the notice aggregation and the Axis licence itself. `LICENSING.md` is edited in plan ticket OS-23, not here.

## Roadmap gate changes

`ROADMAP.md` gets a banner pointing here now. Its gate text is rewritten in plan ticket OS-23 after this ADR is accepted. The changes:

- **ADR 0002 criterion 1 is re-stated as C1′ (code module):** in the own shell on macOS and Linux, open a workspace file from the files module or a diff, edit it, save it through `axis.files/1`, and see TypeScript diagnostics (Monaco worker). Also: tabs and a split, find and replace in a file, project search, go to line, a diff view, and return to the agent home with buffers and selection kept. Not required: debugger, extension host, language servers (Phase 2b), SCM UI beyond `axis.changes`.
- **Criterion 2 is re-stated as C2′ (module isolation):** the core shell has no static import of any optional module (lint, source check). The production build puts each module in its own chunk that the core chunk does not reach (bundle check). With every optional module disabled, the core scenarios pass. Bundle size and cold start are measured and recorded (no budget until the baseline).
- **G0 (Phase 0 gate, replaces all four lines):** the own shell boots on macOS and Linux into the agent home with real daemon data; project add and trust through main's dialogs; a workspace with the files, changes (+ and - per file and hunk), terminal and code modules; C1′ and C2′; ADR 0003 criteria 1 to 3 re-run against our window (a plugin view, a second window, a navigated frame and a non-app frame are refused); the Trusted Types smoke passes.
- **Phase 1a:** "IDE view" bullet becomes the code module (C1′). "View modes" becomes the module layout (main area plus an optional side split; `perWorkspace` and `split` keep their meaning for the code module; `global` is dropped). Lines that change: PTY-5 (no git extension or test extension; the env test uses a parent environment with the same injected variable set); "untrusted repository opens in Restricted Mode in IDE view" becomes "read only in files and code, daemon refuses writes"; Trust enforcement (no Workspace Trust model; T1, T2, T4 plus main's live-window and registered-path answer); Bridge, UI and bundle (criteria 1 to 3 and 5 as above; criterion 4 removed; criterion 6 deferred with the web host; criterion 7 removed); Open VSX (removed); no reh-web listener (becomes "no listener at all"); IDE-1 (keys after a module switch reach only the destination's last focused element); CFG-1 (structural, see Decision 5); the keyboard-only line (modes as above).
- **Phase 1c:** the side-panel editor uses the editor kit, sharing the window's buffer with the code module. The O-8 fallback "IDE split half if the embed exceeds ADR 0002 criterion 2" is removed. "Opening a folder in IDE view does not register it" is removed (there is no folder open). "Shell-layer footprint against criterion 2" becomes C2′.
- **Phase 2b:** inline edit and diff happen in the code module. The browser skeleton follows the web host (W1), not reh-web. **Phase 6:** the extension matrix is removed.
- "Recommended first 10 tickets" is replaced by `own-shell-plan.md`.

## Consequences

- **Positive:** the product's core is no longer an IDE; React, our own layout and our own design system without an upstream budget; no weekly upstream sync; a renderer with far less authority; one place for brand strings and colour tokens (the rebrand is cheap); a module seam for non-code work.
- **Negative:** we build the IDE surface ourselves and it will be smaller than VS Code: no extensions, no debugger, language servers later. Electron security updates become our job. File manager, terminal, search and hunk staging need new daemon contracts, and they are security-reviewed work. Some overlay UI work is thrown away.
- **Product:** `PRODUCT.md`'s "never a reduced editor" and "full IDE" text is reversed and is edited with the gates (OS-23). A user who wants VS Code keeps their own editor next to Axis; a later "Open in external editor" intent can hand off a path.

## Rollback

- Before G0, the interim Code OSS shell keeps building (nothing is deleted until OS-22), and the packages are shared, so switching back costs only the renderer work done.
- If Electron proves unworkable, Tauri (option B) reuses the renderer, the packages and the contracts, and redoes main's adapters and their evidence.

## Open questions

1. Should the S2 index mirror ship in Phase 1, or wait for user feedback?
2. Project kinds and agents without a worktree (the later ADR for non-code modules).
