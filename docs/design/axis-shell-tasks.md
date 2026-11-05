# Axis workbench shell: M3 implementation tasks

> Part of the Axis workbench shell design. The index, with the summary of decisions (§0), the layout (§1), risks (§7) and decisions (§8), is [`axis-shell.md`](axis-shell.md). This file holds §6 (the M3 tasks S1.x and S2.x). Section numbers are those of the original single document, so a reference such as "`axis-shell.md` §3.10" resolves through the section map in the index.

## 6. M3 implementation tasks

Each task is one PR on its own branch.

Verification commands are the upstream scripts run inside the M2 working tree. Unit tests run with `./scripts/test.sh --grep Axis` (Electron runner; `--grep` at `test/unit/electron/index.js:97`; glob `**/test/**/*.test.js` at `renderer.js:90`) and `npm run test-browser -- --grep Axis` (`test/unit/browser/index.js:47,56,141,156`) [V]. The smoke runner also takes `--grep`/`-f` (`test/smoke/test/index.js:25`) [V].

Tests follow the upstream sessions patterns:

- part tests use `workbenchInstantiationService` plus a stubbed `TestLayoutService` (`sessions/test/browser/parts/panelPart.test.ts:22,48,186-193`) [V];
- layout logic is tested by calling workbench methods against fake hosts (`sessions/test/browser/workbench.test.ts:771-802`) [V].

**Stage 1**

| Task | Scope | Acceptance criteria | Verification |
|---|---|---|---|
| S1.1 | `product.json` identity and endpoints (§2.5, D4), plus the notices patch G3: `dev.dylanlambertson.axis` ids, `DylanLambertson.Axis`, fresh GUIDs, licence keys pointing at the Axis `LICENSE`, added before distribution | App runs as "Axis"; data in `~/.axis`; no request to `*.microsoft.com`, `vscode-cdn.net` or `api.github.com` during a 10-minute idle session with a folder open; `LICENSE.txt` and `ThirdPartyNotices.txt` present in the desktop, server and web artifacts (G3) | `scripts/code.sh --log trace`, plus an Electron net log (`--log-net-log=<file>`) grep; artifact listing |
| S1.2 | Range `1500–1999` step 1: stop building, installing and packaging `extensions/copilot`; shared build and lint edits (§2.7) | `npm ci`, `npm run compile`, `npm run eslint`, `npm run hygiene` and `npm run valid-layers-check` pass; no Copilot UI | Command logs attached to the PR |
| S1.3 | **Measured spike (D1):** range `1500–1999` step 2, evaluating decision 6 options (a), then (b), then (c). Unbundle the agent host, drop the packages, add type stubs or the tsconfig exclusion, run `regen-locks` (§2.7–2.8) | All four SC-3 checks pass on packaged desktop, server and web builds for the chosen option. The footprint and result of every option tried are recorded under criterion 3. The chosen patch set is kept in block `1500–1999`. S1.3 also applies D8: it neutralises the Agents-window choke points and verifies every listed trigger (§2.7) before removing the build entries | `check-artifacts` and `regen-locks` output; stub lint and unit test; `npm ci` from a clean tree |
| GATE-D | **Hard gate before the first distributed build (D1):** full removal of the Copilot and agent-host root dependencies and code. SC-3 checks 1–4 pass on release artifacts; `check-artifacts --notices` finds `LICENSE.txt`, `ThirdPartyNotices.txt` and the Axis `LICENSE` in the desktop, server and web artifacts (decision 5); and the `@vscode/copilot-api` dev-use and licence-text legal reviews are closed | Release checklist blocks distribution until met | Release pipeline runs `check-artifacts`; legal sign-off recorded |
| S1.4 | `extensions/theme-axis` dark and light (§2.3) | Both themes selectable; a contrast test (Axis script) checks every foreground against **each surface it is drawn on** (canvas, surface and raised). Text and placeholders must reach ≥4.5:1; focus and control borders ≥3:1 (dark control border 3.20:1 on raised is the tightest case). The stated exceptions (disabled text, line numbers) are listed in the test | Script output; screenshots of editor, sidebar, quick input and panel |
| S1.5 | `axisDefaults.contribution.ts` and P10 (restyle, shell block); Axis proprietary header rule (part of P8, landed early; D4) | Fresh profile shows the §2.2 defaults; `chat.disableAIFeatures` is effectively true; Axis-owned files carry the proprietary header, and upstream files keep MIT | Settings editor "Modified by Axis defaults" view; unit test asserting registered defaults; `npm run eslint` |
| S1.6 | Icons and assets (§2.6), `build/lib/electron.ts:146-147` | No VS Code or Code-OSS imagery in the dock/taskbar, About, watermark or web manifest | Packaged build visual check; `file` sizes check script |
| S1.7 | Stage 1 checkpoint: packaged macOS and Linux builds; upstream smoke subset | Builds launch; the PRODUCT.md scenario 5 walkthrough works | `npm run gulp vscode-darwin-x64-min` (or `-arm64-min`) / `vscode-linux-x64-min`; `npm run smoketest -- --grep "Search\|Terminal\|Statusbar\|Extensions\|Languages\|Task"` (`test/smoke/src/main.ts:20-37,454-457`) [V] |
| S1.8 | Range `2000–2999` security hardening (§3.6). M3 lands H1 (web TT), H3 (cookie `Secure`) and H4 (optional `openExternal` allow-list). H2 (`frame-src` for the self-hosted webview origin) goes to M6 with D9 | The web CSP carries Trusted Types with no violations in the web walkthrough; the cookie is `Secure` over TLS; `openExternal` refuses `file:` and custom schemes (H4) | TT-violation smoke test (threat model §7 SIT); `curl -I` cookie check; a unit test for the H4 allow-list |

