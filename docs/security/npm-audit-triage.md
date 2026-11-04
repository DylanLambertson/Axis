# Triage: npm audit advisories

Status: finding, revised 2026-11-04. Docs only: no dependency, lockfile or patch file is changed by this note. Advisory data is whatever the npm registry returned on that date and will drift.

## How this was produced

Counts are a dated snapshot. The advisory database changes daily: the first run (2026-11-03) found 68 on the upstream lockfile; the same lockfile on 2026-11-04 gives 53, because fifteen build and dev packages are no longer flagged. Treat every list of build-only and dev-only package names below as unstable and re-run the commands.

- **Axis packages workspace:** `npm ci --ignore-scripts && npm audit` and `npm audit --omit=dev` at the repository root, Node 24.22.1, npm 11.19.1.
- **Code OSS tree:** the pinned commit `2c33b50b` (tag 1.144.0) in a path without spaces, every `code-oss/patches/*.patch` applied with `git apply`, then the lockfile regeneration that `code-oss/hooks/post-apply.d/10-regen-locks` performs (`npm install --package-lock-only --ignore-scripts` in `.` and `remote/`, npm 11.19.1). The regenerated lockfiles match the hook's recorded sha256 values (root `15a0ae34…59af`, remote `1b2fb668…c30f`). Each lockfile was then audited with `npm audit --package-lock-only --json --prefix <dir>` on 2026-11-04. Nothing was installed and no scripts ran.
- The shipped tree is the **post-hook** lockfile. The hook removes `@github/copilot-sdk`, its nested `zod` 4.3.6 and `@anthropic-ai/sdk`, so those do not appear in the shipped set. The upstream lockfile before the hook gives 53 (17 high, 33 moderate, 3 low); after the hook it gives 51 (16 high, 32 moderate, 3 low).
- "Reachable" is a reading of the source and the patches, not a dynamic test. Where a call site was not traced, the table says so.

Classes:

- **runtime**: a production dependency that ends up in the shipped app (or a shipped built-in extension).
- **build-only**: used by the packaging pipeline (gulp and friends) on the build host. It never ships, but a flaw there can hit the build machine, so keep that machine off untrusted input.
- **dev-only**: lint, test and developer tooling. Does not ship and does not run in a release build.

## Axis packages workspace

`npm audit`: **0 vulnerabilities** (including dev dependencies and with `--omit=dev`), on main as of 2026-11-04. The workspace depends on `zod` 4.6.6, `typescript` 7.0.2 and `@types/node` only. Nothing to triage. Re-run on every dependency change (ADR 0005 allows `zod` only at runtime).

## Code OSS root lockfile (after the lockfile hook): 51 advisories

As of 2026-11-04: 51 (16 high, 32 moderate, 3 low, 0 critical). Split by class:

| Class | Packages with an advisory | High | Recommendation |
|---|---|---|---|
| runtime | 8 | 4 | Table below. |
| build-only | 17 | 9 | Accept, track, do not patch. |
| dev-only | 26 | 3 | Accept, track, do not patch. |

### Runtime (8)

