# Project Axis — Workbench Integration Alternatives (input to ADR 0002)

Research date: 2026-11-01. Baseline: Code OSS (microsoft/vscode) pinned at **1.144.0** (released 2026-10-28).

Evidence tags: **VERIFIED** = read in a primary source (repo file, release, issue, official doc) on the research date;
**INFERRED** = derived from verified facts, reasoning shown; **UNKNOWN** = not found / not measurable from public sources.
Bracketed numbers like [S3] refer to the Sources list at the end.

---

## 0. Key context discovered (affects every option)

1. **Upstream now ships a minor every week.** VS Code minors 1.111.0 (2026-03-09) through 1.144.0 (2026-10-28) shipped
   at roughly 7-day intervals (33 minors in ~33 weeks). Before that it was monthly (1.106 2025-11-12, 1.107 2025-12-10,
   1.108 2026-01-08, 1.109 2026-02-04). **VERIFIED** [S1]. Every downstream project in this report now *batches*
   several upstream minors per sync; "lag" should be measured in minors and weeks, not releases.
2. **Upstream itself now contains a second, independent top-level shell.** Code OSS 1.144.0 has `src/vs/sessions`
   ("Agents Window"), described as "a top-level layer above `vs/workbench`" with its own entry points
   (`sessions.desktop.main.ts`, `sessions.web.main.ts`), its own `DesktopWorkbench`/`MobileWorkbench` layout and
   import-layering rules enforced by ESLint (`LAYERS.md`, `LAYOUT.md`). **VERIFIED** [S2]. This is a first-party
   precedent for exactly what Axis wants: a custom shell built on top of the standard workbench services without
   rewriting `vs/workbench`.
3. monaco-vscode-api (option B) is itself a **patch series over Code OSS** (116 patch files in `vscode-patches/`,
   regenerated with `git format-patch` on each upgrade). **VERIFIED** [S5][S7]. Choosing B does not remove upstream
   patch maintenance; it moves it to a third party.

---

## A. Direct fork of Code OSS (custom shell as patch series and/or added contributions)

**Maturity/activity.** Upstream is MIT-licensed source; 1.144.0 is current. **VERIFIED** [S1].

**How it tracks upstream.** You control cadence. Two proven mechanics:

| Precedent | Mechanism | Size | Current lag (2026-11-01) |
|---|---|---|---|
| VSCodium | Patch files applied to a pinned tag (`upstream/stable.json` = 1.143.1); semi-automated `dev/update_patches.sh` produces `.rej` files for manual fixing | 69 `.patch` files: 42 core + 27 platform-specific (linux 17, windows 6, osx/alpine/insider/helper 1 each; `patches/user/` holds only a readme), plus 5 disabled (`.no`/`.yet`) and two JSON removal manifests (`52-ext-copilot-remove-it.json`, `80-ui-disable-onboarding.json`) | Pinned 1.143.1 vs 1.144.0 = 1 minor; release 1.143.17232 on 2026-10-28, 6 days after VS Code 1.143.1 (2026-10-22). **VERIFIED** [S8][S9] |
| Positron | Long-lived git fork; periodic `git merge upstream/<branch>` (`scripts/pull-upstream.sh`); in-file `// --- Start Positron --- … // --- End Positron ---` markers on every modified upstream line | 555 `.tsx` files and 1,839 `src/` paths containing "positron" out of 13,089 `src/` files | `package.json` version on `main` = 1.138.0 vs 1.144.0 = 6 minors (~6 weeks). Merge to 1.143.0 open since 2026-10-28. **VERIFIED** [S10][S11][S12] |

Positron upstream-merge PRs (all **VERIFIED** [S12]):

| PR | Range | Opened → merged | Files changed |
|---|---|---|---|
| #14673 | → 1.124.0 | 2026-07-03 → 07-08 | 4,175 |
| #15243 | → 1.130.0 | 2026-07-30 → 08-10 | not fetched |
| #15768 | → 1.134.0 | 2026-08-27 → 09-04 | 4,783 |
| #16475 | 1.134 → 1.138 | 2026-10-06 → 10-09 | 4,450 |
| #16970 | 1.138 → 1.143 | 2026-10-28 → open | 6,880 |

