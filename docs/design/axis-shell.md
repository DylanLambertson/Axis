# Axis workbench shell: design for Phase 0 M3

- **Status:** Draft for owner review. Implementation follows this document once accepted.
- **Date:** 2026-11-01
- **Upstream baseline:** Code OSS `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.
- **Inputs:** `docs/UX.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `assets/brand/`, ADR 0002 (proposed) and `docs/feasibility/{code-oss-inventory,integration-alternatives,licensing-and-marketplace}.md`.
- **Conventions:**
  - Upstream paths are relative to the Code OSS root at the baseline commit. `file:line` refers to that commit.
  - Axis repository paths start with `code-oss/` (M2 tooling: `code-oss/patches/NNNN-name.patch` and `code-oss/overlay/**`).
  - **[V]** means VERIFIED: read in source. **[I]** means INFERRED: reasoned, not proven by running anything. No upstream scripts were run.
  - "Patch" means a hunk that edits an existing upstream file. "Overlay" means a new file copied into the tree. "Removal" means a path the M2 apply script deletes (see §7.3).

## 0. Summary of decisions

1. **Layout.** UX.md's layout maps onto upstream parts that already exist (§1). The Axis shell reuses **every upstream part as-is** in M3 and owns only the grid, the layout service and its policy. None of the 8 upstream parts is subclassed. Part IDs are reused, so no new `Parts` enum value is needed.
2. **Stage 1 (restyle)** needs one patch line in an upstream TypeScript file, plus product.json, resources and the de-Copilot build edits (§2).
3. **Stage 2 (shell)** is a `src/vs/axis` layer modelled on `src/vs/sessions`.
   - Desktop boots through a subclass of the upstream `DesktopMain`. That needs one small refactor patch, mirroring the `createWorkbench` hook that web already has.
   - Web boots through a subclass of `BrowserMain`, with no patch to `web.main.ts`.
   - Shell footprint: **9 upstream files and about 35 changed lines (about 60 with markers)**, against the ADR budget of 12 files and 300 lines (§3.10).
4. **Contributions.** Bring-up imports the upstream `workbench.*.main` files **wholesale** and overrides services afterwards. It then switches to a generated, curated `axis.common.main.ts` driven by an explicit exclude list (§3.5).
5. **Copilot removal is the real footprint risk, not the shell.**
   - Deleting `extensions/copilot` breaks `eslint.config.js:15`, `build/npm/dirs.ts:18`, `npm run compile` and the hygiene and packaging steps.
   - Removing the root dependencies cascades into 114 import sites under `src/vs/platform/agentHost` and a top-level throw in `build/gulpfile.vscode.ts:44-51`.
   - This needs its own tracked budget (§2.7, §3.10).
6. **React is not used in M3 product UI.** Enabling `.tsx` touches about 9 more upstream build files, and React 19 ships CJS only while the bundler marks every package external. M3 runs a measured spike instead (§4).

## 1. Target layout mapped to parts

```text
┌ Top bar ── TITLEBAR_PART: workspace switcher · command/search · agent activity · account/model ┐
├ BANNER_PART (only when a banner is shown, e.g. Restricted Mode)                                  ┤
│ ACTIVITYBAR │ SIDEBAR_PART           │ EDITOR_PART (tabs, splits, diff, preview) │ AUXILIARYBAR │
│ (rail)      │ explorer/search/SCM/   ├───────────────────────────────────────────┤ AI panel     │
│             │ debug/extensions       │ PANEL_PART: terminal/problems/output       │ (hidden)     │
└ STATUSBAR_PART (kept; see decision D3) ─────────────────────────────────────────────────────────┘
```

| UX.md element | Part / mechanism | Reuse | Evidence and notes |
|---|---|---|---|
| Top bar container | `TITLEBAR_PART` through upstream `ITitleService` (`NativeTitleService`/`BrowserTitleService`) | **Reused as-is** | Registered at `services/title/electron-browser/titleService.ts:10` and `workbench.web.main.ts:122` [V]. Keeps the menubar, window controls, WCO and auxiliary-window title bars. |
| Workspace switcher | Action in `MenuId.CommandCenter`, order 0, placed left of the search box | Contribution | The command center renders `MenuId.CommandCenter` (`titlebar/commandCenterControl.ts:48`) [V]. A custom view item comes via `IActionViewItemService.register(menu, commandId, factory)` (`platform/actions/browser/actionViewItemService.ts:30`) [V]. |
| Command/search | Upstream command center | **Reused** | Created at `titlebarPart.ts:635` when `window.commandCenter` is on (default `true`, `workbench.contribution.ts:917-919`) [V]. |
| Agent activity indicator | `MenuId.TitleBar` action with a custom view item. M3 shows an "idle" state with a command | Contribution | `MenuId.TitleBar` is rendered at `titlebarPart.ts:644,815` [V]. |
| Account/model control | `MenuId.TitleBar` action next to the upstream Accounts entry | Contribution | Upstream moves Accounts and Manage into the title bar only when `workbench.activityBar.location` is `top` or `bottom` (`titlebarPart.ts:768-774,913-916`) [V]. Axis keeps them in the rail, so they stay discoverable. |
| Activity rail | Upstream `ActivitybarPart`, placed by the Axis grid as its own leaf | **Reused** | It is always created inside `SidebarPart` (`sidebar/sidebarPart.ts:71`) and registers itself as `Parts.ACTIVITYBAR_PART` (`activitybarPart.ts:191`, `part.ts:53-62`) [V]. "Collapsible" means `setPartHidden(true, ACTIVITYBAR_PART)`. |
| Explorer/search/Git | Upstream `SidebarPart` with upstream view containers | **Reused** | Created by `PaneCompositePartService` (`parts/paneCompositePartService.ts:36-38,105`) [V]. |
| Editor | Upstream `EditorParts`/`MainEditorPart` | **Reused** | `registerSingleton(IEditorGroupsService, EditorParts)` (`parts/editor/editorParts.ts:1042`) [V]. Sessions subclasses it only to force single-group behaviour (`sessions/browser/parts/editorParts.ts:16-55`) [V]. Axis does not need that. |
| Optional AI panel | Upstream `AuxiliaryBarPart` hosting an Axis view container `workbench.view.axis.ai` | **Reused**, plus Axis views | `ViewContainerLocation.AuxiliaryBar` is a contribution target [V, inventory §3]. Hidden by default. |
| Terminal/problems/output | Upstream `PanelPart`, bottom | **Reused** | Same service as above [V]. |
| Status bar (not in UX.md) | Upstream `StatusbarService` | **Reused** | `statusbarPart.ts:1073` [V]. Git branch, problems, language status and extension items live here. |
| Banner (not in UX.md) | Upstream `BannerPart` | **Reused** | `bannerPart.ts:263` [V]. Keeps the Restricted Mode warning, which is a security signal. |
| Grid, sizes, visibility, persistence | `AxisWorkbench` implementing `IWorkbenchLayoutService` | **Replaced** (Axis-owned) | Replaces `workbench.ts`/`layout.ts`, which Axis never edits. |

