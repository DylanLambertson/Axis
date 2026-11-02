# ADR 0005: Axis packages layout (`packages/*`)

- **Status:** Proposed. Becomes Accepted when the staging spike (validation criteria below) shows a package reaching the daemon utility process in a Code OSS build.
- **Date:** 2026-11-02.
- **Decision owner:** Dylan Lambertson.
- **Depends on:** ADR 0002 (Code OSS integration strategy), ADR 0003 (Electron IPC bridge) and ADR 0004 (agent-first workspace shell), all Proposed.
- **Refines:** ADR 0003 D6, which placed the envelope, errors and contract definitions under `src/vs/axis/platform/protocol/common/`. Those move to `packages/protocol` (this ADR). The renderer client, the main seam and the daemon entry stay in the overlay.
- **Related:** `docs/design/axis-agent-shell.md` §5 and §8 (worktree contract, task B4), `docs/design/axis-agent-shell-policies.md`, `docs/ci.md`, `docs/packages.md`.
- **Evidence tags:** **[V]** verified in the Code OSS 1.144.0 tree or an Axis document; **[I]** inferred, not verified.

## Context

Phase 1a needs a lot of Axis-owned daemon and domain logic: the worktree manager, the run journal and audit chain, the protocol contracts, later the policy engine and tool broker. ADR 0002 and ADR 0003 say where the UI and bridge seams go (`code-oss/overlay/src/vs/axis/**`), but not where this logic goes.

Facts that shape the answer:

- **A Code OSS build is expensive.** The checkout and build are about 7.6 GB, and `npm run compile` needs more than 8 GiB of RAM; PR CI cannot run it (`docs/ci.md`, `docs/feasibility/code-oss-build.md` §7) [V]. Code that can only be tested inside that build would be tested rarely.
- **Daemon logic does not need the workbench.** The daemon is a Node utility process with its own entry point (ADR 0003 D1). Worktree management, journal and audit code need `node:*` and a schema library, not `vs/*` services.
- **Code OSS already bundles with esbuild.** `build/next/index.ts` lists entry points by module id (for example `vs/platform/terminal/node/ptyHostMain`, `:100-112`) and bundles each with esbuild 0.27.2 [V]. Its tsconfig is `strict`, `module: nodenext`, `target: ES2024`, with `noUnusedLocals`, `exactOptionalPropertyTypes: false` and `moduleDetection: legacy` (`src/tsconfig.base.json`) [V].
- **The overlay is new-files-only** and copies into `vendor/code-oss` after the patches (`code-oss/overlay/README.md`). Post-apply hooks may add untracked files but may change no upstream file except lockfiles (`code-oss/hooks/post-apply.d/README.md`) [V].
- **Zod 4.4.3** is a direct dependency of Code OSS 1.144.0 (`package.json:173`, locked at 4.4.3) and ADR 0003 D2 chose it for contracts [V].

## Options

### A. Everything in the overlay (`src/vs/axis/**`)

- **For:** one build, one lint, nothing new to stage.
- **Against:** every test needs the 7.6 GB checkout; domain logic is tied to `vs/*` layering rules and Code OSS compiler flags; the three parallel workstreams (protocol, worktrees, audit) cannot be developed or reviewed without a full tree.

### B. Standalone packages in `packages/*`, published to a registry and consumed as dependencies

- **For:** hard isolation.
- **Against:** needs a registry, versioning and a `package.json` patch to Code OSS, which conflicts on every weekly upstream sync (ADR 0003 D2 rejects the same cost for a new dependency). Not justified for private, single-repo code.

### C. Packages in `packages/*`, built and tested alone, then staged into the overlay tree at apply time (chosen)

Packages are plain TypeScript workspaces. A post-apply hook copies their sources into the Code OSS tree as new untracked files, so Code OSS's own compiler and esbuild bundler treat them as ordinary `src/vs/axis` sources.

### D. Pre-bundle each package to a single JS file with esbuild, stage the bundle and a `.d.ts`

- **For:** the packages never meet Code OSS's compiler flags or lint; deterministic single file.
- **Against:** `build/next/index.ts transpile` (the development build) globs `src/**/*.ts`, so a `.js` file is not emitted into `out/`, and `build/next/resources.ts` copies only curated `.js` patterns [V]. That breaks development runs unless more upstream lines are patched. Needs a second esbuild at a version separate from Code OSS's. Kept as the fallback if C fails the spike.

