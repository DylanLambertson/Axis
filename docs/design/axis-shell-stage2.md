# Axis workbench shell: Stage 2, the `src/vs/axis` layer

> Part of the Axis workbench shell design. The index, with the summary of decisions (§0), the layout (§1), risks (§7) and decisions (§8), is [`axis-shell.md`](axis-shell.md). This file holds §3 to §5 (the `src/vs/axis` layer, React plan, accessibility). Stage 2 as written here is superseded by [`axis-agent-shell.md`](axis-agent-shell.md) (ADR 0004); it is kept for reference, and the agent shell design builds on §3.2 to §3.10. Section numbers are those of the original single document, so a reference such as "`axis-shell.md` §3.10" resolves through the section map in the index.

## 3. Stage 2: the `src/vs/axis` shell layer

### 3.1 Files (all overlay)

```text
src/vs/axis/
  LAYERS.md, LAYOUT.md            layer and topology contract (as sessions/LAYERS.md, LAYOUT.md)
  axis.common.main.ts             browser: upstream common contribs (§3.5) + Axis contribs + overrides
  axis.desktop.main.ts            electron-browser: + desktop contribs; export { main } from ./electron-browser/axis.main.js
  axis.web.main.ts                browser: + web contribs
  axis.web.main.internal.ts       mirrors workbench.web.main.internal.ts / sessions.web.main.internal.ts:10-24; exports create
  browser/
    workbench.ts                  AxisWorkbench (grid, parts, restore, persistence)        ~1,500–2,200 LOC [I]
    axisLayoutService.ts          IAxisWorkbenchLayoutService = refineServiceDecorator(IWorkbenchLayoutService)
    layoutState.ts                sizes/visibility, StorageScope.WORKSPACE + StorageTarget.MACHINE
    web.main.ts                   AxisBrowserMain extends BrowserMain { createWorkbench }   (sessions/browser/web.main.ts:31-33)
    web.factory.ts                create()                                                  (sessions/browser/web.factory.ts:19-49)
    actions/axisLayoutActions.ts  focus/toggle/reset commands (§5)
    media/axisWorkbench.css       structural CSS scoped to .monaco-workbench.axis-workbench
  electron-browser/axis.main.ts   AxisDesktopMain extends DesktopMain { createWorkbench }; main()
  contrib/aiPanel/browser/        view container workbench.view.axis.ai (AuxiliaryBar) + empty-state view
  contrib/topBar/browser/         workspace switcher, agent activity indicator, account/model control
  test/browser/                   workbench, layoutState, topBar tests
src/vs/workbench/contrib/axis/browser/axisDefaults.contribution.ts   (Stage 1)
build/axis/eslint.axis.ts, build/axis/eslintCopilotStub.ts           (lint config modules)
extensions/theme-axis/**
```

The Axis-owned code is estimated at about 3–4.5k LOC [I], at the low end of the inventory's 3–8k. Most of the saving comes from reusing every part and the title service.

### 3.2 Bootstrap

**Desktop.**

1. `windowImpl.ts:1311-1318` loads `vs/code/electron-browser/workbench/workbench[-dev].html` [V]. This is unchanged.
2. Its bootstrap imports the workbench main at `code/electron-browser/workbench/workbench.ts:511-514` [V]. The patch points it at `vs/axis/axis.desktop.main.js`.
3. `axis.main.ts` defines `AxisDesktopMain extends DesktopMain` (the class is exported at `desktop.main.ts:73`; `open()` at `:118`) [V]. Its `createWorkbench()` returns `new AxisWorkbench(...)`.
4. The upstream service bootstrap in `DesktopMain.initServices` (file, storage, profiles, remote) **stays authoritative**. Axis does not copy it, unlike `sessions/electron-browser/sessions.main.ts`, which is a 420-line copy [V].

Why this approach:

- Reusing `workbench.html` keeps the upstream CSP and Trusted Types allow-list (`workbench.html:25-69`) [V].
- The only HTML change is the bundled CSS link at `:73` [V]. Dev CSS comes from the `cssDevService` scan of `out/**/*.css` (`platform/cssDev/node/cssDevService.ts:55`) [V], so it needs no change.