Features reach the shell only through the service interface. No workbench code imports `browser/layout.js` or casts to `Layout`: a grep for `instanceof Layout`, `as Layout` and imports of `browser/layout.js` returned nothing [V]. So a different implementation of `IWorkbenchLayoutService` is enough.

**Honest scope note [I].** Stage 1 alone already produces this topology, because it is upstream's default layout. Stage 2 is justified by three things:

- ADR 0002's M3 validation criteria;
- future Axis-only surfaces that need grid nodes, such as an agent timeline or review queue (§3.4);
- decoupling from weekly `layout.ts` churn.

The owner should confirm that this justifies Stage 2 in Phase 0 (decision D7).

## 2. Stage 1: restyle only

### 2.1 Placement rule

- Axis code that must also work in the **stock** workbench lives in `src/vs/workbench/contrib/axis/**`, as an overlay. The existing `src/vs/workbench/contrib/*/~` lint target already covers it [V, `eslint.config.js:1943-1970`].
- It is wired in by **one import line** in `src/vs/workbench/workbench.common.main.ts`, after the "Opener" import at `:489-490` [V].
- Shell-only code lives in `src/vs/axis/**` (Stage 2). Its entry points import the Stage 1 contribution as well.

### 2.2 Default settings to register

File: `src/vs/workbench/contrib/axis/browser/axisDefaults.contribution.ts`.

- It calls `Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{ overrides, source: 'axisDefaults', preventExperimentOverride: true }])`.
- The API is at `configurationRegistry.ts:524`, with fields at `:397-402` [V]. The same pattern is used at `sessions/contrib/configuration/browser/configuration.contribution.ts:39-46` [V].
- Built-in code is not limited by the extension scope filter, so APPLICATION-scoped keys work [V, inventory §3].

| Key | Axis default | Upstream default / registration | Why |
|---|---|---|---|
| `workbench.colorTheme` | `Axis Dark` | `isWeb ? Light 2026 : Dark 2026` (`services/themes/common/themeConfiguration.ts:38`) [V] | Brand |
| `workbench.preferredDarkColorTheme` / `preferredLightColorTheme` | `Axis Dark` / `Axis Light` | `:48` / `:58` [V] | OS auto-detect |
| `workbench.activityBar.location` | `default` (vertical rail) | `default`; `workbench.contribution.ts:674-686` [V] | Explicit, because the Axis shell requires it |
| `workbench.sideBar.location` / `workbench.panel.defaultLocation` | `left` / `bottom` | `:585` / `:597` [V] | UX layout |
| `workbench.secondarySideBar.defaultVisibility` | `hidden` | enum at `:616-618` [V] | The AI panel is optional |
| `workbench.statusBar.visible` | `true` | `:643` [V] | D3 |
| `window.commandCenter` / `workbench.layoutControl.enabled` | `true` / `true` | `:917-919` / `:803` [V] | Top-bar search; panel toggles |
| `workbench.experimental.modernUI` | `true` | `true` with `experiment: { mode: 'auto' }` (`:834-838`) [V] | Floating parts, 6–8px radii |
| `window.density.layout` | `compact` | `:260` [V] | Dense UI; no gaps between cards [I visual; validate] |
| `workbench.shadows` | `false` | `:829` [V] | "Near-zero shadows" |
| `workbench.startupEditor` / `workbench.welcomePage.walkthroughs.openOnInstall` | `none` / `false` | `welcomeGettingStarted/browser/gettingStarted.contribution.ts:317` / `:311` [V] | Upstream walkthroughs are VS Code- and Copilot-branded |
| `chat.disableAIFeatures` | `true` | `false`, WINDOW scope (`chat/browser/chat.shared.contribution.ts:2437-2442`) [V] | Hides built-in Copilot UI. It also disables the agent host (`platform/agentHost/browser/agentHostEnablementService.ts:32-33`) [V] |
| `telemetry.telemetryLevel` / `telemetry.feedback.enabled` | `off` / `false` | `platform/telemetry/common/telemetryService.ts:337` / `:381` [V] | Belt and braces. OSS already reports no telemetry (licensing doc §5) |
| `workbench.settings.enableNaturalLanguageSearch` | `false` | `preferences/common/preferencesContribution.ts:111` [V] | Online service |
| `editor.fontSize` | `13` | editor option | UX.md "13–14px standard UI" [I design] |

### 2.3 Built-in color theme `extensions/theme-axis`

**Packaging.** Packaging is automatic: `build/lib/extensions.ts:416` globs `extensions/*/package.json`. A JSON-only extension needs no entry in `build/gulpfile.extensions.ts` or `build/npm/dirs.ts` [V]. With no `main`, it should also be included in web builds [I].

**`package.json` `contributes.themes`.** This mirrors `extensions/theme-defaults/package.json:17-26` [V]:

```json
{ "id": "Axis Dark",  "label": "%axisDark%",  "uiTheme": "vs-dark", "path": "./themes/axis-dark.json" },
{ "id": "Axis Light", "label": "%axisLight%", "uiTheme": "vs",      "path": "./themes/axis-light.json" }
```

**Files and syntax colours.**