INFERRED: Positron syncs about every 4–5 weeks, batching 4–6 weekly minors. Each merge PR takes 3–11 days to land
and is followed by fix-up PRs (e.g. #15462 "Get the ext-host job green again after the 1.130 merge", #15670).
Positron is in fact a fork of a fork: Code OSS → `rstudio/vscode-server` (Posit Workbench server) → Positron.
**VERIFIED** (in-repo merge runbook) [S11].

**Features.** Everything Code OSS has: Electron desktop, `vscode-reh` / `vscode-reh-web` server builds (both
are targets in `build/gulpfile.reh.ts` at 1.144.0, **VERIFIED** [S3]), node + web-worker extension hosts, terminal,
debug/DAP, SCM/Git, notebooks, webviews, search, and the upstream chat/agent and `vs/sessions` layers.
Gaps (all are product-service/licensing gaps, not code gaps): no Microsoft Marketplace (use Open VSX), no Microsoft
Settings Sync service, and Microsoft-licensed extensions (C/C++, Python/Pylance, Live Share, Remote-SSH/Containers/WSL)
are restricted to Microsoft products. **VERIFIED** (VSCodium docs) [S9]. Replacements exist on Open VSX
(clangd, Native Debug, BasedPyright, open-remote-ssh). **VERIFIED** [S9].

**Custom shell.** Three levels of invasiveness (INFERRED from sources):
- (a) contributions only (views, view containers, parts hidden by config) — near-zero patch cost, limited freedom;
- (b) a sibling top-level layer like upstream `vs/sessions` (own `Workbench` subclass/layout and entry points, reusing
  `vs/workbench/services` and contribs) — additive files, few upstream edits; **this is now an upstream-sanctioned
  pattern** [S2];
- (c) editing `vs/workbench/browser/layout.ts`, `parts/*` — maximal freedom, highest merge-conflict surface.

**React in a Code OSS fork — concrete evidence.**
- *Positron* (VERIFIED [S10][S13]): `react`/`react-dom` 19.2.4 are root dependencies; `src/tsconfig.json` sets
  `"jsx": "react-jsx"` so React `.tsx` compiles in the normal Code OSS TypeScript pipeline (no separate bundler).
  Bridge = `src/vs/base/browser/positronReactRenderer.tsx`: a `Disposable` that calls `createRoot(container)`, renders
  each element inside `PositronReactServicesProvider` (a React context exposing the DI services object), unmounts on
  dispose; `IReactComponentContainer` carries width/height/focus/visibility events from the VS Code part/view into
  React. Components live alongside workbench code: `src/vs/workbench/contrib/**` (338 tsx),
  `src/vs/workbench/browser/positron*` (e.g. `positronComponents` 37, `positronDataExplorer` 22, `positronDataGrid` 16),
  plus `src/vs/workbench/browser/parts` (23 tsx — i.e. Positron edits upstream parts with React).
  Cost signal: the 4–7k-file merge PRs above (INFERRED: mostly upstream churn; Positron-specific conflict share UNKNOWN).
- *Void* (VERIFIED [S14]): React + Tailwind compiled by a **separate** `tsup` build
  (`src/vs/workbench/contrib/void/browser/react/{build.js,tsup.config.js}`, 7 entry bundles into `out/`, ESM,
  `injectStyle`), with Tailwind scoped via a custom `scope-tailwind` tool; README says this "is not possible in plain
  VS Code, and required extending the build pipeline". Browser code may not import `node_modules`, so React is bundled
  raw and LLM calls go through an `electron-main` IPC channel. Apache-2.0.
- Void outcome (VERIFIED [S14][S4]): repo **archived**, README "Void is now deprecated"; last release v1.3.4
  (2025-04-15); last commit 2026-06-02; `package.json` still at VS Code **1.99.3** — i.e. it never rebased past
  April 2025 base (INFERRED from HEAD version). A small team with a heavy React layer did not sustain upstream sync.

**Closed-source forks.** Cursor docs: "Cursor is based upon the VS Code codebase". **VERIFIED** [S15].
Windsurf: its docs URL now serves "Devin Desktop" docs; no explicit fork statement found on the fetched page — **UNKNOWN** [S16].

---

## B. Custom app embedding VS Code services via @codingame/monaco-vscode-api

**Maturity/activity.** MIT. Latest v38.1.3 (2026-10-29); 15 releases in Oct 2026 alone; 471 commits since
2025-11-01. **VERIFIED** [S4][S5]. **Maintainer concentration:** top contributor CGNonofr has 617 commits; next is 41;
since 2026-08-01 only 3 PR authors / 13 merged PRs (most work is direct commits). **VERIFIED** [S5]. Bus factor ≈ 1
(INFERRED).

**Upstream tracking.** `package.json` `config.vscode` = 1.142.0 (commit d956e8a…), monaco 0.57.0. **VERIFIED** [S5].
Major-version → VS Code mapping (VERIFIED from release notes [S4]):

| mva | date | VS Code | | mva | date | VS Code |
|---|---|---|---|---|---|---|
| v22 | 2025-10-10 | 1.105 | | v30 | 2026-04-01 | 1.114 |
| v23 | 2025-11-14 | 1.106 | | v31 | 2026-04-28 | 1.117 |
| v24 | 2025-12-16 | 1.107 | | v32 | 2026-05-13 | 1.120 |
| v25 | 2026-01-12 | 1.108 | | v34 | 2026-06-16 | 1.124 |
| v26 | 2026-02-09 | 1.109 | | v35 | 2026-07-09 | 1.128 |
| v27 | 2026-03-05 | 1.110 | | v37 | 2026-09-17 | 1.138 |
| v28 | 2026-03-09 | 1.111 | | v38 | 2026-10-19 | 1.142 |
| v29 | 2026-03-30 | 1.113 | | v33, v36 | — | not stated in notes (UNKNOWN) |

INFERRED: adoption is fast once chosen (1.138 → v37 next day; 1.142 released 2026-10-14 → v38 five days later) but it
skips minors (every ~3–4 weekly releases), and each sync is a **breaking major**. Today it is 2 minors behind (1.142 vs
1.144); Axis cannot pin exactly 1.144.0 on B until a release targets it (INFERRED). Downstream lag example: Windmill
pins `=25.0.0` (VS Code 1.108). **VERIFIED** [S17]. TypeFox `monaco-languageclient` depends on ^37.6.0. **VERIFIED** [S17].

**Features (VERIFIED, wiki "List of service overrides" [S6]).** Separate packages for: extensions (web-worker
extension host in an iframe), files, search, quickaccess, debug, terminal, SCM, testing, output, markers, notebook,
chat, remote-agent (remote FS/search/terminals via a VS Code server), timeline/outline, and three mutually exclusive
layout modes: `editor`, `views`, `workbench`. Demo also runs the upstream sessions workbench
(`main.workbench.session.ts`). **VERIFIED** [S5].
Known gaps (VERIFIED): "monaco-vscode-api only bundles the web services of VSCode. Electron is not supported yet …
the node extension host … is the only one able to run non-web-compatible extensions … the only way … is to connect
to a VSCode server via websocket" (maintainer, issue #719, 2025-10) and native services "not really planned yet"
(#810, 2026-06) [S7]. `initialize` can be called only once; services cannot be unloaded (README "Sandbox mode") [S5].
Shadow DOM and sandbox modes are beta. Wiki getting-started guide: "There is no full documentation" [S6].
Settings Sync: no override found in the list — **UNKNOWN**.

**Custom shell.** Highest freedom of all options: in `views` mode the host app owns the DOM and calls
`attachPart(Parts.SIDEBAR_PART | EDITOR_PART | PANEL_PART | AUXILIARYBAR_PART | STATUSBAR_PART | …, element)` to mount
individual VS Code parts anywhere (demo `setup.views.ts`). **VERIFIED** [S5]. A React shell can own layout and host
parts in refs (INFERRED).

**Electron.** Not officially supported (above). Workable architecture (INFERRED from #719 + `docs/vscode_server.md`):
Electron renderer runs monaco-vscode-api; main process spawns a Code OSS `reh` server built **at the exact commit in
`config.vscode.commit`**; connect via remote-agent override for node extensions, terminal, FS. The doc points to
Microsoft's server download or VSCodium `reh` builds [S7b] — Axis would have to build its own `reh` from Code OSS to
avoid Microsoft binary licensing (INFERRED; see `licensing-and-marketplace.md` §1 and §3). Net: B for desktop = B + a Code OSS
server build, i.e. two moving parts version-locked together.

---

## C. Eclipse Theia

**Maturity/activity.** EPL-2.0 with secondary GPL-2.0-with-Classpath-exception. **VERIFIED** [S18]. Monthly minors
(v1.67 2025-12-10 … v1.76.0 2026-09-24; 10 minors/12 months) plus patch releases (v1.74.3 2026-10-23). **VERIFIED** [S4].
365 listed contributors; 927 commits since 2025-11-01; 43 PR authors / 195 merged PRs since 2026-08-01. **VERIFIED** [S4][S18].

**VS Code API compatibility.**
- Declared `DEFAULT_SUPPORTED_API_VERSION`: 1.96.0 (Theia 1.57, 2024-12) → 1.121.0 (1.72) → 1.130.0 (1.74.3) →
  1.139.0 (1.76.0 / master). **VERIFIED** [S19]. At release this is ≈ the then-current VS Code (1.139 released 2026-09-23,
  Theia 1.76 on 2026-09-24).
- Official comparator report (eclipse-theia.github.io/vscode-theia-comparator) tracks 2,685 API items; for Theia
  v1.74.3 ("latest" in report, labelled supported-by VS Code 1.130.0), v1.74.2 and master the counts are identical:
  **2,400 Supported (89.4%), 231 Stubbed (8.6%), 24 Partial, 30 Unsupported**. **VERIFIED** (parsed report HTML) [S20].
  Unsupported items include the whole Timeline API. Stubbed = API exists but no-ops (INFERRED from label).
- Editor core: `@theia/monaco-editor-core` = 1.108.201 in master. **VERIFIED** [S19]. INFERRED: editor internals track
  VS Code 1.108 (2026-01), ~36 weekly minors behind; Theia's own policy aims for "< 1 week of work" per Monaco update and
  forbids re-exporting VS Code internals [S21].

**Features.** Packages include debug, terminal, scm, notebook, search-in-workspace, plugin-ext-vscode, vsx-registry
(Open VSX), remote (SSH), dev-container, remote-wsl, collaboration, electron, secondary-window, plus a large AI
framework (`ai-core`, `ai-chat`, `ai-mcp`, provider packages for several LLM vendors and local runtimes).
**VERIFIED** [S18]. VS Code extensions run in Theia's own plugin host implementing the API above (so behaviour can differ
from VS Code — INFERRED). Settings Sync: UNKNOWN.

**Custom shell.** By design: project goals say Theia "explicitly allows deviation from the standard workbench layout";
widgets can be any tech, `ReactWidget` is the common base; DI via InversifyJS, layout via Lumino; experimental
"Perspectives" (1.74). **VERIFIED** [S21][S22]. React is first-class (`react` ^19 in `@theia/core`) [S18].

**Electron.** First-class target (`@theia/electron`, Electron 44.9.1). **VERIFIED** [S18]. Browser target first-class too.

**Products/precedent.** Theia IDE (master at 1.77.0-next). Arduino IDE 2.3.10 (2026-06-09) is built on
`@theia/*` **1.57.0** (2024-12-16, API 1.96) — an adopter ~18 months behind Theia. **VERIFIED** [S23].

---

## D. Alternative VS Code-compatible server for the web target (combined with A)

| Server | License | Latest | Tracking approach | Lag on 2026-11-01 |
|---|---|---|---|---|
| Code OSS `reh-web` (built from the Axis fork) | MIT | same as fork | same tree as desktop; `gulpfile.reh.ts` targets `reh`, `reh-web` **VERIFIED** [S3] | 0 vs Axis fork (by construction) |
| coder/code-server | MIT | v4.144.0, 2026-10-29 | `lib/vscode` git submodule + **29 quilt patches** (`patches/series`: base-path, proxy-uri, auth/logout, marketplace, webview, service-worker, telemetry, csp-hashes, remote-storage …); bot PRs per upstream release **VERIFIED** [S24] | 1 day after VS Code 1.144.0 |
| gitpod-io/openvscode-server | MIT | v1.109.5, 2026-02-20 | "minimal set of changes" on upstream **VERIFIED** [S25] | 35 minors / ~8 months; last `main` commit and release 2026-02-20 (the repository was last pushed 2026-09-24, on another branch) — INFERRED stalled |

code-server activity: ~15 releases Jul–Oct 2026; 21 PR authors / 102 merged PRs since 2026-08-01. **VERIFIED** [S4].
Gaps: code-server and OpenVSCode are web-only (no Electron) **VERIFIED** (descriptions) [S4]; both run the node
extension host server-side, so web gets full extension compatibility if a server exists (INFERRED). A server-less
static web build (pure browser) only gets web-worker extensions (INFERRED, consistent with [S7]).
Precedent: Positron itself is downstream of Posit's own `vscode-server` fork (Code OSS server for Posit Workbench) —
i.e. A + self-maintained server for web. **VERIFIED** [S11].

INFERRED recommendation within D: build `reh-web` from the Axis fork (one codebase, one pin) and borrow specific
code-server patch ideas (base path, proxy, auth, CSP) under MIT, rather than adopting a second fork. Do not depend on
OpenVSCode Server given its staleness.

---

## Comparison matrix

| | IDE feature coverage | Extension compat | Custom-shell freedom | Desktop | Web | Upstream lag / rebase cost | Team-size precedent | License / branding risk | Overall risk |
|---|---|---|---|---|---|---|---|---|---|
| **A** Code OSS fork | Full (everything upstream ships) | Highest achievable without MS Marketplace; Open VSX; MS-licensed exts excluded | Medium→High: high if shell is a `vs/sessions`-style layer; conflict-prone if `layout.ts`/parts edited | Native Electron, upstream-maintained | Via fork's `reh-web` | Self-controlled. Precedents: VSCodium 69 patches, ~1 minor behind; Positron 4–7k-file merges every 4–5 weeks, ~6 minors behind | VSCodium ~11 PR authors; Positron ~37 PR authors (17 with ≥10 PRs/quarter); Void (small) archived | Low (MIT); must rebrand, swap product.json, Open VSX, no MS services | **Medium** (known, steady cost) |
| **B** monaco-vscode-api | High in browser (most workbench services as overrides); node-only features need a server | Web extensions locally; node extensions only via remote server | Highest (`attachPart` into own React DOM) | Not supported officially; needs Electron + matching Code OSS `reh` server | Native strength (browser) | Fast (days) but skips minors; breaking major each sync; you inherit its 116-patch series + your own app glue | Effectively 1 core maintainer | Low (MIT); server build licensing as in A | **High** (bus factor, Electron gap, two version-locked parts) |
| **C** Eclipse Theia | Broad IDE feature set, own implementations | ~89% stable API Supported, 8.6% stubbed; plugin host is a reimplementation | High by design (DI, ReactWidget, Lumino) | First-class | First-class | Monthly; API version declared current, editor core at 1.108; adopters lag (Arduino 18 months) | 43 PR authors/quarter, foundation-governed | EPL-2.0/GPL-2.0+CE: weak copyleft on modified Theia files (LEGAL REVIEW; not covered by `licensing-and-marketplace.md`) | **Medium-High** (compat fidelity, editor-core lag, different architecture) |
| **D** alt server + A | Same as A for web | Full via server node ext host | n/a (inherits A) | n/a (A) | code-server: tracks in ~1 day; OpenVSCode: stalled; own `reh-web`: zero extra lag | code-server: 29 patches; own reh-web: no extra fork | code-server ~21 PR authors | Low (MIT) | **Low** if own `reh-web`; Medium if second fork |

---

## Recommendation

**Choose A (Code OSS 1.144.0 fork) with the web target served by the fork's own `reh-web` (A+D-self).** Reasoning:

1. Only A gives full VS Code feature parity on both Electron and web from one tree; B lacks native/Electron support and
   C reimplements the extension API (~11% not fully supported).
2. The custom-shell objection to A is weaker in 2026: upstream ships `vs/sessions`, a layout-owning top-level layer above
   `vs/workbench` with desktop and web entry points [S2]. Axis can add an analogous `vs/axis` layer (new files, few
   upstream edits), keeping the patch surface closer to VSCodium's than Positron's.
3. React is proven in a Code OSS fork with **no separate bundler** (Positron: `jsx: react-jsx`, `createRoot` bridge,
   services via context) [S13]. Prefer Positron's in-pipeline approach over Void's side-build. Keep React to leaf
   UI (agent panels, settings) hosted in parts/views; do not React-ify upstream `parts/*` (Positron's 23 tsx there are
   a conflict source — INFERRED).
4. Rebase cost is real but measurable: plan a sync every 2–4 weekly minors with marker-annotated edits
   (`// --- Start Axis ---`) and a patch-count budget. Void shows the failure mode when this is under-resourced.
5. Keep **B as the primary M4 alternative prototype** (best shell freedom, MIT, fast tracking) and C as secondary
   (attractive built-in AI framework and Electron story, but compat fidelity and editor-core lag).

### Must be validated by hands-on spikes
**M3 (custom workbench on Code OSS fork):**
- Build a `vs/axis` layer modelled on `vs/sessions`: own Workbench/layout, desktop + web entry points; measure files
  touched outside new directories (target: count + LOC).
- Mount a React 19 component in a view and in a custom part via a Positron-style renderer; verify CSP, `tsec`/hygiene
  lint, and production bundling (esbuild/mangle) accept `.tsx`.
- Do a real sync 1.144 → latest weekly minor; record wall-clock hours and conflicted files.
- Build `reh-web`, serve with Open VSX; confirm node extensions, terminal, debug (e.g. Native Debug / js-debug), Git.
**M4 (time-boxed alternatives):**
- B: React shell + `attachPart`; run inside Electron with a spawned Code OSS `reh` at mva's pinned commit; test a node
  extension (clangd), terminal, DAP debugging, Git; measure upgrade effort for one mva major (v38 → next).
- C: Theia app with custom React shell; run 10–15 Axis-critical Open VSX extensions and record stubbed-API failures;
  check whether editor-core (1.108-based Monaco) blocks needed editor features.
- All: cold-start time, memory, bundle size on desktop and web.

### Open questions
- Will upstream keep `vs/sessions` layering stable enough to imitate? (It is new and marked with experimental settings.)
- Positron-specific share of merge conflicts per sync — not public; ask Posit or measure in M3.
- Does Axis need Microsoft-licensed extensions (Pylance, C/C++, Remote-SSH)? If yes, every option fails equally.
- Settings Sync equivalent for Axis (none of A–D provide a service) — UNKNOWN; product decision.
- monaco-vscode-api long-term sponsorship beyond its primary maintainer — UNKNOWN.
- EPL-2.0 obligations for a modified Theia shell — LEGAL REVIEW if option C is pursued.

---

## Sources (all accessed 2026-11-01)

- [S1] VS Code releases: https://github.com/microsoft/vscode/releases (via `gh release list -R microsoft/vscode`)
- [S2] Code OSS 1.144.0 `src/vs/sessions/{README,LAYERS,LAYOUT,DESKTOP}.md`: https://github.com/microsoft/vscode/tree/1.144.0/src/vs/sessions
- [S3] Code OSS 1.144.0 `build/gulpfile.reh.ts`: https://github.com/microsoft/vscode/blob/1.144.0/build/gulpfile.reh.ts ; `src/vs/workbench/browser`: https://github.com/microsoft/vscode/tree/1.144.0/src/vs/workbench/browser
- [S4] Release lists / repo metadata: https://github.com/CodinGame/monaco-vscode-api/releases , https://github.com/eclipse-theia/theia/releases , https://github.com/coder/code-server/releases , https://github.com/gitpod-io/openvscode-server/releases , https://github.com/VSCodium/vscodium/releases , https://github.com/posit-dev/positron/releases , https://github.com/voideditor/void (archived flag, releases)
- [S5] monaco-vscode-api `package.json`, README, `vscode-patches/`, contributors, `demo/src/setup.views.ts`: https://github.com/CodinGame/monaco-vscode-api
- [S6] monaco-vscode-api wiki (List of service overrides; Getting started guide; upgrade guide): https://github.com/CodinGame/monaco-vscode-api/wiki
- [S7] monaco-vscode-api issues #719, #810, #723: https://github.com/CodinGame/monaco-vscode-api/issues/719 , https://github.com/CodinGame/monaco-vscode-api/issues/810 ; [S7b] `docs/vscode_server.md`: https://github.com/CodinGame/monaco-vscode-api/blob/main/docs/vscode_server.md
- [S8] VSCodium `patches/` tree, `upstream/stable.json`, `dev/update_patches.sh`, `docs/howto-build.md`: https://github.com/VSCodium/vscodium
- [S9] VSCodium `docs/extensions-compatibility.md`: https://github.com/VSCodium/vscodium/blob/master/docs/extensions-compatibility.md
- [S10] Positron `package.json`, `product.json`, `LICENSE.txt` (Elastic License 2.0), `src/tsconfig.json`, git tree: https://github.com/posit-dev/positron
- [S11] Positron `scripts/pull-upstream.sh` and in-repo upstream-merge runbook / change-marker reference (`merge-upstream-vscode/`): https://github.com/posit-dev/positron/blob/main/scripts/pull-upstream.sh
- [S12] Positron PRs #14673, #15243, #15768, #16475, #16970, #15462, #15670: https://github.com/posit-dev/positron/pulls
- [S13] Positron `src/vs/base/browser/positronReactRenderer.tsx`, `positronReactRendererContext.tsx`: https://github.com/posit-dev/positron/tree/main/src/vs/base/browser
- [S14] Void README, `VOID_CODEBASE_GUIDE.md`, `src/vs/workbench/contrib/void/browser/react/`: https://github.com/voideditor/void
- [S15] Cursor docs, VS Code migration: https://cursor.com/docs/configuration/migrations/vscode
- [S16] Windsurf docs (now Devin Desktop): https://docs.windsurf.com/windsurf/getting-started
- [S17] Windmill `frontend/package.json`: https://github.com/windmill-labs/windmill ; TypeFox monaco-languageclient `packages/client/package.json`: https://github.com/TypeFox/monaco-languageclient
- [S18] Theia repo (README license, `packages/`, `packages/core/package.json`, `packages/electron/package.json`): https://github.com/eclipse-theia/theia
- [S19] Theia `dev-packages/application-package/src/api.ts` at master, v1.76.0, v1.74.3, v1.72.0, v1.57.0; `packages/monaco/package.json`: https://github.com/eclipse-theia/theia/blob/master/dev-packages/application-package/src/api.ts
- [S20] Theia VS Code API status report: https://eclipse-theia.github.io/vscode-theia-comparator/status.html ; generator: https://github.com/eclipse-theia/vscode-theia-comparator
- [S21] Theia `doc/vscode-usage.md`: https://github.com/eclipse-theia/theia/blob/master/doc/vscode-usage.md ; Project goals: https://theia-ide.org/docs/project_goals/
- [S22] Theia docs, Widgets and Perspectives: https://theia-ide.org/docs/widgets/ , https://theia-ide.org/docs/perspectives/
- [S23] Arduino IDE `arduino-ide-extension/package.json` and releases: https://github.com/arduino/arduino-ide ; Theia IDE: https://github.com/eclipse-theia/theia-ide
- [S24] code-server `patches/series`, `docs/CONTRIBUTING.md`, `lib/vscode` submodule: https://github.com/coder/code-server
- [S25] OpenVSCode Server README and commits: https://github.com/gitpod-io/openvscode-server
