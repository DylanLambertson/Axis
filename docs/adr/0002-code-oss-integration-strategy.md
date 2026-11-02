# ADR 0002: Code OSS integration strategy

**Status:** Proposed. Becomes Accepted, or is replaced, once the Phase 0 M3 and M4 spikes report against the criteria below.
**Date:** 2026-11-01
**Upstream baseline:** `microsoft/vscode` tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.

**Phase 0 milestones referenced in this ADR:**

| ID | Milestone |
|---|---|
| M1 | Upstream inventory and licensing review |
| M2 | Reproducible pinned Code OSS build |
| M3 | Custom workbench spike |
| M4 | Time-boxed prototypes of options B and C |
| M5 | Extension compatibility matrix |
| M6 | Web prototype |
| M7 | Threat model |
| M8 | Cross-OS CI |

## Context

Axis needs VS Code-class IDE capabilities (editor, LSP, debugger, terminal, Git, search, extension host) on Electron desktop and in the browser, behind a custom minimal workbench shell. ADR 0001 left the integration approach open pending this Phase 0 gate.

Evidence gathered for this decision lives in `docs/feasibility/`:

- `code-oss-inventory.md`: build targets, layering, shell architecture, security posture and upstream cadence at the pinned tag.
- `licensing-and-marketplace.md`: license, trademark, marketplace, proprietary-extension and telemetry constraints.
- `integration-alternatives.md`: comparison of the four options below, with precedents.

The facts that most shape the decision:

1. **Weekly upstream releases.** Upstream ships a minor release every week. Between 1.120 and 1.144 that is 25 minors in about 25 weeks, and about 40% of them got recovery releases. `integration-alternatives.md` measures the longer 1.111–1.144 window, with the same weekly result. Downstream forks batch several minors per sync.
2. **Closed main shell.** The main workbench shell is a hard-coded composition. The part list is fixed in `workbench.ts`, the grid topology in `layout.ts`, and part IDs are a `const enum`. Features reach the shell only through `IWorkbenchLayoutService`, part IDs, view-container locations and menus.
3. **Upstream already ships an alternative shell.** `src/vs/sessions` is a full second workbench shell with its own entry points, layout service implementation and parts. It reuses the shared services and part base classes, with lint-enforced layering. That is a first-party template for a separate Axis shell.
4. **Copilot is wired into core.**
   - `@vscode/copilot-api` is licensed for Code-OSS "for development purposes only". It is imported by 4 non-test files in `src/vs/platform/agentHost/` plus a typings file.
   - `@github/copilot-sdk` is imported by 54 non-test files under `src/vs/platform/agentHost/**`, and the build throws if its metadata is missing (`build/lib/copilot.ts:56-60`).
   - The in-tree `extensions/copilot` depends on `@github/copilot`.
   - `product.json` sets `defaultChatAgent` to GitHub Copilot.
   - Precedent: VSCodium's removal is a 125-path manifest plus a 29-file, about 3,567-line patch, about 1,470 of those lines lockfiles. Removal is therefore likely the largest patch Axis carries, larger than the shell itself.
