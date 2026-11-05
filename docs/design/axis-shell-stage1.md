# Axis workbench shell: Stage 1, restyle

> Part of the Axis workbench shell design. The index, with the summary of decisions (§0), the layout (§1), risks (§7) and decisions (§8), is [`axis-shell.md`](axis-shell.md). This file holds §2 (Stage 1: restyle only, done and still in force). Section numbers are those of the original single document, so a reference such as "`axis-shell.md` §3.10" resolves through the section map in the index.

## 2. Stage 1: restyle only

### 2.1 Placement rule

- Axis code that must also work in the **stock** workbench lives in `src/vs/workbench/contrib/axis/**`, as an overlay. The existing `src/vs/workbench/contrib/*/~` lint target already covers it [V, `eslint.config.js:1943-1970`].
- It is wired in by **one import line** in `src/vs/workbench/workbench.common.main.ts`, after the "Opener" import at `:489-490` [V].
  - This is restyle patch P10 in the shell block `0001–0999` (ADR 0002 decision 2; criterion 2).
  - It is retired at S2.2, when the Axis entry points import the contribution themselves and the stock workbench is no longer loaded.
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

**Token mapping.** Hex values come from UX.md. Values marked * are not in UX.md yet.

- The control-border and light-theme tokens are **accepted** (D6, §8); §2.3.1 proposes the matching UX.md edits.
- The accent tint and the derived hover and scrollbar values are theme-level implementation values. They are validated by the S1.4 contrast test, not added as UX tokens.

| UX token | Dark | Light | Color-registry ids (registration [V]) |
|---|---|---|---|
| canvas (frame) | `#111214` | `#FAFAFB` | `titleBar.activeBackground` (`workbench/common/theme.ts:781`), `titleBar.inactiveBackground`, `activityBar.background` (`:407`), `statusBar.background` (`:303`), `statusBar.noFolderBackground` |
| surface (content) | `#181A1D` | `#FFFFFF` | `editor.background` (`platform/theme/common/colors/editorColors.ts:19`), `sideBar.background` (`theme.ts:625`), `panel.background` (`:497`), `terminal.background` (`contrib/terminal/common/terminalColorRegistry.ts:18`), `editorGroupHeader.tabsBackground` (`theme.ts:221`), `tab.activeBackground` (`:32`), `tab.inactiveBackground` (`:36`), `sideBarSectionHeader.background`, `commandCenter.background` (`:847`) |
| raised | `#202227` | `#FFFFFF` + border | `editorWidget.background` (`editorColors.ts:49`), `quickInput.background` (`colors/quickpickColors.ts:17`), `menu.background` (`colors/menuColors.ts:25`), `notifications.background`, `keybindingLabel.background` (`colors/inputColors.ts:212`), `button.secondaryBackground`, `checkbox.background` (`inputColors.ts:181`), `list.hoverBackground` (`colors/listColors.ts:65`), `toolbar.hoverBackground` (`editorColors.ts:350`), `commandCenter.activeBackground` (`theme.ts:853`) |
| border (decorative) | `#2B2E34` | `#E5E7EB` | `panel.border` (`theme.ts:499`), `sideBar.border` (`:634`), `titleBar.border` (`:799`), `statusBar.border` (`:324`), `editorGroup.border` (`:241`), `tab.border`, `widget.border` (`editorColors.ts:343`), `editorWidget.border`, `commandCenter.border` (`theme.ts:860`) |
| control border* | `#6B7079` | `#8A8F98` | `input.border` (`inputColors.ts:28`), `checkbox.border`. These must reach 3:1 (WCAG 1.4.11) on every surface they are drawn on. Dark `#6B7079`: 3.77 canvas, 3.50 surface, **3.20 raised**, where quick input, the find widget and menus draw `input.border`. Light `#8A8F98`: 3.11 canvas, 3.25 surface and raised [I computed]. The decorative border reaches only 1.4:1 / 1.2:1 [I computed] |
| text primary | `#E8E9EB` | `#17191D` | `foreground` (`colors/baseColors.ts:13`), `editor.foreground` (`editorColors.ts:23`), `tab.activeForeground`, `titleBar.activeForeground`, `activityBar.foreground`, `list.activeSelectionForeground`, `settings.headerForeground` (`contrib/preferences/common/settingsEditorColorRegistry.ts:12`), `button.secondaryForeground`, `editorCursor.foreground` |
| text secondary | `#9A9EA7` | `#50555F`* | `descriptionForeground` (`baseColors.ts:29`), `icon.foreground`, `tab.inactiveForeground`, `activityBar.inactiveForeground`, `statusBar.foreground`, `titleBar.inactiveForeground`, `editorLineNumber.activeForeground`, `commandCenter.foreground` (`theme.ts:828`) |
| text muted | `#70757F` | `#6B7280`* | `disabledForeground` (`baseColors.ts:21`) and `editorLineNumber.foreground` (a stated S1.4 exception: 3.77:1 on the dark editor surface). **Not** `input.placeholderForeground`: WCAG 1.4.3 applies to placeholder text, so it maps to secondary (`#9A9EA7`: 6.98 / 6.50 / 5.93 on canvas / surface / raised; light `#50555F`). Dark muted is **4.0:1** on canvas [I computed], so it must not be used for body text |
| accent (filled) | `#5823F6` | `#5823F6` | `button.background` (`inputColors.ts:121`); `button.foreground` `#FFFFFF` (`:113`, 7.0:1); `activityBarBadge.background` (`theme.ts:458`) with `#FFFFFF` foreground; `statusBarItem.remoteBackground` |
| accent-on-dark / accent (text, focus) | `#9776F9` | `#5823F6` | `focusBorder` (`baseColors.ts:37`), `textLink.foreground` (`:56`), `textLink.activeForeground`, `list.focusOutline` (`listColors.ts:25`), `inputOption.activeBorder`, `activityBar.activeBorder` (`theme.ts:435`), `tab.activeBorderTop` (`:128`), `panelTitle.activeBorder`, `progressBar.background` (`colors/miscColors.ts:75`), `sash.hoverBorder` (`miscColors.ts:18`) |
| accent tint* | `#9776F926` | `#5823F614` | `list.activeSelectionBackground` (`listColors.ts:33`), `list.inactiveSelectionBackground`, `menu.selectionBackground`, `quickInputList.focusBackground`, `selection.background` (`#9776F940` / `#5823F626`) |
| derived* | `#4A1AD6` | `#4A1AD6` | `button.hoverBackground` (`inputColors.ts:125`); `scrollbarSlider.background` `#9A9EA733` / `#50555F33` (`miscColors.ts:56`); `badge.background` = raised, with text-primary foreground (`miscColors.ts:25`), so the accent stays reserved for interaction |
| status | set explicitly | set explicitly | The themes include only the syntax snapshot, so unset workbench colours fall back to registry defaults, not to the 2026 theme. Set in both themes and checked by the contrast test: `statusBar.debuggingBackground`/`Foreground` dark `#1F6F99`/`#FFFFFF` (5.54:1; the 2026 `#3994BC` is 3.42:1 under white), light `#0069CC`/`#FFFFFF` (the 2026 pair, 5.39:1); `statusBarItem.errorBackground`/`Foreground` `#B42318`/`#FFFFFF` (6.57:1) and `statusBarItem.warningBackground`/`Foreground` `#CCA700`/`#111214` (8.12:1) in both; `errorForeground` dark `#F48771`, light `#AD0707`; `editorError/Warning/Info.foreground` (`editorColors.ts:70,83,96`) dark `#F14C4C`/`#CCA700`/`#59A4F9`, light `#E51400`/`#895503`/`#0063D3` (light warning: the registry `#BF8803` is 2.99:1) |

