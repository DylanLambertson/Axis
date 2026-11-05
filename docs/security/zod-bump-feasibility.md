# Feasibility: raising the Code OSS tree's zod to a patched release

Status: analysis, written 2026-11-03, revised 2026-11-04. **No bump is implemented.** Scope: GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6, memory exhaustion in `$ZodArray`) in the vendored Code OSS tree at the pinned commit `2c33b50b` (tag 1.144.0) with the Axis patch series applied. This note builds on `docs/security/zod-advisory-triage.md`, which establishes where zod lives and whether it is reachable (it is the authority on reachability; read it for the evidence and the untested assumptions). It adds the mechanism analysis and a measured lockfile experiment.

## Verdict

A bump of the tree's `zod` is **mechanically possible for the root and `remote/` lockfiles through the existing `10-regen-locks` post-apply hook, but not safely completable without a build**, and it would not cover the one copy that is reachable at runtime. Do not merge a bump from script-level checks alone.

Reachability, per the triage note:

- Root and `remote/` `zod` 4.4.3: **not runtime-reachable** because no entry point reaches the only importer (static import graph in the triage note; patches 1530 to 1560 keep the agent host out of the bundle and unstarted). Present on disk, never loaded.
- `extensions/markdown-language-features` `zod` 4.4.3 (exact pin): **runtime-reachable, low exposure.** Both directions are parsed (host to webview arrays derive from the opened document), the RPC body is parsed only after the `messageSecret` check, and exploitation needs array elements that fail validation. Local denial of service only; the triage note says this was not tested.
- Axis packages pin 4.6.6 and are not affected. Bare `zod` in the daemon bundle resolving to the tree's copy is the one way this reaches Axis code (ADR 0005 D4); the staging check for that does not exist yet.

## How the version is pinned

| Layer | What it does for zod |
|---|---|
| `code-oss/upstream.json` | Pins the commit. Nothing about zod. |
| Upstream `package.json`, `remote/package.json` | `"zod": "^4.4.3"` (a range that already admits 4.6.x). |
| Upstream `package-lock.json`, `remote/package-lock.json` | Resolve `node_modules/zod` to 4.4.3. This is what `npm ci` installs. |
| `extensions/markdown-language-features/package.json` | Exact `"zod": "4.4.3"` devDependency, with its own lockfile; esbuild bundles it. |
| Patches 1500, 1550 | Edit `package.json` / `remote/package.json` (drop extension install, agent SDKs). They do not touch zod and patch no lockfile. |
| Hook `code-oss/hooks/post-apply.d/10-regen-locks` | Regenerates the root and `remote/` lockfiles with `npm install --package-lock-only --ignore-scripts` (npm 11.19.1), then asserts the removed-entry lists, that nothing was added or changed, that **`node_modules/zod` is unchanged** (ADR 0003 D2, threat model SC-3 check 4), and the SHA-256 of each result. |
| `HOOK_ALLOWED_BASENAMES` (`scripts/code-oss/lib.sh`) | Hooks may change only `package-lock.json` / `npm-shrinkwrap.json` among upstream files. |

There is no overlay lockfile and no npm `overrides` mechanism: overlay files are new files only, and an `overrides` entry would need a `package.json` patch.

## What I measured

Run on 2026-11-03 (Node 24.22.1, npm 11.19.1, registry state of that day; "latest in range" will move). I rebuilt the hook's inputs outside the tree (pinned `package.json`, `package-lock.json`, `.npmrc` for root and `remote/`, plus patches 1500 and 1550 applied to the two `package.json` files) and ran the hook's own command with Node 24.22.1 / npm 11.19.1. Results:

