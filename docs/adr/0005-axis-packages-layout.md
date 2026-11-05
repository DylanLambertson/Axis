# ADR 0005: Axis packages layout (`packages/*`)

- **Status:** Proposed. Spike results are in the Results table below (Linux, 12 packages, 2026-11-05); it becomes Accepted with the owner's decision. Open before then: the overlay import-patterns lint (criterion 4), running the stub as a real utility process (ticket X1, criteria 3 and 5), the macOS packaged re-run, and ticket BRAND-1 (D3.6).
- **Date:** 2026-11-02.
- **Decision owner:** Dylan Lambertson.
- **Depends on:** ADR 0002 (Code OSS integration strategy), ADR 0003 (Electron IPC bridge) and ADR 0004 (agent-first workspace shell), all Proposed.
- **Refines:** ADR 0003 D6, which placed the envelope, errors and contract definitions under `src/vs/axis/platform/protocol/common/`. Those move to `packages/protocol` (this ADR). The renderer client, the main seam and the daemon entry stay in the overlay. Also refines the ADR 0003 D3 envelope sketch (see D8).
- **Related:** `docs/design/axis-agent-shell.md` §5 and §8 (worktree contract, task B4), `docs/design/axis-agent-shell-policies.md`, `docs/ci.md`, `docs/packages.md`.
- **Evidence tags:** **[V]** verified in the Code OSS 1.144.0 tree, an Axis document or by running the staging spike; **[I]** inferred, not verified.

## Context

Phase 1a needs a lot of Axis-owned daemon and domain logic: the worktree manager, the run journal and audit chain, the protocol contracts, later the policy engine and tool broker. ADR 0002 and ADR 0003 say where the UI and bridge seams go (`code-oss/overlay/src/vs/axis/**`), but not where this logic goes.

Facts that shape the answer:

- **A Code OSS build is expensive.** The checkout and build are about 7.6 GB, and `npm run compile` needs more than 8 GiB of RAM; PR CI cannot run it (`docs/ci.md`, `docs/feasibility/code-oss-build.md` §7) [V]. Code that can only be tested inside that build would be tested rarely.
- **Daemon logic does not need the workbench.** The daemon is a Node utility process with its own entry point (ADR 0003 D1). Worktree management, journal and audit code need `node:*` and a schema library, not `vs/*` services.
- **Code OSS already bundles with esbuild, but leaves packages external.** `build/next/index.ts` lists entry points by module id (for example `vs/platform/terminal/node/ptyHostMain`, `:100-112`) and bundles each with esbuild 0.27.2 [V]. `build/next/bundle.ts` sets `packages: 'external'`, so a bare import such as `zod` is **not** bundled: it stays an import and resolves at run time to the application's own `node_modules`, which at this commit holds zod 4.4.3 [V, run: a one-file esbuild with the same option kept `import { z } from "zod"`]. Its tsconfig is `strict`, `module: nodenext`, `target: ES2024`, with `noUnusedLocals`, `exactOptionalPropertyTypes: false` and `moduleDetection: legacy` (`src/tsconfig.base.json`) [V].
- **The overlay is new-files-only** and copies into `vendor/code-oss` after the patches (`code-oss/overlay/README.md`). Post-apply hooks may add untracked files but may change no upstream file except lockfiles (`code-oss/hooks/post-apply.d/README.md`) [V].
- **Zod** is a direct dependency of Code OSS 1.144.0 (`package.json:173`, locked at 4.4.3) and ADR 0003 D2 chose it for contracts [V]. 4.4.3 carries a high advisory (see D4).

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

### D2. The boundary rules

1. **Packages never import `vs/*`,** Electron, or the DOM. A package may import `node:*`, `zod` and other `@axis/*` packages. Nothing else without an amendment to this ADR.
2. **The overlay talks to the daemon only through `@axis/protocol`,** over the MessagePort from ADR 0003 D1. The renderer imports contracts, never domain packages. A renderer import of `@axis/worktrees` is a defect; the renderer asks the daemon.
3. **Packages assume nothing about who calls them.** Identity (`ConnectionContext`) and actor come from the daemon pipeline, never from payload fields (ADR 0003 D2, D7).
4. **Contracts have no Node imports** so web and desktop share them (ADR 0003 I8). Domain packages may use Node.
5. **The daemon MUST validate every decoded client message (`hello`, request and cancel) with `parseClientMessage` from `@axis/protocol`.** It runs `inspectMessage` before any schema: one iterative walk that rejects forbidden keys (`__proto__`, `constructor`, `prototype`), shared references and cycles, values JSON cannot carry, and anything over the limits in D4. [V, zod 4.6.6] A top-level own `__proto__` on a strict object is rejected by Zod, but inside a `z.json()` value it is silently dropped, which hides the attack instead of refusing it. Rejecting is the intended behaviour, and it also covers per-method payloads parsed later. Calling the envelope schemas directly is a defect.
6. **Packages do not read `process.env` or the clock implicitly** where tests need control: take them as parameters.