## Decision (proposed)

### D1. What goes where

| Lives in `packages/*` (`@axis/*`) | Lives in `code-oss/overlay/src/vs/axis/**` |
|---|---|
| Wire contracts and schemas (`@axis/protocol`) | Renderer client, views, agent part, workbench contributions |
| Daemon and domain logic: worktree manager, journal, audit, later policy and broker | Main-process seam (daemon fork, handshake, native approvals) |
| Anything that needs only `node:*`, `zod` and other `@axis/*` packages | Anything that uses `vs/*` services, DI, `IFileService`, Electron or the DOM |
| The daemon's RPC server core and policy pipeline (when written) | The thin daemon entry `daemon/node/axisDaemonMain.ts`, which wires packages to `process.parentPort` |

Rule of thumb: if it can be tested with `node --test` on a clean CI runner, it is a package. If it needs a workbench service, it is overlay code.

### D2. The boundary rules (enforced, not advisory)

1. **Packages never import `vs/*`,** Electron, or the DOM. A package may import `node:*`, `zod` and other `@axis/*` packages. Nothing else without an amendment to this ADR.
2. **The overlay talks to the daemon only through `@axis/protocol`,** over the MessagePort from ADR 0003 D1. The renderer imports contracts, never domain packages. A renderer import of `@axis/worktrees` is a defect; the renderer asks the daemon.
3. **Packages assume nothing about who calls them.** Identity (`ConnectionContext`) and actor come from the daemon pipeline, never from payload fields (ADR 0003 D2, D7).
4. **Contracts have no Node imports** so web and desktop share them (ADR 0003 I8). Domain packages may use Node.
5. **Packages do not read `process.env` or the clock implicitly** where tests need control: take them as parameters.

Enforcement: package `tsconfig.base.json` sets `types: ["node"]` and `lib: ["ES2023"]` with no `DOM`, so DOM and Electron types fail to compile. `vs/*` is not resolvable from `packages/` at all. The overlay side gets an import-patterns target (below).

### D3. How packages reach the app

Option C, in four parts. All of this is **[I]** until the spike.

1. **A post-apply hook `code-oss/hooks/post-apply.d/20-stage-axis-packages`** copies every non-test source `packages/<name>/src/**/*.ts` to `src/vs/axis/packages/<name>/**` in the Code OSS tree. These are new untracked files, which the hook contract allows. The hook:
   - rewrites `@axis/<name>` imports to the relative path of the staged package index (the only transformation; the sources already use `.js`-suffixed relative imports, the same convention Code OSS uses);
   - writes a generated-file header and a manifest of copied files with SHA-256 hashes into `vendor/code-oss.applied`;
   - refuses to run if a package imports anything outside D2.1, or if the staged `zod` version differs from the one Code OSS locks.
2. **No new bundler.** Code OSS's esbuild (`build/next`) bundles the staged sources because `axisDaemonMain.ts` (overlay) imports them. The entry list line in `build/next/index.ts` that ADR 0003 D6 already budgets (≤ 2 lines) is the only build-system seam; this ADR adds none.
3. **Type-checking twice, on purpose.** The packages are checked in `packages/` with strict flags that are a superset of Code OSS's (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`; `noUnusedLocals` is added to the base config to match). The staged copy is then checked again by Code OSS's compiler, which catches flag drift early. A package that compiles in `packages/` but not in the tree is a staging bug to fix in the package, not by loosening the tree.
4. **Overlay lint.** The `build/axis/eslint.axis.ts` import-patterns target (ADR 0003 D6 moved it to the overlay) allows `src/vs/axis/packages/<name>` only from `daemon/node`, `server/node` and, for `protocol` only, the renderer client. This holds the line that the renderer imports contracts only.

The same staged code serves desktop (utility process) and web (the reh child process, ADR 0003 D1.7), because both are Node.

### D4. Dependency policy