| Package (installed) | Sev | Advisory topic | Reachable in Axis? | Recommendation |
|---|---|---|---|---|
| `zod` 4.4.3 (root copy; the entry also lists the 3.25.76 copy below) | high | GHSA-mrhx-c7xc-m3w5, memory exhaustion | Root copy: not reached from any entry point. Markdown editor extension copy: reachable, low exposure. See `zod-advisory-triage.md`. | Accept. Re-open if an importer returns. |
| `@vscode/sandbox-runtime` 0.0.1 | high | flagged only through its nested `zod` 3.25.76 | Used by the terminal and MCP sandbox services (`src/vs/platform/sandbox`, `mcpSandboxService.ts`). npm flags it purely because the advisory range `<4.6.6` textually includes 3.x; the vulnerable code is the zod 4 array path. Not verified against the 3.25.76 source. | Accept. |
| `undici` 7.29.1 (also in `remote/`) | high | unbounded memory use; SRI bypass (GHSA-4qv8-2p9j-2685 and others); fixed in 7.30.1 | Yes. `extHostMcpNode.ts` fetches from user-configured MCP servers with it, and `@vscode/proxy-agent` depends on it. A hostile MCP server or proxied response can cause memory exhaustion in the extension host. | **Fix.** `^7.28.0` in `package.json` already admits 7.30.1, so the change is lockfile-only. But the lockfiles come from the `10-regen-locks` hook, which asserts that every kept entry is unchanged and checks recorded hashes, so the fix is a hook change (new expected entry and new hashes), not a patch file. The zod bump has the same shape. Highest priority of the runtime set. |
| `follow-redirects` 1.16.1 | high | cross-realm `sensitiveHeaders` arrays (GHSA-mrwp-f3q8-3g9p) | Only through `axios`, used by `@microsoft/dev-tunnels-management`, i.e. Remote Tunnels. Reachable only if a user enables that feature. | Same hook change as `undici`; low priority. Consider whether Axis should ship Remote Tunnels (product question). |
| `ip-address` 10.7.2 | moderate | quadratic parse of zone identifiers | Through `socks` in the proxy agent, when a SOCKS proxy address is parsed. Local configuration input. | Accept. |
| `uuid` 3.4.0 | moderate | missing buffer bounds check in v3/v5/v6 when `buf` is passed | Through `@microsoft/dev-tunnels-connections` (Remote Tunnels). The flaw needs a caller that passes an output buffer; none found. | Accept. No fix available for that dependent. |
| `katex` 0.16.22 | low | prototype pollution can bypass `trust` restrictions (GHSA-238p-pmpm-9mq7) | Used by the chat markdown renderer. `markedKatexSupport.ts` does not set a `trust` option. | Accept. |
| `@microsoft/dev-tunnels-connections` 1.3.61 | moderate | flagged through `uuid` | Same as `uuid`. | Accept. |

Gone after the hook (present in the upstream lockfile, removed from the shipped one): `@anthropic-ai/sdk` 0.82.0 (moderate, insecure default file permissions, GHSA-p7fg-763f-g4gf) and `@github/copilot-sdk` with its nested `zod` 4.3.6 (high).

### Build-only (17)

The gulp packaging pipeline and its transitive globbing and watching packages: `gulp`, `gulp-cli`, `glob-watcher`, `gulp-sourcemaps`, `@gulp-sourcemaps/identity-map`, `css`, `source-map-resolve`, `decode-uri-component`, `anymatch`, `chokidar`, `readdirp`, `braces`, `micromatch`, `findup-sync`, `liftoff`, `matchdep`, `@vscode/l10n-dev`.

The advisories are ReDoS and uncontrolled-resource-use issues in glob and path matching, and in old `chokidar`, `braces` and `micromatch` versions. The inputs are the repository's own file names and the build's own configuration. Several have no fix available (`fixAvailable: false`) because upstream pins them behind gulp 4. Recommendation: accept. Run builds only from the pinned commit plus the reviewed patch series, not on untrusted checkouts. Do not change the lockfiles for these: the hook pins them by hash and every change must be re-reviewed at each upstream sync.

### Dev-only (26)

ESLint and `typescript-eslint` chains (`eslint`, `@eslint/config-array`, five `@typescript-eslint/*`, `typescript-eslint`, `@ts-morph/common`, `ts-morph`, `@vscode/telemetry-extractor`), test tooling (`mocha`, `serialize-javascript`, `test-exclude`, `@vscode/test-cli`, `@vscode/component-explorer-cli`, `vite-plugin-istanbul`), the MCP test dependencies (`@modelcontextprotocol/sdk`, `hono`, `@hono/node-server`, `body-parser`, `qs`) and shared helpers (`minimatch`, `glob`, `postcss`, `fast-uri`). The three high ones are `@modelcontextprotocol/sdk`, `body-parser` and `postcss`. The MCP SDK is imported only by agent-host tests, which patch 1560 keeps out of the build. Recommendation: accept. They do not ship and do not run in a release build.

## Other lockfiles in the tree

Same method, count of packages with an advisory, run on 2026-11-04 (extension, `build/` and `test/` lockfiles are not touched by the hook). Only the shipped ones matter for runtime. The counts drift like the root one.

