# Axis workbench shell: design for Phase 0 M3

> **Stage 2 is superseded by the agent-first shell design (ADR 0004)**, [`axis-agent-shell.md`](axis-agent-shell.md). Stage 1 (restyle, §2) is done and still applies; §3 and the Stage 2 parts of §5 and §6 are kept for reference only.

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

## Section map

This design was one document; it is now split into focused files. Section numbers are unchanged, so references elsewhere ("`axis-shell.md` §2.9", "S1.3", "R8", "D8") still resolve:

| Sections | File |
|---|---|
| §0 summary, §1 layout, §7 risks and open questions (R1–R12), §8 decisions (D1–D9) | this file |
| §2 Stage 1: restyle (§2.1–§2.9) | [`axis-shell-stage1.md`](axis-shell-stage1.md) |
| §3 Stage 2: the `src/vs/axis` layer (§3.1–§3.10), §4 React plan, §5 accessibility | [`axis-shell-stage2.md`](axis-shell-stage2.md) |
| §6 M3 tasks (S1.x, GATE-D, S2.x) | [`axis-shell-tasks.md`](axis-shell-tasks.md) |
| Agent-first Stage 2 (ADR 0004) | [`axis-agent-shell.md`](axis-agent-shell.md) |

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
