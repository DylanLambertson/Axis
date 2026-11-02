# Axis workbench shell: design for Phase 0 M3

> **Stage 2 is superseded by the agent-first shell design (ADR 0004).** See `docs/design/axis-agent-shell.md` (to be added separately). Stage 1 (restyle, §2) is done and still applies; §3 and the Stage 2 parts of §5–§6 are kept for reference only.

- **Status:** Draft for owner review. Implementation follows this document once accepted. Aligned with ADR 0002 as merged in `13764bc` (decisions 6–7, criteria 1–7), ADR 0003 and the Phase 0 threat model.
- **Date:** 2026-11-01
- **Upstream baseline:** Code OSS `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.
- **Inputs:**
  - `docs/UX.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `assets/brand/`;
  - ADR 0002 as merged (decisions 6–7, validation criteria 1–7) and ADR 0003 (IPC bridge, D2 and D6);
  - `docs/security/threat-model-phase0.md` (SC-3, WEB-2–4, EL-5, §8);
  - `docs/feasibility/{code-oss-inventory,integration-alternatives,licensing-and-marketplace}.md`.
- **Conventions:**
  - Upstream paths are relative to the Code OSS root at the baseline commit. `file:line` refers to that commit.
  - Axis repository paths follow the M2 tooling (`docs/feasibility/code-oss-build.md`):
    - `code-oss/patches/NNNN-name.patch`: the patch series;
    - `code-oss/overlay/**`: new files only (the apply script refuses to overwrite an upstream file);
    - `code-oss/replace/**`: whole-file replacements of existing upstream files, such as icons;
    - `code-oss/removals.txt`: upstream paths deleted after the patches;
    - `code-oss/hooks/post-apply.d/NN-name`: executables run after apply, for example to regenerate lockfiles;
    - `scripts/code-oss/*.sh`: `fetch`, `apply`, `build`, `run`, `footprint` and `test`, plus the M3 helpers `gen-icons.sh`, `gen-theme-syntax.mjs` and `check-artifacts.sh`.
  - **[V]** means VERIFIED: read in source. **[I]** means INFERRED: reasoned, not proven by running anything. No upstream scripts were run.
  - "Patch" means a hunk that edits an existing upstream file. "Overlay" means a new file copied into the tree. "Removal" means a path the M2 apply script deletes (see §7.3).
- **Patch ranges.** Each range is measured on its own (ADR 0002 decisions 3, 6 and 7):

  | Range | Contents | Measured against |
  |---|---|---|
  | `0001–0999` | Shell layer, including the ADR 0003 bridge seams and the restyle patches (decision 2) | Criterion 2: ≤ 12 files and ≤ 300 lines |
  | `1000–1499` | Rebrand and licensing guardrails (decision 5) | Criterion 3: measured, no fixed budget |
  | `1500–1999` | Copilot and agent-host removal (decision 6) | Criterion 3: measured, no fixed budget |
  | `2000–2999` | Security hardening (decision 7) | Criterion 3: measured, no fixed budget |

  This numbering matches the M2 scripts. The footprint script reports each block separately.

  All blocks must rebase within the sync in criterion 4.

## 0. Summary of decisions

The design decisions are recorded in §8.


1. **Layout.** UX.md's layout maps onto upstream parts that already exist (§1). The Axis shell reuses **every upstream part as-is** in M3 and owns only the grid, the layout service and its policy. None of the 8 upstream parts is subclassed. Part IDs are reused, so no new `Parts` enum value is needed.
2. **Stage 1 (restyle)** needs one temporary import line (P10, shell block, decision 2), plus `product.json`, the notices patch and resources in block `1000–1499` (decision 5) (§2).
3. **Stage 2 (shell)** is a `src/vs/axis` layer modelled on `src/vs/sessions`.
   - Desktop boots through a subclass of the upstream `DesktopMain`. That needs one small refactor patch, mirroring the `createWorkbench` hook that web already has.
   - Web boots through a subclass of `BrowserMain`, with no patch to `web.main.ts`.
   - Shell range including the ADR 0003 seams: **10 upstream files and about 45 changed lines (about 75 with markers)**, against criterion 2's 12 files and 300 lines (§3.10).
4. **Contributions.** Bring-up imports the upstream `workbench.*.main` files **wholesale** and overrides services afterwards. It then switches to a generated, curated `axis.common.main.ts` driven by an explicit exclude list (§3.5).
5. **Copilot removal is the largest patch set.** It follows ADR 0002 decision 6 and is evaluated in the order (a), (b), (c) (§2.7).
   - The design expects option (a): unbundle the agent-host entry points and `extensions/copilot`, drop the packages from `dependencies`, and type-check the unbundled sources against type-only stubs or a tsconfig exclusion.
   - The SC-3 checks are acceptance criteria.
   - `@anthropic-ai/sdk` goes with the agent host. `@vscode/sandbox-runtime` is kept and reviewed. `zod` stays a direct dependency.
