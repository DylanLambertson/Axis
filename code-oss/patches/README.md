# Code OSS patch series

Axis changes to upstream Code OSS files live here as a numbered series. `scripts/code-oss/apply.sh` resets `vendor/code-oss` to the commit pinned in `../upstream.json`, then applies every `*.patch` file in this directory with `git apply`, in lexical (byte) order.

## Naming

```text
NNNN-short-name.patch
```

- `NNNN`: four digits, unique across the series. The number sets the order and the block (below); leave gaps if you expect to insert patches later.
- `short-name`: lowercase letters, digits, `-` and `.`, describing the change (for example `1010-product-identity.patch`).

`apply.sh` rejects files that do not match this pattern, numbers outside the blocks below, duplicate numbers and symlinks. This `README.md` is the only other file allowed here.

## Number blocks

| Numbers | Block | Contents |
|---|---|---|
| `0001`–`0999` | shell | The Axis shell layer and its seams (ADR 0002 decision 2). Budget: at most 12 upstream files and 300 upstream lines. |
| `1000`–`1499` | guardrails | Rebrand and licensing guardrails: product identity, notices, `extensionsGallery`, service endpoints, telemetry (ADR 0002 decision 5). |
| `1500`–`1999` | copilot | Copilot and agent-host removal or stubbing (ADR 0002 decision 6). |
| `2000`–`2999` | security | Security hardening (ADR 0002 decision 7). |

Numbers `0000` and `3000`–`9999` are unassigned; extend this table and `patch_block` in `scripts/code-oss/lib.sh` together before using them. Because the series applies in lexical order, the blocks apply in table order.

`scripts/code-oss/footprint.sh` reports, per block, the upstream files and lines each block changes, plus the net total against the pinned commit.

## Format

- A unified diff relative to the upstream repository root, as produced by `git diff` or `git format-patch` inside `vendor/code-oss`. Paths use the `a/` and `b/` prefixes (`-p1`).
- Each patch must apply on top of the pinned commit plus all lower-numbered patches.
- A patch that fails stops the run and names the patch. The tree is then marked incomplete in `vendor/code-oss.applied`, and `build.sh` and `run.sh` refuse to use it until `apply.sh` succeeds.

## Rules (ADR 0002)

- Prefer contributions, `product.json`, default settings and the overlay to patches. Patch upstream files only where no extension point exists. Whole-file asset replacements go in `../replace`, deletions in `../removals.txt`.
- Do not edit `src/vs/workbench/browser/layout.ts` or `src/vs/workbench/browser/parts/*` in place.
- Mark edited regions in upstream files with `// --- Start Axis ---` and `// --- End Axis ---`.
- Keep each patch focused on one concern, so that conflicts during an upstream sync stay local.

The series is empty for the Phase 0 M2 baseline build.
