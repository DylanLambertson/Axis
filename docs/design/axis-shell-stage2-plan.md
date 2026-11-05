# Axis workbench shell: React, accessibility and M3 tasks (§4 to §6)

> Part of the Axis workbench shell design. Section numbers (§) are stable across the parts; `axis-shell.md` lists which part holds which section.

## 4. React integration plan

**Decision for M3.**

- **React is deferred (D5, §8).** All M3 Axis UI is vanilla TS/DOM with upstream widgets.
- S2.11 is a **throwaway spike** that answers ADR 0002 criterion 5. It builds one React view (the AI panel empty state) through the normal pipeline, measures it, and is not merged.
- If the spike fails, Axis UI stays vanilla. Under criterion 5 that does not reject the ADR.

**Why.** Today no compile, check or bundle path handles `.tsx` [V]:

- `src/tsconfig.json:29-35` includes only `.ts`;
- `build/next/transpile.ts:15-27` hard-codes `loader: 'ts'`;
- `build/next/index.ts:432-451` globs `**/*.ts`, and `:282-285` would copy a `.tsx` raw into `out/`;
- `build/lib/compilation.ts:69` has `tsFilter = /\.ts$/`, and `build/lib/tsb/transpiler.ts:133-134` recognises only `.ts`;
- the `build/checker/tsconfig.*.json` includes use `**/*.ts`;
- `src/tsconfig.tsec.json` inherits the `.ts`-only include;
- ESLint `code-import-patterns` is scoped to `src/**/*.ts` (`eslint.config.js:1610-1612`);
- component fixtures use `.fixture.ts` globs (`build/rspack/rspack.serve-out.config.mts:126`, `build/vite/vite.config.ts:171`).

Bundles also mark every package external (`build/next/bundle.ts:18`) [V], and no runtime import map resolves a bare `react` specifier in the renderer [I]. React 19 publishes CJS only (no UMD) [I], so `importAMDNodeModule` (`src/vs/amdX.ts:210-234`) cannot load it.

**Design to validate in spike S2.11** (throwaway branch, measured):

| Concern | Plan |
|---|---|
| Bridge | `src/vs/axis/browser/react/axisReactRenderer.tsx`, Positron-style (alternatives doc: `positronReactRenderer.tsx`): a `Disposable` that owns `createRoot(container)`, renders inside `AxisServicesContext.Provider`, and unmounts on dispose. It passes a **narrow typed services object**, not the raw `IInstantiationService`. It forwards size, focus and visibility from the hosting `ViewPane`. An error boundary reports to `ILogService` |
| tsconfig | `"jsx": "react-jsx"` in `src/tsconfig.json`, and include `./vs/axis/**/*.tsx` only, which confines TSX to Axis. Same include for the browser and electron-browser checker tsconfigs |
| Transpile and bundle | Loader by extension (`tsx`) and `jsx: 'automatic'` in `transpile.ts` and `bundle.ts`. Widen the globs in `index.ts`/`compilation.ts`/`tsb`. Bundle react, react-dom and scheduler into the Axis entry with an `onResolve` plugin, or emit a separate vendor ESM bundle loaded with `import(FileAccess.asBrowserUri(...))`. Both follow the precedent at `build/next/devTunnelsWeb.ts:38-70` and `devTunnelsWebLoader.ts:81-89` [V] |
| Mangling | Only `#private` fields are renamed (`build/next/private-to-property.ts:10-33`, enabled at `build/lib/esbuild.ts:55-58`). No `mangleProps` [V], so JSX props are safe [I] |
| CSP / Trusted Types | `style-src 'self' 'unsafe-inline'` already allows React inline styles (`workbench.html:32-35`, server `webClientServer.ts:153`) [V]. React DOM's normal rendering uses DOM APIs, not TT sinks [I]. **Ban `dangerouslySetInnerHTML`**; any HTML must go through an allow-listed policy created with `createTrustedTypesPolicy` (`base/browser/trustedTypes.ts:11-33`), and its name must be added to `workbench.html:50-68` [V]. No new policy is expected |
| Lint, tsec, hygiene | Widen `code-import-patterns` and the browser `no-restricted-syntax` globs to `{ts,tsx}` (`eslint.config.js:1236,1610`). Allow `react`/`react-dom/client` only in Axis targets. Add a `react/no-danger` equivalent. Run tsec over `.tsx`. Hygiene already checks headers, indentation and unicode on any file (`build/filters.ts:36-46,82,176`) [V]; `tsFormattingFilter` (`:237-238`) needs `.tsx` |
| Tests | `.test.tsx` is picked up once it transpiles to `.test.js` (`test/unit/electron/renderer.js:90`) [V] |
| Licence | React is MIT. Add it to ThirdPartyNotices |