**Web (reh-web).**

1. The server serves `vs/code/browser/workbench/workbench[-dev].html` (`server/node/webClientServer.ts:388`) [V].
2. That page imports `create` statically from `workbench.web.main.internal.js` (`code/browser/workbench/workbench.ts:24`) [V]. The patch points it at `vs/axis/axis.web.main.internal.js`.
3. `BrowserMain` already exposes `protected createWorkbench()` (`workbench/browser/web.main.ts:262-264`) [V], and sessions overrides it (`sessions/browser/web.main.ts:31-33`) [V].
4. The `server-web` bundle is the `vs/code/browser/workbench/workbench` entry, CSS included (`build/next/index.ts:160-166,193-195`) [V]. So reh-web needs **no** build entry change.

### 3.3 `AxisWorkbench`

**Shape.**

- It is `class AxisWorkbench extends Disposable implements IAxisWorkbenchLayoutService`. Like sessions (`sessions/browser/workbench.ts:277`) [V], it does not subclass `Layout`.
- `startup()` follows sessions `:559-657` [V]: services → hover delegate → `initLayout` → `WorkbenchContributionsRegistry.start` / `EditorFactoryRegistry.start` → `WorkbenchContextKeysHandler` → listeners → `renderWorkbench` → `createWorkbenchLayout` → notifications → `layout()` → `restore()`.
- `initServices()` sets the layout service to `this`, then copies `getSingletonServiceDescriptors()` (`sessions/browser/workbench.ts:670-690`, `workbench/browser/workbench.ts:171-190`) [V].

**Part containers.**

- Create them exactly like upstream, as `div.part#<Parts id>` with the same roles: editor `main`, banner `banner`, status bar `footer`/`status`, others `none` (`workbench/browser/workbench.ts:326-341,349-359`) [V].
- This keeps upstream smoke-test selectors and screen-reader behaviour valid [I].
- The root gets `role="application"`, as at `layout.ts:1683` [V], plus `monaco-workbench axis-workbench`.

**Grid.**

- It uses `SerializableGrid.deserialize(descriptor, { fromJSON }, { proportionalLayout: false })`, as at `sessions/browser/workbench.ts:1559-1600` [V].
- Topology: a vertical root of [titlebar, banner, middle, statusbar]. The middle is a horizontal split of [activitybar, sidebar, center, auxiliarybar]. The center is a vertical split of [editor (flex, high priority), panel].
- Sizes and visibility persist **per workspace** (UX.md "Preserve user layout per workspace").

**Multi-window.** Port the auxiliary-window handling from `layout.ts:501-512` [V]: `onDidAddContainer`, per-window layout and style-loaded tracking. Sessions omits it (no `onDidOpenAuxiliaryWindow` in `sessions/browser/workbench.ts`) [V], but Axis needs "Move Editor into New Window".

**`IWorkbenchLayoutService` contract.** The interface is `layoutService.ts:492-734`; the `ILayoutService` base is `platform/layout/browser/layoutService.ts:26` [V].

| Member group | M3 behaviour |
|---|---|
| `ILayoutService` containers, dimensions, offsets and events; `layout`, `isRestored`/`whenRestored`, `registerPart`, `getContainer`, `isVisible`, `setPartHidden`, `hasFocus`, `focusPart`, `getVisibleNeighborPart`, `getSize`/`setSize`/`resizePart`, `getMaximumEditorDimensions`, window-maximized members | **Full** |
| `isSecondarySideBarVisible`/`toggleSecondarySideBar`, `toggleMaximizedPanel`/`isPanelMaximized`, `toggleMaximizedAuxiliaryBar`/`setAuxiliaryBarMaximized`/`isAuxiliaryBarMaximized` | **Full** |
| `isFloatingPanelsEnabled`, `isModernUICompact`, `hasMainWindowBorder`, `getMainWindowBorderRadius` | **Full**: read `LayoutSettings.*` (`layoutService.ts:45-60`) [V]. Upstream parts call these (`activitybarPart.ts:108-173`) [V] |
| `getSideBarPosition` | Always `LEFT` |
| `getPanelPosition`/`setPanelPosition`, `getPanelAlignment`/`setPanelAlignment` | `BOTTOM`/`center` only in M3. Other values log and keep the current one [I; upstream layout actions stay visible, R7] |
| `toggleMenuBar` | Delegate to the `window.menuBarVisibility` toggle, as upstream does |
| `isMainEditorLayoutCentered`/`centerMainEditorLayout` | Delegate to the main editor part's centered layout |
| `toggleZenMode`/`onDidChangeZenMode` | Unsupported: notify "not available in Axis" and never fire. Sessions does the same, as a no-op (`sessions/browser/workbench.ts:3091`) [V]. Excluded together with `workbench.zenMode.contribution` (§3.5) |
| `openedDefaultEditors` | `false` |

