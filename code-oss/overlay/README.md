# Code OSS overlay

Axis-owned source files that do not exist upstream (for example `src/vs/axis/**`). `scripts/code-oss/apply.sh` copies everything under this directory into `vendor/code-oss` at the same relative path, after the patch series in `../patches`, the removals in `../removals.txt` and the replacements in `../replace` have been applied.

## Rules

- **New files only.** If a file already exists at the destination, whether from upstream or created by a patch, `apply.sh` refuses to copy it and lists the colliding paths. To change an upstream file, add a patch; to replace an upstream asset wholesale, use `../replace`.
- A destination may not pass through an upstream symlink or file.
- Only regular files and directories are allowed; symlinks are rejected.
- Paths must be printable ASCII without `\` or `:`. No path component may name the Git directory in any spelling a case-insensitive or Windows filesystem would accept: `.git`, `.GIT`, `.git.`, `.git ` or `git~1`. This keeps the overlay from writing Git hooks into `vendor/code-oss/.git`. The same check applies to `../replace` and `../removals.txt`.
- This `README.md` and `.DS_Store` files are not copied.
- File modes are preserved.
- Name new source files after the upstream conventions of the layer they live in. Keep Axis code under `src/vs/axis/` unless a build entry point requires another location.

`apply.sh` records each copied file in `vendor/code-oss.applied`. Files dropped from the overlay are removed from the tree on the next run.

Contents from M3: the Axis themes (`extensions/theme-axis/**`), the Axis defaults contribution and its tests (`src/vs/workbench/contrib/axis/**`) and the Axis ESLint additions (`build/axis/eslint.axis.ts`); see `docs/design/axis-shell-stage1-built.md` §2.9.
