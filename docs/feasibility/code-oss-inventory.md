# Code OSS 1.144.0: technical inventory for Project Axis

- Source: `microsoft/vscode`, tag `1.144.0`. A shallow clone confirmed HEAD = `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.
- Method: read-only inspection with grep/sed/find/wc. No npm, node, gulp or repo scripts were run.
- Paths are relative to the repo root. Line numbers refer to that commit.
- Each claim is tagged **[V]** (VERIFIED: read in source) or **[I]** (INFERRED: reasoned from the source or from outside knowledge, not confirmed).
- Path letters (a)/(b)/(c) in §4 and §9 describe customization depth inside a fork. They are unrelated to the option letters A–D in `integration-alternatives.md` and ADR 0002.

---

## 1. Toolchain and build

### Versions
| Item | Value | Source |
|---|---|---|
| Node.js (dev/build) | `24.22.1` | `.nvmrc` [V] |
| Node.js check | Major must match; minor/patch must be >= `.nvmrc` (skip with `VSCODE_SKIP_NODE_VERSION_CHECK`) | `build/npm/preinstall.ts:12-39` [V] |
| Package manager | npm only (yarn rejected); npm must be < 13 | `build/npm/preinstall.ts:41-54` [V] |
| Electron | `43.8.3` (`target=`), `ms_build_id="15784459"`, `runtime=electron`, `build_from_source=true` | `.npmrc` [V]; also `cgmanifest.json:533-538` [V] |
| Electron fetch | From Electron's GitHub releases, unless `product.electronArtifactFeed` is set (it is `""` in OSS) | `build/lib/electron.ts:106-140`, `product.json:36` [V] |
| Remote/server Node | `24.22.1` | `remote/.npmrc` `target=` [V]; read by `build/gulpfile.reh.ts:59-64` [V] |
| Native addon headers | `node-gyp ^11.2.0`, installed into `build/npm/gyp`. It downloads Electron headers and overlays `build/npm/gyp/custom-headers` | `build/npm/gyp/package.json`, `build/npm/preinstall.ts:72,~123-160` [V] |
| Windows C++ | Visual Studio 2026 (folder `18`), 2022 or 2019 is required (`vs20xx_install` overrides the path) | `build/npm/preinstall.ts:63-70,79-120` [V] |
| Linux packages (CI) | `build-essential pkg-config libx11-dev libx11-xcb-dev libxkbfile-dev libnotify-bin libkrb5-dev` | `.github/workflows/pr.yml:237` [V]; test jobs add `libgtk-3-0 libgbm1 xvfb` (`pr-linux-test.yml:78-85`) [V] |
| Python | No pinned version for core. node-gyp 11 needs Python 3; CI pins `3.12` only for the in-repo copilot extension job (`pr.yml:818-822`); macOS CI installs `setuptools` (`pr-darwin-test.yml:91`) | [V] for the CI lines; the Python 3 requirement is [I] |
| macOS | Xcode command-line tools, needed for node-gyp | [I] (the wiki, which `CONTRIBUTING.md:95` links to, was not fetched) |
| Contributing docs | `CONTRIBUTING.md` defers build prerequisites to the GitHub wiki page "How to Contribute" | `CONTRIBUTING.md:95` [V] |

### Build system
- Gulp 4 (`package.json:232`) drives TypeScript build scripts run with `--experimental-strip-types` (`package.json:59`) [V].
- Bundling and transpiling moved to an esbuild pipeline in `build/next/` (`build/next/index.ts`). Gulp tasks call `runEsbuildBundle(...)` [V].
- `npm run compile` = `compile-client` + `compile-copilot`. `npm run watch` = `watch-client-transpile`, `watch-client`, `watch-extensions` and `watch-copilot` (`package.json:26,36`) [V].
- The esbuild entry points are hard-coded lists in `build/next/index.ts:104-196` [V]:
  - Desktop: `vs/workbench/workbench.desktop.main`, `vs/sessions/sessions.desktop.main`, `ptyHostMain`, `agentHostMain`, `extensionHostProcess`, `watcherMain`, and others.
  - Code: `vs/code/electron-browser/workbench/workbench`, `vs/sessions/electron-browser/sessions`, `sharedProcessMain`, `cliProcessMain`.
  - CSS bundle entries: `getCssBundleEntryPointsForTarget`.

### Gulp packaging targets (all [V])
| Family | Task names | Defined at |
|---|---|---|
| Desktop | `vscode-{win32-x64,win32-arm64,darwin-x64,darwin-arm64,linux-x64,linux-armhf,linux-arm64}[-min][-ci]`, plus `vscode`/`vscode-min` for the host platform | `build/gulpfile.vscode.ts:586-650` |
| Linux packages | `vscode-linux-{x64,armhf,arm64}-{prepare,build}-{deb,rpm}`, `...-prepare-snap`, `...-build-snap` | `build/gulpfile.vscode.linux.ts:294-320` |
| Windows installers | `vscode-win32-${arch}-${target}-setup`, `vscode-win32-{x64,arm64}-inno-updater` | `build/gulpfile.vscode.win32.ts:141,163-164` |
| Web | `vscode-web[-min][-ci]`, `esbuild-vscode-web[-min]`, `compile-web-extensions-build` | `build/gulpfile.vscode.web.ts:30-31,83-106` |
| Remote server | `vscode-reh-{platform}-{arch}[-min][-ci]` and `vscode-reh-web-...`. Platforms: win32 x64/arm64, darwin x64/arm64, linux x64/arm64, alpine arm64, linux-alpine | `build/gulpfile.reh.ts:46-57,533-575` |
| Core CI | `core-ci`, `core-ci-pr`, `compile`, `watch`, `compile-client`, `transpile-client` | `build/gulpfile.vscode.ts:81-89`, `build/gulpfile.ts:31-51` |
| Monaco / CLI | `compile-editor-esm`, `monacodts`, `compile-cli`, `watch-cli` | `build/gulpfile.editor.ts`, `build/gulpfile.cli.ts` |

### Dev entry points (all [V])
- `scripts/code.sh`:
  - Resolves the binary from `product.json` (`nameLong`/`nameShort`/`applicationName`) under `.build/electron/`.
  - Runs `node build/lib/preLaunch.ts`, which ensures `node_modules`, downloads Electron (`npm run electron`), runs `npm run compile` if `out/` is missing, and fetches built-in extensions.
  - Sets `NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1` and execs Electron on the repo root (`.`). The app entry is `package.json "main": "./out/main.js"` → `src/main.ts` → `src/mainImpl.ts:247` → `vs/code/electron-main/main.js`.
- `scripts/code-web.sh/.js` spawns `@vscode/test-web` against the local sources (`scripts/code-web.js:8,90-91`). This is browser-only, with no server.
- `scripts/code-server.sh/.js` spawns `out/server-main.js`, the REH server that also serves the web client (`scripts/code-server.js:43-46`).
- In dev mode, `VSCODE_DEV_SERVER_URL` can override the window URL (`src/vs/platform/windows/electron-main/windowImpl.ts:1312`).

### Source size (`src/vs`, `*.ts` incl. tests; [V] via find/wc)
| Layer | .ts files (non-test) | LOC (all .ts) | .css |
|---|---|---|---|
| base | 499 (315) | 161,600 | 39 |
| platform | 3,496 (2,556) | 1,057,347 (`agentHost/` alone 761,682) | 11 |
| editor | 877 (669) | 289,350 | 67 |
| workbench | 4,877 (3,443) | 1,854,969 (`contrib/chat` alone 742,435) | 295 |
| sessions (new layer) | 1,026 (623) | 456,220 | 97 |
| code | 22 (17) | 6,850 | 0 |
| server | 30 (22) | 7,307 | 0 |
| **all `src/**/*.ts`** | 11,036 | ~3.88M | |

- `extensions/` holds 96 extension folders. The in-repo `extensions/copilot` alone has 2,583 .ts files [V].
- AI-agent code (agentHost, chat, sessions) makes up about 2M of the ~3.9M LOC [V counts]. Most of it is outside what Axis needs [I].

---

## 2. Layering rules

- **Layer order:** `base → platform → editor → workbench → code / server → sessions` [V].
  - Source: `.github/instructions/source-code-organization.instructions.md:12-20`.
  - The same doc says "`workbench` must never import from `sessions`".
  - `eslint.config.js:1943-1955` does allow `vs/workbench/contrib/*/~` to import `vs/sessions/~` [V]. The prose rule and the lint config disagree.
- **Environment sub-layers** (`common`, `node`, `browser`, `electron-browser`, `electron-utility`, `electron-main`) are enforced by the `local/code-layering` rule (`eslint.config.js:117-140`; implementation in `.eslint-plugin-local/code-layering.ts`) [V]:
  - `browser` → `common`
  - `electron-browser` → `common`, `browser`
  - `electron-main` → `common`, `node`, `electron-utility`
- **Module import allow-lists** use `local/code-import-patterns` (`eslint.config.js:1631` onward, targets from about line 1762 to 2341). Each `target` glob lists the allowed `restrictions` [V]. Examples:
  - `src/vs/workbench/~` may import base, platform, editor, `workbench/~` and `workbench/services/*/~`, but not contrib (`:1886-1901`).
  - `workbench/contrib/*/~` may also import other contribs and `vs/sessions/~` (`:1943-1970`).
  - `src/vs/code/~` may import workbench only for `hasBrowser` (`:2004-2030`).
  - The sessions layer has its own targets (`:2175-2341`).
  - Each `*.main.ts` entry file has its own rule (`:2077-2140`).
- **Severity:** the rules are configured as `'warn'`, but `build/eslint.ts:104-105` throws if `warningCount > 0`. In practice they are errors in CI [V].
- **Type checks:** `npm run valid-layers-check` runs `build/checker/layersChecker.ts` and `layersTypeCheck.ts`, with per-layer `tsconfig.{browser,electron-browser,electron-main,electron-utility,node,worker}.json`. These block native-only types (e.g. `INativeEnvironmentService`) in browser code (`package.json:72`, `build/checker/`) [V].
- **Implication:** a fork that adds `src/vs/axis/**` must add matching `code-import-patterns` targets to `eslint.config.js`, or turn the lint off for the folder [V by analogy with the sessions targets]. This is a small, additive patch in a single file.

---

## 3. Workbench shell architecture

### DOM and layout construction (all [V])
- `src/vs/workbench/browser/workbench.ts` (442 lines): `class Workbench extends Layout` (`:66`).
  - `startup()` (`:111`) → `initServices()` (`:171`).
  - `initServices()` registers **the Workbench object itself as `IWorkbenchLayoutService`** (`:175`), then adds every `registerSingleton` descriptor (`:187-190`).
  - It then starts the contribution registry (`:142`) and calls `renderWorkbench()` (`:300-347`).
  - `renderWorkbench()` loops over a **hard-coded list of 8 parts** (`:326-341`): titlebar, banner, activitybar, sidebar, editor, panel, auxiliarybar, statusbar. For each it calls `createPart()`, which makes a `div.part#<id>` (`:350-360`), then `getPart(id).create(container)`.
- `src/vs/workbench/browser/layout.ts` (3,247 lines): `abstract class Layout`, which implements the whole `IWorkbenchLayoutService`.
  - `createWorkbenchLayout()` (`:1644-1700`) maps the 8 part IDs to views and calls `SerializableGrid.deserialize(this.createGridDescriptor(), …, { proportionalLayout: false })` (`:1676`).
  - `createGridDescriptor()` (`:2670`) builds a fixed topology: a vertical root of [titlebar, banner, middle section, statusbar]. The middle section is assembled by `arrangeMiddleSectionNodes`/`arrangeEditorNodes` (`:2559`) from activitybar, sidebar, editor, panel and auxiliarybar.
  - Visibility, maximize and zen mode all live here.
- The grid primitive is `src/vs/base/browser/ui/grid/grid.ts` (`SerializableGrid`), built on `splitview` and `sash` (`src/vs/base/browser/ui/`).
- The part base class is `src/vs/workbench/browser/part.ts`. Its constructor calls `layoutService.registerPart(this)` (`:62`), and the Layout keeps a map (`layout.ts:1257-1270`).
- Part IDs are a **`const enum Parts`** in `src/vs/workbench/services/layout/browser/layoutService.ts:21-32`. It already contains `SESSIONS_PART` and `CUSTOM_VIEW_GRID_PART`, added for the Agents Window.
- The layout service interface (`layoutService.ts:492`) has about 48 members.

### How parts are created (all [V])
| Part | File (lines) | Instantiated by |
|---|---|---|
| Titlebar | `parts/titlebar/titlebarPart.ts` (1,076) | `ITitleService`: `BrowserTitleService` (`workbench.web.main.ts:122`) / `NativeTitleService` (`services/title/electron-browser/titleService.ts:10`) |
| Editor | `parts/editor/editorPart.ts` (1,680) | `IEditorGroupsService` → `EditorParts` (`parts/editor/editorParts.ts:1042`) |
| Sidebar / Panel / Aux bar | `sidebar/sidebarPart.ts` (355), `panel/panelPart.ts` (226), `auxiliarybar/auxiliaryBarPart.ts` (313) | `PaneCompositePartService` creates all three (`parts/paneCompositePartService.ts:36-38,105`) |
| Activity bar | `activitybar/activitybarPart.ts` (873) | Created **inside** `SidebarPart` (`sidebarPart.ts:71`) |
| Statusbar | `statusbar/statusbarPart.ts` (1,073) | `IStatusbarService` (`:1073`) |
| Banner | `banner/bannerPart.ts` (326) | `IBannerService` (`:263`) |

These are wired in through side-effect imports in `src/vs/workbench/workbench.common.main.ts:48-54` [V].

**Coupling metrics [V]:**
- 126 non-test files in workbench and sessions import `IWorkbenchLayoutService`, 43 of them in `contrib/`.
- `Parts.*_PART` is referenced about 600 times. PANEL 110, EDITOR 102, AUXILIARYBAR 102, SIDEBAR 99, ACTIVITYBAR 59, STATUSBAR 55, TITLEBAR 51, BANNER 20.
- Features talk to the shell through the layout *service* API and through Part IDs, not through DOM.
- Consequence: a replacement shell must implement `IWorkbenchLayoutService` in a compatible way and keep the existing Part IDs meaningful [I].

### Desktop vs web entry points (all [V])
**Desktop:**
1. electron-main `windowImpl.ts:1311-1319` loads `vs/code/electron-browser/workbench/workbench[-dev].html`, or `vs/sessions/electron-browser/sessions[-dev].html` when `isSessionsWindow`.
2. The HTML runs `workbench.js` (`workbench.html:80`). `src/vs/code/electron-browser/workbench/workbench.ts:510-517` dynamically imports the **hard-coded URL `vs/workbench/workbench.desktop.main.js`**.
3. `workbench.desktop.main.ts` (226 lines) imports `workbench.common.main.ts` (492 lines: 120 contrib imports and about 107 service/browser imports) plus 38 desktop-only contribs.
4. `src/vs/workbench/electron-browser/desktop.main.ts:133` runs `new Workbench(mainWindow.document.body, …)`.

**Web:**
1. `src/vs/code/browser/workbench/workbench.ts` calls `create(...)` (`:623`) from `vs/workbench/browser/web.factory.ts:28`.
2. `web.factory.ts` reaches `src/vs/workbench/browser/web.main.ts:263`, which runs `new Workbench(domElement, …)`.
3. The `workbench.web.main.ts` (193 lines) and `workbench.web.main.internal.ts` (46 lines) entries supply web-only services.

### Upstream precedent: `src/vs/sessions` ("Agents Window") (all [V])
Upstream already ships a **second, alternative workbench shell** that reuses everything below it. It is the template closest to what Axis needs.
- It has its own entry points: `sessions.common.main.ts` (529 lines), `sessions.desktop.main.ts`, `sessions.web.main.ts`.
- It has its own HTML (`sessions/electron-browser/sessions.html`) and bootstrap (`sessions/electron-browser/sessions.ts`).
- `sessions/browser/workbench.ts` (3,205 lines) is `abstract class Workbench extends Disposable implements IAgentWorkbenchLayoutService` (`:277`). It is a full re-implementation of the layout service, **not** a subclass of `Layout`.
- It reuses `workbench/browser/part.ts`, `AbstractPaneCompositePart`, `MainEditorPartBase` and the notification components.
- It ships its own `TitlebarPart`, `SidebarPart`, `PanelPart`, `AuxiliaryBarPart`, `EditorPart` and new parts (`SessionsPart`, `ProjectBarPart`, `CustomViewGridPart`) under `sessions/browser/parts/`.
- It overrides services by registering later singletons, for example `IPaneCompositePartService` (`sessions/browser/paneCompositePartService.ts:123`), `IEditorGroupsService` (`sessions/browser/parts/editorParts.ts:55`) and `ITitleService` (`sessions/services/title/...:10`).
- `sessions/LAYOUT.md` documents the topology: no Activity Bar, Status Bar or Banner; part positions fixed and not user-configurable.
- It **curates** contributions: it imports 89 workbench contribs selectively, including files, search, scm, terminal and quickaccess. It replaces debug with `NullDebugService` (`sessions.common.main.ts:295-297`).
- **Upstream cost of the second window type:** `isSessionsWindow` appears in 117 non-test files. Additions also landed in the shared `Parts` enum, `windowImpl.ts`, `windowsMainService.ts`, `build/next/index.ts:106,121,188-189`, `build/gulpfile.vscode.ts:152-153` and `eslint.config.js`. Most of that cost comes from running *both* window types side by side. A fork that *replaces* the main shell needs far fewer touchpoints [I].

### Customization without patching (all [V], registration sites)
**Settings** (`src/vs/workbench/browser/workbench.contribution.ts` unless noted):
- `workbench.activityBar.location` = `default|top|bottom|hidden` (`:674`)
- `workbench.sideBar.location` (`:585`), `workbench.panel.defaultLocation` (`:597`), `workbench.statusBar.visible` (`:643`)
- `workbench.layoutControl.enabled` (`:803`), `window.commandCenter` (`:917`), `window.menuBarVisibility` (`:925`)
- `workbench.experimental.modernUI` plus density, frosted glass, tab style and uppercase-header settings (`:834`; keys in `layoutService.ts:45-60`). This is a floating-panels look (`layout.ts:635-641`).
- `window.titleBarStyle` = `native|custom`, default `custom`, APPLICATION scope (`workbench/electron-browser/desktop.contribution.ts:244-246`); `window.customTitleBarVisibility` (`:257`)
- `workbench.colorTheme` (default `Dark 2026`), `workbench.colorCustomizations`, `workbench.productIconTheme` (`services/themes/common/workbenchThemeService.ts:25-43`)

**Setting defaults:**
- Built-in code can call `Registry.as<IConfigurationRegistry>(...).registerDefaultConfigurations()` for any key (`platform/configuration/common/configurationRegistry.ts:524`), with no scope filter in the registry.
- *Extensions* (`contributes.configurationDefaults`) are limited to window, resource, machine-overridable and language scopes (`workbench/api/common/configurationExtensionPoint.ts:223-229`). They cannot set `window.titleBarStyle` (APPLICATION scope).
- The web embedder option `configurationDefaults` is also honoured (`services/configuration/browser/configuration.ts:48-49`).

**product.json** (schema `src/vs/base/common/product.ts`):
- Identity: `nameShort/nameLong/applicationName/dataFolderName/urlProtocol/darwinBundleIdentifier/win32*`.
- `builtInExtensions`; `extensionsGallery` (absent in OSS); `defaultChatAgent` (GitHub.copilot); `sessionsWindowAllowedExtensions`.
- Telemetry, update and survey URLs, `commandPaletteSuggestedCommandIds`, `onboardingThemes`, `onboardingKeymaps`, etc.

**Contribution APIs:**
- `registerWorkbenchContribution2(id, ctor, WorkbenchPhase.*)` (`workbench/common/contributions.ts:167`; phases `:40-61`).
- View containers and views: `ViewContainerLocation` = `Sidebar|Panel|AuxiliaryBar` only (`workbench/common/views.ts:39-43`).
- Menus on the titlebar: `MenuId.TitleBar`, `TitleBarAdjacentCenter`, `LayoutControlMenu`, `TitleBarContext`, `TitleBarTitleContext` (used in `titlebarPart.ts`).
- Status bar entries (`IStatusbarService.addEntry`).
- Theming participants (`platform/theme/common/themeService.ts:179`) and raw stylesheets (`base/browser/domStylesheets.ts:42`).

**Extension API** (`src/vscode-dts/vscode.d.ts`): `createWebviewPanel` (`:11547`), `registerWebviewViewProvider` (`:11752`), `registerCustomEditorProvider` (`:11791`), `createStatusBarItem` (`:11641`), plus color/icon/product-icon theme contributions.

### What definitely requires patching
Each of these has no registry hook [V]:
- The set of parts and the grid topology (`workbench.ts:326-341`, `layout.ts:1644-1700,2559,2670+`).
- The Parts enum.
- The bootstrap module URL (`code/electron-browser/workbench/workbench.ts:512-514`).
- The HTML/CSP (`workbench.html`).
- New `ViewContainerLocation` values.
- The activity bar living inside the sidebar part.
- Titlebar internal structure beyond its menus.

---

## 4. Dependency injection and services

- **Service registration** (all [V]):
  - `registerSingleton(id, ctor, InstantiationType.Eager|Delayed)` pushes onto a module-level array (`platform/instantiation/common/extensions.ts:25-37`).
  - `Workbench.initServices` copies the array into a `ServiceCollection` in import order (`workbench.ts:187-190`).
  - **A later registration for the same id overwrites an earlier one.** This is the mechanism `vs/sessions` uses to swap in its own `IEditorGroupsService`, `ITitleService` and `IPaneCompositePartService` [V by the registrations listed in §3; the override semantics are [I] from `ServiceCollection.set`].
  - Constructor injection uses `@IFoo` decorators, and `InstantiationService` builds the graph (`platform/instantiation/common/instantiationService.ts`) [V by usage].
- **Upstream's pattern for big features:** `contrib/chat` is about 742k LOC.
  - It is pure contribution: `workbench.common.main.ts:230-242,408-409` imports `chat.contribution.js` and others, plus `workbench.desktop.main.ts:196-197`. 25 files in `contrib/chat/browser` call `registerWorkbenchContribution2`. Its view container sits in `ViewContainerLocation.AuxiliaryBar` (`chatParticipant.contribution.ts:50`) [V].
  - Chat did still need small hooks in `layout.ts`: it imports `ChatAIDisabledSettingId` (`:19`), lists `chat.agentsControl.enabled`/`chat.unifiedAgentsBar.enabled` among layout-affecting settings (`:136-137`) and checks it at `:3050` [V].
  - Lesson: features fit in contribs; shell-level behaviour still leaks into layout.ts.
- **Can a contrib add a new Part without patching `layout.ts`?** No [V]. The Part list, the grid descriptor and the view map are closed. A contrib can only reuse the existing parts, through view containers, editors, status bar or menus. It can also open an *editor* (e.g. a webview or custom editor) or overlay DOM on `layoutService.mainContainer` [I].
- **Recommended fork layout, with minimal upstream edits [I].** Path letters match §9:
  - **Path (a), restyle only:** add `src/vs/workbench/contrib/axis/` holding:
    - `axis.contribution.ts` (default settings via `registerDefaultConfigurations`, theming participant, commands, status bar and titlebar menu items),
    - an `extensions/theme-axis` color/product-icon theme.
    - Upstream edits: 1 import line in `workbench.common.main.ts`, plus `product.json`.
  - **Path (b), separate shell layer (the sessions pattern):** add `src/vs/axis/` holding:
    - `axis.common.main.ts` (a curated copy of the imports in `workbench.common.main.ts`) and `axis.desktop.main.ts`,
    - `browser/workbench.ts` implementing `IWorkbenchLayoutService`, subclassing or reusing upstream Parts where possible,
    - `electron-browser/axis.ts` bootstrap,
    - overriding singletons registered *after* the upstream imports.
    - Upstream edits: listed in §9b.
  - **Path (b')** subclasses `Layout`/`Workbench` and overrides `createGridDescriptor`. This needs those `private` methods to become `protected`: a small patch, but in hot code that changes often.

---

## 5. UI technology

- **Vanilla TypeScript and DOM** [V]. Widgets live in `src/vs/base/browser/ui/`: actionbar, button, contextview, dialog, dropdown, grid, list, tree, table, menu, sash, scrollbar, splitview, toolbar, hover, inputbox, selectBox, toggle, etc. Many workbench parts also use the `observable` utilities (`vs/base/common/observable`) [I by convention].
- **No React or other UI framework in `src/`** [V]:
  - Root `package.json` has no `react|preact|vue|svelte|lit|solid-js` dependency.
  - Grepping for `from 'react'`-style imports in `src/**/*.ts` found only string literals inside test fixtures (`workbench/test/browser/componentFixtures/editor/findWidget.fixture.ts:21`) and diff-test `.tsx` fixtures.
  - React (`@fluentui/react-components`, `@types/react`) appears only in `extensions/copilot` `devDependencies` (`package.json:6901-6920`), for its test simulation workbench.
- **Theming** [V]:
  - Colors are registered with `registerColor(...)` (about 950 call sites; registry in `platform/theme/common/colorRegistry.ts` with `colors/*.ts`).
  - `colorThemeCss.ts:50` emits each color as a CSS custom property `--vscode-<id with dots→dashes>` (`platform/theme/common/colorUtils.ts:35-40`).
  - Workbench CSS consumes them through about 11,344 `var(--vscode-…)` references.
  - Restyling colors therefore needs **no patches**: a theme, `colorCustomizations` or a theming participant is enough.
  - Structural CSS (sizes, spacing, borders) lives in about 295 `.css` files under `workbench/` and does need overrides or patches.

---

## 6. Security posture inherited

- **Workbench BrowserWindow** [V]:
  - `defaultBrowserWindowOptions` (`platform/windows/electron-main/windows.ts:134-165`) sets `sandbox: true` (`:160`), `spellcheck: false`, `autoplayPolicy: 'user-gesture-required'`, `enableBlinkFeatures: 'HighlightAPI'` and `enableDeprecatedPaste: true` (TODO, `:161-163`).
  - `windowImpl.ts:787-796` adds `preload: vs/base/parts/sandbox/electron-browser/preload.js`, `additionalArguments: --vscode-window-config=<url>` and `v8CacheOptions`.
  - `contextIsolation` and `nodeIntegration` are **not set explicitly** for the workbench. Electron's defaults (contextIsolation=true, nodeIntegration=false) apply [I; the defaults are Electron behaviour]. The use of `contextBridge` confirms context isolation is on.
  - The `browserView` (integrated browser) sets them explicitly (`platform/browserView/electron-main/browserView.ts:146-152`).
- **Preload** [V]:
  - `preload.ts` exposes a minimal `vscode` global through `contextBridge.exposeInMainWorld('vscode', globals)` (`:252`). It wraps `ipcRenderer` send/invoke/on/once with `validateIPC`, which only allows channels starting with `vscode:` (`:16-17,110-160`).
  - Auxiliary windows use `preload-aux.ts` (`:53`; `auxiliaryWindowsMainService.ts:98`).
- **Main-side IPC validation** [V]: `validatedIpcMain` (`base/parts/ipc/electron-main/ipcMain.ts:106-148`) rejects a message when:
  - the channel does not start with `vscode:`,
  - the sender URL host is not `VSCODE_AUTHORITY` (dev localhost is allowed),
  - or the sender is not a main frame.
- **App resources** are served from the custom `vscode-file://` protocol (`platform/protocol/electron-main/protocolMainService.ts:53-62`, with special handling for `workbench.html` at `:109,128`) [V].
- **CSP** in `workbench.html` [V]: `default-src 'none'`, `script-src 'self' …`, `require-trusted-types-for 'script'`, plus a `trusted-types` allow-list.
- **Utility processes**, all Electron `utilityProcess.fork` through `platform/utilityProcess/electron-main/utilityProcess.ts:261` [V]:

| Process | Entry point | Launched by |
|---|---|---|
| Shared process | `vs/code/electron-utility/sharedProcess/sharedProcessMain` | `platform/sharedProcess/electron-main/sharedProcess.ts:148-174` |
| Extension host (one per window, `WindowUtilityProcess`) | `vs/workbench/api/node/extensionHostProcess` | `platform/extensions/electron-main/extensionHostStarter.ts:77-118` |
| Pty host | `vs/platform/terminal/node/ptyHostMain` | `platform/terminal/electron-main/electronPtyHostStarter.ts:51-62` |
| Agent host | `vs/platform/agentHost/node/agentHostMain` | `platform/agentHost/electron-main/electronAgentHostStarter.ts:202-212` |
| File watcher | `vs/platform/files/node/watcher/watcherMain` | `platform/files/node/watcher/watcherClient.ts:35` |

  - Web uses a web-worker extension host [I].

---

## 7. Built-in extensions

**`extensions/` folder (96 dirs)** [V]:
- Languages and grammars: bat, clojure, coffeescript, cpp, csharp, css, dart, diff, docker, dotenv, fsharp, go, groovy, handlebars, hlsl, html, ini, java, javascript, json, julia, latex, less, log, lua, make, markdown-basics, objective-c, perl, php, powershell, pug, python, r, razor, restructuredtext, ruby, rust, scss, shaderlab, shellscript, sql, swift, typescript-basics, vb, xml, yaml.
- Language features: css-, html-, json-, markdown-, php-language-features, **typescript-language-features**, markdown-math, mermaid-markdown-features, emmet, ipynb, notebook-renderers, search-result, references-view, simple-browser, prompt-basics.
- SCM and auth: **git**, git-base, github, github-authentication, microsoft-authentication, merge-conflict.
- Tasks and debug: **npm**, grunt, gulp, jake, **debug-auto-launch**, debug-server-ready, terminal-suggest, tunnel-forwarding.
- Themes: theme-defaults, theme-abyss, theme-kimbie-dark, theme-modern-icons, theme-monokai, theme-monokai-dimmed, theme-quietlight, theme-red, theme-seti, theme-solarized-dark, theme-solarized-light, theme-tomorrow-night-blue.
- Other: configuration-editing, extension-editing, **copilot** (GitHub `copilot-chat`, MIT `LICENSE.txt`).
- Test-only: vscode-api-tests, vscode-colorize-tests, vscode-colorize-perf-tests, vscode-test-resolver.

**Packaging rules** [V]:
- `build/lib/extensions.ts:313-326`: `nativeExtensions` = git and microsoft-authentication. `excludedExtensions` = copilot, the test extensions, `ms-vscode.node-debug` and `node-debug2`.
- `copilot` is excluded from the generic stream but **packaged separately whenever `extensions/copilot` exists** (`packageCopilotExtensionStream`, `:468-472`; task `compile-copilot-extension-build` in every desktop and REH target).
- Deleting that folder disables it.

**`product.json` `builtInExtensions`** (`:40-88`) [V]:

| Extension | Version | Repo |
|---|---|---|
| `ms-vscode.js-debug-companion` | 1.1.3 | microsoft/vscode-js-debug-companion |
| `ms-vscode.js-debug` | 1.140.0 | microsoft/vscode-js-debug |
| `ms-vscode.vscode-js-profile-table` | 1.0.11 | microsoft/vscode-js-profile-visualizer |

- Each entry has a sha256 and marketplace metadata (`publisherDisplayName: Microsoft`).
- Download source (`build/lib/builtInExtensions.ts:88-99`): from the **Marketplace** only if `product.extensionsGallery.serviceUrl` is set. OSS has no `extensionsGallery`, so they come from **GitHub releases**. Platform-specific VSIXs always come from GitHub.
- No extension gallery is configured in OSS. Axis would need Open VSX or its own gallery (and must not use the Microsoft Marketplace) [I].

---

## 8. Upstream cadence (GitHub releases API, fetched 2026-11-01) [V]

**Last 12 minor releases:**

| Version | Date |
|---|---|
| 1.144.0 | 2026-10-28 |
| 1.143.0 | 2026-10-22 |
| 1.142.0 | 2026-10-14 |
| 1.141.0 | 2026-10-07 |
| 1.140.0 | 2026-09-30 |
| 1.139.0 | 2026-09-23 |
| 1.138.0 | 2026-09-16 |
| 1.137.0 | 2026-09-09 |
| 1.136.0 | 2026-09-02 |
| 1.135.0 | 2026-08-26 |
| 1.134.0 | 2026-08-19 |
| 1.133.0 | 2026-08-12 |

**Recovery releases since May:** 1.143.1 (10-22), 1.141.1 (10-13), 1.141.2 (10-14), 1.139.1 (09-25), 1.136.1 (09-03), 1.136.2 (09-08), 1.132.1 (08-11), 1.129.1 (07-17), 1.128.1 (07-14), 1.124.2 (06-12), 1.123.1/1.123.2 (06-10), 1.122.1 (05-29), 1.119.1 (05-12).

- 1.119.0 (2026-05-06) to 1.144.0 (2026-10-28) is **25 minor releases in about 25 weeks: a weekly minor cadence**.
- 9 of the last 25 minors had at least one recovery release.
- Rebasing on every minor means about 52 rebases a year. A realistic fork policy is to rebase every 2–4 weeks onto the latest recovery build [I].

---

## 9. Implications for a custom shell

### Overall feasibility [I, based on the evidence above]
- Editor, explorer, search, SCM, terminal, debug, diagnostics/LSP, the command palette and the extension host are all contributions and services. They reach the shell only through `IWorkbenchLayoutService`, Part IDs, view-container locations and menus.
- The shell itself (`workbench.ts`, `layout.ts`, `browser/parts/*`) is a closed, hard-coded composition.
- Upstream's `vs/sessions` layer shows a full alternative shell can be built **beside** the workbench, reusing the Part classes and services, without forking feature code.
- That is the most rebase-friendly route to a truly custom shell.

### (a) Achievable with configuration and contributions only (0 upstream lines beyond 1 import and product.json)
- **Product identity:** names, data folder, URL protocol, bundle IDs, win32 IDs in `product.json`; app icons in `resources/` (file swaps).
- **Theme:** an Axis color theme, product-icon theme and file-icon theme as a built-in extension (`extensions/theme-axis`). The default comes from `registerDefaultConfigurations({ 'workbench.colorTheme': 'Axis Dark' })` in a built-in contrib.
- **Layout defaults:**
  - `workbench.activityBar.location: 'top'|'hidden'`, `workbench.statusBar.visible`, `workbench.layoutControl.enabled`, `window.commandCenter`
  - `window.titleBarStyle: 'custom'` (already the default), `window.menuBarVisibility`, `workbench.sideBar.location`, `workbench.panel.defaultLocation`
  - `workbench.experimental.modernUI` and its density/frosted settings, `workbench.editor.showTabs`, `breadcrumbs.enabled`
- **Titlebar and status bar contents:** actions in `MenuId.TitleBar`, `LayoutControlMenu`, `TitleBarAdjacentCenter`; status bar entries; custom view containers and views in Sidebar, Panel or AuxiliaryBar; webview views and custom editors for bespoke UI.
- **CSS restyle:** a contrib injects an Axis stylesheet (`createStyleSheet`) or a theming participant, with overrides scoped to `.monaco-workbench .part.titlebar` etc. This can change spacing, radii, fonts and borders, though it is fragile against upstream class renames.
- **Feature trimming:** remove `extensions/copilot`. Optionally comment out contrib imports in `workbench.common.main.ts`: a few lines, but they touch an often-edited file.
- **Footprint:** about 0–5 changed lines in upstream files, plus new files in `src/vs/workbench/contrib/axis/` and `extensions/theme-axis/`.

### (b) Small upstream patches for a separate Axis shell (the `vs/sessions` pattern)
New code lives in `src/vs/axis/**`: an estimated 3–8k LOC to start, using `sessions/browser/workbench.ts` (3,205 lines) as reference. Upstream files to touch:

1. `src/vs/code/electron-browser/workbench/workbench.ts:512-514`: import `vs/axis/axis.desktop.main.js` instead of the workbench main. Alternatively, `src/vs/platform/windows/electron-main/windowImpl.ts:1314-1318` could load a new `vs/axis/electron-browser/axis.html` (about 2–4 lines).
2. `build/next/index.ts:104-122,182-196`: add the axis entry points to `desktopEntryPoints`, `codeEntryPoints` and the CSS bundle set (about 4 lines).
3. `build/gulpfile.vscode.ts:147-153`: add `vs/axis/axis.desktop.main.{js,css}` to the packaged resources (about 2 lines).
4. `eslint.config.js`: `code-import-patterns` targets for `src/vs/axis/**` (about 40–80 additive lines, copied from the sessions targets at `:2175-2341`).
5. `src/vs/workbench/services/layout/browser/layoutService.ts:21-32`: **only if** Axis adds new Part IDs (1 line per part). Otherwise reuse existing IDs.
6. `build/lib/electron.ts:146-147`: `companyName` and `copyright` are hard-coded to Microsoft (2 lines). Also `product.json` and `resources/*` icons.
7. Web (optional): `src/vs/code/browser/workbench/workbench.ts` and `build/next/index.ts` web entry lists (about 5 lines).

- **Footprint:** about 6–8 upstream files and about 60–110 changed lines, mostly additive and at stable seams. Expect a rebase conflict about once a month [I].
- **Ongoing cost:** `IWorkbenchLayoutService` (about 48 members) changes upstream from time to time. The `vs/sessions` implementation breaking in the same release is an early-warning signal.

### (c) Deep patches (avoid; high rebase cost)
- **Changing the main workbench grid in place:** editing `layout.ts` (`createGridDescriptor` `:2670+`, `arrangeEditorNodes` `:2559`, visibility and maximize logic) and `workbench.ts:326-341`. layout.ts is 3,247 lines and edited by upstream almost weekly (chat/agents hooks are visible at `:19,136-137,3050`). Estimate: 300–1,500 changed lines, with conflicts on most rebases.
- **A new ViewContainerLocation** (e.g. an "activity rail" location): `ViewContainerLocation` is a `const enum` with 3 values (`workbench/common/views.ts:39-43`) consumed across views, the pane-composite service and the activity bar. Estimate: 20+ files.
- **Pulling the activity bar out of the sidebar** in the main workbench (`sidebarPart.ts:71`, `activitybarPart.ts` 873 lines, `paneCompositeBar.ts`). This could instead be done in an Axis-owned `SidebarPart` under path (b).
- **Rewriting titlebar internals** (`titlebarPart.ts` 1,076 lines; window controls, menubar, command center), when replacement in an Axis shell would do.
- **Changing Electron security settings or the preload/IPC model** (`windows.ts`, `windowImpl.ts`, `preload.ts`, `ipcMain.ts`). Not needed for a shell change; keep upstream defaults.

### Recommended path [I]
1. Start with path (a): theme, product.json and default settings. Fast, with almost no rebase cost.
2. Build path (b) in `src/vs/axis/` against the sessions template:
   - Reuse upstream `EditorParts`, `PaneCompositePartService` and the Part subclasses.
   - Override only `ITitleService` and the layout service.
   - Import a curated copy of `workbench.common.main.ts` so the editor, explorer, search, SCM, terminal, debug, markers, quick access and extension host all keep working.
3. Never edit `layout.ts` directly.