**Restore and lifecycle.** `restore()` must drive `LifecyclePhase.Restored` and then `Eventually` after editors and pane composites restore, as upstream does. Extension activation (`onStartupFinished`) depends on it [I; port from `sessions/browser/workbench.ts:1181` and `layout.ts`].

### 3.4 Parts, services and overrides

- **No Axis part is required in M3.** Every element in §1 reuses an upstream part.
- When an Axis-only surface needs a grid node, it is a `Part` with an Axis string id such as `'axis.parts.agentTimeline'`. `Part` takes `id: string` and self-registers (`part.ts:53-62`) [V].
- It is exposed through `IAxisWorkbenchLayoutService`, as sessions does with `IAgentWorkbenchLayoutService` (`sessions/browser/workbench.ts:177,273`) [V]. **Do not extend the `const enum Parts`.**

**Service overrides.** A later `registerSingleton` wins: entries are pushed in import order (`platform/instantiation/common/extensions.ts:25-37`) and `ServiceCollection.set` overwrites (`serviceCollection.ts:19-21`) [V]. Overrides must be imported **after** the upstream main imports.

| Service | M3 registration |
|---|---|
| `IWorkbenchLayoutService` / `ILayoutService` | `AxisWorkbench` instance, set in `initServices` |
| `ITitleService`, `IEditorGroupsService`, `IPaneCompositePartService`, `IStatusbarService`, `IBannerService` | **Upstream, unchanged** |
| Axis services (later milestones: agent activity model, account/model state) | `src/vs/axis/services/*`, `registerSingleton(..., Delayed)` |

### 3.5 Contribution set

**Phase A (bring-up).**

- `axis.desktop.main.ts` imports `vs/workbench/workbench.desktop.main.js` **wholesale**. That file imports `workbench.common.main.js` at `:15` [V]. Axis contribs and overrides follow.
- `axis.web.main.ts` does the same with `workbench.web.main.js`.
- Result: zero curation drift, and every service is present.

**Phase B (curated, task S2.8).**

- A post-apply hook (`code-oss/hooks/post-apply.d/NN-gen-axis-main`) generates `axis.common.main.ts` at apply time from upstream `workbench.common.main.ts` (`:6-492`) [V] **minus** the exclude list below.
- It **fails** when an exclude pattern no longer matches anything (a stale exclude).
- It prints every upstream import that is new since the last sync, so the sync PR records an include/exclude decision for each one.
- Defaulting to *include* protects service availability. A missing service is a runtime "unknown service" failure [I].

