# Post-apply hooks

Executables run by `scripts/code-oss/apply.sh` after the patches, removals, replacements and overlay have been applied, in lexical (byte) order. They are intended for steps that must regenerate files from the patched tree, such as lockfiles after a dependency removal (ADR 0002 decision 6: lockfile changes are regenerated, never hand-edited).

## Contract

- Name hooks `NN-short-name` (for example `10-regenerate-lockfiles`) so the order is explicit. Every file other than this `README.md` must be an executable regular file; otherwise `apply.sh` fails.
- The working directory is `vendor/code-oss`. The environment provides `AXIS_CODE_OSS_TREE` (absolute tree path), `AXIS_UPSTREAM_COMMIT` and `AXIS_UPSTREAM_TAG`.
- `footprint.sh` is not a hook: it needs the completed stamp that `apply.sh` writes after the hooks. Run it after `apply.sh`.
- A non-zero exit fails the run, names the hook, and marks the tree incomplete.
- Hooks must be deterministic and idempotent: `apply.sh` resets the tree before every run, so a hook always starts from the same input. Untracked hook output is removed by that reset unless upstream ignores it.
- If the manifest's exact Node version is already available (`NODE24_BIN`, or the checksum-pinned tarball that `build.sh` unpacked into `.tools/`), its directory is first on `PATH` and in `AXIS_NODE_BIN_DIR`. `apply.sh` never downloads Node, so a hook that needs Node must check `AXIS_NODE_BIN_DIR` and fail clearly when it is unset.
- Hooks must not reach the network beyond what the step strictly requires; document any access in the hook.
- **Hooks may change only lockfiles among upstream files:** `package-lock.json` and `npm-shrinkwrap.json`, in any directory (`HOOK_ALLOWED_BASENAMES` in `scripts/code-oss/lib.sh`). New untracked files, such as generated sources, are allowed. `apply.sh` records the tree before and after the hooks. `footprint.sh` reports the hooks' changes to upstream files in its `hooks` row, and fails with `UNATTRIBUTED` when a hook changes any other upstream file.
- **Hooks must not set index flags.** `footprint.sh` fails when any entry is marked skip-worktree or assume-unchanged, because those flags hide working-tree edits from Git. The next `apply.sh` or `fetch.sh` clears them.

`apply.sh` records each hook and its SHA-256 in `vendor/code-oss.applied`.

From M3: `10-regen-locks` regenerates the root and remote lockfiles after the Copilot and agent SDK dependencies are dropped, and asserts the exact result (`docs/design/axis-shell.md` §2.8).

From ADR 0005: `20-stage-axis-packages` stages `packages/*` into `src/vs/axis/packages/` (package sources with rewritten imports, a vendored zod and `stage-manifest.json`). It needs `npm ci --ignore-scripts` at the repository root, adds only new untracked files, and is covered by `test/code-oss/stage-packages.test.mjs`.
