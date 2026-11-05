# Triage: zod GHSA-mrhx-c7xc-m3w5 in the Code OSS tree

Status: finding, revised 2026-11-04. Scope: the vendored Code OSS tree at the pinned commit `2c33b50b` (tag 1.144.0) with the Axis patch series (`code-oss/patches/*.patch`) applied and the post-apply lockfile regeneration run. No patch or hook file is changed by this note.

**Summary: the advisory is not reachable at runtime from Axis code or from any desktop, server or web entry point of the built tree.** It is reachable, with low exposure, in one built-in extension (the Markdown editor). The Axis packages use the patched zod 4.6.6.

## The advisory

- GHSA-mrhx-c7xc-m3w5, high, CVSS 7.5. Affects `zod` < 4.6.6 (first patched 4.6.6). The registry title says "oversized constrained collections"; the GitHub description says "an array schema without a length constraint". These are the same advisory.
- Memory exhaustion in `$ZodArray` (`handleArrayResult`): validating a very large array accumulates one issue object per **failing** element, with no early exit.
- To exploit it an attacker needs (1) a zod array schema that sees their data and (2) an array with very many elements that **fail** validation. The impact is denial of service of the validating process. No code execution, no data disclosure.

## Where the tree has zod (after the patches and the lockfile hook)

Method: fetch the pinned commit, `git apply` every patch in `code-oss/patches/` (all apply), then run the same lockfile regeneration as `code-oss/hooks/post-apply.d/10-regen-locks` (`npm install --package-lock-only --ignore-scripts` in `.` and `remote/`, npm 11.19.1 with Node 24.22.1). The regenerated lockfiles have exactly the sha256 values the hook records (root `15a0ae34…59af`, remote `1b2fb668…c30f`).

The hook removes the `@github/copilot-sdk` entries, its nested `zod` 4.3.6 and `@anthropic-ai/sdk` 0.82.0 (its `EXPECTED_ROOT` list) and asserts that every kept entry, including `node_modules/zod`, is unchanged. So after apply the tree has these copies:

| Copy | Version | Declared by | Used at runtime in Axis? |
|---|---|---|---|
| `node_modules/zod` (root and `remote/`) | 4.4.3 (vulnerable) | `package.json` and `remote/package.json`: `"zod": "^4.4.3"` | Not reached from any entry point. See the import graph below. |
| `extensions/markdown-language-features` | 4.4.3 (vulnerable), exact pin | its `package.json` devDependency, bundled by esbuild (`zod/mini`) | Yes, in the built-in Markdown editor RPC. Low exposure, see below. |
| `@vscode/sandbox-runtime/node_modules/zod` | 3.25.76 | `@vscode/sandbox-runtime` | Flagged only because the advisory range `<4.6.6` textually includes 3.x; the vulnerable code is the zod 4 `$ZodArray`. Not verified against the 3.25.76 source. |
| `extensions/copilot` | 3.25.76 | its own `package.json` | No. Patches 1500 to 1520 do not install or package it. |
| `@github/copilot-sdk/node_modules/zod` | 4.3.6 | `@github/copilot-sdk` | Removed from the lockfiles by the hook (it was present in the upstream lockfile). |

### Root `zod` 4.4.3: not reached by any entry point

Evidence is a static import graph, not a tsconfig exclusion. (Patch 1560 excludes `agentHost/node/**` from the checker tsconfigs, but that does not stop a file that is imported from being compiled: `sharedProcessMain.ts` and `serverServices.ts` still import 18 other `agentHost/node/**` files, listed below.)

How it was computed, so it can be re-run:

- Entry points: the `desktopEntryPoints`, `codeEntryPoints`, `workerEntryPoints` and `serverEntryPoints` lists in `build/next/index.ts` (patch 1530 removes `agentHostMain` and `diffWorkerMain` from them), plus `vs/sessions/sessions.web.main.internal`, `vs/workbench/workbench.web.main.internal`, `vs/server/node/serverServices`, `vs/server/node/server.main`, `src/main.ts`, `src/server-main.ts` and `src/cli.ts`.
- Walk: a Node script over `src/` that follows `import … from`, side-effect `import 'x'`, `export … from` and `import('x')` with string literals, resolves `vs/…` and relative specifiers, and skips `import type`. It records every reached file that imports `zod` or `zod/*`.
- Result: 6,579 files reached, **no file importing `zod` is reached, and no file under `agentHost/node/claude/` is reached**. A positive control (starting from `claudeJsonSchemaToZod.ts`) finds its `zod` import, so the walk does detect it.
- Files under `agentHost/node/` that are still reached (compiled and bundled): `nodeAgentHostStarter`, the ssh, WSL, dev-container and tunnel remote-host services and their helpers, `localAgentHostMetadata`, `agentHostLockfile`, `appNodeModules`. None imports zod.
- The only non-test importer of `zod` in `src/` is `src/vs/platform/agentHost/node/claude/clientTools/claudeJsonSchemaToZod.ts` (plus component fixtures under `src/vs/workbench/test/**`, never packaged). Nothing in `code-oss/overlay/` imports `zod`.
- Not started either: patches 1530, 1540 and 1545 unbundle the agent host, do not start it and refuse its spawn flags.