**Footprint consequence (criterion 2).**

- The shell range already uses 10 of its 12 files (§3.10). In-pipeline `.tsx` (`jsx: react-jsx`, ADR 0002 decision 4) adds about 9 build files, so the spike also measures a **no-JSX variant**:
  - React is called through `createElement` (or a tagged template such as `htm`) in ordinary `.ts`;
  - the only build changes are a React resolve/vendor step in `build/next/bundle.ts` and the dependency entries;
  - the ESLint targets live in the overlay module.
- The no-JSX variant adds about 1–2 files and keeps criterion 2.
- The spike report gives both numbers. Any later adoption is a new decision, made after Phase 0: no-JSX React, an ADR amendment that counts pipeline enablement separately, or vanilla.
- Either way, M3 checks TT and CSP the same way:
  - a Playwright/Electron smoke test loads the view under the production CSP and fails on any Trusted Types violation (threat model §7, SIT);
  - a lint rule bans `dangerouslySetInnerHTML` in `src/vs/axis` (threat model EL-1).

**Risks to verify:**

- the real upstream footprint (expected about 9 files beyond §3.6);
- production bundle size and startup delta, lazy-loaded in the AI panel only;
- dev watch support for `.tsx` (`index.ts:803-807`);
- focus and keyboard interop between React-managed DOM and the upstream list/focus trackers;
- React DOM and Trusted Types under `require-trusted-types-for 'script'`;
- whether a second component model fragments the design system (DEVELOPMENT.md §9 "no competing component systems").

## 5. Accessibility and keyboard navigation

These follow UX.md (WCAG 2.2 AA, keyboard-only workflows, command palette for all essential actions, no colour-only status).

1. **Landmarks.**
   - Keep upstream roles and ids for every reused part (§3.3).
   - Every part container gets an `aria-label`: "Top Bar", "Activity Bar", "Primary Side Bar", "Editor", "Panel", "AI Panel", "Status Bar". Use `role="none"` where upstream does, to avoid screen-reader chatter (`workbench.ts:329`) [V].
   - New Axis controls are toolbar items with accessible names and `aria-haspopup` where they open menus.
2. **Focus order.**
   - The upstream F6 cycle is hard-coded as Editor → Panel → Auxiliary Bar → Status Bar → Activity Bar → Side Bar, **without the title bar** (`workbench/browser/actions/navigationActions.ts:308-324`; F6 at `:362-367`) [V].
   - Axis registers `axis.action.focusNextPart`/`focusPreviousPart` on F6 and Shift+F6 with a higher weight. The cycle is Top Bar → Activity Bar → Side Bar → Editor → Panel → AI Panel → Status Bar, skipping hidden parts through `getVisibleNeighborPart`.
3. **Commands for every action.** Each one is in the Command Palette with a category and is bindable:

   | Command id | Notes |
   |---|---|
   | `axis.action.focusTopBar` | |
   | `axis.action.switchWorkspace` | Delegates to the recent-workspace picker |
   | `axis.action.showAgentActivity` | |
   | `axis.action.selectModel` | M3: a placeholder that states "not configured", never a fake list |
   | `axis.action.manageAccounts` | |
   | `axis.action.toggleActivityRail` | |
   | `axis.action.toggleAIPanel` | |
   | `axis.action.focusAIPanel` | |
   | `axis.action.resetLayout` | |

   The upstream toggles stay valid: `workbench.action.toggleSidebarVisibility`, `togglePanel`, `toggleAuxiliaryBar` and `focusSideBar`.
4. **Focus visibility and contrast.**
   - `focusBorder` is `#9776F9` (5.6:1 on canvas, ≥3:1 on raised) or `#5823F6` on light.
   - Control borders follow the §2.3 proposal.
   - Status uses icon plus text plus colour. The agent indicator exposes its state in its label (for example "Agents: idle").
5. **Motion.** No new animation over 200ms. Honour `workbench.reduceMotion` (`workbench.contribution.ts:771`) [V]. No loops in the activity indicator.
6. **Zoom.** Grid minimum sizes are expressed in CSS px. Verify at 200% window zoom and at `window.zoomLevel` 3.
7. **Verification.**
   - Keyboard-only walkthrough of PRODUCT.md scenario 5 (open repo → edit → diagnostics → terminal tests → commit).
   - VoiceOver (macOS) and Orca (Linux) part announcements.
   - Upstream `test/smoke/src/areas/accessibility` suite.
   - An automated contrast test over both theme JSONs (S1.4).

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