`contrastBorder` and `contrastActiveBorder` (`baseColors.ts:41,45`) stay unset outside the HC themes.

**First-run behaviour [V/I].**

- The pre-load palette applies only when the setting equals the upstream constants (`services/themes/browser/workbenchThemeService.ts:156`, constants at `common/workbenchThemeService.ts:42-50`) [V]. On the **first** launch Axis therefore paints an unloaded OS-scheme theme until extensions register (`:163-185`) [V].
- Later launches use the cached `colorThemeData` from storage (`:149-153`) [V].
- The Electron window background before the renderer loads is `#1F1F1F`/`#FFFFFF` (`platform/theme/electron-main/themeMainServiceImpl.ts:23-26`) until the stored background exists [V].
- Fixing both is optional polish: about 4 lines in 2 files (optional restyle patches P11/P12 in the shell block, §3.6 and §3.10). The large `*_INITIAL_COLORS` maps (`common/workbenchThemeService.ts:73-365`) are **not** replaced.

### 2.3.1 Proposed `docs/UX.md` token edits (D6; UX.md is not changed by this design)

Replace the "Visual tokens (provisional)" paragraph's token list with:

```text
Dark default: canvas #111214, surface #181A1D, raised #202227, border #2B2E34 (decorative
separators only), control-border #6B7079 (inputs, checkboxes and other component boundaries;
3.77:1 canvas, 3.50:1 surface, 3.20:1 raised), primary text #E8E9EB, secondary #9A9EA7 (also placeholder text), muted #70757F (disabled
text only; 4.0:1 on canvas, 3.8:1 on surface, so never body or placeholder text).
Light alternative: canvas #FAFAFB, surface #FFFFFF, raised #FFFFFF with border, border #E5E7EB
(decorative), control-border #8A8F98 (>= 3:1 on surface and canvas), text #17191D,
secondary #50555F (7.2:1; also placeholder text), muted #6B7280 (4.6:1).
```