- `themes/axis-{dark,light}.json` hold `"colors"`. Each one `include`s `./axis-{dark,light}-syntax.json`.
- The syntax files are an MIT snapshot of the flattened `tokenColors` and `semanticTokenColors` from the include chains `2026-dark → dark_modern → dark_plus → dark_vs` and `2026-light → light_modern → light_plus → light_vs`. Each include is declared at line 4 of its file [V].
- An include is resolved relative to the including file (`colorThemeData.ts:784-785`) [V]. Including across extensions (`../../theme-defaults/...`) would work on desktop but is fragile [I], so the snapshot stays inside the extension.
- High contrast stays on the upstream `Default High Contrast` themes.

**Token mapping.** Hex values come from UX.md. Values marked * are **proposed** because UX.md does not define them; they need UX sign-off (D6).

| UX token | Dark | Light | Color-registry ids (registration [V]) |
|---|---|---|---|
| canvas (frame) | `#111214` | `#FAFAFB` | `titleBar.activeBackground` (`workbench/common/theme.ts:781`), `titleBar.inactiveBackground`, `activityBar.background` (`:407`), `statusBar.background` (`:303`), `statusBar.noFolderBackground` |
| surface (content) | `#181A1D` | `#FFFFFF` | `editor.background` (`platform/theme/common/colors/editorColors.ts:19`), `sideBar.background` (`theme.ts:625`), `panel.background` (`:497`), `terminal.background` (`contrib/terminal/common/terminalColorRegistry.ts:18`), `editorGroupHeader.tabsBackground` (`theme.ts:221`), `tab.activeBackground` (`:32`), `tab.inactiveBackground` (`:36`), `sideBarSectionHeader.background`, `commandCenter.background` (`:847`) |
| raised | `#202227` | `#FFFFFF` + border | `editorWidget.background` (`editorColors.ts:49`), `quickInput.background` (`colors/quickpickColors.ts:17`), `menu.background` (`colors/menuColors.ts:25`), `notifications.background`, `keybindingLabel.background` (`colors/inputColors.ts:212`), `button.secondaryBackground`, `checkbox.background` (`inputColors.ts:181`), `list.hoverBackground` (`colors/listColors.ts:65`), `toolbar.hoverBackground` (`editorColors.ts:350`), `commandCenter.activeBackground` (`theme.ts:853`) |
| border (decorative) | `#2B2E34` | `#E5E7EB` | `panel.border` (`theme.ts:499`), `sideBar.border` (`:634`), `titleBar.border` (`:799`), `statusBar.border` (`:324`), `editorGroup.border` (`:241`), `tab.border`, `widget.border` (`editorColors.ts:343`), `editorWidget.border`, `commandCenter.border` (`theme.ts:860`) |
| control border* | `#61666F` | `#8A8F98` | `input.border` (`inputColors.ts:28`), `checkbox.border`. These must reach 3:1 (WCAG 1.4.11). The decorative border reaches only 1.4:1 / 1.2:1 [I computed] |
| text primary | `#E8E9EB` | `#17191D` | `foreground` (`colors/baseColors.ts:13`), `editor.foreground` (`editorColors.ts:23`), `tab.activeForeground`, `titleBar.activeForeground`, `activityBar.foreground`, `list.activeSelectionForeground`, `settings.headerForeground` (`contrib/preferences/common/settingsEditorColorRegistry.ts:12`), `button.secondaryForeground`, `editorCursor.foreground` |
| text secondary | `#9A9EA7` | `#50555F`* | `descriptionForeground` (`baseColors.ts:29`), `icon.foreground`, `tab.inactiveForeground`, `activityBar.inactiveForeground`, `statusBar.foreground`, `titleBar.inactiveForeground`, `editorLineNumber.activeForeground`, `commandCenter.foreground` (`theme.ts:828`) |
| text muted | `#70757F` | `#6B7280`* | `disabledForeground` (`baseColors.ts:21`), `input.placeholderForeground`, `editorLineNumber.foreground`. Dark muted is **4.0:1** on canvas [I computed], so it must not be used for body text |
| accent (filled) | `#5823F6` | `#5823F6` | `button.background` (`inputColors.ts:121`); `button.foreground` `#FFFFFF` (`:113`, 7.0:1); `activityBarBadge.background` (`theme.ts:458`) with `#FFFFFF` foreground; `statusBarItem.remoteBackground` |
| accent-on-dark / accent (text, focus) | `#9776F9` | `#5823F6` | `focusBorder` (`baseColors.ts:37`), `textLink.foreground` (`:56`), `textLink.activeForeground`, `list.focusOutline` (`listColors.ts:25`), `inputOption.activeBorder`, `activityBar.activeBorder` (`theme.ts:435`), `tab.activeBorderTop` (`:128`), `panelTitle.activeBorder`, `progressBar.background` (`colors/miscColors.ts:75`), `sash.hoverBorder` (`miscColors.ts:18`) |
| accent tint* | `#9776F926` | `#5823F614` | `list.activeSelectionBackground` (`listColors.ts:33`), `list.inactiveSelectionBackground`, `menu.selectionBackground`, `quickInputList.focusBackground`, `selection.background` (`#9776F940` / `#5823F626`) |
| derived* | `#4A1AD6` | `#4A1AD6` | `button.hoverBackground` (`inputColors.ts:125`); `scrollbarSlider.background` `#9A9EA733` / `#50555F33` (`miscColors.ts:56`); `badge.background` = raised, with text-primary foreground (`miscColors.ts:25`), so the accent stays reserved for interaction |
| status | inherited | inherited | `errorForeground` (`baseColors.ts:25`), `editorError/Warning/Info.foreground` (`editorColors.ts:70,83,96`), `statusBar.debuggingBackground`: keep the 2026 values, then verify contrast in task S1.4 |

`contrastBorder` and `contrastActiveBorder` (`baseColors.ts:41,45`) stay unset outside the HC themes.

**First-run behaviour [V/I].**

