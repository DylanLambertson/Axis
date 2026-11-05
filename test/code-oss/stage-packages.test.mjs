// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  STAGE_ROOT,
  importSpecifiers,
  nonLiteralLoads,
  rewriteSpecifiers,
  stage,
  zodClosure,
} from "../../scripts/code-oss/stage-packages.mjs";

function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

/** A fake repo: two packages and a tiny "zod" with an import graph and one unreachable file. */
function fixture({ zodVersion = "9.9.9", pinned = "9.9.9" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "axis-stage-"));
  const repo = join(base, "repo");
  const tree = join(base, "tree");
  mkdirSync(tree, { recursive: true });
  put(repo, "node_modules/zod/package.json", JSON.stringify({ name: "zod", version: zodVersion }));
  put(repo, "node_modules/zod/LICENSE", "MIT\n");
  put(repo, "node_modules/zod/index.js", 'export * from "./v4/core.js";\n');
  put(repo, "node_modules/zod/index.d.ts", 'export * from "./v4/core.js";\n');
  put(repo, "node_modules/zod/v4/core.js", "export const z = {};\n");
  put(repo, "node_modules/zod/v4/core.d.ts", "export declare const z: {};\n");
  put(repo, "node_modules/zod/v3/unused.js", "export const unused = 1;\n");
  put(repo, "node_modules/zod/index.cjs", "module.exports = {};\n");
  put(repo, "packages/protocol/package.json", JSON.stringify({ name: "@axis/protocol", dependencies: { zod: pinned } }));
  put(
    repo,
    "packages/protocol/src/index.ts",
    '// Copyright (c) 2026 Dylan Lambertson. All rights reserved.\nimport { z } from "zod";\nexport * from "./sub/a.js";\nexport const x = z;\n',
  );
  put(repo, "packages/protocol/src/sub/a.ts", 'export const a = 1;\n');
  put(repo, "packages/protocol/src/types.d.ts", "export type T = 1;\n");
  put(repo, "packages/protocol/test/t.test.ts", 'import "node:test";\n');
  put(repo, "packages/worktrees/package.json", JSON.stringify({ name: "@axis/worktrees", dependencies: { "@axis/protocol": "0.0.0", zod: pinned } }));
  put(
    repo,
    "packages/worktrees/src/index.ts",
    'import { x } from "@axis/protocol";\nimport { readFileSync } from "node:fs";\nexport const y = [x, readFileSync];\nconst lazy = () => import("@axis/protocol");\nvoid lazy;\n',
  );
  return { base, repo, tree };
}

const read = (tree, rel) => readFileSync(join(tree, STAGE_ROOT, rel), "utf8");

test("rewriteSpecifiers: every import form, relative result", () => {
  const src = 'import a from "zod";\nexport * from "@axis/protocol";\nimport "zod";\nconst b = import("zod");\nimport c from "./keep.js";\n';
  const out = rewriteSpecifiers(src, "src/vs/axis/packages/worktrees/sub/f.ts", (s) =>
    s === "zod" ? "src/vs/axis/packages/vendor/zod/index.js" : s === "@axis/protocol" ? "src/vs/axis/packages/protocol/index.js" : null,
  );
  assert.equal(out.match(/"\.\.\/\.\.\/vendor\/zod\/index\.js"/g).length, 3);
  assert.match(out, /export \* from "\.\.\/\.\.\/protocol\/index\.js"/);
  assert.match(out, /from "\.\/keep\.js"/);
});

test("importSpecifiers and nonLiteralLoads", () => {
  assert.deepEqual(importSpecifiers('import a from "zod"; // import x from "no"\n/* import "y" */ export * from "./b.js";').sort(), ["./b.js", "zod"]);
  assert.equal(nonLiteralLoads("await import(name)").length, 1);
  assert.equal(nonLiteralLoads('await import("zod")').length, 0);
});