- **Runtime dependencies:** `zod` only, pinned exactly to **4.4.3**, matching Code OSS 1.144.0 so that the build contains one copy. Every upgrade of Code OSS's Zod is an upgrade here, in the same PR.
- **Dev dependencies:** `typescript` and `@types/node`, pinned exactly, at the repository root only.
- **No other runtime dependency** without an ADR amendment. `node:sqlite` or the Code OSS-provided SQLite is chosen by the journal workstream, not assumed here.
- **Exact pins and a committed lockfile.** CI installs with `npm ci`; `--ignore-scripts` is used wherever install scripts are not needed.
- **Known advisory.** `zod@4.4.3` has GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections; fixed in 4.6.6) [V, npm audit]. The pin is forced by D4's rule of one copy. Mitigation: ADR 0003 D2's envelope check bounds message size, depth and string length before any schema runs, and every array and record in a contract carries an explicit maximum. Review again at each Code OSS sync.

### D5. Language, module and build conventions

- npm workspaces at the repository root; packages in `packages/<name>/`, named `@axis/<name>`, `private: true`, `"type": "module"`.
- TypeScript strict, `NodeNext` modules, target `ES2023`, one `tsconfig.base.json` that every package extends, with project references between packages.
- Tests use `node:test` and `node:assert` only. `npm test` builds with `tsc -b` and runs `node --test "dist/test/**/*.test.js"`. (Node 24 does not accept a bare directory after `--test`.)
- Node version is the one in `code-oss/upstream.json` (`24.22.1`), recorded in `engines`.
- **Lint.** Strict `tsc` is the gate for now. An ESLint flat config is deferred: it needs `typescript-eslint` and its transitive dependencies for little gain over strict `tsc`, and the overlay already carries the lint that matters (import patterns). Revisit when a package has logic that the compiler cannot catch.

### D6. Testing and CI

- A CI job `Axis packages` runs `npm ci`, `npm run typecheck`, `npm run build` and `npm test` on Linux with the Node version read from `code-oss/upstream.json`. It does not need the Code OSS checkout, so it is cheap and runs on every PR.
- After merge, `Axis packages` becomes a required check (`docs/ci.md`).
- Staging is tested in two layers: a unit test of the hook against a fake tree (no 7.6 GB build), and the manual full build for the end-to-end check.

### D7. File headers

Every Axis-owned source file starts with `// Copyright (c) 2026 Dylan Lambertson. All rights reserved.` Axis-owned code is proprietary (ADR 0002); packages carry `"license": "UNLICENSED"` and `"private": true` so they cannot be published by accident.

## Consequences and tradeoffs

- Domain logic is testable in seconds on any machine, in parallel by separate workstreams, with no checkout.
- A staging step is a new moving part. Its failure modes (flag drift, import rewrite bugs) are caught by the double type-check and the hook's own tests, but they exist.
- Source staging couples packages to Code OSS's compiler flags. The base config is kept a superset of them so drift shows in `packages/` first.
- ADR 0003's file budget is unchanged: no upstream file is touched beyond what D6 already counted. The hook adds untracked files only.
- Two homes for Axis code need a clear rule. D1 is that rule; reviews should reject code in the wrong home.
- `zod` stays pinned to a version with a known advisory until Code OSS moves. The mitigation is design (bounded contracts), not an upgrade.

## Validation criteria (staging spike, before Accepted)

1. A package's staged copy compiles under Code OSS's `src/tsconfig.json` with no changes to the package.
2. `build/next` bundles `axisDaemonMain.ts` with a staged package; the bundle contains one copy of `zod`.
3. The daemon utility process in a packaged build imports and runs a package function.
4. The import-patterns lint rejects a renderer import of a domain package and a package import of `vs/*`.
5. Dev (`transpile`) and packaged builds both work.

## Rollback

- **If staging fails the spike,** switch to Option D (pre-bundled JS plus declarations). Packages, tests and CI do not change; only the hook and the upstream entry line do.
- **If the split proves wrong,** the packages move into `src/vs/axis` as plain source (Option A). They are already plain TypeScript with relative imports and no workspace-only features, so the move is a file copy plus deleting the rewrite step.
- Deleting `packages/`, the root `package.json` and the hook leaves ADR 0002 and ADR 0003 as they were, except for ADR 0003 D6's protocol location.

## Open questions

1. Where does the SQLite binding come from for `@axis/journal`: `node:sqlite` in the pinned Node, or Code OSS's `@vscode/sqlite3`? (Journal workstream.)
2. Should renderer-side contract use go through `zod/mini` (smaller bundle, no JIT) and, if so, should `@axis/protocol` expose a mini entry? Measure in the M3 spike (ADR 0003 D2).
3. Should the hook fail or warn on a package that compiles under Code OSS only with `noUnusedLocals` disabled? Proposed: fail.