- The pre-load palette applies only when the setting equals the upstream constants (`services/themes/browser/workbenchThemeService.ts:156`, constants at `common/workbenchThemeService.ts:42-50`) [V]. On the **first** launch Axis therefore paints an unloaded OS-scheme theme until extensions register (`:163-185`) [V].
- Later launches use the cached `colorThemeData` from storage (`:149-153`) [V].
- The Electron window background before the renderer loads is `#1F1F1F`/`#FFFFFF` (`platform/theme/electron-main/themeMainServiceImpl.ts:23-26`) until the stored background exists [V].
- Fixing both is optional polish: about 4 lines in 2 files (§3.10, P10/P11). The large `*_INITIAL_COLORS` maps (`common/workbenchThemeService.ts:73-365`) are **not** replaced.

### 2.4 Product icon theme

- Keep the upstream `Default` product icon theme (codicons). `workbench.productIconTheme` has a single enum value, `Default` (`themeConfiguration.ts:114-116`) [V].
- The codicon font comes from `@vscode/codicons` (`package.json:117`, copied by `build/lib/compilation.ts:372-384`) [V]. `extensions/theme-modern-icons` is a **file** icon theme (`package.json:15-22`) [V], so it is unrelated.
- Axis UI registers its own icon ids with codicon fallbacks through `registerIcon(...)`, for example `axis-agent-activity` → `Codicon.pulse` and `axis-workspace` → `Codicon.repo`. A future `contributes.productIconThemes` entry (`themeExtensionPoints.ts:84-110`) [V] can then restyle Axis icons by id with no code change. No icon font work is planned in M3.

### 2.5 product.json identity

These edits go in a dedicated patch that is excluded from the ADR budget. Current values are at `product.json:2-39,90-249` [V, licensing doc §2]. `<rdns>` is the owner's reverse-DNS prefix (D4).

| Keys | Axis value |
|---|---|
| `nameShort`, `nameLong` | `Axis` |
| `applicationName`, `linuxIconName`, `urlProtocol` | `axis` |
| `dataFolderName`, `sharedDataFolderName`, `serverDataFolderName` | `.axis`, `.axis-shared`, `.axis-server` |
| `serverApplicationName`, `tunnelApplicationName` | `axis-server`, `axis-tunnel` |
| `win32DirName`, `win32NameVersion`, `win32RegValueName`, `win32ShellNameShort` | `Axis`, `Axis`, `Axis`, `&Axis` |
| `win32MutexName`, `win32TunnelServiceMutex`, `win32TunnelMutex` | `axis`, `axis-tunnelservice`, `axis-tunnel` |
| `win32x64AppId`, `win32arm64AppId`, `win32x64UserAppId`, `win32arm64UserAppId`, `darwinProfileUUID`, `darwinProfilePayloadUUID` | Fresh GUIDs, generated **once** and recorded in the patch so installers never collide with Code OSS |
| `win32AppUserModelId`, `darwinBundleIdentifier`, `linuxDesktopName` | `<rdns>.Axis`, `<rdns>.axis`, `<rdns>.Axis` |
| `licenseName`, `licenseUrl`, `serverLicenseUrl`, `reportIssueUrl` | Axis values (**LEGAL REVIEW**) |
| `webviewContentExternalBaseUrlTemplate`, `voiceWsUrl` | Remove `voiceWsUrl`. Set the webview template to an Axis-hosted endpoint: web falls back to `vscode-cdn.net` if it is absent (`services/environment/browser/environmentService.ts:241-243`) [V]. See R5 |
| `defaultChatAgent` | **Replace with an inert stub** (empty ids, no URLs). Do not delete it: the field is non-optional (`base/common/product.ts:282`) [V] and is dereferenced unguarded at `extensionGalleryService.ts:2047`, `abstractExtensionManagementService.ts:1223`, `extensionsWorkbenchService.ts:995,2854` and `services/accounts/browser/defaultAccount.ts:98-103` [V] |
| `trustedExtensionAuthAccess`, `builtInExtensionsEnabledWithAutoUpdates` | Drop the `GitHub.copilot-chat` entries |
| `onboardingThemes`, `onboardingKeymaps` | Themes point at `Axis Dark`/`Axis Light` (`:207-244`). Keymaps relabel `"VS Code"` (`:170-206`) |
| `extensionsGallery` | Open VSX or self-hosted (licensing doc §3). The URL choice is a business decision |
| `agentsTelemetryAppName`, `sessionsWindowAllowedExtensions` | Remove / keep `[]` |

### 2.6 Icons and images from `assets/brand/axis-app-icon.svg`

- Generate the assets with `code-oss/scripts/gen-icons.sh` (rsvg-convert, ImageMagick and `iconutil` on macOS). **Commit the outputs** under `code-oss/overlay/resources/**`, so builds need no image toolchain and reviewers see the bytes [I recommendation].
- These are asset replacements: the overlay overwrites upstream files (requirement on M2, §7.3).

| Target (upstream path) | Sizes / format | Referenced by [V] |
|---|---|---|
| `resources/darwin/code.icns` | iconset 16, 32, 64, 128, 256, 512 and 1024 px (`icon_NxN` and `@2x`) | `build/lib/electron.ts:149` |
| `resources/darwin/{bat,…,yaml}.icns` (28 document icons) | Same iconset. Generic Axis document icon, with the mark on a page | `build/lib/electron.ts:77,101` |
| `resources/win32/code.ico` | 16, 20, 24, 32, 40, 48, 64 and 256 px (upstream has only 4 sizes [V]) | `gulpfile.vscode.ts:318`, `gulpfile.vscode.win32.ts:158`, `build/win32/code.iss:25` |
| `resources/win32/*.ico` (28 document icons) and `sessions.ico` | 16–256 | `gulpfile.vscode.ts:316-344` |
| `resources/win32/code_70x70.png`, `code_150x150.png` | 70², 150² | `gulpfile.vscode.ts:345-346`, `VisualElementsManifest.xml:5-6` |
| `resources/win32/inno-big-{100,125,150,175,200,225,250}.bmp` | 164×314, 192×386, 246×459, 273×556, 328×604, 355×700, 410×797 | `build/win32/code.iss:23` |
| `resources/win32/inno-small-{…}.bmp` | 55×55, 64×68, 83×80, 92×97, 110×106, 119×123, 138×140 | `code.iss:24` |
| `resources/linux/code.png`, `resources/linux/rpm/code.xpm` | 1024² (matches upstream) [V] | `gulpfile.vscode.linux.ts:74,187,218,267` |
| `resources/server/code-192.png`, `code-512.png` | **192², 512²**: the upstream files are wrongly 1024² [V] | `gulpfile.reh.ts:378-381`, `gulpfile.vscode.web.ts:58-62` |
| `resources/server/favicon.ico` | 16, 24, 32, 48, 64 | same |
| `resources/server/manifest.json` | `name`/`short_name` = `Axis` | same |
| `src/vs/workbench/browser/media/code-icon.svg` | `axis-mark.svg` | `titlebarpart.css:297`, `bannerpart.css:33`, `gettingStarted.css:9` and others |
| `src/vs/workbench/browser/parts/editor/media/letterpress-{light,dark,hcLight,hcDark}.svg` | Monochrome mark at the upstream opacity | `editorgroupview.css:134-150` |

