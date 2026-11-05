// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shared fixture for the staging tests (not a test file). Builds a fake repository (two packages, a tiny "zod")
// and an empty Code OSS tree in a fresh temp directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

const exportsOf = (extra = {}) => ({
  ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
  ...extra,
});

export function fixture({ zodVersion = "9.9.9", pinned = "9.9.9" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "axis-stage-"));
  const repo = join(base, "repo");
  const tree = join(base, "tree");
  mkdirSync(tree, { recursive: true });
  put(repo, "node_modules/zod/package.json", JSON.stringify({ name: "zod", version: zodVersion }));
  put(repo, "node_modules/zod/LICENSE", "MIT\n");
  put(repo, "node_modules/zod/index.js", '// import x from "ignored-in-vendor";\nexport * from "./v4/core.js";\n');
  put(repo, "node_modules/zod/index.d.ts", 'export * from "./v4/core.js";\n');
  put(repo, "node_modules/zod/v4/core.js", "export const z = {};\n");
  put(repo, "node_modules/zod/v4/core.d.ts", "export declare const z: {};\n");
  put(repo, "node_modules/zod/v3/unused.js", "export const unused = 1;\n");
  put(repo, "node_modules/zod/index.cjs", "module.exports = {};\n");
  put(repo, "packages/protocol/package.json", JSON.stringify({ name: "@axis/protocol", exports: exportsOf(), dependencies: { zod: pinned } }));
  put(
    repo,
    "packages/protocol/src/index.ts",
    '// Copyright (c) 2026 Dylan Lambertson. All rights reserved.\nimport { z } from "zod";\nexport * from "./sub/a.js";\nexport const x = z;\n',
  );
  put(repo, "packages/protocol/src/sub/a.ts", "export const a = 1;\n");
  put(repo, "packages/protocol/test/t.test.ts", 'import "node:test";\n');
  put(
    repo,
    "packages/worktrees/package.json",
    JSON.stringify({ name: "@axis/worktrees", exports: exportsOf({ "./daemon-confirm": { default: "./dist/src/confirm.js" } }), dependencies: { "@axis/protocol": "0.0.0", zod: pinned } }),
  );
  put(
    repo,
    "packages/worktrees/src/index.ts",
    'import { x } from "@axis/protocol";\nimport { readFileSync } from "node:fs";\nexport const y = [x, readFileSync];\nconst lazy = () => import("@axis/protocol");\nvoid lazy;\n',
  );
  put(repo, "packages/worktrees/src/confirm.ts", "export const confirm = 1;\n");
  return { base, repo, tree };
}

/** Runs `fn` with a fresh fixture and removes the temp directory afterwards. */
export function withFixture(fn, opts) {
  const f = fixture(opts);
  try {
    return fn(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
}
