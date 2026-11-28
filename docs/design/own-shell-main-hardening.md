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
| `debug-flags.ts` | G-28's third, detecting layer: a packaged build refuses every switch outside a short allow-list (in every form), and `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS`. It does not close G-28 (§2) | The first statement of main, then `app.exit(64)` |
| `fork-options.ts` | The `utilityProcess.fork` options of the daemon and the pty process: `execArgv` exactly `["--disable-sigusr1"]` (the entries accept exactly this `execArgv`, audit C; under Electron the flag alone does not block the inspector, §3 item 5), the caller's environment copied and frozen with every `NODE_*` and `ELECTRON_*` name refused, an absolute working directory, piped stdio | Both `utilityProcess.fork` calls (OS-3) |
| `preload-contract.ts` | The one global, its four functions, their channels and main's exact-key payload parsers | The preload (with its source pin) and the `ipcMain` handlers |

Each test file starts with its mutant list. `scripts/mutation/desktop-main.mjs` runs them on the compiled files (`npm run build` first). It is not part of the gate.

## 2. Choices made inside the ADR's limits

- **App name `axis-shell`, not `axis`.** On macOS, `appData` is `~/Library/Application Support`, which is also the base of the data roots (`.../Axis`). On a case-insensitive file system, `axis` would be the same directory, and Chromium's profile would sit next to the daemon's data, the anchor and the worktrees. `userDataOverlapsDataRoot` makes main refuse to start if the two ever meet.
- **Exact frame URL.** A sender's frame must be exactly `axis-app://shell/index.html`, as ADR 0011 says. So the renderer routes in memory. It never changes its URL with `pushState` or a fragment.
- **`style-src 'unsafe-inline'`.** Monaco and xterm.js insert `<style>` elements at run time. A style cannot run script, and scripts stay `'self'` under Trusted Types. With no policy names, `trusted-types 'none'` applies. OS-18 adds Monaco's names.
- **`window.open` is denied, not forwarded.** A link reaches main only through the preload's `openExternal`, so every link takes one path and gets one confirmation.
- **The spell checker is off.** On Linux and Windows it downloads dictionaries from the network, and the renderer's session must have none.
- **Permission check and request.** Both need the app origin and the main frame (in Electron 45.3.2 a check carries `isMainFrame`); a check embedded in another origin (`embeddingOrigin`) is refused.
- **G-28 is not closed by main.** `ELECTRON_RUN_AS_NODE` means main never runs; `NODE_OPTIONS` is applied before main's first statement; `--inspect` listens before it (measured) and `--inspect-brk`, `--inspect-wait` and `--inspect-brk-node` pause before any user code. Only the packaging fuses (OS-21) and the 1a/L33 launch test close G-28. `debug-flags.ts` is the third layer: it detects, and refuses in time only Chromium's DevTools switches. A packaged build takes an allow-list of switches (the Linux display switches), so an unknown or future debugging switch is refused by default. Do not mark G-28 closed when the second PR wires it.
- **CSP against ADR 0011.** `connect-src 'none'`, as the ADR fixes it (lazy `import()` is `script-src` and workers are `worker-src`, measured). `img-src 'self'` drops the ADR's `data:`; the ADR is amended in the same change. The Trusted Types name `default` is refused.
- **The fork environment.** `daemonEnvironment` allow-lists today, but the fork options are the one choke point of both children, so they refuse every `NODE_*` and `ELECTRON_*` name themselves, and pin the working directory (main chooses it in OS-3).
- **`mailto:`.** Only `to`, `subject`, `body`, `cc` and `bcc` pass. `attach=` and other fields are refused (`mailto_field`). The legacy shell's EL-5 has the same gap: plan row OS-2L.
- **The app windows' session.** Their own in-memory partition (`APP_PARTITION`, no `persist:`), never `defaultSession`: the filter and policy do not touch main's own `net` or other web contents, and nothing a page stores outlives the run.
- **Display media.** The handler calls `callback({})`, measured to refuse (`AbortError`); the permission handler already refuses `display-capture` before it.

## 3. Measured against the pinned Electron (45.3.2)

Measured on Linux (WSLg, X11), with probe apps on the pinned runtime in development and in a packaged copy (`app.isPackaged` true, fuses flipped in the binary). Every API the modules are wired to exists: `protocol.handle`, `protocol.registerSchemesAsPrivileged`, the session's permission request, permission check, device permission and display media handlers, `setSpellCheckerEnabled`, `webRequest.onBeforeRequest` and `utilityProcess.fork`.