| Decision | Upstream imports (`workbench.common.main.ts`) | Reason |
|---|---|---|
| **Keep (ADR checklist)** | `editor.all` (`:8`), `extensionHost.contribution` (`:10`), `workbench.contribution` (`:11`), actions (`:22-32`), extension points (`:39-41`), parts (`:48-54`), **all services and `registerSingleton`s (`:59-195`)**, files/explorer (`:261-263`), search, searchView and searchEditor (`:273-277`), git (`:283`), scm (`:287-289`), debug (`:292-297`), markers (`:300`), quickaccess (`:258`), terminal.all (`:341`), tasks (`:353`), output and logs (`:255,337-338`), extensions and extensionsViewlet (`:333-334`), preferences and keybindings (`:216-218,369`), remote (`:356-357`, needed by reh-web), workspace/workspaces (trust) (`:454,457`), accessibility and accessibilitySignals (`:463,469`) | Editor, explorer, search, SCM, terminal, debug, diagnostics, quick access and the extension host must work (ADR 0002) |
| **Keep (extension compatibility)** | webview, webviewPanel, webviewView and customEditor (`:321-324`), notebook, interactive and repl (`:224,246,249`), testing (`:252`), comments (`:315`), inlineCompletions (`:270,481`), languageStatus, languageDetection, codeActions, format, folding, snippets, emmet, outline, call/type hierarchy, timeline, localHistory, mergeEditor, multiDiffEditor, bulkEdit, authentication, userDataProfile, themes, codeEditor, markdown, url, opener, externalUriOpener, mediaPreview, dropOrPasteInto, list, sash, modernUI | Extensions and core editing depend on these |
| **Keep, disabled by setting** | chat.shared, chat, agentHost, remoteAgentHost, chat.view, inlineChat, agentsVoice, mcp, mcp.view, chatSessions, chatContext, imageCarousel, speech (`:227-243`) | Other contribs inject chat services. Even sessions never drops `chat.shared`, `chatSessions`, `chatContext` and `mcp` (`sessions.common.main.ts:232-240`) [V]. `chat.disableAIFeatures` hides the UI (§2.2). Exclusion is a separate measured experiment (S2.8 stretch goal) |
| **Exclude** | `surveys/nps`, `surveys/languageSurveys` (`:393-394`) | Microsoft surveys; sessions excludes them too [V diff] |
| **Exclude** | `welcomeOnboarding` (`:404`), `welcomeAgentSessions` (`:398`), `chat/browser/onboarding/chatInputSpotlightTour` (`:409`) | Copilot-centred onboarding; sessions excludes them [V diff] |
| **Exclude** | `bracketPairColorizer2Telemetry` (`:466`) | Telemetry only; sessions excludes it [V diff] |
| **Exclude** | `browser/workbench.zenMode.contribution` (`:12`) | Zen mode is unsupported in the Axis layout (§3.3) |
| **Review at S2.8** | `remoteCodingAgents` (`:441`), `editSessions` (`:438`), `userDataSync` (`:432`), `update` (`:390`), `share` (`:475`), `editTelemetry` (`:487`), `welcomeGettingStarted`/`walkThrough` (`:397,399`) | Inert without Microsoft `product.json` stores and keys [I]. Remove only if startup measurements justify it |

`axis.desktop.main.ts` keeps all 38 desktop-only imports of `workbench.desktop.main.ts` in M3, except that it exports `main` from `./electron-browser/axis.main.js` (upstream export at `:226`) [V].

### 3.6 Upstream patches by range

Each hunk is wrapped in `// --- Start Axis ---` / `// --- End Axis ---` (`<!-- -->` in HTML), as ADR 0002 requires. An upstream file may appear in more than one range; each range counts it separately.

**Range `0001–0999`: shell layer (criterion 2).**

