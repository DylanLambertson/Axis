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
| `AXIS_PV_V0_WORK` | optional: scratch folder (default: the OS temp folder) |
| `AXIS_PV_V0_PORT` | optional: local port (default 8951; bound to 127.0.0.1) |

## Running

```sh
node prepare.mjs     # links out/vs, transpiles the overlay into vs/axis, copies page.html
node unit.mjs        # the overlay's unit tests for the pure rules
node run.mjs         # the browser checks; or one section: model, route, keys, approve, trust, race
node mutate.mjs      # 27 mutants of the prototype; each must fail the unit tests or the browser checks
node scan-keys.mjs --check   # the key inventory (review S1); fails on a flagged command the policy does not classify
```

`run.mjs` prints one `PASS` or `FAIL` line per check, with the value it saw and, on a failure, the value it expected. `page.html` registers stand-ins for upstream workbench commands the side panel must not trigger, with the same keys, weight and `when` as at the pin: Save, Save As, Save without Formatting, Save All, Close Editor, Split Editor, Copy Path, Next Editor and Close Group. It then installs the Axis command guards. The `route` section runs twice: with the guards, and without them to show the upstream misroute.

`scan-keys.mjs` imports the web workbench main (never started) so that every contribution registers its commands and keybindings. It keeps the default keybindings that can fire with focus in the side-panel editor and are not editor commands, and runs each handler against recording services to see whether it reads the editor part's active editor. `scan-2c33b50.tsv` is its output at the pin (Linux keymap).

Known harness limits: the editor web worker is not bundled, so worker features (word-based suggestions, link detection) are not exercised, and their load errors are filtered from the output. One unrelated 404 (a missing asset) is reported as a page error.
