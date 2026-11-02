# ADR 0002: Code OSS integration strategy

**Status:** Proposed. Becomes Accepted or is replaced after the Phase 0 M3 (custom workbench) and M4 (alternatives) spikes report against the criteria below.
**Date:** 2026-11-01
**Upstream baseline:** `microsoft/vscode` tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.

## Context

Axis needs VS Code-class IDE capabilities (editor, LSP, debugger, terminal, Git, search, extension host) on Electron desktop and in the browser, behind a custom minimal workbench shell. ADR 0001 left the integration approach open pending this Phase 0 gate.

Evidence gathered for this decision lives in `docs/feasibility/`:

- `code-oss-inventory.md`: build targets, layering, shell architecture, security posture and upstream cadence at the pinned tag.
- `licensing-and-marketplace.md`: license, trademark, marketplace, proprietary-extension and telemetry constraints.
- `integration-alternatives.md`: comparison of the four options below, with precedents.

The facts that most shape the decision:

1. **Weekly upstream releases.** Upstream ships a minor release every week (1.119 to 1.144: 25 minors in about 25 weeks), and roughly a third of them get recovery releases. Downstream forks batch several minors per sync.
2. **Closed main shell.** The main workbench shell is a hard-coded composition. The part list is fixed in `workbench.ts`, the grid topology in `layout.ts`, and part IDs are a `const enum`. Features reach the shell only through `IWorkbenchLayoutService`, part IDs, view-container locations and menus.
3. **Upstream already ships an alternative shell.** `src/vs/sessions` is a full second workbench shell with its own entry points, layout service implementation and parts. It reuses the shared services and part base classes, with lint-enforced layering. That is a first-party template for a separate Axis shell.
4. **Copilot is wired into core.** It depends on `@vscode/copilot-api`, licensed for Code-OSS "for development purposes only", on `@github/copilot-sdk`, and on the in-tree `extensions/copilot` (which depends on `@github/copilot`). `product.json` sets `defaultChatAgent` to GitHub Copilot.
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
   - Copilot dependencies, `extensions/copilot` and `defaultChatAgent` removed or replaced;
   - Microsoft/GitHub service endpoints removed;
   - telemetry off, or Axis-owned and opt-in.

   Items marked LEGAL REVIEW in `licensing-and-marketplace.md` need sign-off before release.

## Validation criteria (M3/M4)

Accept this ADR if the M3 spike shows all of the following:

- A custom Axis shell running editor, explorer, search, SCM/Git, terminal, debugger, diagnostics, command palette and the extension host, on macOS and on Linux.
- Upstream footprint of the shell layer at **≤ 12 upstream files and ≤ 300 changed upstream lines**, excluding `product.json` and resources.
- One real sync from 1.144 to a later weekly minor completed in **≤ 1 working day**, with conflicts limited to the patched seams.
- `reh-web` serving the shell in a browser with node extensions, terminal and Git working through Open VSX, with gaps documented.

Revisit in favour of B or C if any of the following holds:

- The shell needs deep patches to `layout.ts` or the parts (more than about 300 changed upstream lines).
- A single sync takes more than about 3 working days.
- The M4 prototypes show B or C meeting the same feature checklist with materially lower maintenance cost.

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

Until M3 ships, the decision affects only the build scripts and the patch series. Moving to Option B or C after the spikes discards the Axis shell layer and patches but no product code. Product services (AI gateway, orchestration, context, execution, policy) stay behind versioned interfaces per ADR 0001, independent of this choice.