Add one sentence after it: "Decorative borders may fall below 3:1. Any boundary needed to identify a control uses `control-border` (WCAG 2.2 SC 1.4.11)." The accent sentences stay unchanged.

### 2.4 Product icon theme

- Keep the upstream `Default` product icon theme (codicons). `workbench.productIconTheme` has a single enum value, `Default` (`themeConfiguration.ts:114-116`) [V].
- The codicon font comes from `@vscode/codicons` (`package.json:117`, copied by `build/lib/compilation.ts:372-384`) [V]. `extensions/theme-modern-icons` is a **file** icon theme (`package.json:15-22`) [V], so it is unrelated.
- Axis UI registers its own icon ids with codicon fallbacks through `registerIcon(...)`, for example `axis-agent-activity` → `Codicon.pulse` and `axis-workspace` → `Codicon.repo`. A future `contributes.productIconThemes` entry (`themeExtensionPoints.ts:84-110`) [V] can then restyle Axis icons by id with no code change. No icon font work is planned in M3.

### 2.5 product.json identity

These edits are patch G1 in block `1000–1499` (decision 5). They are excluded from criterion 2 but measured under criterion 3. Current values are at `product.json:2-39,90-249` [V, licensing doc §2]. The identifiers follow D4 (§8): the reverse-DNS app id is `dev.dylanlambertson.axis`.

| Keys | Axis value |
|---|---|
| `nameShort`, `nameLong` | `Axis` |
| `applicationName`, `linuxIconName`, `urlProtocol` | `axis` |
| `dataFolderName`, `sharedDataFolderName`, `serverDataFolderName` | `.axis`, `.axis-shared`, `.axis-server` |
| `serverApplicationName`, `tunnelApplicationName` | `axis-server`, `axis-tunnel` |
| `win32DirName`, `win32NameVersion`, `win32RegValueName`, `win32ShellNameShort` | `Axis`, `Axis`, `Axis`, `&Axis` |
| `win32MutexName`, `win32TunnelServiceMutex`, `win32TunnelMutex` | `axis`, `axis-tunnelservice`, `axis-tunnel` |
| `win32x64AppId`, `win32arm64AppId`, `win32x64UserAppId`, `win32arm64UserAppId`, `darwinProfileUUID`, `darwinProfilePayloadUUID` | Fresh GUIDs, generated **once** when S1.1 is implemented and recorded in the patch, so installers never collide with Code OSS |
| `darwinBundleIdentifier`, `linuxDesktopName`, `win32AppUserModelId` | `dev.dylanlambertson.axis`, `dev.dylanlambertson.axis`, `DylanLambertson.Axis` |
| `licenseName`, `licenseUrl`, `serverLicenseUrl` | Point at an Axis `LICENSE` (proprietary, all rights reserved; D4), added at distribution time. Values: `licenseName` `Proprietary`; `licenseUrl` and `serverLicenseUrl` point at the Axis `LICENSE` in the Axis repository. S1.1 sets them when that file is added before distribution; until then, a dev build must not ship an empty or Microsoft URL. `licenseFileName` stays `LICENSE.txt` in M3: desktop packaging copies `product.licenseFileName` (`build/gulpfile.vscode.ts:234`, licensing doc §1), so switching it to the Axis file must also add an explicit `LICENSE.txt` entry in range `1000–1499`. The upstream `LICENSE.txt` (MIT) and `ThirdPartyNotices.txt` must be in **every** artifact (ADR 0002 decision 5). Today only desktop packaging copies them (`gulpfile.vscode.ts:234`); reh and web copy only the missing `remote/LICENSE` (`gulpfile.reh.ts:351`, `gulpfile.vscode.web.ts:49`) [V]. Patch G3 (§3.6) fixes this. The licence text needs **LEGAL REVIEW** before distribution |
| `reportIssueUrl` | `https://github.com/DylanLambertson/Axis/issues/new` (the Axis repository) |
| `webviewContentExternalBaseUrlTemplate`, `voiceWsUrl` | Remove `voiceWsUrl`. Set the webview template to an Axis-hosted endpoint: web falls back to `vscode-cdn.net` if it is absent (`services/environment/browser/environmentService.ts:241-243`) [V]. See R5 |
| `defaultChatAgent` | **Replace with an inert stub** (empty ids, no URLs). Do not delete it: the field is non-optional (`base/common/product.ts:282`) [V] and is dereferenced unguarded at `extensionGalleryService.ts:2047`, `abstractExtensionManagementService.ts:995`, `extensionsWorkbenchService.ts:2854` and `services/accounts/browser/defaultAccount.ts:98-116` (called at `:158`) [V]. Most other uses are optional-chained, so the stub only has to satisfy these unguarded readers |
| `trustedExtensionAuthAccess`, `builtInExtensionsEnabledWithAutoUpdates` | Drop the `GitHub.copilot-chat` entries |
| `onboardingThemes`, `onboardingKeymaps` | Themes point at `Axis Dark`/`Axis Light` (`:207-244`). Keymaps relabel `"VS Code"` (`:170-206`) |
| `extensionsGallery` | Open VSX or self-hosted (licensing doc §3). The URL choice is a business decision |
| `agentsTelemetryAppName`, `sessionsWindowAllowedExtensions` | Remove / keep `[]` |

