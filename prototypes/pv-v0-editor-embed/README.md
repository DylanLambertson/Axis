# PV-V0 editor-embed harness

Evidence for `docs/design/pv-v0-editor-embed.md`. It loads the **real upstream editor**, compiled at the pinned commit, together with the **transpiled overlay prototype** (`code-oss/overlay/src/vs/axis/contrib/sidePanel/`) in headless Chromium. Upstream standalone services stand in for the workbench ones; the write-up lists what that changes. Nothing here is part of the product build or the gate.

## What it needs

| Variable | Points to |
|---|---|
| `AXIS_UPSTREAM_OUT` | `out/vs` of a Code OSS checkout at the pinned commit after `npm run compile` (any applied `vendor/code-oss` works) |
| `AXIS_TYPESCRIPT` | the `typescript` package folder (used only to transpile the overlay) |
| `AXIS_MOCHA` | the `mocha` package folder (upstream's test runner for the unit tests) |
| `AXIS_PLAYWRIGHT_CORE` | the `playwright-core` package folder (upstream's dev dependency) |
| `AXIS_CHROMIUM` | a Chromium or Chrome headless-shell executable |
| `AXIS_UPSTREAM_EXTENSIONS` | optional: the checkout's `extensions/` folder, whose `package.json` keybindings the key scan adds |
| `AXIS_PV_V0_WORK` | optional: scratch folder (default: the OS temp folder) |
| `AXIS_PV_V0_PORT` | optional: local port (default 8951; bound to 127.0.0.1) |

## Running

```sh
node prepare.mjs     # links out/vs, transpiles the overlay into vs/axis, copies page.html
node unit.mjs        # the overlay's unit tests for the pure rules
node run.mjs         # the browser checks; or one section: model, route, keys, approve, trust, conflict, race
node mutate.mjs      # 46 mutants of the prototype; each must fail the unit tests or the browser checks
node scan-keys.mjs --check         # the key inventory, desktop workbench; fails on a candidate the policy does not classify, or when the state matrix or the counts at the pin change
node scan-keys.mjs --web --check   # the same for the web workbench
```

`run.mjs` prints one `PASS` or `FAIL` line per check, with the value it saw and, on a failure, the value it expected. `page.html` registers stand-ins for upstream workbench commands the side panel must not trigger, with the same keys, weight and `when` as at the pin: Save, Save As, Save without Formatting, Save All, Close Editor, Split Editor, Copy Path, Next Editor and Close Group. It then installs the Axis command guards; the `route` section also registers Save and Tasks: Build again afterwards, to check that each gets exactly one guard, then disposes the late Save to check that its guard goes with it, and finally disposes the guards. The `route` section runs twice: with the guards, and without them to show the upstream misroute.

`scan-keys.mjs` imports the desktop workbench main, or the web main with `--web`, so that every contribution registers its commands and keybindings; neither is started, and the desktop preload globals are stubbed. It also adds the built-in extensions' `package.json` keybindings. It keeps the keybindings that can fire with focus in the side-panel editor in any of eight states of the hidden IDE (base, screen reader, diff, several groups, side by side, dirty, debugging, panels) and are not editor commands, and runs each handler against recording services to see whether it reads the editor part's active editor directly. The probe cannot see a command that finds the active editor through another service, so `--check` requires every candidate to be classified in the policy. `scan-2c33b50.tsv` is the desktop output at the pin (Linux keymap), with each command's policy action.

Known harness limits: the editor web worker is not bundled, so worker features (word-based suggestions, link detection) are not exercised, and their load errors are filtered from the output. One unrelated 404 (a missing asset) is reported as a page error.
