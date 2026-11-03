# Triage: npm audit advisories

Status: finding, 2026-11-03. Docs only: no dependency, lockfile or patch file is changed by this note. Advisory data is whatever the npm registry returned on that date and will drift.

## How this was produced

- **Axis packages workspace:** `npm ci --ignore-scripts && npm audit` and `npm audit --omit=dev` at the repository root, Node 24.22.1.
- **Code OSS tree:** the pinned commit `2c33b50b` (tag 1.144.0) fetched into a path without spaces, every `code-oss/patches/*.patch` applied with `git apply`, then `npm audit --package-lock-only` against each `package-lock.json` (no install, no scripts run). The audit reads the **lockfiles**, which the patch series does not touch (patch 1550 edits only the two `package.json` files). Packages that patches remove from `package.json` therefore still appear until the lockfiles are regenerated. They are marked below.
- "Reachable" is a reading of the source plus the patches, not a dynamic test. Where I did not trace a call site, the table says so.

Classes:

- **runtime**: a production dependency that ends up in the shipped app (or a shipped built-in extension).
- **build-only**: used by the packaging pipeline (gulp and friends) on the build host. It never ships, but a flaw there can hit the build machine, so keep that machine off untrusted input.
- **dev-only**: lint, test and developer tooling. Does not ship, and does not run in a release build.

## Axis packages workspace

`npm audit`: **0 vulnerabilities** (including dev dependencies and with `--omit=dev`). The workspace depends on `zod` 4.6.6, `typescript` 7.0.2 and `@types/node` only. Nothing to triage. Re-run on every dependency change (ADR 0005 allows `zod` only at runtime).

## Code OSS root lockfile: the 68 advisories

Reproduced exactly: 68 (17 high, 49 moderate, 2 low, 0 critical). Split by class:

| Class | Packages with an advisory | High | Recommendation |
|---|---|---|---|
| runtime (lockfile as shipped upstream) | 10 | 5 | Table below. |
| build-only | 28 | 9 | Accept, track, do not patch. |
| dev-only | 30 | 3 | Accept, track, do not patch. |

### Runtime (10)

The "after patch 1550" column assumes the lockfiles are regenerated once the Axis `package.json` changes are applied.

| Package (installed) | Sev | Advisory topic | Reachable in Axis? | After patch 1550 | Recommendation |
|---|---|---|---|---|---|
| `@anthropic-ai/sdk` 0.82.0 | moderate | insecure default file permissions (GHSA-p7fg-763f-g4gf) | No. Removed from `package.json` by patch 1550; no Axis code imports it. | Gone | None, once the lockfile is regenerated. |
| `@github/copilot-sdk` (and its nested `zod` 4.3.6) | high | zod GHSA-mrhx-c7xc-m3w5 | No. Removed by patch 1550 and the agent host is not started. | Gone | None, once the lockfile is regenerated. |
| `zod` 4.4.3 (root copy, plus the nested copy above) | high | GHSA-mrhx-c7xc-m3w5, memory exhaustion | Root copy: not reachable (agent-host importer is excluded). Markdown editor extension copy: reachable, low exposure. See `zod-advisory-triage.md`. | Root copy stays | Accept. Re-open if an importer returns. |
| `@vscode/sandbox-runtime` 0.0.1 | high | flagged only through its nested `zod` 3.25.76 | Used by the terminal and MCP sandbox services (`src/vs/platform/sandbox`, `mcpSandboxService.ts`). The advisory is in the zod 4 array code; the 3.x copy is flagged because the advisory range is `<4.6.6`. Likely a false positive. I did not verify against the 3.25.76 source. | Stays | Accept. Check with the registry maintainers' fixed range when it is revised. |
| `undici` 7.29.1 (also in `remote/`) | high | unbounded memory use; SRI bypass (GHSA-4qv8-2p9j-2685 and others) | Yes. `extHostMcpNode.ts` fetches from user-configured MCP servers with it, and `@vscode/proxy-agent` depends on it. A hostile MCP server or proxied response can cause memory exhaustion in the extension host. | Stays | **Fix, lockfile only.** `^7.28.0` in `package.json` already admits a fixed 7.30.1 or later; regenerate the lockfiles (root and `remote/`). Highest priority of the runtime set. |
| `follow-redirects` 1.16.1 | high | cross-realm `sensitiveHeaders` arrays (GHSA-mrwp-f3q8-3g9p) | Only through `axios`, used by `@microsoft/dev-tunnels-management`, i.e. Remote Tunnels. Reachable only if a user enables that feature. | Stays | Lockfile-only bump; low priority. Consider whether Axis should ship Remote Tunnels at all (product question). |
| `ip-address` 10.7.2 | moderate | quadratic parse of zone identifiers | Through `socks` in the proxy agent. Reached when a SOCKS proxy address is parsed. Local configuration input. | Stays | Accept; lockfile-only bump when convenient. |
| `uuid` 3.4.0 | moderate | missing buffer bounds check in v3/v5/v6 when `buf` is passed | Through `@microsoft/dev-tunnels-connections` (Remote Tunnels). The flaw needs a caller that passes an output buffer; I did not find one. | Stays | Accept. No fix available for that dependent (`fixAvailable: false`). |
| `katex` 0.16.22 | low | prototype pollution can bypass `trust` restrictions (GHSA-238p-pmpm-9mq7) | Used by the chat markdown renderer. `markedKatexSupport.ts` does not set a `trust` option, so the bypass has nothing to bypass. | Stays | Accept; lockfile-only bump with the others. |
| `@microsoft/dev-tunnels-connections` 1.3.61 | moderate | flagged through `uuid` | Same as `uuid`. | Stays | Accept. |

