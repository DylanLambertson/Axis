# Post-apply hooks

Executables run by `scripts/code-oss/apply.sh` after the patches, removals, replacements and overlay have been applied, in lexical (byte) order. They are intended for steps that must regenerate files from the patched tree, such as lockfiles after a dependency removal (ADR 0002 decision 6: lockfile changes are regenerated, never hand-edited).

## Contract

- Name hooks `NN-short-name` (for example `10-regenerate-lockfiles`) so the order is explicit. Every file other than this `README.md` must be an executable regular file; otherwise `apply.sh` fails.
- The working directory is `vendor/code-oss`. The environment provides `AXIS_CODE_OSS_TREE` (absolute tree path), `AXIS_UPSTREAM_COMMIT` and `AXIS_UPSTREAM_TAG`.
- A non-zero exit fails the run, names the hook, and marks the tree incomplete.
- Hooks must be deterministic and idempotent: `apply.sh` resets the tree before every run, so a hook always starts from the same input. Untracked hook output is removed by that reset unless upstream ignores it.
- Hooks that need Node.js must locate it the same way `build.sh` does (see `scripts/code-oss/lib.sh`, `resolve_node`). They must not reach the network beyond what the step strictly requires; document any access in the hook.
- Changes that hooks make to tracked upstream files appear in the `total` row of `scripts/code-oss/footprint.sh`, not in a patch block.

`apply.sh` records each hook and its SHA-256 in `vendor/code-oss.applied`.

None for the Phase 0 M2 baseline build.
