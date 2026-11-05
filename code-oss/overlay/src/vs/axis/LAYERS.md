# `src/vs/axis` layers

Axis-owned shell code, copied into the Code OSS tree by `scripts/code-oss/apply.sh`. The rules below are enforced by `local/code-import-patterns` targets in `build/axis/eslint.axis.ts` (docs/design/axis-shell-stage2.md section 3.7).

| Folder | May import | Notes |
|---|---|---|
| `axis.*.main.ts` | Everything below, plus the upstream `workbench.*.main.js` it extends | Entry points. Phase A imports the upstream main wholesale, then Axis contributions |
| `common/`, `browser/`, `electron-browser/` (core) | `vs/base`, `vs/platform`, `vs/editor`, `vs/workbench` (`browser/**` included), `vs/workbench/services/*`, `vs/axis` core and `vs/axis/services/*` | `AxisWorkbench`, the agent part, the layout service |
| `services/*/` | Core, minus `vs/workbench/browser/**`, plus `vs/workbench/contrib/*` | Axis services, registered with `registerSingleton` |
| `contrib/*/` | Services, plus `vs/workbench/browser/**` and `vs/axis/contrib/*` | Commands, views, configuration |

Upstream code never imports `vs/axis`: no upstream target lists it. Every file carries the Axis proprietary header; files adapted from upstream keep the Microsoft header and add an `Adapted from <path>@2c33b50` line.