6. **Security hardening** (threat model §8.4) is range `2000–2999`: web CSP Trusted Types and `frame-src`, the reh cookie `Secure` flag, and an optional `openExternal` allow-list (§3.6, S1.8).
7. **React in M3.** M3 builds one React view through the normal pipeline to test criterion 5, on a measured spike branch (§4).
   - In-pipeline `.tsx` needs about 9 more upstream build files, which would take the shell range past 12 files.
   - A no-JSX variant fits the budget.
   - No product UI depends on React until this is decided.

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

**Decided (D7, §8):** Stage 2 is in Phase 0, because ADR 0002 criteria 1–2 require a custom shell.

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
| `reportIssueUrl` | `https://github.com/DylanLambertson/Project-Axis/issues/new` (the Axis repository) |
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

## 7. Risks, open questions and decisions

### 7.1 Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Decision 6 cascade: the packages feed 114 agentHost import lines, an unconditional gulp check (`gulpfile.vscode.ts:48-51`) and both packaging pipelines [V]. Under (a) or (b), SDK bumps upstream can break the stubs on every sync | Prefer (a1), which needs no stubs; generate (a2) stubs from the pinned SDK version by script; the SC-3 artifact check runs on every sync |
| R2 | Removing `extensions/copilot` from the build breaks the dirs list, compile and hygiene, and possibly the lint config (§2.7) [V] | Do all of S1.2 in one PR; CI runs all five commands |
| R3 | `defaultChatAgent` is dereferenced unguarded (§2.5) [V] | Inert stub; grep `defaultChatAgent\.` at each sync (48 files reference it [V]) |
| R4 | `IWorkbenchLayoutService` churn: 48 members, and upstream parts call layout-specific methods such as `isFloatingPanelsEnabled` [V] | Sync step 3; sessions breakage is an early signal; unit tests over the contract table |
| R5 | Web webviews default to `vscode-cdn.net` (`environmentService.ts:241-243`), REH sets no `webviewEndpoint`, and the web CSP hard-codes `frame-src 'self' https://*.vscode-cdn.net data:` (`webClientServer.ts:151`) [V] (threat model WEB-4) | Deferred to M6 (D9). Default plan: a self-hosted webview origin served by reh-web with per-webview subdomains for isolation, plus H2 in range `2000–2999`. code-server's webview patch is the precedent |
| R6 | Curated list causes missing services or new-contrib drift | Phase A first; generator default-include plus stale-exclude failure |
| R7 | Upstream layout actions (panel position, zen mode) expect behaviour Axis constrains | Exclude zen mode; log and keep for panel position; revisit with a precondition context key if users hit it |
| R8 | Code adapted from sessions or `layout.ts` drifts silently | Keep copies small; record the source path and commit in the header; diff them at sync |
| R9 | `workbench.experimental.modernUI` is experimental and may change quickly | Structural CSS lives in `axisWorkbench.css` with `.axis-workbench` scope; screenshot check at sync |
| R10 | UX token gaps: dark muted is 4.0:1, decorative borders are below 3:1, and light secondary/muted are undefined [I computed] | Resolved by D6: control-border and light tokens accepted; UX.md edits proposed in §2.3.1 |
| R11 | Lifecycle restore phases wrong → extensions never reach `Eventually` | Port the phase logic; test that `onStartupFinished` extensions activate |
| R12 | Each patch fits at least 2 Axis-marker lines per hunk; HTML needs `<!-- -->` | The footprint script counts markers separately |

### 7.2 Open questions

1. Do all Agents-window triggers route through `windowsMainService.ts:296` and `:1599` (§2.7)? S1.3 checks each listed trigger after D8's neutralisation and removal.
2. Are the 28 per-language document icons (darwin/win32) required for M3, or is a single generic Axis document icon acceptable?
3. Is an inert `remoteCodingAgents`, `editSessions` or `userDataSync` visible anywhere in the UI without Microsoft keys? (Answered in S2.8.)
4. Under option (a), does `eslint.config.js:15` still load `extensions/copilot/.eslintplugin` when the extension's own dependencies are not installed (§2.7)? Checked in S1.2.

### 7.3 Requirements on M2 tooling

Met by M2 as follows:

