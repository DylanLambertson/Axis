# Own shell: main window and session hardening (OS-2)

- **Status:** first PR built (the pure modules in `@axis/desktop-main`). The second PR wires them into `apps/desktop/main` once OS-1's scaffold merges.
- **Decides nothing new.** It builds ADR 0011 Decision 2 (process and window model, preload, EL-5, sender checks, stable ids) and Decision 5 item 6 (G-28). The ADR is still PROPOSED; this code is the ticket the owner approved to start.
- **Related:** `docs/design/own-shell-plan.md` (§0 row 2, OS-2, OS-3), `docs/design/main-answers.md` §2 (the ordered sender checks), `docs/security/threat-model-phase1-controls.md` (G-28), `docs/security/threat-model-phase0.md` (EL-5).

## 1. What the first PR holds

Each module is pure and injected: none imports Electron, so each runs under plain Node with `node:test`. The package imports `node:*` and `@axis/protocol` only (ADR 0005).

| Module | What it decides | Wired in the second PR as |
|---|---|---|
| `stable-ids.ts` | `axis-app://shell`, its privileges, the app name `axis-shell`, `userData`, and the check that `userData` never overlaps the data roots | `protocol.registerSchemesAsPrivileged`, `app.setName`, `app.setPath('userData')`, all before `ready` |
| `app-scheme.ts` | Which request is served: `GET`/`HEAD`, a per-segment allow-list, the MIME map, `realpath` containment in the bundle root, fixed error bodies | `protocol.handle(APP_SCHEME, ...)` |
| `csp.ts` | The CSP (exact Trusted Types names, no `'allow-duplicates'`) and the security headers of every response | The scheme handler's headers |
| `window-registry.ts` | Which sender is an app window: registered, frame URL exactly `APP_URL`, main frame, not destroyed; ids never reused; pruning on close | Every `ipcMain` handler, before the payload is parsed |
| `web-policy.ts` | The web preferences; navigation, frame navigation, redirects, webviews and `window.open` refused; only `clipboard-sanitized-write` from the app origin; device, display capture, downloads and the spell checker off | `new BrowserWindow({ webPreferences })`, the window's `webContents`, its session |
| `web-request-filter.ts` | Every request cancelled unless it is for the app origin (`devtools:` too, unpackaged only) | `session.webRequest.onBeforeRequest` |
| `open-external.ts` | EL-5: `http`, `https`, `mailto` only; printable ASCII; no credentials; the full normalised URL in main's confirmation for every link; one dialog per window | The `axis:openExternal` handler, `dialog.showMessageBox`, `shell.openExternal` |
| `debug-flags.ts` | G-28: a packaged build refuses debugging switches in every form, and `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` | The first statement of main, then `app.exit(64)` |
| `fork-options.ts` | The `utilityProcess.fork` options of the daemon and the pty process: `execArgv` exactly `["--disable-sigusr1"]` (Node's bootstrap starts the inspector on an early SIGUSR1, before any user code; the entries accept exactly this `execArgv`, audit C), the caller's allow-listed environment copied and frozen, piped stdio | Both `utilityProcess.fork` calls (OS-3) |
| `preload-contract.ts` | The one global, its four functions, their channels and main's exact-key payload parsers | The preload (with its source pin) and the `ipcMain` handlers |

Each test file starts with its mutant list. `scripts/mutation/desktop-main.mjs` runs them on the compiled files (`npm run build` first). It is not part of the gate.

## 2. Choices made inside the ADR's limits

- **App name `axis-shell`, not `axis`.** On macOS, `appData` is `~/Library/Application Support`, which is also the base of the data roots (`.../Axis`). On a case-insensitive file system, `axis` would be the same directory, and Chromium's profile would sit next to the daemon's data, the anchor and the worktrees. `userDataOverlapsDataRoot` makes main refuse to start if the two ever meet.
- **Exact frame URL.** A sender's frame must be exactly `axis-app://shell/index.html`, as ADR 0011 says. So the renderer routes in memory. It never changes its URL with `pushState` or a fragment.
- **`style-src 'unsafe-inline'`.** Monaco and xterm.js insert `<style>` elements at run time. A style cannot run script, and scripts stay `'self'` under Trusted Types. With no policy names, `trusted-types 'none'` applies. OS-18 adds Monaco's names.
- **`window.open` is denied, not forwarded.** A link reaches main only through the preload's `openExternal`, so every link takes one path and gets one confirmation.
- **The spell checker is off.** On Linux and Windows it downloads dictionaries from the network, and the renderer's session must have none.
- **Permission check versus request.** A check needs the app origin. A request, which is what grants a clipboard write, also needs the main frame.

## 3. To verify in the second PR, against the pinned Electron [I]

1. `onBeforeRequest` with `<all_urls>` sees `http`, `https`, `ws`, `wss` and `file`, and the `axis-app` requests pass. A runtime probe in OS-19 checks that the renderer reaches no network.
2. G-28 timing: whether Chromium opens the DevTools port before main's first statement runs. If it does, the refusal in main is not enough on its own. The packaging fuses (OS-21) and the 1a/L33 launch test, where nothing may listen, are what close the row.
3. ES module chunks and workers load from the scheme with `supportFetchAPI` and without `corsEnabled`.
4. `setDisplayMediaRequestHandler` refuses when its callback gets `{}`.
5. `utilityProcess.fork` passes `execArgv: ["--disable-sigusr1"]` to the child's Node, in a development and in a packaged build: a SIGUSR1 sent to the child at start leaves no inspector listening.
6. The permission handlers' `details` carry `requestingUrl` and `isMainFrame` for `clipboard-sanitized-write`. Copy works in Monaco and xterm.js, and `clipboard-read` is refused.