### 2.6 Icons and images from `assets/brand/axis-app-icon.svg`

- Generate the assets with `scripts/code-oss/gen-icons.sh`. It rasterises the SVG at each final size with headless Chrome (`scripts/code-oss/icons/render.html`), packs ICO and XPM with `scripts/code-oss/icons/pack.py` (Python standard library) and ICNS with `iconutil`, so it runs on a stock Mac with Chrome installed. **Commit the outputs** under `code-oss/replace/**`, so builds need no image toolchain and reviewers see the bytes.
- These are asset replacements, so they live in `code-oss/replace/`; the overlay is for new files only.
- `gen-icons.sh --check` (run in CI) verifies that the derived SVGs still match `assets/brand/`. Rasters are not compared byte for byte, because Chrome's rasteriser changes between releases.
- **Implemented in S1.6:** `code.icns`, `code.ico`, the two tile PNGs and `VisualElementsManifest.xml`, `linux/code.png`, `rpm/code.xpm` (256 px rather than 1024 px, to keep it small), the server PNGs, favicon and manifest, `code-icon.svg` and the four letterpress SVGs.
- **Deferred** until Windows and per-language packaging are in scope (open question 2): the 28 per-language document icons (darwin and win32), `sessions.ico` and the Inno Setup wizard bitmaps.

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

`build/lib/electron.ts:146-147` hard-codes `companyName`/`copyright` as Microsoft [V]. That is a 2-line patch in the rebrand block (G2).

### 2.7 Copilot and agent-host removal (ADR 0002 decision 6, range `1500–1999`)

**How it is reached [V].**

- **Desktop.**
  - Electron main always creates `ElectronAgentHostStarter`/`AgentHostProcessManager` (`src/vs/code/electron-main/app.ts:767-769`) and calls `agentHostProcessManager.start()` at `:813`.
  - The utility process starts lazily when a renderer asks for a connection (comment at `:761-766`).
  - The renderer asks only when the runtime is available and AI features are enabled (`agentHostEnablementService.ts:32-33`).
- **Server.**
  - `serverServices.ts:273-277` spawns an agent host only with `--agent-host-port`/`--agent-host-path`.
  - Its comment says the default lazily starts one when the first renderer connects (`:266-267`).
- **Entry points.** `vs/platform/agentHost/node/agentHostMain` and `diffWorkerMain` are hard-coded in `build/next/index.ts:111-112` (desktop) and `:140-141` (server); `:110` and `:139` are `ptyHostMain` and must stay. The starters point at that entry (`electronAgentHostStarter.ts:202,212`, `nodeAgentHostStarter.ts:95`).
- Until this patch set lands, `chat.disableAIFeatures: true` (§2.2) is the runtime gate. This does not settle threat model assumption A9, which stays unverified until the SC-3 artifact check passes.

**Options, evaluated in ADR order.** M3 picks the first option that passes every SC-3 check below.

| Option | What changes | Type-checking the remaining sources | Expected footprint [I] |
|---|---|---|---|
| **(a) Unbundle (expected choice)** | Remove the agent-host entries from `build/next/index.ts:111-112,140-141` (not `:110`/`:139`, which are `ptyHostMain`). In `app.ts:767-769`, skip creating the starter and manager, and drop the `agentHostProcessManager.start()` call at `app.ts:813`. In `serverServices.ts`, always register `UnavailableAgentHostChannel` (already imported at `:86`). Drop the Copilot packaging steps (table below). Remove `@github/copilot-sdk`, `@vscode/copilot-api` and `@anthropic-ai/sdk` from `dependencies` in `package.json:104,106,118` and `remote/package.json:7,12`, so `node_modules` in artifacts cannot contain them. Do not build, install or package `extensions/copilot` | Either **(a1)** add `src/vs/platform/agentHost/{node/{copilot,claude,codex},test}/**` to `exclude` in `src/tsconfig.json` (`:29-35`), which works only if nothing still type-checked imports them transitively (measure with `tsgo --listFiles`). `exclude` does not stop files pulled in by imports, and non-excluded files such as `agentHostMain.ts` and `agentHostServerMain.ts` import the providers, so **(a1) will most likely fall through to (a2)** unless those entry files are excluded too; or **(a2)** add overlay `.d.ts` stubs. The ADR notes 48 of the 54 copilot-sdk importers are type-only. `@github/copilot-sdk` is MIT (licensing doc §4), so its `.d.ts` can be vendored at the pinned version. `@vscode/copilot-api` already has ambient typings (`src/typings/copilot-api.d.ts:13`) | About 20 files, about 100 lines, plus regenerated lockfiles |
| (b) Stub packages | `file:` packages under `build/axis/stubs/` replace the two packages: `.d.ts` plus an `index.js` whose exports throw | Same as (a2) | (a) minus the tsconfig change, plus stub maintenance on every SDK bump |
| (c) Delete (VSCodium-style) | Removal manifest for `node/{copilot,claude,codex}/**` and their tests, plus patches to the outside importers (`agentHostMain.ts`, `agentHostServerMain.ts`, `agentHostBootstrap.ts`, `agentHostServices.ts`, `agentHostAutomationCustomizations.ts`, `localModelSetupChannel.ts`, `claude/claudeAgent.ts`, otel) | None needed | Highest conflict risk, because agentHost changes weekly. VSCodium's precedent is 29 files and about 3,567 lines (ADR context 4) |