`build/lib/electron.ts:146-147` hard-codes `companyName`/`copyright` as Microsoft [V]. That is a 2-line patch in the rebrand bucket.

### 2.7 Copilot removal

| Item | Mechanism | Stage | Evidence [V] |
|---|---|---|---|
| `extensions/copilot/**` (2,583 .ts files) | **Removal manifest**, not a patch. A deletion patch would carry every deleted line and conflict on every sync | S1.2 | `packageCopilotExtensionStream` is guarded by `existsSync` (`build/lib/extensions.ts:470-472`) |
| `eslint.config.js:15` imports `./extensions/copilot/.eslintplugin/index.ts` | Patch: point it at an overlay stub `build/axis/eslintCopilotStub.ts` (`{ rules: {} }`). The copilot block at `:2649-2800` then matches no files [I; verify] | S1.2 | `:15,:2661` |
| `build/npm/dirs.ts:18` `'extensions/copilot'` | Patch: delete the line (postinstall spawns `npm install` in each dir) | S1.2 | `postinstall.ts:57-65` |
| Root `package.json` scripts `compile` (`:26`), `compile-copilot` (`:28`), `watch`/`watch-transpile` (`:36-37`), `watch-copilot*` (`:55-57`), `copilot:*` (`:94-95`) | Patch | S1.2 | `npm run compile` = `compile-client` + `compile-copilot` |
| `build/hygiene.ts:34-41` reads `extensions/copilot/package.json` with no guard; callers at `:356-360` and `build/gulpfile.hygiene.ts:50-52` | Patch: guard with `existsSync` | S1.2 | |
| `build/lib/copilot.ts:276-278` throws when the SDK dir is missing; called by `gulpfile.vscode.ts:556-569,609` and `gulpfile.reh.ts:523-552` | Patch the call sites: skip when `extensions/copilot` is absent | S1.2 (packaging) | |
| `build/gulpfile.vscode.linux.ts:26` reads `resources/linux/copilot-link.sh` with no guard (`:109,114`) | Patch | S1.2 | |
| `build/next/build-fast.ts:21-26,143-144`, `.vscode-test.js:93-94` | Patch | S1.2 | |
| `product.json` `defaultChatAgent`, `trustedExtensionAuthAccess`, `builtInExtensionsEnabledWithAutoUpdates` | product.json patch (§2.5) | S1.1 | |
| Root `package.json:106` `@github/copilot-sdk`, `:118` `@vscode/copilot-api`, `:330` `copilotRuntimeVersion`; `remote/package.json:7,12,82` | Patch, then regenerate lockfiles (§2.8) | **S1.3, decision D1** | |
| `build/gulpfile.vscode.ts:44-51` top-level copilot runtime check (throws on every gulp run once the SDK is gone); `:53-60,209-211,255-262,272,431-443`; `gulpfile.reh.ts:362-367` | Patch | S1.3 | |
| `src/vs/platform/agentHost/**`: 97 `@github/copilot-sdk` and 17 `@vscode/copilot-api` import lines (51 + 4 non-test); `CAPIClient` is a value import in `node/shared/copilotApiService.ts:7` | Removal manifest for `node/copilot/**` and its tests, plus patches to the 7 outside importers (`agentHostMain.ts`, `agentHostServerMain.ts`, `agentHostBootstrap.ts`, `agentHostServices.ts`, `agentHostAutomationCustomizations.ts`, `localModelSetupChannel.ts`, `claude/claudeAgent.ts`) and the otel/telemetry files | S1.3 | `src/typings/copilot-api.d.ts:13` already declares `@vscode/copilot-api` types, so only the runtime value import needs work |

**Recommendation.** S1.2 (folder and product keys) goes into M3.

- S1.3 is the gate before any **distributed** build. The ADR 0002 guardrails apply to distribution.
- `@vscode/copilot-api` is licensed "for development purposes only" with Code-OSS (licensing doc §4), so dev-only use during M3 is arguably permitted. **LEGAL REVIEW.**
- Until S1.3 lands, `chat.disableAIFeatures: true` keeps the agent host off at runtime.

### 2.8 Lockfile regeneration

Removing root dependencies does require regenerating `package-lock.json`, because the lock records them at `:15,:27,:1173-1313,:4336` [V]. `remote/package-lock.json` is affected too. Steps:

1. The upstream precedent is `npm install --package-lock-only --ignore-scripts` per directory (`build/azure-pipelines/common/apply-sdk-canary-override.ts:174-183`, `build/agent-sdk/README.md:91-94`) [V].
   - `--ignore-scripts` skips `build/npm/preinstall.ts`, which runs header installs (`:125`) [I, npm lifecycle].
   - `.npmrc` already sets `legacy-peer-deps=true` [V].
2. M2 apply step (`code-oss/scripts/apply` → `regen-locks`):
   - pin npm to the version bundled with `.nvmrc` Node `24.22.1` (npm < 13 is enforced at `preinstall.ts:46-53`) [V];
   - run the command above in `.` and `remote/`;
   - then **assert** that the removed set equals the expected list: `@github/copilot-sdk`, its 8 platform packages, the nested `zod` and `@vscode/copilot-api`, and nothing else changed (`git diff --numstat` plus a JSON key diff).
