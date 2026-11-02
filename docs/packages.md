# Axis packages

Axis-owned TypeScript that does not need Code OSS services lives in `packages/*` as npm workspaces (`@axis/<name>`). The decision and the rules are in `docs/adr/0005-axis-packages-layout.md`; this page is the working summary.

| Package | Purpose |
|---|---|
| `@axis/protocol` | Versioned envelope, structured errors, contracts such as `axis.worktrees/1`, and the challenge shape. Zod schemas and inferred types. No Node imports. |

More packages (worktrees, journal, audit) are added by their own changes.

## Rules

- Packages may import `node:*`, `zod` (exactly 4.6.6) and other `@axis/*` packages. They never import `vs/*`, Electron or the DOM.
- The UI and workbench code in `code-oss/overlay/src/vs/axis/**` reaches the daemon only through `@axis/protocol`.
- Tests use `node:test`. No other test framework.

## Commands

Use Node 24.22.1 (see `code-oss/upstream.json`). From the repository root:

```bash
npm ci --ignore-scripts
npm run typecheck   # strict tsc across all packages
npm run build       # tsc -b packages/*
npm test            # build, then node --test "dist/test/**/*.test.js" in each package
```

## Adding a package

1. Copy `packages/protocol/package.json` and `tsconfig.json` to `packages/<name>/` and rename.
2. Add `references` to the tsconfig and a pinned `"0.0.0"` dependency for each workspace package you use.
3. Use `.js` suffixes on relative imports, put sources in `src/` and tests in `test/` (`*.test.ts`).
4. Run `npm install --ignore-scripts` and commit the lockfile.
5. Start every file with `// Copyright (c) 2026 Dylan Lambertson. All rights reserved.`

## Reaching the app

Planned in ADR 0005 D3: a post-apply hook stages package sources into `src/vs/axis/packages/` so Code OSS's own esbuild bundles them into the daemon. Not implemented yet.