**Edits shared by all options (range `1500–1999`) [V anchors].**

| Item | Mechanism |
|---|---|
| `extensions/copilot/**` (2,583 .ts files) | (a): keep it in the tree but unbuilt (see the build-task row below). (c): removal manifest. **Never a deletion patch**, which would carry every line and conflict on every sync. `packageCopilotExtensionStream` already skips a missing folder (`build/lib/extensions.ts:470-472`) |
| `compileCopilotExtensionBuildTask` (`build/gulpfile.extensions.ts:282`, which calls `packageCopilotExtensionStream`) in the desktop series `build/gulpfile.vscode.ts:636` (import `:27`) and the reh series `build/gulpfile.reh.ts:567` (import `:26`) [V] | Remove the task from both series and drop both imports. Under (a) the folder stays, and `packageCopilotExtensionStream` skips only a **missing** folder (`build/lib/extensions.ts:470-472`), so without this edit Copilot would still be packaged. The SC-3 artifact check catches a regression |
| `build/npm/dirs.ts:18` | Delete the line, so postinstall stops running `npm install` there (`postinstall.ts:57-65`) |
| `package.json` scripts `:26,:28,:36-37,:55-57,:94-95`; `:330` `copilotRuntimeVersion`; `remote/package.json:82` | Drop the Copilot compile, watch and setup scripts and the version key |
| `build/gulpfile.vscode.ts:45-60` (keep `:44` `const commit`, used at `:62,143,204-205,405`) | Remove `packageLock` (`:45-47`), the SDK version check that throws on every gulp run once the SDK is gone (`:48-51`), and `getLockedPackageVersion` (`:53-60`, used only at `:211`). Drop the Copilot names from the `:29` import |
| `build/gulpfile.vscode.ts:209-211,255-262,272,431-443,556-569,609`; `build/gulpfile.reh.ts:33` (import), `:362-366,523-529,552` | Drop the Copilot packaging, platform-package and ripgrep-shim steps. `build/lib/copilot.ts:276-278` throws without the SDK |
| `build/gulpfile.vscode.linux.ts:26-27,109,114,202` (`copilot-link.sh`); `build/next/build-fast.ts:21-26,143-144,378-404,420,460-469` (the copilot lane, which reads `extensions/copilot/package.json` unguarded at `:460`); `.vscode-test.js:93-94` | Remove the references. Under (a) the folder stays, so the `build-fast` reads still succeed, but the lane must not compile it |
| `build/hygiene.ts:34-41` (callers `:356-360`, `gulpfile.hygiene.ts:50-52`) | Guard with `existsSync`. Needed under (c); harmless under (a) |
| `eslint.config.js:15` imports `extensions/copilot/.eslintplugin` | (a): unchanged if the plugin resolves with the extension's dependencies not installed; otherwise point it at an overlay stub `{ rules: {} }` [I; verify] |
| `product.json` `defaultChatAgent`, `trustedExtensionAuthAccess`, `builtInExtensionsEnabledWithAutoUpdates` | §2.5. `defaultChatAgent` becomes an inert stub |
| Agent-host unit tests (`src/vs/platform/agentHost/test/**`) | Removal manifest. They are not shipped, and they import SDK values |

**Other agent-related dependencies (threat model SC-3) [V].**