### Build-only (28)

The gulp packaging pipeline and its transitive globbing and watching packages: `gulp`, `gulp-cli`, `glob-watcher`, `glob-stream`, `vinyl-fs`, `gulp-filter`, `multimatch`, `gulp-symdest`, `gulp-azure-storage`, `@vscode/gulp-electron`, `gulp-sourcemaps`, `@gulp-sourcemaps/identity-map`, `css`, `source-map-resolve`, `decode-uri-component`, `gulp-json-editor`, `js-beautify`, `anymatch`, `chokidar`, `readdirp`, `braces`, `micromatch`, `findup-sync`, `liftoff`, `matchdep`, `asar`, `temp`, `@vscode/l10n-dev`.

The advisories are ReDoS and uncontrolled-resource-use issues in glob and path matching, and in old `chokidar`, `braces` and `micromatch` versions. The inputs are the repository's own file names and the build's own configuration. Several have no fix available (`fixAvailable: false`) because upstream pins them behind gulp 4. Recommendation: accept. Run builds only from the pinned commit plus the reviewed patch series, not on untrusted checkouts. Do not patch lockfiles: a lockfile patch conflicts on every upstream sync.

### Dev-only (30)

ESLint and `typescript-eslint` chains (`eslint`, `eslint-plugin-import`, `@eslint/config-array`, five `@typescript-eslint/*`, `typescript-eslint`, `tsec`, `@ts-morph/common`, `ts-morph`, `@vscode/telemetry-extractor`), test tooling (`mocha`, `serialize-javascript`, `c8`, `test-exclude`, `@vscode/test-cli`, `@vscode/component-explorer-cli`, `vite-plugin-istanbul`), the MCP test dependencies (`@modelcontextprotocol/sdk`, `hono`, `@hono/node-server`, `body-parser`, `qs`) and shared helpers (`minimatch`, `glob`, `rimraf`, `postcss`, `fast-uri`). The three high ones are `@modelcontextprotocol/sdk`, `body-parser` and `postcss`. The MCP SDK is imported only by agent-host tests, which patch 1560 keeps out of the build. Recommendation: accept. They do not ship and do not run in a release build.

## Other lockfiles in the tree

Same method, count of packages with an advisory. Only the shipped ones matter for runtime.

