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

## Parts of this design

This design is split into files of under 500 lines each. Section numbers are unchanged, so a reference such as `§2.9` still names one section.

| Sections | File |
|---|---|
| §0, §1 | `axis-shell.md` (this file) |
| §2.1 to §2.8 | `axis-shell-stage1.md`: placement rule, default settings, theme, `product.json`, icons, Copilot and agent-host removal, lockfiles |
| §2.9 | `axis-shell-stage1-built.md`: Stage 1 and Stage 1b as implemented, with the patch series, runtime checks and follow-ups |
| §3 | `axis-shell-stage2.md`: the `src/vs/axis` shell layer (superseded by ADR 0004) |
| §4 to §6 | `axis-shell-stage2-plan.md`: React, accessibility, M3 tasks |
| §7, §8 | `axis-shell-risks.md`: risks, open questions, decisions D1 to D9 |
| Agent-first Stage 2 (ADR 0004) | `axis-agent-shell.md`: the agent-first shell design; `axis-shell-runbook.md`: building and running it; `../feasibility/axis-shell-phase0.md`: what Phase 0 measured |

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