| # | File and anchor at 1.144.0 [V] | Intended hunk |
|---|---|---|
| P2 | `src/vs/workbench/electron-browser/desktop.main.ts:132-136,168` | Extract a hook that mirrors `web.main.ts:262` (see below) |
| P3 | `src/vs/code/electron-browser/workbench/workbench.ts:511-514` | `'../../../workbench/workbench.desktop.main.js'` → `'../../../axis/axis.desktop.main.js'`; `vs/workbench/workbench.desktop.main.js` → `vs/axis/axis.desktop.main.js` |
| P4 | `src/vs/code/electron-browser/workbench/workbench.html:73` | `href="../../../workbench/workbench.desktop.main.css"` → `href="../../../axis/axis.desktop.main.css"` |
| P5 | `src/vs/code/browser/workbench/workbench.ts:24` | `import { create } from '../../../axis/axis.web.main.internal.js';` |
| P6 | `build/next/index.ts:104-106` (`desktopEntryPoints`) and `:185-190` (desktop CSS set) | `+ 'vs/axis/axis.desktop.main',` in each. Optional: the CDN `web` target at `:168-172,198-201` |
| P7 | `build/gulpfile.vscode.ts:144-156` (`computeChecksums`) | `+ 'vs/axis/axis.desktop.main.js', 'vs/axis/axis.desktop.main.css',` |
| P8 | `eslint.config.js:14-15` imports, `:2366` end of the `code-import-patterns` targets, the `src/vs/code/~` target `:2004-2028`, and the end of `defineConfig(` | `+ import { axisImportPatternTargets, axisConfigs } from './build/axis/eslint.axis.ts';`, `+ ...axisImportPatternTargets,`, `+ { when: 'hasBrowser', pattern: 'vs/axis/axis.web.main.internal.js' },`, `+ ...axisConfigs,` |
| P9 | `build/filters.ts` `copyrightFilter` (`:176-235`) | `+ '!src/vs/axis/**', '!src/vs/workbench/contrib/axis/**', '!extensions/theme-axis/**', '!build/axis/**',`. ESLint enforces the Axis header for `.ts` instead |
| B1 | `src/vs/code/electron-main/app.ts`, after `initChannels` (`:782-784`) | ADR 0003 D6: import and start `axisMainSeam` (≤ 6 lines) |
| B2 | `src/vs/server/node/serverServices.ts` | ADR 0003 D6: register the `axis` tunnel channel (≤ 4 lines) |
| B3 | `build/next/index.ts` (shared with P6) | ADR 0003 D6: `+ 'vs/axis/daemon/node/axisDaemonMain',` (≤ 2 lines) |
| P10 | `src/vs/workbench/workbench.common.main.ts:489-492` | Restyle (ADR 0002 decision 2): `+ import './contrib/axis/browser/axisDefaults.contribution.js';`. **Temporary**: Stage 1 only, retired at S2.2, so it never coexists with P2–P9 in the final count |
| P11 (optional) | `services/themes/common/workbenchThemeService.ts:43-44` | Restyle: `COLOR_THEME_DARK`/`LIGHT` set to `Axis Dark`/`Axis Light`, for the first-run palette (§2.3) |
| P12 (optional) | `platform/theme/electron-main/themeMainServiceImpl.ts:23-26` | Restyle: `DEFAULT_BG_DARK/LIGHT` set to `#111214`/`#FAFAFB` |
| B4 | `eslint.config.js` (shared with P8) | ADR 0003's ≤ 40 target lines go into the overlay module `build/axis/eslint.axis.ts`, so P8's spread covers them. No extra upstream lines |

ADR 0003 estimated about 52 lines for B1–B4. Moving its ESLint targets into the overlay module brings that down to about 12 upstream lines. B1 and B2 are new files for this range. The bridge itself lands in Phase 1, but M3 reserves its share of the budget.

P2 pseudo-diff:

```diff
         // Create Workbench
-        const workbench = new Workbench(mainWindow.document.body, {
+        const workbench = this.createWorkbench(mainWindow.document.body, {
             extraClasses: this.getExtraClasses(),
             resetLayout: this.configuration['disable-layout-restore'] === true
         }, services.serviceCollection, services.logService);
@@
-    private registerListeners(workbench: Workbench, storageService: NativeWorkbenchStorageService): void {
+    private registerListeners(workbench: IDesktopMainWorkbench, storageService: NativeWorkbenchStorageService): void {
+    protected createWorkbench(...args: ConstructorParameters<typeof Workbench>): IDesktopMainWorkbench {
+        return new Workbench(...args);
+    }
+type IDesktopMainWorkbench = Pick<Workbench, 'startup' | 'onWillShutdown' | 'onDidShutdown'>;
```

This change is behaviour-neutral and could be offered upstream. That would retire P2.

Not needed, by design: `layout.ts`, `workbench.ts`, `browser/parts/*`, the `Parts` enum, `windowImpl.ts` and `web.main.ts` [V reasons above].