3. Record the resulting lockfile sha256 in the manifest. CI runs `npm ci` in a clean checkout to prove the lock is reproducible.
4. Regenerate at apply time rather than committing a lockfile patch. A lock patch would conflict on almost every sync [I].

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

- `code-oss/scripts/gen-axis-main` generates `axis.common.main.ts` at apply time from upstream `workbench.common.main.ts` (`:6-492`) [V] **minus** the exclude list below.
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

### 3.6 Upstream patches (shell bucket, ADR metric)

Each hunk is wrapped in `// --- Start Axis ---` / `// --- End Axis ---` (`<!-- -->` in HTML), as ADR 0002 requires.

| # | File and anchor at 1.144.0 [V] | Intended hunk |
|---|---|---|
| P1 | `src/vs/workbench/workbench.common.main.ts:489-492` (after `import './contrib/opener/browser/opener.contribution.js';`) | `+ import './contrib/axis/browser/axisDefaults.contribution.js';` (Stage 1) |
| P2 | `src/vs/workbench/electron-browser/desktop.main.ts:132-136,168` | Extract a hook that mirrors `web.main.ts:262` (see below) |
| P3 | `src/vs/code/electron-browser/workbench/workbench.ts:511-514` | `'../../../workbench/workbench.desktop.main.js'` → `'../../../axis/axis.desktop.main.js'`; `vs/workbench/workbench.desktop.main.js` → `vs/axis/axis.desktop.main.js` |
| P4 | `src/vs/code/electron-browser/workbench/workbench.html:73` | `href="../../../workbench/workbench.desktop.main.css"` → `href="../../../axis/axis.desktop.main.css"` |
| P5 | `src/vs/code/browser/workbench/workbench.ts:24` | `import { create } from '../../../axis/axis.web.main.internal.js';` |
| P6 | `build/next/index.ts:104-106` (`desktopEntryPoints`) and `:185-190` (desktop CSS set) | `+ 'vs/axis/axis.desktop.main',` in each. Optional: the CDN `web` target at `:168-172,198-201` |
| P7 | `build/gulpfile.vscode.ts:144-156` (`computeChecksums`) | `+ 'vs/axis/axis.desktop.main.js', 'vs/axis/axis.desktop.main.css',` |
| P8 | `eslint.config.js:14-15` imports, `:2366` end of the `code-import-patterns` targets, the `src/vs/code/~` target `:2004-2028`, and the end of `defineConfig(` | `+ import { axisImportPatternTargets, axisConfigs } from './build/axis/eslint.axis.ts';`, `+ ...axisImportPatternTargets,`, `+ { when: 'hasBrowser', pattern: 'vs/axis/axis.web.main.internal.js' },`, `+ ...axisConfigs,` |
| P9 | `build/filters.ts` `copyrightFilter` (`:176-215`) | `+ '!src/vs/axis/**', '!src/vs/workbench/contrib/axis/**', '!extensions/theme-axis/**', '!build/axis/**',`. ESLint enforces the Axis header for `.ts` instead |

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

`axisConfigs` adds one flat-config block. For `src/vs/axis/**`, `src/vs/workbench/contrib/axis/**`, `build/axis/**` and `extensions/theme-axis/**`, it replaces `header/header` (`eslint.config.js:142-151`) [V] with the Axis header (text is decision D4).

Files that are adapted from upstream (copied from sessions or `layout.ts`) keep the Microsoft MIT header and add an Axis modification notice plus an `Adapted from <path>@2c33b50` line. They get a separate `files` entry so the Microsoft header is still enforced. `layersChecker.ts` iterates `src/tsconfig.json` files (`:101,375-388`) [V], so `vs/axis` is checked with no change.

### 3.8 Build entry points

- **Desktop:** `vs/axis/axis.desktop.main` is the JS and CSS bundle (P6) and is checksummed (P7). The upstream `vs/workbench/workbench.desktop.main` stays bundled in M3, so the stock workbench remains buildable for A/B triage. Dropping it later saves bundle time and size.
- **reh-web:** no change. The `vs/code/browser/workbench/workbench` entry includes Axis through P5 [V].
- **Packaging:** `vscode-darwin-arm64-min`, `vscode-linux-x64-min`, `vscode-reh-web-linux-x64-min` (`gulpfile.vscode.ts:586-650`, `gulpfile.reh.ts:533-575`) [V, inventory].

### 3.9 Desktop vs web

| Concern | Desktop | Web (reh-web) |
|---|---|---|
| Entry | `axis.desktop.main` → `AxisDesktopMain` (P2/P3) | `axis.web.main.internal` → `AxisBrowserMain` (P5) |
| Title bar | `NativeTitleService` with window controls and the custom menubar on Win/Linux | `BrowserTitleService` with a hamburger menu |
| Extension host | Node utility process (inventory §6) | Remote node host on the server plus web worker [I] |
| Terminal, Git, file watcher | Local pty host, git extension | Through the remote server |
| Webviews | `vscode-webview://` | `webviewContentExternalBaseUrlTemplate`, which needs an Axis endpoint (R5) |
| CSP / Trusted Types | `workbench.html` meta (unchanged) | Server header without trusted-types (`webClientServer.ts:144-158`) [V] |
| Layering | Axis core is `browser/`; desktop-only code sits in `electron-browser/`, enforced by `local/code-layering` (`eslint.config.js:117-140`) [V] | Same code |

### 3.10 Upstream footprint estimate

| Bucket | Files | Changed lines (excluding markers) | Notes |
|---|---|---|---|
| **Shell (ADR 0002 metric)** P1–P9 | **9** | **~35** (≈60 with markers) | Additive; at stable seams |
| Optional theme polish: P10 `ThemeSettingDefaults` (`common/workbenchThemeService.ts:43-44`), P11 `DEFAULT_BG_*` (`themeMainServiceImpl.ts:23-26`) | +2 → 11 | +4 | Leaves 1 file of headroom |
| React enablement (§4) | +~9 | +~50 | **Breaks the 12-file budget** if counted here |
| Rebrand and de-Copilot S1.1/S1.2 (excluding product.json and resources) | ~10 (eslint.config.js is shared) | ~45 | `electron.ts`, `dirs.ts`, `package.json`, `hygiene.ts`, `gulpfile.hygiene.ts`, `gulpfile.vscode.ts`, `gulpfile.reh.ts`, `gulpfile.vscode.linux.ts`, `build-fast.ts`, `.vscode-test.js` |
| De-Copilot S1.3 (root deps and agentHost) | ~15–25 | ~100–250, plus removals | **Highest conflict risk**: agentHost changes weekly [I] |