1. **`webRequest` with `<all_urls>`: holds.** It saw and cancelled `http`, `https`, `ws` and image loads from the page, and `http`, `https` and `ws` from a module worker; `axis-app` loads pass. It does not see `data:` (not network: `connect-src 'self'` refuses it), `file:` (`fetch` refuses it first) or a worker's own script load (`worker-src 'self'` covers it). So the CSP stays a layer of its own.
2. **G-28 timing: split.** `--remote-debugging-port` starts listening at `ready`, after main's first statement, so main's refusal closes it (development and packaged). `--inspect` (main's own Node inspector) listens **before** main's first statement, in development and in a packaged build with default fuses; only the `EnableNodeCliInspectArguments` fuse off closes it. **The fuse is a gate for every packaged build (OS-21)**, with a launch test that `--inspect` never opens a port.
3. **ES module chunks and workers: hold.** Static and dynamic `import`, a module `Worker` and `fetch` of a bundle file load from the scheme with `standard`, `secure`, `supportFetchAPI` and without `corsEnabled`.
4. **Display media: holds.** `callback({})` makes `getDisplayMedia` reject (`AbortError`); the permission handler already refuses `display-capture` before it (`NotAllowedError`).
5. **`--disable-sigusr1`: does not hold under Electron.** The child receives the flag (`process.execArgv`) but a `SIGUSR1` after start still opens an inspector on `127.0.0.1:9229`, in development and in a packaged build with default fuses; plain Node 24.22.1 honours the flag. With `EnableNodeCliInspectArguments` off, the signal opens no inspector but **kills** the child. A `process.on("SIGUSR1", ...)` listener as the entry's first statement blocks the inspector in every mode and the child keeps running, so **the daemon and pty entries install it first** (audit C follow-up, owned by the credential audit work). The fork options keep the flag: it costs nothing and holds wherever an entry runs under plain Node. A `SIGUSR1` sent before the entry runs ended the child with no inspector seen.
6. **Permissions: hold.** `navigator.clipboard.writeText` from a user gesture arrives as `clipboard-sanitized-write` with `requestingUrl` `axis-app://shell/index.html` and `isMainFrame` true, and is allowed. Without a gesture it arrives as `clipboard-read` and is refused, so **a copy must come from a user action** (Monaco's and xterm.js's copy commands do). `readText` arrives as `clipboard-read` and is refused. The check handler's origin is `axis-app://shell/` (trailing slash; `isAppOrigin` parses it). It is also asked for `background-sync`, which is refused.

## 4. What the second PR must do and prove

- Wire, in this order: the G-28 call as main's first statement (`app.exit(64)`); before `ready`, `registerSchemesAsPrivileged`, `setName`, `setPath('userData')` and the overlap refusal, with both paths resolved (`path.resolve`, then `realpath` of the deepest existing ancestor: links and Windows short names); `protocol.handle` turning `AppResponse` into a `Response` with every header; the app partition's session with `hardenSession` and the filter; `hardenWebContents` on every web contents (`app.on("web-contents-created")`, DevTools included in development); `checkAppSender` before any payload parse on every `ipcMain` handler; the openExternal dialog drawn by main (modal, Cancel the default, a closed window resolves false).
- Check at startup that each Electron session and web contents API the policy calls exists, and throw if one does not: a renamed API must fail loudly, not install nothing.
- Load exactly `APP_URL` (`axis-app://shell/index.html`, not `axis-app://shell/`), or every sender fails the frame check.
- Pin "no listener" for the device-picker events (`select-hid-device`, `select-serial-port`, `select-usb-device` on the session, `select-bluetooth-device` on the web contents) and for `app`'s `select-client-certificate` and `login`: a listener that forgets `preventDefault` makes Electron pick the first device.
- The preload: one frozen global, four functions, no `ipcRenderer` leak, and its source pin.
- Feed real `protocol.handle` request URLs through the handler (Chromium canonicalises the standard scheme before main sees it).
- For OS-3: each forked file imports the signal guard (`@axis/daemon-host/signal-guard`, `@axis/pty-process/signal-guard`, audit C follow-up) as its one static import and loads the entry with `import()`; each package's `testing/process-main-child.ts` shows the shape. Measured under load, the guard still leaves a narrow band right after spawn in which a `SIGUSR1` can open the inspector, so the `EnableNodeCliInspectArguments` fuse (OS-21) stays the control for packaged builds.
- For OS-3: `window.gone` on navigation uses `did-start-navigation` (`will-navigate` does not fire on a reload or an in-page change); the fork's working directory is main's choice.
- Later: an openExternal rate limit per window (dialog fatigue), and refusing or flagging loopback and private-address `http(s)` hosts.

**Not verified yet:** macOS and Windows (the G-28 timing and the fuses above all), and a real copy in Monaco and xterm.js inside the shell. They are checked with the packaged builds (OS-21) and the editor and terminal tickets.
