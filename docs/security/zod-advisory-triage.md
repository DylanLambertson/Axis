# Triage: zod GHSA-mrhx-c7xc-m3w5 in the Code OSS tree

Status: finding, 2026-11-03. Scope: the vendored Code OSS tree at the pinned commit `2c33b50b` (tag 1.144.0) with the Axis patch series (`code-oss/patches/*.patch`) applied. The Axis packages are not affected (see "Axis packages" below). No patch file is changed by this note.

## The advisory

- GHSA-mrhx-c7xc-m3w5, high, CVSS 7.5. Affects `zod` < 4.6.6 (first patched 4.6.6).
- Memory exhaustion in `$ZodArray` (`handleArrayResult`): validating a very large array against an array schema without a length cap accumulates one issue object per failing element, with no early exit.
- The attacker must therefore (1) have a zod array schema that sees their data, (2) send an array with very many elements that fail validation. The impact is denial of service of the validating process. There is no code execution and no data disclosure.

## Where the tree has zod

Evidence gathered by applying every patch in `code-oss/patches/` to a clean checkout of the pinned commit, then searching for imports and reading both lockfiles.

| Copy | Version | Declared by | Used at runtime in Axis? |
|---|---|---|---|
| `node_modules/zod` (root and `remote/`) | 4.4.3 (vulnerable) | `package.json` and `remote/package.json`: `"zod": "^4.4.3"` | **No importer is compiled or started.** See below. |
| `extensions/markdown-language-features` | 4.4.3 (vulnerable), exact pin | its `package.json` devDependency, bundled by esbuild (`zod/mini`) | **Yes**, in the built-in Markdown editor RPC. Low severity, see below. |
| `@github/copilot-sdk/node_modules/zod` | 4.3.6 (vulnerable) | `@github/copilot-sdk` | No. Patch 1550 removes the SDK from both `package.json` files. The lockfiles are not patched and still list it. |
| `@vscode/sandbox-runtime/node_modules/zod` | 3.25.76 | `@vscode/sandbox-runtime` | Different major, different code path (the advisory names the v4 `$ZodArray`). Not assessed further. |
| `extensions/copilot` | 3.25.76 | its own `package.json` | No. Patches 1500 to 1520 do not install or package that extension. |

### Root `zod` 4.4.3: not reachable

- Every non-test importer of `zod` in `src/` is `src/vs/platform/agentHost/node/claude/clientTools/claudeJsonSchemaToZod.ts`, plus its test. The other `src/` hits are component fixtures under `src/vs/workbench/test/**` (dev only, never packaged).
- That file is part of the agent host. Patch 1530 removes `agentHostMain` and `diffWorkerMain` from the bundle entry lists, patch 1540 stops the agent host from starting, patch 1545 refuses its spawn flags, and patch 1560 excludes `src/vs/platform/agentHost/node/**` from every checker tsconfig and from `build/lib/compilation.ts`. The importer is neither compiled nor started.
- The remaining consumers of the hoisted `zod` in the lockfile are dev-only (`@modelcontextprotocol/sdk`, `zod-to-json-schema`, `@vscode/component-explorer*`) or are removed by patch 1550 (`@anthropic-ai/sdk` peer, `@anthropic-ai/claude-agent-sdk`).
- Nothing in `code-oss/overlay/` imports `zod`.
- The package is still present on disk in a packaged app, because it stays a production dependency (ADR 0003 asks the patch set to keep it, ADR 0005 D4 notes it). Present is not reachable: nothing loads it.

Conclusion: **not runtime-reachable** while the agent host stays excluded. It becomes reachable if a later patch restores an importer of the root `zod`, or if the Axis daemon bundle resolves bare `zod` to the root copy (ADR 0005 D4 "How 4.6.6 reaches the daemon bundle"). That second case is the one to guard: the daemon must bundle 4.6.6. ADR 0005 D4 specifies a staging check for this, but no script under `scripts/code-oss/` implements it yet.

### Markdown editor 4.4.3: reachable, low severity

- `extensions/markdown-language-features/src/preview/markdownEditorProtocol.ts` and `markdownEditorRpc.ts` parse messages between the webview and the extension host with `zod/mini`. The schemas include unbounded arrays (for example `tokens`, `colorMap`, `subscribe`, `unsubscribe`). The extension is built in, `removals.txt` does not list it, and no Axis patch touches it, so it ships.
- The inbound parse runs on `postMessage` data from the editor's own webview (`enableScripts: true`). The sender is first-party webview code, not a network peer. To exploit it an attacker needs script execution inside that webview, at which point a hang of the extension host is the smaller problem.
- Impact is a local denial of service (extension host memory), no escalation.

Conclusion: **runtime-reachable, low exposure, accept** for now.

## Axis packages

`@axis/protocol`, `@axis/pty-policy` and `@axis/challenge` pin `zod` 4.6.6 exactly, which is the patched release. The packages' lockfile resolves 4.6.6 (`npm ci` installs it). `parseClientMessage` bounds the message (size, depth, node count) before any schema runs, so an oversized array is rejected before zod sees it.

## Is a bump trivial and safe?

Not trivial. Recommendation: do not bump now.

- Root and `remote/`: `package.json` already allows 4.6.6 (`^4.4.3`). The change would be lockfile-only (`npm install zod@4.6.6 --package-lock-only`, in the root and in `remote/`). But the series patches no lockfile today, and a lockfile patch conflicts on upstream syncs, which ADR 0003 and ADR 0005 want to avoid. It also buys nothing while the importer is excluded.
- Markdown extension: its `package.json` pins exactly `4.4.3`. A bump needs a `package.json` and lockfile patch for an extension that upstream owns, for a low-exposure path.
- If a later change makes the root copy reachable, do the root bump then, in the 2000 to 2999 security block, together with its lockfile, and re-run the build to check the type-check against 4.6.6.

## Follow-ups

1. Implement the ADR 0005 D4 check that stops the daemon bundle from resolving the tree's 4.4.3 (not present in `scripts/code-oss/` today). It is the one way this advisory could reach Axis code.
2. Before any patch re-enables code under `src/vs/platform/agentHost/node/**`, re-open this note.
3. Open question for the patch-series owner: patch 1550 edits `package.json` and `remote/package.json` but not the lockfiles, which still list `@github/copilot-sdk` and its nested zod 4.3.6. Check that `npm ci` in the vendored tree accepts this, and what the shipped `node_modules` contains.