**Stage 2**

| Task | Scope | Acceptance criteria | Verification |
|---|---|---|---|
| S2.1 | Layer scaffold: `src/vs/axis` tree, `LAYERS.md`, `build/axis/eslint.axis.ts`, P8, P9 | An empty Axis module lints and type-checks; a deliberate `vs/workbench → vs/axis` import is rejected | `npm run eslint`, `npm run valid-layers-check`; negative lint fixture |
| S2.2 | Bootstrap plumbing: P2–P7, `axis.*.main.ts` (Phase A wholesale), `AxisDesktopMain` returning the **upstream** `Workbench` first | Desktop boots through the Axis entry with an unchanged UI; checksums are valid in the packaged build | Launch; About dialog has no "installation corrupt" warning; `out/vs/axis/axis.desktop.main.{js,css}` exist |
| S2.3 | `AxisWorkbench` v1: grid, part creation, restore phases, persistence, the full layout-service table (§3.3) | Editor, explorer, search, SCM, terminal, debug, problems, command palette and the extension host work; sizes and visibility restore per workspace; no `unknown service` errors | Unit tests for grid and state; smoke subset (S1.7); `Developer: Inspect Context Keys` sanity; extension host log |
| S2.4 | AI panel view container (empty state, no fake AI) and auxiliary-window support | AI panel toggles and resizes and stays hidden by default; "Move Editor into New Window" works | Unit test; manual check |
| S2.5 | Top-bar contributions on the **reused upstream title bar and menus** (D2, §1) | Workspace switcher (in `MenuId.CommandCenter`), agent indicator ("idle") and account/model control (in `MenuId.TitleBar`) are present and keyboard operable, with honest unavailable states. No Axis title-bar part | Unit tests (view items, commands); screenshots |
| S2.6 | Keyboard and a11y (§5) | F6 cycle includes the top bar; every §5 command is in the palette; VoiceOver and Orca announce parts | Upstream accessibility smoke area; manual SR script |
| S2.7 | Web bring-up: `axis.web.main*`, `AxisBrowserMain`, `web.factory`, P5. The webview hosting model is **deferred to M6** (D9) | `scripts/code-server.sh` serves the Axis shell; node extensions (Open VSX), terminal and Git work; webview behaviour is recorded as an M6 gap; other gaps documented | Browser walkthrough; gap list in `docs/feasibility/` |
| S2.8 | Phase B curated contributions (generator, exclude list, stale-exclude check) | Same functional checks as S2.3; startup time not worse than Phase A (median of 5 `Developer: Startup Performance` runs) | Generator self-test; perf numbers in the PR |
| S2.9 | Packaged Axis-shell builds on macOS and Linux; ADR checklist demo | ADR 0002 validation bullet 1 is satisfied | Recorded walkthrough; smoke subset on both OSes |
| S2.10 | **Upstream sync exercise** from 1.144 to a release **at least 2 weekly minors later** (criterion 4; latest recovery release, matching the sync policy) | ≤ 1 working day for **all four blocks** (`0001–0999`, `1000–1499`, `1500–1999`, `2000–2999`); conflicts only in patched seams | Protocol below |
| S2.11 | **Throwaway** React spike answering criterion 5 (§4, D5): in-pipeline `.tsx` and no-JSX variants | One React view passes the production CSP/TT smoke test, lint/hygiene/tsec and the minified production bundle; footprint, bundle and startup deltas recorded for both variants | Measurements in the PR description; the spike branch is **not merged** |
| S2.12 | Footprint report and ADR 0002 validation write-up | Criterion 2 met by range `0001–0999`; criterion 3 recorded separately for `1000–1499`, `1500–1999` and `2000–2999`; ADR status updated with evidence | `scripts/code-oss/footprint.sh` output per range |

**Sync exercise protocol (S2.10).** Record each of these in `docs/feasibility/upstream-sync-log.md`:

1. wall-clock start and end;
2. per-patch `git apply --3way` result and the number of conflicted hunks, **per block and per upstream file**, including conflicts between blocks that touch the same file;
3. `git diff 1.144.0..<new> --stat` over every patched file and over `layoutService.ts`, `workbench.common.main.ts`, `workbench.desktop.main.ts`, `desktop.main.ts` and `sessions/browser/workbench.ts` (an early warning for layout-service churn);
4. the count of type errors under `src/vs/axis` before fixes;
5. generator diff: new upstream imports and stale excludes;
6. time to green across `compile`, `eslint`, `valid-layers-check`, Axis unit tests, the smoke subset and a packaged build;
7. lockfile regeneration result: the added/removed list, reviewed in the sync PR (SC-3 check 3);
8. SC-3 artifact check and the TT-violation smoke test re-run on the new base.

Pass means ≤ 1 working day across all ranges, with no edits outside patched seams except type fixes in `src/vs/axis` and stub updates for a bumped SDK.