- Commands: in a scratch directory, `git show 2c33b50b:<file>` for `.npmrc`, `package.json`, `package-lock.json` and the `remote/` equivalents; `git apply --include=package.json --include=remote/package.json` of patches 1500 and 1550; then per directory `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` (the hook's step), and for the bump run additionally `npm update zod --package-lock-only --ignore-scripts --no-audit --no-fund`; `sha256sum package-lock.json`.
- The unmodified run reproduces the hook's recorded hashes exactly (root `15a0ae34…59af`, remote `1b2fb668…c30f`), so the experiment is faithful. It needs the tree's `.npmrc` (`legacy-peer-deps=true`); without it npm fails with unrelated peer conflicts.
- Adding `npm update zod --package-lock-only --ignore-scripts` after the hook's install changes **exactly one lockfile entry in each file**, `node_modules/zod`, 4.4.3 to 4.6.7 (the newest release in the existing `^4.4.3` range). No entries added or removed, `package.json` untouched, no peer-dependency conflict (`@modelcontextprotocol/sdk` and `zod-to-json-schema` accept `^4`). Resulting hashes: root `55e1cb74…d471`, remote `76a21d45…62b8`.
- `npm install zod@4.6.6 --package-lock-only` would pin 4.6.6 but rewrites the `package.json` range to `^4.6.6`, which a hook may not do (and the footprint check would flag as `UNATTRIBUTED`). Without a `package.json` patch the hook can only reach "latest in range", not exactly 4.6.6. Both are patched releases.

## What a hook-only change would be, and why it is not enough

Change set (if later wanted): in `10-regen-locks`, run `npm update zod` after the install, relax the "zod unchanged" assertion to "zod is the only changed entry and its version is >= 4.6.6", and update the two hashes. That is a small Axis-only change, but:

1. **It does not fix the reachable copy.** The Markdown extension's exact `4.4.3` pin lives in an upstream `package.json`; a hook cannot edit it. Bumping it needs a patch to `extensions/markdown-language-features/package.json` and a regenerated extension lockfile (the hook currently only visits `.` and `remote/`). That is a new patch touching a file upstream owns, for a low-exposure local path.
2. **The type-check against the new zod is unverified.** Compilation and the `build/next` bundle must be run to confirm nothing in the compiled `src/` (component fixtures under `src/vs/workbench/test/**` and any future Axis `vs/axis` facade) breaks against 4.6.x types and the `zod/mini` entry. The agent-host importer is not reached by any entry point as of this commit (static import graph in the triage note), so the likely risk is low, but I was told not to build and cannot assert it.
3. **It buys nothing today.** The root copy is never loaded. The bump becomes worthwhile when a patch re-enables an importer, or when the daemon bundle resolves bare `zod` to the tree.
4. **It touches security invariants.** ADR 0003 D2 and threat-model control SC-3 (4) only require that `zod` stays a direct dependency; the "`node_modules/zod` unchanged" assertion is the hook's own, stricter check. So a bump needs a hook edit and new hashes, not an ADR amendment. Both recorded hashes move; the weekly upstream sync must re-derive the hashes anyway (hook comment), so the maintenance cost is an extra review line per sync.

## Recommendation

1. Do not bump the root or `remote/` lockfiles now. Revisit when an importer of the root `zod` returns, or at the 2000 to 2999 security patch block (ADR 0005 D4 follow-up), using the hook change above together with a verification build.
2. Highest value, no build needed: implement the ADR 0005 D4 staging check so the daemon bundle can never resolve the tree's 4.4.3. It is the only route by which this advisory reaches Axis code.
3. Decide separately whether to accept the Markdown editor exposure (triage note: accept) or carry a patch for its `package.json` and lockfile.

## How to verify a bump when one is made

1. `scripts/code-oss/fetch.sh && scripts/code-oss/apply.sh`; the hook must print `package-lock.json sha256 … (matches)` for the new hashes, and `footprint.sh` must show only lockfile changes in its `hooks` row.
2. `npm ci` in the tree and in `remote/`; then `node -e "console.log(require('zod/package.json').version)"` is >= 4.6.6 at both.
3. Type-check and the desktop and server bundle checks, on the macOS host (which owns release builds) or on the Linux build (`chore/linux-build-validation`); run the Markdown editor smoke test.
4. Grep the bundled outputs for the zod version string.

## Risk

Low technical risk for the lockfile-only change (one entry, no peer conflict, reproducible hashes); the residual risk is the unverified type-check and bundle, plus the divergence between the tree's lockfile (4.6.7) and the Axis packages' exact pin (4.6.6), which ADR 0005 already accepts because esbuild bundles each copy separately.