| Package | Where it is used | Decision |
|---|---|---|
| `@anthropic-ai/sdk` `^0.82.0` (runtime, `package.json:104`) | Only `src/vs/platform/agentHost/node/claude/**` and `node/shared`. `workspaceTagsService.ts:255-256` lists it only as a string for npm-tag telemetry | **Removed** together with the agent host, by the same option |
| `@anthropic-ai/claude-agent-sdk` `0.3.304` (devDependency, `package.json:176`; lock `license: "SEE LICENSE IN README.md"`) | agentHost `claude` sources and tests | **Removed** with option (c). Under (a), keep it only if (a1) fails, and then **LEGAL REVIEW** before installing it in CI. devDependencies are not packaged [I] |
| `@openai/codex` `0.163.0` (devDependency, `package.json:178`) | Referenced as a string or path by agentHost (`common/agentService.ts`, `node/agentHostServerMain.ts`); `node/codex/protocol/generated/**` are generated types | Same as `claude-agent-sdk` |
| `@vscode/sandbox-runtime` `0.0.1` (`package.json:128`, `remote/package.json:19`) | Launched as a CLI from `node_modules` by `platform/sandbox/common/terminalSandboxEngine.ts:616` and `workbench/contrib/mcp/common/mcpSandboxService.ts:303`; packaged by `gulpfile.vscode.ts:297` | **Kept and reviewed.** It belongs to the terminal and MCP sandboxing, not to Copilot, and it is a Phase 3 sandbox candidate (threat model §8.2). M3 records whether it runs with default settings |
| `zod` `^4.4.3` (`package.json:173`, `remote/package.json:56`) | Its only upstream non-test consumer is the agent host (ADR 0003 D2) | **Kept as a direct dependency.** Asserted by the lock script (§2.8) |

**Still open, measured during M3:**

- `vs/sessions` agent entries (**approved, D8, §8**): `build/next/index.ts:106,120,124-127,188-189,200`; checksums at `gulpfile.vscode.ts:152-155`.
  - Triggers exist, so S1.3's question is already answered "yes" [V]:
    - `nativeHost.openAgentsWindow`, which the renderer can reach (`platform/native/electron-main/nativeHostMainService.ts:375-376`);
    - the `--agents` CLI flag (`platform/environment/node/argv.ts:111`), handled at `platform/launch/electron-main/launchMainService.ts:146-148`;
    - the Windows jump-list task `--agents` (`workspacesHistoryMainService.ts:400-406`, already gated on `chat.disableAIFeatures` at `:400`);
    - protocol links (`app.ts:1553-1560`);
    - the global keybinding route (`globalKeybindingsMainService.ts:193`);
    - restoring a window whose workspace is the agent-sessions workspace (`windowsMainService.ts:1599`).
  - Removing only the build entries would leave these opening a missing `sessions.html`.
  - D8 therefore also **neutralises the choke points**:
    - `IWindowsMainService.openAgentsWindow` (`windowsMainService.ts:296`) logs and returns `[]`, or opens a normal window;
    - `isSessionsWindow` at `:1599` is forced to `false`.
  - All the triggers above route through those two points [I; S1.3 verifies with a test per trigger].
  - Size: about 12 deletion lines plus about 6 lines in `windowsMainService.ts`, all in block `1500–1999`.
- The renderer-reachable `UtilityProcessWorker` channel (`app.ts:1530-1532`, ADR 0003 open question 3): **keep**. The file watcher and disk file system provider use it (`services/files/electron-browser/watcherClient.ts`, `diskFileSystemProvider.ts`) [V].

**SC-3 acceptance checks (all required; task S1.3).**

1. **No Copilot or agent-host code in artifacts.**
   - `scripts/code-oss/check-artifacts.sh` scans the packaged desktop app (including an `asar list` of `node_modules.asar`), the `vscode-reh-*` server and the `vscode-reh-web` output.
   - With `--notices` it also fails if `LICENSE.txt`, `ThirdPartyNotices.txt` or (from distribution) the Axis `LICENSE` is missing from any of the three targets.
   - It fails on any path containing `node_modules/@github/copilot`, `node_modules/@vscode/copilot-api`, `node_modules/@anthropic-ai` or `extensions/copilot`, on any `agentHostMain` or `diffWorkerMain` file, and on any bundle containing those import specifiers.
2. **Every remaining stub is inert.**
   - Prefer `.d.ts`-only stubs, which have no runtime.
   - Any JS stub exports only functions and classes that throw `Error('Axis: <package> is not available')`.
   - An ESLint block for `build/axis/stubs/**` forbids imports of `child_process`, `net`, `http`, `https`, `dns`, `worker_threads` and `fs`, and any use of `fetch`, `process` or `require`.
   - A unit test asserts that the stub throws.
3. **Lockfiles are regenerated by script and reviewed.**
   - `regen-locks` (§2.8) rewrites `package-lock.json` and `remote/package-lock.json` and prints the added and removed packages.
   - The output is pasted into the sync PR and reviewed. Lockfiles are never hand-edited.
4. **`zod` stays a direct dependency** in `package.json` and `remote/package.json`, resolved at the top level `node_modules/zod`. Asserted by `regen-locks`.