**Recommendation.**

- Amend ADR 0002 to track two budgets: shell (≤12/≤300, as written) and rebrand/de-Copilot (proposed ≤20 files/≤300 lines excluding removals).
- Measure both with `code-oss/scripts/footprint`. It counts distinct upstream files and `+`/`-` lines across `code-oss/patches/*`, bucketed by patch-number range (0001–0099 rebrand, 0100–0199 shell, 0200+ other), and excludes `product.json` and `resources/**`.

## 4. React integration plan

**Decision for M3.** No Axis product UI uses React. Every M3 Axis view (AI panel empty state, top-bar items) is vanilla TS/DOM with upstream widgets, consistent with ADR 0002 §4. React stays allowed for future Axis-owned leaf views, **but only after spike S2.11 passes**.

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
   - Keyboard-only walkthrough of PRODUCT.md scenario 1 (open repo → edit → diagnostics → terminal tests → commit).
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
| S1.1 | product.json identity and endpoints (§2.5) | App runs as "Axis"; data in `~/.axis`; no request to `*.microsoft.com`, `vscode-cdn.net` or `api.github.com` during a 10-minute idle session with a folder open | `scripts/code.sh --log trace`, plus an Electron net log (`--log-net-log=<file>`) grep |
| S1.2 | Remove `extensions/copilot` with the build, lint and hygiene patches (§2.7) | `npm ci`, `npm run compile`, `npm run eslint`, `npm run hygiene` and `npm run valid-layers-check` pass; no Copilot UI | Command logs attached to the PR |
| S1.3 | **Decision D1.** Remove root Copilot deps, the agentHost subtree and regenerate lockfiles (§2.8) | As S1.2, plus `npm ci` from a clean tree and the lock assertion script; agent host absent | Same, plus `rg -l "copilot-sdk\|copilot-api" src build package*.json` returns nothing |
| S1.4 | `extensions/theme-axis` dark and light (§2.3) | Both themes selectable; a contrast test (Axis script) proves text ≥4.5:1, focus and control borders ≥3:1, and the stated exceptions | Script output; screenshots of editor, sidebar, quick input and panel |
| S1.5 | `axisDefaults.contribution.ts` and P1; Axis header rule (part of P8) | Fresh profile shows the §2.2 defaults; `chat.disableAIFeatures` is effectively true | Settings editor "Modified by Axis defaults" view; unit test asserting registered defaults |
| S1.6 | Icons and assets (§2.6), `build/lib/electron.ts:146-147` | No VS Code or Code-OSS imagery in the dock/taskbar, About, watermark or web manifest | Packaged build visual check; `file` sizes check script |
| S1.7 | Stage 1 checkpoint: packaged macOS and Linux builds; upstream smoke subset | Builds launch; the PRODUCT.md scenario 1 walkthrough works | `npm run gulp vscode-darwin-arm64-min` / `vscode-linux-x64-min`; `npm run smoketest -- --grep "Search\|Terminal\|Statusbar\|Extensions\|Languages\|Task"` (`test/smoke/src/main.ts:20-37,454-457`) [V] |

**Stage 2**

| Task | Scope | Acceptance criteria | Verification |
|---|---|---|---|
| S2.1 | Layer scaffold: `src/vs/axis` tree, `LAYERS.md`, `build/axis/eslint.axis.ts`, P8, P9 | An empty Axis module lints and type-checks; a deliberate `vs/workbench → vs/axis` import is rejected | `npm run eslint`, `npm run valid-layers-check`; negative lint fixture |
| S2.2 | Bootstrap plumbing: P2–P7, `axis.*.main.ts` (Phase A wholesale), `AxisDesktopMain` returning the **upstream** `Workbench` first | Desktop boots through the Axis entry with an unchanged UI; checksums are valid in the packaged build | Launch; About dialog has no "installation corrupt" warning; `out/vs/axis/axis.desktop.main.{js,css}` exist |
| S2.3 | `AxisWorkbench` v1: grid, part creation, restore phases, persistence, the full layout-service table (§3.3) | Editor, explorer, search, SCM, terminal, debug, problems, command palette and the extension host work; sizes and visibility restore per workspace; no `unknown service` errors | Unit tests for grid and state; smoke subset (S1.7); `Developer: Inspect Context Keys` sanity; extension host log |
| S2.4 | AI panel view container (empty state, no fake AI) and auxiliary-window support | AI panel toggles and resizes and stays hidden by default; "Move Editor into New Window" works | Unit test; manual check |
| S2.5 | Top-bar contributions (§1) | Workspace switcher, agent indicator ("idle") and account/model control are present and keyboard operable, with honest unavailable states | Unit tests (view items, commands); screenshots |
| S2.6 | Keyboard and a11y (§5) | F6 cycle includes the top bar; every §5 command is in the palette; VoiceOver and Orca announce parts | Upstream accessibility smoke area; manual SR script |
| S2.7 | Web: `axis.web.main*`, `AxisBrowserMain`, `web.factory`, P5; webview endpoint (R5) | `scripts/code-server.sh` serves the Axis shell; node extensions (Open VSX), terminal and Git work; gaps documented | Browser walkthrough; gap list in `docs/feasibility/` |
| S2.8 | Phase B curated contributions (generator, exclude list, stale-exclude check) | Same functional checks as S2.3; startup time not worse than Phase A (median of 5 `Developer: Startup Performance` runs) | Generator self-test; perf numbers in the PR |
| S2.9 | Packaged Axis-shell builds on macOS and Linux; ADR checklist demo | ADR 0002 validation bullet 1 is satisfied | Recorded walkthrough; smoke subset on both OSes |
| S2.10 | **Upstream sync exercise** to the first weekly minor released after S2.9 (expected 1.145.x or later) | ≤ 1 working day; conflicts only in patched seams | Protocol below |
| S2.11 | React spike (§4), throwaway branch | Report covering footprint, bundle and startup delta, CSP/TT and lint results | Measurements in the PR description; branch not merged |
| S2.12 | Footprint report and ADR 0002 validation write-up | Both budgets reported from the script; ADR status updated with evidence | `code-oss/scripts/footprint` output |