Enforcement, today:
- `test/packages/imports.test.mjs` (run by `npm test`) scans the import specifiers of every TypeScript file in each package (`src/`, `test/`, `contract/` and any other directory, excluding `dist/` and `node_modules/`) and each `package.json`. Packages may import relative paths that stay inside the package, `zod`, `@axis/*` and `node:*`; `@axis/protocol` may not import `node:*` in `src/` (D2.1, D2.4), but its tests and test-support entry points may. Anything else, including `vs/*` and `electron`, fails. Declared dependencies may only be `zod` (at the pinned version) and `@axis/*`.
- `tsconfig.base.json` sets `lib: ["ES2023"]` with no `DOM`, so DOM types fail to compile.

Not yet implemented: the renderer-imports-contracts-only rule (overlay import-patterns target, D3.4) and the hook's own checks (D3.1). D2.2, D2.3, D2.5 and D2.6 are review rules, with D2.5 tested at the `@axis/protocol` level.

### D3. How packages reach the app

Option C, implemented and proved by the staging spike [V]. In four parts:

1. **A post-apply hook `code-oss/hooks/post-apply.d/20-stage-axis-packages`** (logic in `scripts/code-oss/stage-packages.mjs` with `stage-fs.mjs`, `stage-scan.mjs` and `stage-verify.mjs`; tests in `test/code-oss/stage-*.test.mjs` and `test/packages/stage-real.test.mjs`) writes new untracked files under `src/vs/axis/packages/` in the Code OSS tree, which the hook contract allows. It:
   - copies every non-test `packages/<name>/src/**/*.ts` to `src/vs/axis/packages/<name>/**`, with a generated-file header after the copyright line;
   - rewrites `@axis/<name>` to the relative path of the staged package `index.js`, a declared subpath such as `@axis/journal/daemon-principal` to its staged module, and bare `zod` to the vendored copy (the only transformations; the sources already use `.js`-suffixed relative imports, the same convention Code OSS uses). A subpath is stageable only if the package's `exports` maps it into `dist/src/` (so `@axis/providers/contract`, which lives outside `src/`, is not);
   - vendors zod (D4);
   - writes `stage-manifest.json` with the SHA-256 of every staged file and of its source, and a `treeSha256` over all of them. The tree fingerprint recorded in `vendor/code-oss.applied` covers the staged files, and the stamp records the hook script's hash (not those of its helper modules: the fingerprint of the output is what detects drift);
   - **refuses (fail closed, leaving no staged output)** anything outside this allowlist. Inputs are regular files only: `packages/<name>/package.json`, `packages/<name>/src/**/*.ts` and the zod files its entry point reaches. It reads without following links (`O_NOFOLLOW`, then `fstat` on the open descriptor), refuses a symbolic link, device, pipe or socket anywhere in the inputs (the whole `node_modules/zod` tree is listed first, so a link anywhere in it fails the run, used or not), refuses a file with more than one hard link, and re-checks at the end that every input is unchanged and still resolves inside the repository (a directory swapped for a link after it was read fails), a link in the tree path it would write through, `node_modules` or `dist` under `src`, any other extension (`.js`, `.json`, `.d.ts`, `.node`), a test file in `src`, hidden or oddly named files, invalid UTF-8 or NUL bytes, files over 4 MiB (32 MiB in all), a package whose `name` is not `@axis/<dir>`, and a dependency other than `zod` and `@axis/*`. A file dated more than five minutes in the future, or modified while staging, is refused ("no files newer than expected"); so is a staged directory that holds a file its manifest does not list;
   - applies the import allowlist (relative inside the package's `src`, `node:*`, `zod` pinned, `@axis/*` and declared subpaths) to the **source**, then again to the **staged files** (`verifyStaged`, which re-reads them from disk and checks them against the manifest): after rewriting, a staged file may import only `node:*` and other staged files, so a bare `zod` or `@axis/*` left over, a path leaving the staged tree, an unresolved target, or a restricted module (below) reached by relative path fails. Imports are found on the tokens of a small tokenizer (`tokenize` in `stage-scan.mjs`: strings, nested templates, regular-expression literals, comments), so `import { "z" as z } from "zod"`, `export { "x" as y } from "vs/..."` and `import /* ' */ ...` are seen; the text patterns also run on the raw text, comments included, and a commented-out import is rewritten and checked like a real one. Escapes in a specifier fail the allowlist. The scans refuse `eval`, `new Function`, `createRequire`, `getBuiltinModule`, `process.binding`, `import.meta.resolve`, triple-slash references and any dynamic load with a non-literal argument, in Axis sources only (vendored zod uses `new Function` for its JIT and is pinned third-party code; the daemon can set `z.config({ jitless: true })`). They are still text and token lints; the module-graph check in part 5 is the stronger guarantee;
   - refuses if the installed zod is not the version pinned in `packages/*/package.json`, or if `src/vs/axis/packages` exists and was not staged by it;
   - writes into a temporary sibling `src/vs/axis/packages.staging`, verifies it there and renames it into place, so a failure while writing (full disk, a path collision, a case-insensitive duplicate such as `Foo.ts` and `foo.ts`, which is refused up front) leaves no partial tree, and a temporary left by a run that died is removed by the next run. The package name `vendor` is reserved for the vendored namespace, and the vendored zod `package.json` is a synthesized minimal one (no `scripts`, no `exports` map);
- is deterministic and idempotent: output depends on file contents only (not time, user, umask or path; files are 0644 and directories 0755), so the same input gives the same `treeSha256`, and it deletes and rebuilds its output directory, so files of deleted sources disappear.
2. **No new bundler.** Code OSS's esbuild (`build/next`) bundles the staged sources because the overlay entry `vs/axis/daemon/node/axisDaemonMain.ts` imports them. The only build-system seam is `code-oss/patches/0200-axis-daemon-entry.patch` in `build/next/index.ts`: three added lines in each of the desktop and server entry lists (6 lines) and the private-field exemption of D3.6 (4 added lines and one changed line). **Budget:** ADR 0003 D6 allowed 2 lines for the entry seam; the patch adds 11 lines and removes 1, of which 6 are the `// --- Start/End Axis ---` markers the footprint report requires and 1 is a comment. The overrun is the second entry list (the reh server needs the entry too), the markers, and a security exemption that was not foreseen. The owner has not yet accepted this; `footprint.sh` still shows the shell block at 4 files, +32/−2. The file was first touched by this series in the shell block (only patch 1530 touched it before). The entry in this change is a stub that prints the protocol and contract list and the zod version, enough to prove bundling. **Left for ticket X1** (`docs/design/daemon-host.md`): the real `axisDaemonMain.ts`, a ~30-line adapter that wraps `process.parentPort` and calls `runHost` from `@axis/daemon-host`, plus the main-process seam that forks it; the entry-list lines stay as they are.
3. **Type-checking twice, on purpose.** The packages are checked in `packages/` with strict flags that are a superset of Code OSS's (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`; `noUnusedLocals` matches). The staged copy is then checked again by Code OSS's compiler. [V] Only the tree's real `npm run typecheck-client` (`src/tsconfig.json`) is a faithful second check: it loads Code OSS's global typings and found three packages that the base-config check passed (`setTimeout` returns an opaque handle there, so `.unref()` needs a cast). `check-staged.mjs --full-typecheck` runs it (about 1 minute, 8.2 GiB). A package that compiles in `packages/` but not in the tree is fixed in the package, not by loosening the tree.
4. **Overlay lint.** The `build/axis/eslint.axis.ts` import-patterns target (ADR 0003 D6 moved it to the overlay) allows `src/vs/axis/packages/<name>` only from `daemon/node`, `server/node` and, for `protocol` only, the renderer client. This holds the line that the renderer imports contracts only. **[I]** Not implemented yet.
5. **Module-graph check on the real bundle** (`scripts/code-oss/check-daemon-graph.mjs`; `scripts/code-oss/check-staged.mjs` runs it with the type-check). It bundles the daemon entry and every staged package index with the tree's esbuild and the options of `build/next/bundle.ts`, with a metafile, and checks what esbuild resolved: every input under `src/vs/axis/packages` is a file the hook wrote; no input comes from `node_modules`; a staged module imports only `node:*` and staged files (an import esbuild dropped as unused is reported as external with its relative specifier, and passes only if it names a staged file); nothing imports a bare `zod` (the tree's 4.4.3); the bundle carries the pinned zod version and not the tree's; and the restricted modules (table `RESTRICTED_MODULES` in `stage-scan.mjs`) are imported only by the packages allowed to: `journal/daemon-principal.ts` and `runs/daemon-attestation.ts` by their own package and by `daemon`; the mint holders `journal/principal.ts`, `runs/attestation.ts` and `audit/lock.ts` by their own package alone; never by the overlay entry or another package. This closes the "TODO (staging hook)" under D6 for the staged tree, **for the unmangled graph only**: D3.6 covers what the packaged build does to it. It needs a built Code OSS tree, so it runs in the manual end-to-end check, not in PR CI; the unit tests drive it with synthetic metafiles.

6. **`#private` fields in minified builds.** Upstream passes `--mangle-privates` with every `--minify` build (`build/lib/esbuild.ts`), and `build/next/index.ts` then runs `convertPrivateFields` on every emitted bundle except the extension host: each `#field` becomes a plain `$a`-style property. For Axis this is a security problem, not only a size change: `UserPrincipal.is`, `TrustAttestation.is` (and its single-use `#used` flag), `InstanceLock` and the challenge manager rest on `#` brands, and after mangling a hand-written `{ $a: "user" }` or a `structuredClone` of a real principal passes the check, and a consumed attestation can be reset. The module-graph check builds without that post-processing, so it cannot see this. **Rule:** a security marker in an `@axis/*` package may rely on `#private` surviving only while the build exempts `vs/axis/` outputs from mangling, and that exemption is itself checked. The exemption is the second part of patch 0200 (`keepAxisPrivates`, a path test on the emitted file), `check-privates.mjs` verifies it is present in the tree's `build/next/index.ts` (step 4 of `check-staged.mjs`) and, with `--build-bundle`, swaps the committed brand probe (`scripts/code-oss/brand-probe.ts`) in for the daemon entry of the scratch tree, runs the tree's real minified `--target server` bundle step (about 30 s), runs the output and fails unless a hand-written object, a `structuredClone` and an own-property copy of a real principal and attestation are all rejected, the principal exposes no own key, and a consumed attestation stays used. The committed stub entry has no `#` fields, so only the probe can show that the exemption works. **Limits:** the exemption covers outputs under `vs/axis/` (the daemon entry and any other Axis entry point); an Axis module that the workbench bundle pulls in is still mangled, which is acceptable only because no brand-bearing package may be imported by renderer code (D2.2). **Follow-up ticket BRAND-1:** stop depending on `#` for brands (a module-private `WeakSet` or closure marker, which survives mangling, bundling and any future tool), then drop the exemption.

The same staged code serves desktop (utility process) and web (the reh child process, ADR 0003 D1.7), because both are Node.

### D4. Dependency policy

- **Runtime dependencies:** `zod` only, pinned exactly to **4.6.6**, the patched release. Code OSS's own tree still pins 4.4.3; the two need not match, because esbuild bundles the daemon's dependencies into the daemon bundle, so duplicate copies cost size, not correctness. Security outweighs deduplication.
- **Dev dependencies:** `typescript` and `@types/node`, pinned exactly, at the repository root only.
- **No other runtime dependency** without an ADR amendment. SQLite is `node:sqlite`, a Node built-in, not a package (D9).
- **Exact pins and a committed lockfile.** CI installs with `npm ci`; `--ignore-scripts` is used wherever install scripts are not needed.
- **Known advisory.** `zod@4.4.3` has GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections; fixed in 4.6.6) [V, npm audit]. (a) Packages use the patched zod 4.6.6. (b) The Code OSS tree still pins 4.4.3 upstream. Follow-up for the security-hardening patch block (2000-2999): bump it with a `package.json` change plus lockfile regeneration, if zod is still used at runtime after the agent-host removal (to be checked).
- **How 4.6.6 reaches the daemon bundle** [V]. Because `build/next` leaves packages external (Context), neither a nested `node_modules` nor an esbuild alias would be needed if only the bundle mattered, but both fail the other requirement: dev (`transpile`) runs and the packaged app resolve a bare `zod` to the application's 4.4.3. The chosen mechanism is **vendoring**: the hook copies the ESM JavaScript and declarations of zod 4.6.6 that are reachable from its entry point (194 files, 1.1 MB; all staged output is about 340 files, 2 MB) from the repository's `node_modules` to `src/vs/axis/packages/vendor/zod/` and rewrites the packages' `zod` import to it. Relative imports are bundled by esbuild, `transpile` copies the non-TypeScript files for development runs, and Code OSS's `tsc` type-checks against the `.d.ts` files, so one copy of 4.6.6 serves bundle, dev and types. An esbuild alias was rejected because it needs more lines in `build/next/index.ts` and does not help the dev build; a tree bump (below, (b)) stays the cleaner long-term fix but is not a prerequisite. The vendored `LICENSE` (MIT) and `package.json` are kept beside it; add zod to the Axis notices when a distributable build is prepared. `@axis/protocol` exports `ZOD_VERSION` (`src/version.ts`, tested against `packages/protocol/package.json`) so the daemon stub can print the version it bundled; it is new public API of that package. Evidence from the spike: the minified daemon bundle contains `major:4,minor:6,patch:6`, has no bare `zod` import and no `4.4.3`, and running it prints `"zod":"4.6.6"`.
- **Message bounds, exactly as coded** (`packages/protocol/src/limits.ts`; defence in depth against the advisory, not a replacement for the patch). `inspectMessage` is one bounded, iterative walk over the decoded value, which works on structured-clone input where no byte length is known:
  - `MAX_MESSAGE_BYTES` = 1 MiB in total, counting strings and keys by UTF-8 length and other values by a small fixed charge (an approximation);
  - `MAX_STRING_BYTES` = 256 KiB per string or key;
  - `MAX_MESSAGE_NODES` = 10,000 values;
  - `MAX_DEPTH` = 16 levels of objects and arrays, the root counting as level 1;
  - any object reached twice is rejected (`shared-reference`), because a structured-clone MessagePort preserves aliasing and a small DAG can expand into an exponential tree; decoded JSON is a tree, so a revisit is hostile, and this also rejects cycles.
  The same walk bounds `payload`, `result` and every `error.details` value (`boundedJsonSchema`, used instead of `z.json()`). `details` has at most 16 keys, and `E_APPROVAL_REQUIRED` must carry a challenge. Every array and record in method payloads also has an explicit maximum. Byte-level framing limits on the port, if any, are separate and belong to the transport.

### D5. Language, module and build conventions

- npm workspaces at the repository root; packages in `packages/<name>/`, named `@axis/<name>`, `private: true`, `"type": "module"`.
- TypeScript strict, `NodeNext` modules, target `ES2023`, one `tsconfig.base.json` that every package extends, with project references between packages.
- Tests use `node:test` and `node:assert` only. `npm test` cleans and builds with `tsc -b` (root `tsconfig.json` references, no shell globbing), runs `node --test "dist/test/**/*.test.js"`. (Node 24 does not accept a bare directory after `--test`.)
- Node version is the one in `code-oss/upstream.json` (`24.22.1`), recorded in `engines`.
- **Lint.** Strict `tsc` is the gate for now. An ESLint flat config is deferred: it needs `typescript-eslint` and its transitive dependencies for little gain over strict `tsc`, and the overlay already carries the lint that matters (import patterns). Revisit when a package has logic that the compiler cannot catch.

### D6. Testing and CI

- A CI job `Axis packages` runs `npm ci`, `npm run typecheck`, `npm run build` and `npm test` on Linux with the Node version read from `code-oss/upstream.json`. It does not need the Code OSS checkout, so it is cheap and runs on every PR.
- After merge, `Axis packages` becomes a required check (`docs/ci.md`).
- Staging is tested in three layers: unit tests of the hook against a fake tree (`test/code-oss/stage-*.test.mjs`, in the Code OSS scripts job), a test that stages the real packages and the installed zod into a temporary tree (`test/packages/stage-real.test.mjs`, run by `npm test`), and the manual full build for the end-to-end check (`check-staged.mjs`, below).
- The user-principal subpath (`@axis/journal/daemon-principal`) is importable only from the daemon package. The source scan (`imports.test.mjs`) refuses it elsewhere, refuses re-exports of it, and flags `createRequire` and `process.getBuiltinModule`; `principal-dist.test.mjs` applies the same rules to the emitted JavaScript after the build; the staging hook refuses the subpath from any other package and the module-graph check (D3.5) enforces it on the bundle. **Not covered:** the overlay beyond the daemon entry's bundle (other overlay files are not scanned), `eval`-built loads, and code that is not bundled (a worker script loaded by path). The `RESTRICTED_*` tables in `stage-scan.mjs` repeat the maps in `imports.test.mjs`; a test in `test/code-oss/stage-graph.test.mjs` fails if they drift apart.

### D7. File headers

Every Axis-owned source file starts with `// Copyright (c) 2026 Dylan Lambertson. All rights reserved.` Axis-owned code is proprietary (ADR 0002); packages carry `"license": "UNLICENSED"` and `"private": true` so they cannot be published by accident.

### D8. Contract decisions recorded here

- **Deferred contracts.** `discard`, `commit` and `push` (design section 5.3 and 5.4) are not in `axis.worktrees/1` yet. They arrive with their own changes, and `push` and review actions are likely a separate contract.
- **Idempotency is decided per method.** The design does not state it. `create`, `finalise`, `remove` and `restoreFromRunBase` require a key; `list` and `status` do not. The envelope key is optional in the schema, so enforcement is the daemon's: `requiresIdempotencyKey(contract, version, method)` is the lookup it must use, and the daemon refuses a missing key with `E_INVALID_ARGUMENT`.
- **Reads are tier 0** (`list`, `status`). The design leaves read tiers open.
- **`restoreFromRunBase` takes `{ runId, id, paths }`.** The policies document names `{ runId, paths }`; `id` is added so the daemon checks that the run belongs to the workspace.
- **Envelope deviations from ADR 0003 D3's sketch.** Ids are strings (at most 64 characters), not numbers. The contract and its major version are separate fields (`contract: "axis.worktrees"`, `contractVersion: 1`) instead of one `axis.runs/1` string. `v` is the envelope protocol version, 1 to 1000. `error.details` is a bounded JSON record (at most 16 keys) rather than a fixed shape, and `E_APPROVAL_REQUIRED` requires `details.challenge`. The error code set is ADR 0003's, unchanged.
- **Parse failures** return an enum reason only and never echo input.

### D9. SQLite for the journal and the audit log: `node:sqlite`

`@axis/audit` and `@axis/journal` use the built-in `node:sqlite` (`DatabaseSync`), with no added dependency. This closes open question 1.

**Evidence.**

- `node:sqlite` loads without a flag in Node 24.22.1, the pin in `code-oss/upstream.json`, and reports SQLite 3.53.4 [V, run locally].
- The desktop daemon runs in Electron's Node, not the pinned Node. The Code OSS Electron build (target 43.8.3, `.npmrc` and `.build/electron/version`) embeds Node 24.22.0 [V]. Run as plain Node (`ELECTRON_RUN_AS_NODE=1`), it loads `node:sqlite` and reports the same SQLite 3.53.4 [V]. The full `@axis/audit` and `@axis/journal` suites (including the SIGKILL matrix) passed under that binary when this was measured (before the review fixes; re-run them under the shipped Electron binary at each Electron bump) [V].
- The web server (the reh child, ADR 0003 D1.7) runs the pinned Node 24.22.1 (`remote/.npmrc` target `24.22.1`) [V].
- The code uses WAL, `synchronous=FULL`, `BEGIN IMMEDIATE`, savepoints, `STRICT` tables, triggers and `isTransaction` [V, all exercised by the tests]. Code OSS's own `@vscode/sqlite3` 5.1.12-vscode is a native addon [V] and would add a native build to the daemon.

**Risks and mitigations.**

- **Still experimental upstream.** Node documents the module as pre-stable, so its API could change or be removed in a later Node line [I, from the Node documentation, not re-read for this ADR].
  - Mitigation: the Node pin and the Electron pin are changed only deliberately, and the two package suites are the canary. Any Node or Electron bump runs them under both the pinned Node and the Electron binary (`ELECTRON_RUN_AS_NODE=1`) before it merges. A change in behaviour surfaces as a test failure, not as a data problem in the field.
  - The surface is kept small and in one place: `packages/audit/src/db.ts` owns opening, transactions and migrations; the rest uses `prepare`, `run`, `get`, `all` and `iterate`.
- **Electron's Node can differ from the pinned Node** (24.22.0 against 24.22.1 today) [V]. A future Electron may ship a Node with a different `node:sqlite`. The same canary step covers this, since it runs the suites under the Electron binary.
- **On-disk format.** SQLite files are portable across SQLite versions, so a fallback does not need a data migration [I].

**Fallback.** If `node:sqlite` is removed or changes incompatibly, swap the binding behind `db.ts` for `better-sqlite3`, built through Code OSS's native-module pipeline for the Electron ABI (the same route `@vscode/sqlite3` takes) [I, not tried]. `better-sqlite3` has a similar synchronous API, so the change should stay inside `db.ts` and its tests. That would need an amendment to D4 (a new runtime dependency) and the packaged-build check for the native module.

## Consequences and tradeoffs

- Domain logic is testable in seconds on any machine, in parallel by separate workstreams, with no checkout.
- A staging step is a new moving part. Its failure modes (flag drift, import rewrite bugs) are caught by the double type-check and the hook's own tests, but they exist.
- The vendored zod is third-party source in the tree (untracked, regenerated on every apply). It must follow the zod pin, and it counts toward the notices work for distributable builds.
- Source staging couples packages to Code OSS's compiler flags. The base config is kept a superset of them so drift shows in `packages/` first.
- ADR 0003's file budget is unchanged: no upstream file is touched beyond what D6 already counted. The hook adds untracked files only.
- Two homes for Axis code need a clear rule. D1 is that rule; reviews should reject code in the wrong home.
- Two zod versions may exist in the tree until the 2000-2999 follow-up lands. The staged packages carry their own vendored zod 4.6.6 [V, see D4]; renderer code that still imports Code OSS's zod gets 4.4.3.

## Validation criteria (staging spike, before Accepted)

The criteria as first written (unchanged):

1. A package's staged copy compiles under Code OSS's `src/tsconfig.json` with no changes to the package.
2. `build/next` bundles `axisDaemonMain.ts` with a staged package, and the bundle contains zod 4.6.6, checked by grepping the bundled zod version string (and not finding 4.4.3).
3. The daemon utility process in a packaged build imports and runs a package function.
4. The import-patterns lint rejects a renderer import of a domain package and a package import of `vs/*`.
5. Dev and packaged builds both work: `node build/next/index.ts transpile` completes and the daemon starts from `out/` with a staged package function callable; the packaged smoke (`scripts/code-oss/build.sh`, then launching the packaged app) does the same.
6. The hook is idempotent: a second `apply.sh` run is a no-op, and the recorded manifest hashes match the staged files.

Added by the 2026-11-02 run: 7. `footprint.sh` reports no UNATTRIBUTED rows. Added by the review of 2026-11-05: 8. a minified (packaged-style) build keeps the `#private` brands of the Axis modules that reach the daemon bundle (D3.6).

### Results

First run 2026-11-02 on macOS with `@axis/protocol` alone. Re-run 2026-11-04 and 2026-11-05 on Linux x64 (WSL2) against Code OSS 1.144.0 (`2c33b50b16c4`) with all 12 packages on `main` (340 staged files), Node 24.22.1, in a vendor directory outside the repository. Rows 1, 2, 6 and 8 are repeatable with `scripts/code-oss/check-staged.mjs` (`--full-typecheck`; `--build-bundle`, which runs the committed brand probe) and the tests named in each row; rows 3 and 5 are manual runs.

| # | Verdict | Evidence |
|---|---|---|
| 1 | **Pass, after a fix** (as written: `src/tsconfig.json`) | `npm run typecheck-client` (`tsc --project src/tsconfig.json --noEmit --skipLibCheck`, 49 s, 8.2 GiB) failed with 7 errors in three packages: Code OSS's global typings make `setTimeout` return an opaque `TimeoutHandle` without `unref`. It passes (exit 0) after one-line casts in `@axis/daemon` (2 files) and `@axis/runs`. The quick check in `check-staged.mjs` (`tsconfig.base.json` plus overrides, `skipLibCheck: false`) did not see this; the 2026-11-04 text called it criterion 1 and was wrong to do so |
| 2 | **Pass** | Packaged minified bundle: `major:4,minor:6,patch:6` once, no `minor:4,patch:3`, no bare `zod` import. `check-daemon-graph.mjs`: 13 entries, 238 inputs, 237 staged, none from `node_modules`, only `node:*` externals. Unit: `stage-real.test.mjs`, `stage-graph.test.mjs` |
| 3 | **Partial** | The packaged Electron binary, run as `ELECTRON_RUN_AS_NODE=1 ./axis …/axisDaemonMain.js`, prints the contract list and `"zod":"4.6.6"`. That is a plain Node run of the stub; there is no utility process until ticket X1 |
| 4 | **Not verified** | The overlay import-patterns lint (D3.4) is not implemented. The package side is enforced by `imports.test.mjs`, the hook and the graph check |
| 5 | **Partial** | Dev: `transpile` (44 s) and `node out/vs/axis/daemon/node/axisDaemonMain.js` print the same line. Packaged: `npm run gulp vscode-linux-x64-min` (7 min 32 s, 4.3 GiB) contains the bundle and the packaged binary runs it as in 3. Deviations: the stub is run as a script, not "started by the packaged app" (nothing launches a daemon yet: X1), and the macOS packaged build was not re-run |
| 6 | **Pass** | Two `apply.sh` runs: identical stamp fingerprint and `stage-manifest.json`. `stage-packages.test.mjs`: the same `treeSha256` from another path, mtime and umask |
| 7 | **Pass** | `footprint.sh`: 43 files net, no UNATTRIBUTED row; shell block 4 files, +32/−2 |
| 8 | **Pass** | The committed probe `scripts/code-oss/brand-probe.ts` (run by `check-staged.mjs --build-bundle`) imports `UserPrincipal`, `userPrincipal()`, `TrustAttestation` and `attestTrust`. Tree's real minified bundle step: first with `--target desktop` (5 min 33 s, 4.3 GiB), and on the final head with `--target server` (23 s): `#` names survive in `vs/axis/daemon/node/axisDaemonMain.js` while the workbench bundle in the same run has 0 `this.#x` and 535 `$x`. Run under plain Node and under the packaged Electron binary: `UserPrincipal.is({ $a: "user" })` false, `UserPrincipal.is(structuredClone(principal))` false, `TrustAttestation.is({ $a: {}, $b: false })` false, `Object.keys(principal)` empty. **Control, repeated on the final head:** with the exemption removed from the tree's `build/next/index.ts`, `--build-bundle` reports 0 `#` names and fails on six forgeries (`handWritten`, `cloned`, `copied`, `ownKeys`, `attestationHandWritten`, `attestationCloned`). Earlier, the same bundle through the tree's own `convertPrivateFields` (11 edits) gives true, true, true and `["$a"]`, i.e. without the exemption the brand is forgeable |

The text scans (hook and `imports.test.mjs`) can be fooled by an unusual spelling; the module-graph check reads what esbuild resolved and cannot. Neither sees what the packaged build does afterwards: that is D3.6 and row 8.

### Amendment 2026-11-05

The review of the first Linux run found that the criteria had been rewritten rather than amended: criterion 1 was checked against `src/tsconfig.base.json` instead of `src/tsconfig.json`, and criterion 5 was weakened to "runs under `ELECTRON_RUN_AS_NODE`" before being marked pass. This amendment restores the original text above and records the deviations in the Results table instead. Criterion 1 then failed on the real configuration (7 errors, fixed in the packages), so the earlier "pass" was premature. Criterion 8 was added because the review showed that the minified build rewrites `#private` brands. Status: criteria 1, 2, 6, 7 and 8 pass, 5 passes with the deviation above, 3 is partial and 4 is not verified, so the ADR stays Proposed.

## Rollback

- **If staging fails the spike,** switch to Option D (pre-bundled JS plus declarations). Packages, tests and CI do not change; only the hook and the upstream entry line do.
- **If the split proves wrong,** the packages move into `src/vs/axis` as plain source (Option A). They are already plain TypeScript with relative imports and no workspace-only features, so the move is a file copy plus deleting the rewrite step.
- Deleting `packages/`, the root `package.json` and the hook leaves ADR 0002 and ADR 0003 as they were, except for ADR 0003 D6's protocol location.

## Open questions

1. ~~Where does the SQLite binding come from for `@axis/journal`?~~ Resolved by D9: `node:sqlite`.
2. Should renderer-side contract use go through `zod/mini` (smaller bundle, no JIT) and, if so, should `@axis/protocol` expose a mini entry? Measure in the M3 spike (ADR 0003 D2).
3. Should the hook fail or warn on a package that compiles under Code OSS only with `noUnusedLocals` disabled? Proposed: fail.