| Lockfile | Total (high / critical) | Shipped? | Note |
|---|---|---|---|
| `remote/` | 5 (4 / 0) | Server only | The runtime items above (`undici`, `katex`, copilot-sdk and zod). Same recommendations. |
| `build/` | 12 (4 / 0) | No | Build-only (`@azure/identity`, `@azure/msal-node`, `extract-zip`, `markdown-it`, minimatch family). Accept; run builds from reviewed inputs. |
| `extensions/markdown-language-features` | 10 (2 / **1**) | **Yes, built-in** | **Needs attention.** `dompurify` 3.4.16 has a critical advisory (GHSA-cg2g-xh64-v4q7, SAFE_FOR_TEMPLATES bypass, and others). It is a production dependency, used by `notebook/index.ts` (the notebook markdown renderer). I did not trace how the sanitised output is used. `markdown-it` 14.3.2 (high, quadratic-time DoS) and `katex`, `minimatch` come with it. Recommend: verify the dompurify exposure, then either bump through a patch to that extension's `package.json` and lockfile (security block 2000 to 2999) or disable the feature if Axis does not need it. |
| `extensions/microsoft-authentication` | 1 (1 / 0) | Yes, built-in | `@azure/msal-node` 5.4.0, high: the authorization code flow may disclose parameters. Check whether Axis ships this extension and whether any Axis flow uses Microsoft sign-in; if not, consider listing it in `removals.txt`. |
| `extensions/emmet` | 1 (1 / 0) | Yes, built-in | `image-size` 1.0.2 (ICNS parser DoS). Reached only when Emmet reads an image file. Accept. |
| `extensions/{css,html,json}-language-features`, `npm` | 2, 2, 2, 1 (0 / 0) | Yes | `minimatch` / `vscode-languageclient` ReDoS. Accept. |
| `extensions/markdown-math`, `mermaid-markdown-features` | 2 each (0 / 0) | Yes | `katex` low. Accept. |
| `extensions/notebook-renderers` | 1 (1 / 0) | Yes | `undici` 7.29.1 is a dev dependency of the bundle. Accept. |
| `extensions/copilot`, `extensions/copilot/chat-lib` | 44 (9 / 2), 15 (3 / 1) | **No.** Patches 1500 to 1520 do not install or package it. | Ignore, provided those patches hold. |
| `build/agent-sdk/agents/claude` | 9 (3 / 1) | No | Agent SDK build helper; the agent host is removed. |
| `build/npm/gyp`, `build/rspack`, `build/vite`, `test/*`, `.vscode/extensions/vscode-pr-pinger`, `remote/web`, `vscode-api-tests` and test workspaces | 1 to 5 each | No (build or test) | Accept. `remote/web` has one low `katex`. |

## Recommendations, in order

1. **Verify `dompurify` in `markdown-language-features`** (critical, shipped). Decide: bump via the 2000 to 2999 patch block, or drop the notebook markdown renderer if unused.
2. **Regenerate the lockfiles after patch 1550** so `@anthropic-ai/sdk`, `@github/copilot-sdk` and the nested `zod` 4.3.6 leave the audit. If the lockfile is regenerated anyway, also let `undici` move to a fixed 7.x (its `package.json` range already allows it), which clears the highest runtime item. Both are lockfile or `package.json` changes in a series that today patches neither lockfile; the maintainer should decide whether a lockfile patch is worth the sync conflicts.
3. Decide whether Axis ships Remote Tunnels and `microsoft-authentication`. Not shipping them removes `follow-redirects`, `uuid`, `@azure/msal-node` and the dev-tunnels packages from the runtime set.
4. Accept the build-only and dev-only items; keep the build host off untrusted input. Re-run this audit at each upstream sync and add `npm audit` for the Axis workspace to CI if it is not there.

## Not done

- No dynamic test of any advisory. No install of the Code OSS tree (lockfile-only audit).
- Call sites for `dompurify`, `sandbox-runtime`'s zod 3.25.76 and `image-size` were not traced.
- The advisory counts depend on the registry on 2026-11-03.