**Sync exercise protocol (S2.10).** Record each of these in `docs/feasibility/upstream-sync-log.md`:

1. wall-clock start and end;
2. per-patch `git apply --3way` result and the number of conflicted hunks;
3. `git diff 1.144.0..<new> --stat` over every patched file and over `layoutService.ts`, `workbench.common.main.ts`, `workbench.desktop.main.ts`, `desktop.main.ts` and `sessions/browser/workbench.ts` (an early warning for layout-service churn);
4. the count of type errors under `src/vs/axis` before fixes;
5. generator diff: new upstream imports and stale excludes;
6. time to green across `compile`, `eslint`, `valid-layers-check`, Axis unit tests, the smoke subset and a packaged build;
7. lockfile regeneration result.

Pass means ≤ 1 working day, with no edits outside patched seams except type fixes in `src/vs/axis`.

## 7. Risks, open questions and decisions

### 7.1 Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | De-Copilot cascade: root deps feed 114 agentHost imports and an unconditional gulp check (`gulpfile.vscode.ts:44-51`) [V] | Separate budget; removal manifest plus importer patches; gate S1.3 before distribution |
| R2 | Deleting `extensions/copilot` breaks the lint config, dirs, compile and hygiene (§2.7) [V] | Do all of S1.2 in one PR; CI runs all five commands |
| R3 | `defaultChatAgent` is dereferenced unguarded (§2.5) [V] | Inert stub; grep `defaultChatAgent\.` at each sync (48 files reference it [V]) |
| R4 | `IWorkbenchLayoutService` churn: 48 members, and upstream parts call layout-specific methods such as `isFloatingPanelsEnabled` [V] | Sync step 3; sessions breakage is an early signal; unit tests over the contract table |
| R5 | Web webviews default to `vscode-cdn.net` (`environmentService.ts:241-243`) and REH sets no `webviewEndpoint` (`webClientServer.ts` has no match) [V] | Axis-hosted per-webview origin; serving from the same origin weakens isolation; code-server's webview patch is the precedent (alternatives doc) |
| R6 | Curated list causes missing services or new-contrib drift | Phase A first; generator default-include plus stale-exclude failure |
| R7 | Upstream layout actions (panel position, zen mode) expect behaviour Axis constrains | Exclude zen mode; log and keep for panel position; revisit with a precondition context key if users hit it |
| R8 | Code adapted from sessions or `layout.ts` drifts silently | Keep copies small; record the source path and commit in the header; diff them at sync |
| R9 | `workbench.experimental.modernUI` is experimental and may change quickly | Structural CSS lives in `axisWorkbench.css` with `.axis-workbench` scope; screenshot check at sync |
| R10 | UX token gaps: dark muted is 4.0:1, decorative borders are below 3:1, and light secondary/muted are undefined [I computed] | Control-border and light tokens (§2.3); D6 |
| R11 | Lifecycle restore phases wrong → extensions never reach `Eventually` | Port the phase logic; test that `onStartupFinished` extensions activate |
| R12 | Each patch fits at least 2 Axis-marker lines per hunk; HTML needs `<!-- -->` | The footprint script counts markers separately |

### 7.2 Open questions

1. Should the upstream Agents window (`isSessionsWindow`, `windowImpl.ts:1314-1315` [V]) stay reachable once Copilot is gone? Removing its build entries means about 12 extra deletion lines in `build/next/index.ts`/`gulpfile.vscode.ts`.
2. Are the 28 per-language document icons (darwin/win32) required for M3, or is a single generic Axis document icon acceptable?
3. Is an inert `remoteCodingAgents`, `editSessions` or `userDataSync` visible anywhere in the UI without Microsoft keys? (Answered in S2.8.)
4. Does ESLint accept a stub `copilot-local` plugin whose rules are missing while the referencing block matches no files (§2.7)? Verified in S1.2.

### 7.3 Requirements on M2 tooling

- Overlay supports **new files and replacing upstream files** (assets in §2.6).
- A **removal manifest** (`code-oss/removals.txt`) applied after checkout.
- Post-apply hooks: `regen-locks` (§2.8), `gen-axis-main` (§3.5), `gen-icons` verification, `footprint`.
- Patches numbered by bucket: 0001–0099 rebrand/de-Copilot, 0100–0199 shell.

### 7.4 Decisions needed from the owner

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Excise the Copilot root deps and agentHost in M3, or before the first distributed build | Before distribution (S1.3 as a gate); M3 runs with `chat.disableAIFeatures` (LEGAL REVIEW on dev-only use) |
| D2 | Top bar: reuse the upstream title bar plus menus, or build an Axis-owned title bar (sessions-style, about 800 LOC, must re-implement the menubar and WCO) | Reuse in M3 |
| D3 | Keep the status bar (not in UX.md) | Keep |
| D4 | Reverse-DNS id (`<rdns>`), Axis code licence and header text, `licenseUrl` | Owner and LEGAL REVIEW |
| D5 | React | Defer; S2.11 spike only; React gets its own budget line if adopted |
| D6 | Proposed tokens: control border (dark and light), light secondary and muted, accent tint and hover | Accept or adjust in UX.md |
| D7 | Is Stage 2 worth it in Phase 0, given that Stage 1 already matches the UX layout (§1)? | Yes, but limited to the ADR proof (S2.1–S2.10); defer Axis-only parts |
| D8 | ADR 0002 amendment: two footprint budgets (§3.10) | Adopt |
| D9 | Web webview hosting model (R5) | Axis-hosted wildcard subdomain, decided in S2.7 |