test("zodClosure keeps only what index.js reaches", () => {
  const { base, repo } = fixture();
  try {
    assert.deepEqual(zodClosure(join(repo, "node_modules/zod")), [
      "LICENSE", "index.d.ts", "index.js", "package.json", "v4/core.d.ts", "v4/core.js",
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("stage: stages sources, vendors zod, rewrites imports, writes a manifest", () => {
  const { base, repo, tree } = fixture();
  try {
    const m = stage({ repo, tree });
    assert.equal(m.zod, "9.9.9");
    assert.deepEqual(m.packages, ["protocol", "worktrees"]);
    const idx = read(tree, "protocol/index.ts");
    const lines = idx.split("\n");
    assert.match(lines[0], /^\/\/ Copyright \(c\) 2026 Dylan Lambertson/);
    assert.match(lines[1], /^\/\/ Staged by code-oss\/hooks\/post-apply\.d\/20-stage-axis-packages/);
    assert.match(idx, /from "\.\.\/vendor\/zod\/index\.js"/);
    assert.match(idx, /from "\.\/sub\/a\.js"/);
    const w = read(tree, "worktrees/index.ts");
    assert.match(w, /from "\.\.\/protocol\/index\.js"/);
    assert.match(w, /import\("\.\.\/protocol\/index\.js"\)/);
    assert.match(w, /from "node:fs"/);
    assert.equal(existsSync(join(tree, STAGE_ROOT, "protocol/types.d.ts")), false);
    assert.equal(existsSync(join(tree, STAGE_ROOT, "protocol/t.test.ts")), false);
    assert.equal(existsSync(join(tree, STAGE_ROOT, "vendor/zod/v3/unused.js")), false);
    assert.equal(existsSync(join(tree, STAGE_ROOT, "vendor/zod/index.cjs")), false);
    const manifest = JSON.parse(read(tree, "stage-manifest.json"));
    for (const f of manifest.files) {
      const sum = createHash("sha256").update(readFileSync(join(tree, STAGE_ROOT, f.path))).digest("hex");
      assert.equal(f.sha256, sum, f.path);
    }
    assert.ok(manifest.files.some((f) => f.path === "protocol/index.ts" && f.source === "packages/protocol/src/index.ts"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("stage: idempotent, and removes files of deleted sources", () => {
  const { base, repo, tree } = fixture();
  try {
    stage({ repo, tree });
    const first = read(tree, "stage-manifest.json");
    stage({ repo, tree });
    assert.equal(read(tree, "stage-manifest.json"), first);
    rmSync(join(repo, "packages/protocol/src/sub/a.ts"));
    writeFileSync(join(repo, "packages/protocol/src/index.ts"), "export const x = 1;\n");
    stage({ repo, tree });
    assert.equal(existsSync(join(tree, STAGE_ROOT, "protocol/sub/a.ts")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("stage: refuses bad input", () => {
  const cases = [
    ["a stray import", (r) => put(r, "packages/protocol/src/bad.ts", 'import "vs/base/common/event";\n'), /outside the allowlist/],
    ["a relative import leaving the package", (r) => put(r, "packages/protocol/src/bad.ts", 'import "../../worktrees/src/index.js";\n'), /leaves the package/],
    ["a non-literal dynamic load", (r) => put(r, "packages/protocol/src/bad.ts", "await import(name);\n"), /string literal/],
    ["a zod subpath", (r) => put(r, "packages/protocol/src/bad.ts", 'import "zod/mini";\n'), /only the "zod" entry/],
    ["an unknown workspace package", (r) => put(r, "packages/protocol/src/bad.ts", 'import "@axis/nope";\n'), /unknown workspace package/],
    ["a missing index.ts", (r) => rmSync(join(r, "packages/worktrees/src/index.ts")), /index\.ts is missing/],
  ];
  for (const [name, mutate, re] of cases) {
    const { base, repo, tree } = fixture();
    try {
      mutate(repo);
      assert.throws(() => stage({ repo, tree }), re, name);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("stage: zod version mismatch and collisions fail", () => {
  let f = fixture({ zodVersion: "9.9.8", pinned: "9.9.9" });
  try {
    assert.throws(() => stage({ repo: f.repo, tree: f.tree }), /installed zod is 9\.9\.8 but packages pin 9\.9\.9/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
  f = fixture();
  try {
    put(f.tree, `${STAGE_ROOT}/foreign.ts`, "export {};\n");
    assert.throws(() => stage({ repo: f.repo, tree: f.tree }), /collision/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