**Range `1000–1499`: rebrand and licensing guardrails (decision 5).**

| # | File | Hunk |
|---|---|---|
| G1 | `product.json` | §2.5. Measured here; `product.json` is excluded from criterion 2 |
| G2 | `build/lib/electron.ts:146-147` | `companyName` and `copyright` |
| G3 | `build/gulpfile.reh.ts:351` and `build/gulpfile.vscode.web.ts:49` | Replace `gulp.src(['remote/LICENSE'], { base: 'remote', allowEmpty: true })`, which copies a file that does not exist at the pin, with `gulp.src(['LICENSE.txt', 'ThirdPartyNotices.txt', 'licenses/**'], { base: '.', allowEmpty: true })`. The Axis `LICENSE` is added to all three targets the same way when it exists. Desktop already copies the notices (`gulpfile.vscode.ts:234`) [V] |

Assets (`resources/**`, `code-icon.svg`, letterpress) are overlay replacements, not patches.

**Range `1500–1999`: Copilot and agent-host removal.** These are the §2.7 edits. Under option (a) they cover:

- `build/next/index.ts:111-112,140-141`;
- `app.ts:767-769` and `:813`;
- `serverServices.ts:273-358` (always `UnavailableAgentHostChannel`);
- `package.json` and `remote/package.json`;
- `gulpfile.vscode.ts`, `gulpfile.reh.ts`, `gulpfile.vscode.linux.ts`;
- `compileCopilotExtensionBuildTask` in `gulpfile.vscode.ts:636` (import `:27`) and `gulpfile.reh.ts:567` (import `:26`), defined at `gulpfile.extensions.ts:282`;
- `build/npm/dirs.ts`, `build/next/build-fast.ts`, `.vscode-test.js`, `build/hygiene.ts`, `gulpfile.hygiene.ts`;
- for (a1), `src/tsconfig.json`;
- plus removal-manifest entries and regenerated lockfiles.

**Range `2000–2999`: security hardening (decision 7; threat model §8.4).**

| # | File and anchor [V] | Hunk | Threat |
|---|---|---|---|
| H1 | `src/vs/server/node/webClientServer.ts:144-158` (`createWorkbenchContentSecurityPolicy`) | Add `require-trusted-types-for 'script'; trusted-types <desktop allow-list>` copied from `workbench.html:50-68` | WEB-3 |
| H2 | same function, `:151` `frame-src 'self' https://*.vscode-cdn.net data:` | Replace `vscode-cdn.net` with the Axis webview origin. Paired with the `product.json` template (§2.5); otherwise every webview frame is blocked | WEB-4 |
| H3 | `webClientServer.ts:319-325` and `:488-494` (`cookie.serialize`) | `secure: true` when TLS is in use, detected by a fixed rule consistent with WEB-5: (1) the request socket itself is TLS, or (2) the operator passes an explicit launcher flag (for example `--axis-tls-terminated`) for a TLS-terminating proxy. `x-forwarded-proto` is honoured only from a configured trusted proxy address, never by default. Log a startup warning when `--host` is non-loopback and neither applies. Not `HttpOnly`: the client reads the token (`web.main.ts:325`) | WEB-2, WEB-5 |
| H4 (optional) | `platform/native/electron-main/nativeHostMainService.ts:731-737,788-790` | Allow-list `http`, `https` and `mailto` before `doOpenShellExternal`; log and refuse other schemes | EL-5 |

These are expected to be about 2 files and about 25 lines [I]. H1 must be checked against every web-only Trusted Types policy (web workers, the extension-host iframe) in S2.7 before it lands.

### 3.7 ESLint layer rules (`build/axis/eslint.axis.ts`, overlay)

- `code-import-patterns` expands `/~` to both `/<layer>/**` and `/test/<layer>/**` (`.eslint-plugin-local/code-import-patterns.ts:174-182`) [V], so tests are covered.
- Any `src/vs/**` file that matches no target is reported (`:68-71`) [V], so every Axis folder needs a target.
- The rules are allow-lists. Workbench targets do not list `vs/axis`, which keeps `workbench → axis` imports banned, unlike `vs/sessions` (`eslint.config.js:1953`) [V].