**Licence note.** `@vscode/copilot-api` is licensed "for development purposes only" with Code-OSS (licensing doc §4). Until range `1500–1999` lands, it is installed only in development checkouts. **LEGAL REVIEW** covers that interim use.

### 2.8 Lockfile regeneration

Removing root dependencies requires regenerating `package-lock.json`, because the lock records them at `:15,:27,:1173-1313,:4336` [V]. `remote/package-lock.json` is affected too. Steps:

1. The upstream precedent is `npm install --package-lock-only --ignore-scripts` per directory (`build/azure-pipelines/common/apply-sdk-canary-override.ts:174-183`, `build/agent-sdk/README.md:91-94`) [V].
   - `--ignore-scripts` skips `build/npm/preinstall.ts`, which runs header installs (`:125`) [I, npm lifecycle].
   - `.npmrc` already sets `legacy-peer-deps=true` [V].
2. A post-apply hook (`code-oss/hooks/post-apply.d/NN-regen-locks`, run by `scripts/code-oss/apply.sh`):
   - pin npm to the version bundled with `.nvmrc` Node `24.22.1` (npm < 13 is enforced at `preinstall.ts:46-53`) [V];
   - run the command above in `.` and `remote/`;
   - then **assert** that the removed set equals the expected list: `@github/copilot-sdk` with its 8 platform packages and its own nested `zod` (`package-lock.json:1173-1313`), `@vscode/copilot-api` and `@anthropic-ai/sdk` with their exclusive transitive dependencies;
   - also assert that nothing else changed (`git diff --numstat` plus a JSON key diff) and that top-level `zod` is unchanged (SC-3 check 4).
3. Record the resulting lockfile sha256 in the manifest. CI runs `npm ci` in a clean checkout to prove the lock is reproducible.
4. Regenerate at apply time rather than committing a lockfile patch. A lock patch would conflict on almost every sync [I].

### 2.9 Stage 1 as implemented (M3)

Measured on `feat/axis-stage1-rebrand` against Code OSS `1.144.0`, macOS 15 on Intel x64. Upstream line counts come from `scripts/code-oss/footprint.sh`.

**Patch series.**

| Block | Patches | Upstream files | Lines added / deleted (markers) | Contents |
|---|---|---|---|---|
| `0001–0999` shell | `0010` (P8 part), `0020` (P9), `0100` (P10) | 3 | 21 / 1 (8) | ESLint spreads `axisConfigs` from `build/axis/eslint.axis.ts`; copyright filter exempts Axis paths; the temporary defaults import |
| `1000–1499` rebrand | `1000` (G1), `1010` (G2), `1015`, `1020` (G3) | 4 | 97 / 109 (10) | `product.json` identity (§2.5), Electron company and copyright, the macOS help book and workspace document-type names, notices in reh, reh-web and web |
| `1500–1999` Copilot and agent host | `1500`–`1560` (8 patches) | 19 | 190 / 122 (84) | S1.2: the Copilot extension is not installed, compiled, packaged or tested. S1.3: option (a) with (a1), below; `1545` refuses the agent-host spawn flags |
| `2000–2999` security | none | 0 | 0 | S1.8 not started |
| `replace/` | 16 files | 16 | n/a | Icons, images and manifests (§2.6) |
| net vs pin (`git diff`) | | 43 | 931 / 2,670 | Includes the lockfiles regenerated by `code-oss/hooks/post-apply.d/10-regen-locks` (root 88 / 901, remote 0 / 484) |

Overlay (new files): `extensions/theme-axis/**` (§2.3), `src/vs/workbench/contrib/axis/{browser,test/browser}/axisDefaults*` (§2.2) and `build/axis/eslint.axis.ts` (§3.7).

**S1.3 Copilot and agent-host removal: options tried, in ADR order.**

| Option | Result |
|---|---|
| (a) unbundle, type-checked with (a2) shorthand stubs (`declare module '<pkg>';` in a `.d.ts`) | **Failed.** 3,825 type errors in 151 files, all under `platform/agentHost` (2,600 in tests). The sources use SDK names as types and namespaces (TS2709 and TS2694), which shorthand modules cannot express. Full `.d.ts` stubs would mean vendoring the SDK typings at every bump |
| (a) unbundle with (a1) tsconfig exclusion | **Chosen; all checks pass.** An import-graph scan showed that the files importing the SDKs, and everything that imports them, form a closed set inside `platform/agentHost` (183 sources, 221 tests) that no kept entry point reaches. `src/tsconfig.json` and the six layer-checker tsconfigs exclude `agentHost/node/**`, `agentHost/test/node/**` and `agentHostOTelService.ts`, and keep as explicit roots the 18 `agentHost/node` files that the shared process, main process and server import (remote agent hosts, dev containers). Because tsb rejects files outside the program, `build/lib/compilation.ts` skips agent-host sources that are not tsconfig roots, so the tsconfig is the single list |
| (b) stub packages, (c) delete | Not needed |