| Lockfile | Total (high / critical) | Shipped? | Note |
|---|---|---|---|
| `remote/` (post-hook) | 4 (3 / 0) | Server only | The runtime items above (`undici`, `katex`, `@vscode/sandbox-runtime` and zod). Same recommendations. |
| `build/` | 10 (4 / 0) | No | Build-only (`@azure/identity`, `@azure/msal-node`, `extract-zip`, `markdown-it`, minimatch family). Accept; run builds from reviewed inputs. |
| `extensions/markdown-language-features` | 8 (2 / **1**) | **Yes, built-in** | **Needs attention.** `dompurify` 3.4.16 has a critical advisory (GHSA-cg2g-xh64-v4q7, SAFE_FOR_TEMPLATES bypass, and others). It is a production dependency, used by `notebook/index.ts` (the notebook markdown renderer). I did not trace how the sanitised output is used. `markdown-it` 14.3.2 (high, quadratic-time DoS), `katex` and the zod 4.4.3 devDependency (see `zod-advisory-triage.md`) are the other flagged packages. Recommend: verify the dompurify exposure, then either bump through a patch to that extension's `package.json` and lockfile (security block 2000 to 2999) or disable the feature if Axis does not need it. |
| `extensions/microsoft-authentication` | 1 (1 / 0) | Yes, built-in | `@azure/msal-node` 5.4.0, high: the authorization code flow may disclose parameters. Check whether Axis ships this extension and whether any Axis flow uses Microsoft sign-in; if not, consider listing it in `removals.txt`. |
| `extensions/emmet` | 1 (1 / 0) | Yes, built-in | `image-size` 1.0.2 (ICNS parser DoS). Reached only when Emmet reads an image file. Accept. |
| `extensions/{css,html,json}-language-features`, `npm` | 2, 2, 2, 1 (0 / 0) | Yes | `minimatch` / `vscode-languageclient` ReDoS. Accept. |
| `extensions/markdown-math`, `mermaid-markdown-features` | 2 each (0 / 0) | Yes | `katex` low. Accept. |
| `extensions/notebook-renderers` | 1 (1 / 0) | Yes | `undici` 7.29.1 is a dev dependency of the bundle. Accept. |
| `extensions/copilot`, `extensions/copilot/chat-lib` | 40 (9 / 2), 13 (3 / 1) | **No.** Patches 1500 to 1520 do not install or package it. | Ignore, provided those patches hold. |
| `build/agent-sdk/agents/claude` | 9 (3 / 1) | No | Agent SDK build helper; the agent host is removed. |
| `build/npm/gyp`, `build/rspack`, `build/vite`, `test/automation`, `test/monaco`, `test/sanity`, `.vscode/extensions/vscode-pr-pinger`, `remote/web`, `vscode-api-tests` and test workspaces | 1 to 5 each | No (build or test) | Accept. `remote/web` has one low `katex`. |

## Recommendations, in order

1. **Verify `dompurify` in `markdown-language-features`** (critical, shipped). Decide: bump via the 2000 to 2999 patch block, or drop the notebook markdown renderer if unused.
2. **Move `undici` to 7.30.1 or later** (highest runtime item). The `10-regen-locks` hook already removes the copilot SDK, its nested zod and `@anthropic-ai/sdk` from the shipped lockfiles. A `undici` bump (and a zod bump, if ever wanted) is lockfile-only but must be done as a change to that hook, because the hook asserts that no kept entry changes and checks recorded hashes. Decide whether that is worth the maintenance on each upstream sync.
3. Decide whether Axis ships Remote Tunnels and `microsoft-authentication`. Not shipping them removes `follow-redirects`, `uuid`, `@azure/msal-node` and the dev-tunnels packages from the runtime set.
4. Accept the build-only and dev-only items; keep the build host off untrusted input. Re-run this audit at each upstream sync and add `npm audit` for the Axis workspace to CI if it is not there.

## Not done

- No dynamic test of any advisory. No install of the Code OSS tree (lockfile-only audit).
- Call sites for `dompurify`, `sandbox-runtime`'s zod 3.25.76 and `image-size` were not traced.
- The advisory counts depend on the registry on the date given (first run 2026-11-03: 68 on the upstream lockfile; 2026-11-04: 53 upstream, 51 after the hook). The build-only and dev-only package lists are not stable between runs.
