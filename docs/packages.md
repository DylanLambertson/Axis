# Axis packages

Axis-owned TypeScript that does not need Code OSS services lives in `packages/*` as npm workspaces (`@axis/<name>`). The decision and the rules are in `docs/adr/0005-axis-packages-layout.md`; this page is the working summary.

| Package | Purpose |
|---|---|
| `@axis/protocol` | Versioned envelope, structured errors, contracts such as `axis.worktrees/1`, and the challenge shape. Zod schemas and inferred types. No Node imports. |

More packages (worktrees, journal, audit) are added by their own changes.

## Rules

- Packages may import `node:*`, `zod` (exactly 4.6.6) and other `@axis/*` packages. They never import `vs/*`, Electron or the DOM.
- The UI and workbench code in `code-oss/overlay/src/vs/axis/**` reaches the daemon only through `@axis/protocol`.
- Tests use `node:test`. No other test framework. `test/packages/imports.test.mjs` enforces the import allowlist.

## Commands

Use Node 24.22.1 (see `code-oss/upstream.json`). From the repository root:

```bash
npm ci --ignore-scripts
npm run typecheck   # strict tsc across all packages
npm run build       # clean, then tsc -b with the root tsconfig.json references
npm test            # clean build (scripts/clean-dist.mjs), then node --test "dist/test/**/*.test.js" in each package
```

## Adding a package

1. Copy `packages/protocol/package.json` and `tsconfig.json` to `packages/<name>/` and rename. Keep `"type": "module"` in the package; the repository root stays CommonJS so the existing `test/` scripts load.
2. Add `{ "path": "packages/<name>" }` to `references` in the root `tsconfig.json`, `references` in the package tsconfig, and a `"0.0.0"` dependency for each workspace package you use.
3. Use `.js` suffixes on relative imports, put sources in `src/` and tests in `test/` (`*.test.ts`).
4. Run `npm install --ignore-scripts` and commit the lockfile.
5. Start every file with `// Copyright (c) 2026 Dylan Lambertson. All rights reserved.`

## Reaching the app

`apply.sh` runs `code-oss/hooks/post-apply.d/20-stage-axis-packages` (logic in `scripts/code-oss/stage-packages.mjs`), which writes new files under `src/vs/axis/packages/` in the Code OSS tree:

- `<name>/**`: the package's `src/**/*.ts` with `@axis/*` and `zod` imports rewritten to relative paths;
- `vendor/zod/**`: the ESM JavaScript and declarations of zod reachable from its entry, taken from the repository's `node_modules` (run `npm ci --ignore-scripts` first);
- `stage-manifest.json`: SHA-256 of every staged file.

The overlay entry `vs/axis/daemon/node/axisDaemonMain` imports `../../packages/protocol/index.js`, and patch `0200-axis-daemon-entry.patch` lists it in `build/next/index.ts`. Why zod is vendored: see ADR 0005 D3.
