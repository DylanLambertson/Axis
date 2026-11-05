# Axis workbench shell: risks, open questions and decisions (§7, §8)

> Part of the Axis workbench shell design. Section numbers (§) are stable across the parts; `axis-shell.md` lists which part holds which section.

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
| R10 | UX token gaps: dark muted is 4.0:1, decorative borders are below 3:1, and light secondary/muted are undefined [I computed] | Resolved by D6: control-border and light tokens accepted; UX.md edits in §2.3.1, applied in Stage 1b |
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
| L2 | LEGAL REVIEW of the Axis proprietary `LICENSE` text and placement (D4). A placeholder `LICENSE` is in the repository root from Stage 1b | Owner, before distribution |
| L3 | LEGAL REVIEW before installing `@anthropic-ai/claude-agent-sdk` in CI, if (a1) fails (§2.7) | Owner, during S1.3 |

## 8. Decisions

Decisions recorded 2026-11-01; D4 is an owner decision. Where they differ from recommendations elsewhere in this document, these decisions take precedence.

| ID | Decision | Effect on this design |
|---|---|---|
| D1 | **M3 evaluates and measures the decision 6 strategies.** S1.3 is a measured spike under ADR 0002 decision 6 and criterion 3. Full removal of the root dependencies and the agent host is a **hard gate before the first distributed build**. The legal review of `@vscode/copilot-api` in dev builds stays open (L1) | S1.3 and GATE-D (§6); §2.7 dispositions apply |
| D2 | **Reuse the upstream title bar and menus.** No Axis title-bar part | §1, S2.5 |
| D3 | **Keep the status bar** | §1, §2.2 |
| D4 | **Axis-owned code is proprietary (all rights reserved).** Upstream MIT and third-party notices are preserved as required. The reverse-DNS app id is `dev.dylanlambertson.axis` (`darwinBundleIdentifier` and `linuxDesktopName` `dev.dylanlambertson.axis`, `win32AppUserModelId` `DylanLambertson.Axis`; new win32 GUIDs are generated at implementation). Axis-owned files carry `Copyright (c) 2026 Dylan Lambertson. All rights reserved.`; upstream files keep their MIT headers. `licenseName`/`licenseUrl` point to the Axis `LICENSE` on `main` (PR #32). Legal review of the licence text stays a pre-distribution item (L2) | §2.5, §3.7, S1.1, S1.5 |
| D5 | **React is deferred.** S2.11 stays a throwaway spike that answers ADR 0002 criterion 5, including the no-JSX variant | §4, S2.11 |
| D6 | **Accept the control-border and light-theme tokens.** The dark control border is `#6B7079` (3.77 / 3.50 / 3.20 on canvas / surface / raised). An earlier `#61666F` was rejected because it reaches only 2.76:1 on raised. Placeholders use secondary. The matching `docs/UX.md` edits are listed in §2.3.1 and were applied in Stage 1b | §2.3, §2.3.1, R10 |
| D7 | **Stage 2 is in Phase 0**, because criteria 1–2 require it | §1, §3, S2.1–S2.12 |
| D8 | **Remove the `vs/sessions` (Agents window) entry points** in block `1500–1999`. Triggers exist (§2.7), so the removal also neutralises `windowsMainService.ts:296` and `:1599`, and S1.3 verifies each trigger | §2.7, §7.2 question 1, S1.3 |
| D9 | **Deferred to M6.** Default: the self-hosted webview origin is served by reh-web, with the `frame-src` CSP edit (H2) in the decision 7 range | §2.5, §3.6 H2, S1.8, S2.7, R5 |

**Budget alignment (merged ADR 0002).**

- At its next amendment, ADR 0002 decision 3 and criterion 3 should name all four blocks, including `1000–1499` for decision 5. They currently fold the rebrand into the decision 6 patch set. ADR 0003 D6 should note that its ESLint targets live in the overlay module.
- Hunks for different blocks in the same upstream file (`app.ts`, `serverServices.ts`, `build/next/index.ts`) can conflict with each other. S2.10 records conflicts per file across blocks, not only per block.

- Decision 5 rebrand guardrails, decision 6 Copilot removal and decision 7 security hardening are separately measured blocks under criterion 3. Criterion 4's one-day sync covers every block.
- The ADR 0003 D6 bridge seams (about 4 files and 52 lines) count toward the shell block. Shell plus bridge is 10 files, which fits ≤ 12 (§3.10).