| Target | Layer | May import |
|---|---|---|
| `src/vs/axis/axis.common.main.ts` | browser | `vs/base/~`, `vs/base/parts/*/~`, `vs/platform/*/~`, `vs/editor/~`, `vs/editor/contrib/*/~`, `vs/editor/editor.all.js`, `vs/workbench/~`, `vs/workbench/api/~`, `vs/workbench/services/*/~`, `vs/workbench/contrib/*/~`, `vs/workbench/contrib/terminal/terminal.all.js`, `vs/workbench/workbench.common.main.js` (Phase A), `vs/axis/~`, `vs/axis/services/*/~`, `vs/axis/contrib/*/~` (as `eslint.config.js:2175-2194`) |
| `src/vs/axis/axis.desktop.main.ts` | electron-browser | The above, plus `vs/workbench/workbench.desktop.main.js`, `vs/axis/axis.common.main.js` |
| `src/vs/axis/axis.web.main.ts` | browser | The above, plus `vs/workbench/workbench.web.main.js`, `vs/axis/axis.common.main.js` |
| `src/vs/axis/axis.web.main.internal.ts` | browser | `vs/base/~`, `vs/platform/*/~`, `vs/axis/~`, `vs/axis/axis.web.main.js` |
| `src/vs/axis/~` (core) | per folder | `vs/base/~`, `vs/base/parts/*/~`, `vs/platform/*/~`, `vs/editor/~`, `vs/editor/contrib/*/~`, `vs/workbench/~` (covers `electron-browser/desktop.main.js`), `vs/workbench/browser/**`, `vs/workbench/services/*/~`, `vs/axis/~`, `vs/axis/services/*/~` (as `:2289-2302`) |
| `src/vs/axis/services/*/~` | per folder | Core minus `vs/workbench/browser/**`, plus `vs/workbench/contrib/*/~` (as `:2341-2366`, LAYERS.md:60-73) |
| `src/vs/axis/contrib/*/~` | per folder | Services plus `vs/workbench/browser/**` and `vs/axis/contrib/*/~` |

`axisConfigs` adds one flat-config block. For `src/vs/axis/**`, `src/vs/workbench/contrib/axis/**`, `build/axis/**` and `extensions/theme-axis/**`, it replaces `header/header` (`eslint.config.js:142-151`) [V] with the Axis proprietary header (D4):

```text
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
```

Upstream files keep their MIT headers, which this design never edits.

Files that are adapted from upstream (copied from sessions or `layout.ts`) keep the Microsoft MIT header and add an Axis modification notice plus an `Adapted from <path>@2c33b50` line. They get a separate `files` entry so the Microsoft header is still enforced. `layersChecker.ts` iterates `src/tsconfig.json` files (`:101,375-388`) [V], so `vs/axis` is checked with no change.

### 3.8 Build entry points

- **Desktop:** `vs/axis/axis.desktop.main` is the JS and CSS bundle (P6) and is checksummed (P7). The upstream `vs/workbench/workbench.desktop.main` stays bundled in M3, so the stock workbench remains buildable for A/B triage. Dropping it later saves bundle time and size.
- **reh-web:** no change. The `vs/code/browser/workbench/workbench` entry includes Axis through P5 [V].
- **Runtime-loaded assets:**
  - Assets referenced from CSS `url()` are bundled by esbuild's `file` loader (`build/next/index.ts:520-526`) [V].
  - Assets loaded at runtime through `FileAccess` URIs need curated patterns in `build/next/resources.ts:20-31`; sessions adds its own at `:29-30` [V].
  - M3 Axis UI loads **no** assets by URI: icons are codicons and CSS-referenced SVGs, and replaced upstream assets keep their listed paths (`:26-27`). If that changes, `resources.ts` is an eleventh shell file.