The other lockfile consumers of the hoisted `zod` are dev-only (`@modelcontextprotocol/sdk`, `zod-to-json-schema`, `@vscode/component-explorer*`) or removed by patch 1550 and the hook.

What is **not** verified:

- The graph is a text scan. It does not see `require()` with a computed path, imports built from variables, or code loaded by file path at runtime. I did not look for those.
- It covers `src/`. Extensions and `node_modules` packages that depend on zod are covered by the table above, not by the graph.
- No build was run and no packaged app inspected. The package stays on disk (it is a production dependency); nothing in the graph loads it.

Conclusion: not reachable as of this commit. It becomes reachable if a later patch re-enables an importer, or if the Axis daemon bundle resolves bare `zod` to the root copy (ADR 0005 D4 "How 4.6.6 reaches the daemon bundle"). ADR 0005 D4 specifies a staging check for the second case; no script under `scripts/code-oss/` implements it yet.

### Markdown editor 4.4.3: reachable, low severity (partly an assumption)

- `markdownEditorProtocol.ts` and `markdownEditorRpc.ts` use `zod/mini`. The schemas contain unbounded arrays (`tokens`, `colorMap`, `subscribe`, `unsubscribe`, and others). The extension is built in, `removals.txt` does not list it and no Axis patch touches it, so it ships.
- **Both directions are parsed.** The same transport is bundled in the extension host and, through `markdown-editor-src/editor.ts`, in the webview (`enableScripts: true`).
  - Webview to host: sent by the editor's own script. Sending an oversized failing array needs script execution inside the webview.
  - Host to webview: some arrays (highlight tokens, link presentations and similar) are derived from the opened document by the host. A hostile document could make the host send large arrays. Whether such an array can be made both very large **and failing validation** was not checked.
- **Gate:** `markdownEditorRpc.ts` parses the envelope first and the RPC body only after `messageSecret` matches, so a message from anything that does not know the secret is dropped before the message schema runs. The envelope has `message: z.unknown()`, so the big array is not validated at that step.
- **The advisory needs failing elements.** Elements produced by the host's own code are well formed, so they pass and do not trigger the issue accumulation. This is an inference from the schema shapes, not a test.
- No test was run with a very large failing array against the real schemas.
- Impact if exploited: denial of service of the extension host or the webview, local only.

Conclusion: runtime-reachable, low exposure. Accept for now, and treat the reasoning above as an assumption until tested.

## Axis packages

Every `packages/*` pins `zod` 4.6.6 exactly (`audit`, `challenge`, `daemon`, `git-ops`, `journal`, `protocol`, `providers`, `pty-policy` at the time of writing) and the workspace lockfile resolves 4.6.6. `parseClientMessage` bounds a message (size, depth, node count) before any schema runs, so an oversized array is rejected before zod sees it.

## Is a bump trivial and safe?

Not trivial. Recommendation: do not bump now.

- Root and `remote/`: `package.json` already allows 4.6.6 (`^4.4.3`), so the change would be lockfile-only. But the lockfiles are produced by the `10-regen-locks` hook, which asserts that every kept entry, including `zod`, is unchanged and checks recorded hashes. A bump is therefore a change to that hook (its assertion goes beyond ADR 0003 D2, which only requires that `zod` stays a direct dependency) and a new set of hashes, not a patch file. It buys nothing while no importer is reachable.
- Markdown extension: its `package.json` pins exactly `4.4.3`. A bump needs a `package.json` and lockfile patch for an extension that upstream owns and the hook does not visit, for a low-exposure path.
- If a later change makes the root copy reachable, do the bump then, together with the hook change and new hashes, and re-run the type-check against 4.6.x.

## Follow-ups

1. Implement the ADR 0005 D4 check that stops the daemon bundle from resolving the tree's 4.4.3. It is the one way this advisory could reach Axis code.
2. Before any patch re-enables code under `src/vs/platform/agentHost/node/claude/**`, or adds a `zod` importer outside the extensions, re-run the import graph and re-open this note.