`1530`–`1560` remove the agent-host entry points (`build/next/index.ts`), stop Electron main from creating the agent host starter and manager and make the server register `UnavailableAgentHostChannel` by default (`app.ts`, `serverServices.ts`), and drop `@github/copilot-sdk`, `@vscode/copilot-api` and `@anthropic-ai/sdk` from the root and remote dependencies and `@anthropic-ai/claude-agent-sdk` and `@openai/codex` from devDependencies, with the packaging steps that fetched or checked them. L3 no longer applies, because `claude-agent-sdk` is not installed.

**SC-3 checks.**

1. `scripts/code-oss/check-artifacts.sh --notices` (which fails closed: any listing, asar or grep error fails the run, paths match anywhere including `node_modules.asar.unpacked`, and auto-discovery requires all three artifacts) passes on `vscode-darwin-x64-min`, `vscode-reh-darwin-x64-min` and `vscode-reh-web-darwin-x64-min`. `node_modules.asar` has no `@github`, `@anthropic-ai` or `@vscode/copilot-api` entry and keeps `zod`, and `LICENSE.txt` and `ThirdPartyNotices.txt` are in all three artifacts (G3).
2. No stub remains: (a1) needs none.
3. `10-regen-locks` regenerates both lockfiles with `npm install --package-lock-only --ignore-scripts`, using exactly npm 11.19.1 (bundled with Node 24.22.1). It fails unless the removed entries equal its expected `name@version` lists, every kept entry is unchanged in every field, the root entry loses only the agent SDK names, and each lockfile has the sha256 recorded in the hook. It removed 51 root entries (28 SDK packages and their platform builds, 23 exclusive transitive dependencies such as `koffi` and `json-schema-to-ts`) and 31 remote entries. `npm ci` succeeded on the regenerated lock.
4. `zod` stays a direct dependency, resolved at `node_modules/zod`, at the same version; the hook asserts it.

**Deviations and follow-ups.**

- `defaultChatAgent` is an inert stub of empty strings, which is upstream's own fallback (`?? ''`). Onboarding theme entries keep their upstream ids (`dark-2026`, `light-2026`), because `onboardingVariationA.ts` preselects `dark-2026`; only their labels and theme ids change.
- `licenseUrl` and `serverLicenseUrl` point at `LICENSE` in the Axis repository, which does not exist yet (L2).
- `webviewContentExternalBaseUrlTemplate` is unchanged. Desktop does not use it, but **reh-web webviews load from Microsoft's `vscode-cdn.net` until M6**, and the web CSP `frame-src` still allows it (D9, R5, threat model WEB-4).
- `extensionsGallery` is still unset (business decision).
- The About dialog still prints `@github/copilot` and `@github/copilot-sdk` version lines (now `Unknown`). This needs a small patch in block `1500–1999`.
- Still open in block `1500–1999`: D8 (the Agents-window entry points and choke points) and removing `extensions/copilot` from the tree. The dev launcher skips the extension through `VSCODE_SKIP_BUILTIN_EXTENSIONS`.
- Open question 4 is answered: ESLint loads `extensions/copilot/.eslintplugin` with the extension's `node_modules` absent.
- `1545` makes the server fail at startup when `--agent-host-port`, `--agent-host-path` or GitHub environment hosting is used, since they would fork the unbundled `agentHostMain`. The `--agent-host-bridge-*` flags still let renderers proxy to an externally running agent host.
- `@vscode/sandbox-runtime` is kept (§2.7). By code reading, it is launched only for chat-agent terminal tools with `chat.agent.sandbox.enabled` on, or for MCP servers whose definition sets `sandboxEnabled`; with the Axis defaults (AI features off) neither path runs. This was not observed at runtime.
- Header rule: every Axis-owned file added in M3 carries `Copyright (c) 2026 Dylan Lambertson. All rights reserved.`, scripts included (`check-artifacts.sh`, `gen-icons.sh`, `gen-theme-syntax.mjs`, `icons/*`, `10-regen-locks`). JSON files cannot carry it.
- Deviation from §2.8 step 3: the lockfile sha256s are recorded in `10-regen-locks`, not in the manifest.
- `build/next/index.ts transpile` (the development fast build) globs `src/**/*.ts`, so it still emits the excluded agent-host files into `out/`. Development only: packaged outputs have no `agentHost/node` files.
- Follow-ups (Linux packaging, not on the M3 gating platform): the Linux templates still say "Visual Studio Code" (`resources/linux/code.appdata.xml:8,10`, `debian/control.template:8,15`, `rpm/code.spec.template:7,21`, `snap/snapcraft.yaml:5`), name Microsoft as maintainer and packager, and `debian/templates.template` offers to add Microsoft's apt repository. Fix them in block `1000–1499` before any Linux package is built.