- New files go in `code-oss/overlay/`; whole-file replacements of upstream files (assets in §2.6) go in `code-oss/replace/`, which refuses targets that do not exist at the pin.
- A **removal manifest** (`code-oss/removals.txt`) applied after the patches.
- Post-apply hooks in `code-oss/hooks/post-apply.d/`: `regen-locks` (§2.8) and `gen-axis-main` (§3.5). Icon verification is `scripts/code-oss/gen-icons.sh --check` in CI. `scripts/code-oss/footprint.sh` runs after apply, not as a hook.
- Patches numbered by block, as in the M2 scripts: `0001–0999` shell, `1000–1499` rebrand and licensing, `1500–1999` Copilot and agent host, `2000–2999` security hardening.

### 7.4 Still open

| ID | Item | Owner and when |
|---|---|---|
| L1 | LEGAL REVIEW of interim dev-only use of `@vscode/copilot-api` (D1) | Owner, before GATE-D |
| L2 | LEGAL REVIEW of the Axis proprietary `LICENSE` text and placement (D4) | Owner, before distribution |
| L3 | LEGAL REVIEW before installing `@anthropic-ai/claude-agent-sdk` in CI, if (a1) fails (§2.7) | Owner, during S1.3 |

## 8. Decisions

Decisions recorded 2026-11-01; D4 is an owner decision. Where they differ from recommendations elsewhere in this document, these decisions take precedence.

| ID | Decision | Effect on this design |
|---|---|---|
| D1 | **M3 evaluates and measures the decision 6 strategies.** S1.3 is a measured spike under ADR 0002 decision 6 and criterion 3. Full removal of the root dependencies and the agent host is a **hard gate before the first distributed build**. The legal review of `@vscode/copilot-api` in dev builds stays open (L1) | S1.3 and GATE-D (§6); §2.7 dispositions apply |
| D2 | **Reuse the upstream title bar and menus.** No Axis title-bar part | §1, S2.5 |
| D3 | **Keep the status bar** | §1, §2.2 |
| D4 | **Axis-owned code is proprietary (all rights reserved).** Upstream MIT and third-party notices are preserved as required. The reverse-DNS app id is `dev.dylanlambertson.axis` (`darwinBundleIdentifier` and `linuxDesktopName` `dev.dylanlambertson.axis`, `win32AppUserModelId` `DylanLambertson.Axis`; new win32 GUIDs are generated at implementation). Axis-owned files carry `Copyright (c) 2026 Dylan Lambertson. All rights reserved.`; upstream files keep their MIT headers. `licenseName`/`licenseUrl` point to an Axis `LICENSE` added at distribution time. Legal review of the licence text stays a pre-distribution item (L2) | §2.5, §3.7, S1.1, S1.5 |
| D5 | **React is deferred.** S2.11 stays a throwaway spike that answers ADR 0002 criterion 5, including the no-JSX variant | §4, S2.11 |
| D6 | **Accept the control-border and light-theme tokens.** The dark control border is `#6B7079` (3.77 / 3.50 / 3.20 on canvas / surface / raised). An earlier `#61666F` was rejected because it reaches only 2.76:1 on raised. Placeholders use secondary. The matching `docs/UX.md` edits are proposed in §2.3.1; UX.md itself is edited in a separate change | §2.3, §2.3.1, R10 |
| D7 | **Stage 2 is in Phase 0**, because criteria 1–2 require it | §1, §3, S2.1–S2.12 |
| D8 | **Remove the `vs/sessions` (Agents window) entry points** in block `1500–1999`. Triggers exist (§2.7), so the removal also neutralises `windowsMainService.ts:296` and `:1599`, and S1.3 verifies each trigger | §2.7, §7.2 question 1, S1.3 |
| D9 | **Deferred to M6.** Default: the self-hosted webview origin is served by reh-web, with the `frame-src` CSP edit (H2) in the decision 7 range | §2.5, §3.6 H2, S1.8, S2.7, R5 |

**Budget alignment (merged ADR 0002).**

- At its next amendment, ADR 0002 decision 3 and criterion 3 should name all four blocks, including `1000–1499` for decision 5. They currently fold the rebrand into the decision 6 patch set. ADR 0003 D6 should note that its ESLint targets live in the overlay module.
- Hunks for different blocks in the same upstream file (`app.ts`, `serverServices.ts`, `build/next/index.ts`) can conflict with each other. S2.10 records conflicts per file across blocks, not only per block.

- Decision 5 rebrand guardrails, decision 6 Copilot removal and decision 7 security hardening are separately measured blocks under criterion 3. Criterion 4's one-day sync covers every block.
- The ADR 0003 D6 bridge seams (about 4 files and 52 lines) count toward the shell block. Shell plus bridge is 10 files, which fits ≤ 12 (§3.10).