- **Packaging:** `vscode-darwin-x64-min` on the Intel development Mac (`vscode-darwin-arm64-min` on Apple silicon), `vscode-linux-x64-min`, `vscode-reh-web-linux-x64-min` (`gulpfile.vscode.ts:586-650`, `gulpfile.reh.ts:533-575`) [V, inventory].

### 3.9 Desktop vs web

| Concern | Desktop | Web (reh-web) |
|---|---|---|
| Entry | `axis.desktop.main` → `AxisDesktopMain` (P2/P3) | `axis.web.main.internal` → `AxisBrowserMain` (P5) |
| Title bar | `NativeTitleService` with window controls and the custom menubar on Win/Linux | `BrowserTitleService` with a hamburger menu |
| Extension host | Node utility process (inventory §6) | Remote node host on the server plus web worker [I] |
| Terminal, Git, file watcher | Local pty host, git extension | Through the remote server |
| Webviews | `vscode-webview://` | `webviewContentExternalBaseUrlTemplate`, which needs an Axis endpoint (R5) |
| CSP / Trusted Types | `workbench.html` meta (unchanged) | Server header without trusted-types (`webClientServer.ts:144-158`) [V] until H1 (range `2000–2999`) |
| Layering | Axis core is `browser/`; desktop-only code sits in `electron-browser/`, enforced by `local/code-layering` (`eslint.config.js:117-140`) [V] | Same code |

### 3.10 Upstream footprint estimate

| Range | Files | Changed lines (excluding markers) | Notes |
|---|---|---|---|
| **`0001–0999` shell (criterion 2)**: P2–P9 plus B1–B3 | **10** (8 + `app.ts`, `serverServices.ts`) | **~45** (≈75 with markers) | 2 files of headroom under 12 |
| `0001–0999` if in-pipeline React `.tsx` were adopted (§4) | +~9 → ~19 | +~50 | **Breaks criterion 2.** The no-JSX variant adds about 1–2 files |
| `0001–0999` with optional restyle P11/P12 | 10 → **12 of 12** | +4 | **At the limit**, with no headroom for `build/next/resources.ts` or the no-JSX React variant. Recommendation: do not land P11/P12 in M3 (the cost is a first-launch colour flash) unless the final count leaves room. P10 is temporary and is not counted after S2.2 |
| `1000–1499` rebrand and licensing (G1–G3) | 3, plus `product.json` | ~6, plus `product.json` | |
| `1500–1999` Copilot and agent host, option (a) | ~18–20 | ~100, plus removals and lockfile regeneration | Highest conflict risk: agentHost and the gulp files change often [I]. Option (c) would be larger (VSCodium: 29 files, ~3,567 lines) |
| `2000–2999` security hardening (H1–H4) | 2 | ~25 | No fixed budget (decision 7) |

**Shell plus bridge check (§8, budget alignment).**

- ADR 0003 D6 estimates about 4 files and 52 lines. Two of its files (`build/next/index.ts`, `eslint.config.js`) are already shell files, so it adds only 2 new files: `app.ts` and `serverServices.ts`.
- Counted **as ADR 0003 writes it**, with its ≤ 40 ESLint lines inline in `eslint.config.js`: **10 files and about 35 + 52 ≈ 87 lines**.
- With this design's overlay lint module: **10 files and about 45 lines**.
- Either way it is ≤ 12 files and ≤ 300 lines, leaving 2 files of headroom. Those 2 files are the constraint that rules out in-pipeline `.tsx` (§4), and they would be used up by P11/P12 or by `build/next/resources.ts` (§3.8).

`scripts/code-oss/footprint.sh` measures each range separately. It runs after `scripts/code-oss/apply.sh`, not as a hook, because it needs the completed apply stamp.

- It counts distinct upstream files and `+`/`-` lines across `code-oss/patches/NNNN-*`, reporting the four blocks separately: `0001–0999` shell, `1000–1499` rebrand and licensing (decision 5), `1500–1999` Copilot and agent host (decision 6), and `2000–2999` security hardening (decision 7). Marker lines are reported separately too.
- For criterion 2 it excludes `product.json` and `resources/**`.
- Every sync PR records its output (criteria 2–4).

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