5. **No Microsoft Marketplace.** The Visual Studio Marketplace terms restrict use to Microsoft in-scope products. Microsoft-licensed extensions (Pylance, C/C++ binaries, C# Dev Kit, Remote-SSH/Containers/WSL, Live Share) cannot be offered. Open VSX is the viable registry, but it carries capacity and commercial-terms questions.

## Options

| | Option | Summary | Main risk |
|---|---|---|---|
| A | Code OSS fork | Build Axis from Code OSS sources; customize via contributions and a separate shell layer | Rebase cost against weekly upstream |
| B | `@codingame/monaco-vscode-api` | Custom (React) app hosting VS Code services and parts | Single core maintainer; no Electron support, so node extensions need a version-locked Code OSS server; breaking major each sync |
| C | Eclipse Theia | Separate IDE framework with VS Code API compatibility | 8.6% of API stubbed, editor core at 1.108, EPL-2.0/GPL-2.0 obligations |
| D | Third-party web server (code-server / OpenVSCode Server) | Web target from an external fork, combined with A | A second fork to track; OpenVSCode Server is stale |

## Decision (proposed)

Adopt **Option A**, with the web target built from the same fork's `vscode-reh-web` server target (no third-party server fork):

1. **Upstream handling: a pinned checkout plus a patch series. This is not a full-history fork.**
   - The Axis repository records the upstream tag and commit in a manifest.
   - A script fetches that exact commit into an ignored working directory, then applies Axis patches (a numbered series) and copies Axis-owned source (new files such as `src/vs/axis/**`) into the tree before building.
   - Upstream code is never committed to the Axis repository. Phase 0 M2 implements this mechanism.
2. **Customization depth: lowest that works.**
   - First restyle through contributions, a built-in theme, `product.json` and default settings. These need almost no upstream edits.
   - Then a separate `src/vs/axis` shell layer modelled on `src/vs/sessions`. It implements `IWorkbenchLayoutService`, reuses upstream parts and services, and overrides singletons registered after upstream imports.
   - **Do not edit `layout.ts` or `workbench/browser/parts/*` in place.**
3. **Upstream sync cadence.** Sync onto the latest recovery release every 2–4 weekly minors. Track the patch count and changed upstream lines as a budget, and mark edits in upstream files with `// --- Start Axis ---` / `// --- End Axis ---`.
4. **UI technology.** Keep upstream's vanilla TypeScript/DOM for anything inside reused parts.
   - React is allowed only for Axis-owned leaf UI (views and panels), compiled in the normal pipeline the way Positron does it: `jsx: react-jsx` and a renderer bridge passing services through context.
   - M3 must confirm this works with CSP, Trusted Types, lint and production bundling before it is adopted.
5. **Licensing guardrails, required before any distributed build:**
   - full rebrand (`product.json` identity keys, `resources/` icons, Microsoft strings in `build/lib/electron.ts`);
   - MIT and third-party notices in desktop, server and web artifacts;
   - `extensionsGallery` pointed at Open VSX or a self-hosted registry;
   - Copilot dependencies, `extensions/copilot` and `defaultChatAgent` removed or replaced (see decision 6);
   - Microsoft/GitHub service endpoints removed;
   - telemetry off, or Axis-owned and opt-in.

   Items marked LEGAL REVIEW in `licensing-and-marketplace.md` need sign-off before release.
6. **Copilot removal strategy: a separate, budgeted patch set.**
   - It is kept apart from the shell layer, as a numbered patch range plus an optional removal manifest of paths deleted by `apply.sh`.
   - M3 evaluates, in this order: (a) not building or loading the agent host entry points and the Copilot extension, by removing them from the build entry lists and packaging tasks and leaving the sources in place but unbundled; (b) replacing the two packages with local stubs; (c) deleting the providers, VSCodium-style. The cheapest option that yields a build free of those packages and their runtime is chosen.
   - Lockfile changes are regenerated by the build scripts, never hand-edited.

## Validation criteria (M3–M6)

**Accept** this ADR when all of the following hold:

1. **Shell works:** a custom Axis shell runs editor, explorer, search, SCM/Git, terminal, debugger, diagnostics, command palette and the extension host, on macOS and on Linux.
2. **Shell footprint:** the shell layer changes at most **12 upstream files and 300 upstream lines**. `product.json` and resources don't count.
3. **Guardrail footprint is measured:** the Copilot removal and rebrand patch set (decision 6) is measured and recorded, and it rebases cleanly as part of criterion 4. There is no fixed line budget for it. The cheapest strategy that removes the packages is chosen.
4. **Sync cost:** one real sync from 1.144 to a release at least **2 weekly minors later**, matching the sync policy, takes **≤ 1 working day** for all Axis patches (shell plus guardrails). Conflicts are confined to the patched seams.
5. **React is viable:** a React view built through the normal pipeline passes CSP and Trusted Types, lint/hygiene and the production bundle (decision 4). If it fails, Axis UI stays vanilla TypeScript; that does not reject the ADR.
6. **Extensions:** the M5 matrix of 10 representative Open VSX extensions runs on the Axis build, with every failure recorded. Failures caused by Axis changes must be fixable within the patch budget.
7. **Web:** `reh-web` serves the shell in a browser, with node extensions, terminal and Git working through Open VSX, and gaps documented.

**Revisit** in favour of B or C when any of the following holds:

- The shell needs deep patches to `layout.ts` or the parts (over about 300 changed upstream lines).
- A sync takes more than **3 working days**.
- The M4 prototypes meet the same checklist with materially lower maintenance cost.

**Otherwise** (some acceptance criteria missed without hitting a revisit trigger, e.g. a sync of 1–3 days, or a matrix failure that needs a fix outside the budget):

- The ADR stays Proposed.
- The miss is recorded with a remediation plan and a re-measurement date.
- The owner decides whether Phase 0 exits with a documented exception or extends.

## Consequences

- **Positive:**
  - Full upstream feature set on desktop and web from one tree.
  - Upstream-maintained Electron security posture (sandboxed renderer, validated IPC, Trusted Types CSP).
  - MIT licensing.
  - Axis controls its own sync pace.
- **Negative:**
  - A permanent, recurring rebase cost against a weekly upstream.
  - A large inherited codebase (about 3.9M lines of TypeScript at the tag, around half of it upstream agent/chat code Axis may not need).
  - Weekly upstream churn in shell-adjacent code (`IWorkbenchLayoutService` has about 48 members).
- **Product:**
  - No Microsoft Marketplace and no Microsoft-licensed extensions; open alternatives need their own license checks.
  - Settings Sync needs an Axis-owned design.
  - Open VSX capacity and terms are a business decision before launch.

## Rollback

**Before acceptance**, the decision affects only the build scripts and the patch series. Switching after the spikes:

- **To Option B:** keep the M2 pinned-checkout and build mechanism, which B needs anyway for a Code OSS `reh` server built at the commit monaco-vscode-api pins. Discard the Axis shell layer.
- **To Option C:** discard both the shell layer and the patches.

No product code is lost either way. Product services (AI gateway, orchestration, context, execution, policy) stay behind versioned interfaces per ADR 0001, independent of this choice.

**After acceptance**, a revisit trigger seen during regular syncs (sync cost or patch footprint, tracked per sync) opens a superseding ADR. The migration then reuses the same interfaces.
