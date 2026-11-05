// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Staging behaviour (ADR 0005 D3): output, rewrites, determinism, idempotence, zod vendoring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { STAGE_ROOT, rewriteSpecifiers, stage, zodClosure } from "../../scripts/code-oss/stage-packages.mjs";
import { verifyStaged } from "../../scripts/code-oss/stage-verify.mjs";
import { fixture, put, withFixture } from "./stage-fixture.mjs";

const read = (tree, rel) => readFileSync(join(tree, STAGE_ROOT, rel), "utf8");
const readAll = (tree, manifest) => manifest.files.map((f) => [f.path, readFileSync(join(tree, STAGE_ROOT, f.path), "utf8")]);

test("rewriteSpecifiers: every import form, relative result", () => {
  const src = 'import a from "zod";\nexport * from "@axis/protocol";\nimport "zod";\nconst b = import("zod");\nconst c = require("zod");\nimport d from "./keep.js";\n';
  const out = rewriteSpecifiers(src, "src/vs/axis/packages/worktrees/sub/f.ts", (s) =>
    s === "zod" ? "src/vs/axis/packages/vendor/zod/index.js" : s === "@axis/protocol" ? "src/vs/axis/packages/protocol/index.js" : null,
  );
  assert.equal(out.match(/"\.\.\/\.\.\/vendor\/zod\/index\.js"/g).length, 4);
  assert.match(out, /export \* from "\.\.\/\.\.\/protocol\/index\.js"/);
  assert.match(out, /from "\.\/keep\.js"/);
});

test("zodClosure keeps only what index.js reaches", () => {
  withFixture(({ repo }) => {
    assert.deepEqual(zodClosure(join(repo, "node_modules/zod")), ["LICENSE", "index.d.ts", "index.js", "package.json", "v4/core.d.ts", "v4/core.js"]);
  });
});

test("zodClosure never reads outside the zod directory", () => {
  withFixture(({ repo, base }) => {
    put(repo, "node_modules/zod/index.js", 'export * from "../../outside.js";\n');
    put(base, "outside.js", "export const secret = 1;\n");
    assert.throws(() => zodClosure(join(repo, "node_modules/zod")), /leaves the package/);
  });
});

test("stage: stages sources, vendors zod, rewrites imports, writes a manifest", () => {
  withFixture(({ repo, tree }) => {
    const m = stage({ repo, tree });
    assert.equal(m.zod, "9.9.9");
    assert.deepEqual(m.packages, ["protocol", "worktrees"]);
    const lines = read(tree, "protocol/index.ts").split("\n");
    assert.match(lines[0], /^\/\/ Copyright \(c\) 2026 Dylan Lambertson/);
    assert.match(lines[1], /^\/\/ Staged by code-oss\/hooks\/post-apply\.d\/20-stage-axis-packages/);
    assert.match(read(tree, "protocol/index.ts"), /from "\.\.\/vendor\/zod\/index\.js"/);
    assert.match(read(tree, "protocol/index.ts"), /from "\.\/sub\/a\.js"/);
    const w = read(tree, "worktrees/index.ts");
    assert.match(w, /from "\.\.\/protocol\/index\.js"/);
    assert.match(w, /import\("\.\.\/protocol\/index\.js"\)/);
    assert.match(w, /from "node:fs"/);
    for (const gone of ["protocol/t.test.ts", "vendor/zod/v3/unused.js", "vendor/zod/index.cjs"]) {
      assert.equal(existsSync(join(tree, STAGE_ROOT, gone)), false, gone);
    }
    const manifest = JSON.parse(read(tree, "stage-manifest.json"));
    assert.equal(manifest.schema, 1);
    for (const f of manifest.files) {
      assert.equal(f.sha256, createHash("sha256").update(readFileSync(join(tree, STAGE_ROOT, f.path))).digest("hex"), f.path);
    }
    assert.ok(manifest.files.some((f) => f.path === "protocol/index.ts" && f.source === "packages/protocol/src/index.ts" && /^[0-9a-f]{64}$/.test(f.sourceSha256)));
    assert.equal(verifyStaged(tree).treeSha256, m.treeSha256);
  });
});

test("stage: a declared subpath of another package is rewritten to its staged module", () => {
  withFixture(({ repo, tree }) => {
    put(repo, "packages/protocol/src/uses.ts", 'import { confirm } from "@axis/worktrees/daemon-confirm";\nexport const c = confirm;\n');
    stage({ repo, tree });
    assert.match(read(tree, "protocol/uses.ts"), /from "\.\.\/worktrees\/confirm\.js"/);
  });
});

test("stage: only the vendored zod is imported; no staged file keeps a bare zod or @axis specifier", () => {
  withFixture(({ repo, tree }) => {
    const m = stage({ repo, tree });
    for (const [path, text] of readAll(tree, m)) {
      if (!path.endsWith(".ts")) continue;
      assert.doesNotMatch(text, /from\s+["'](?:zod|@axis\/)/, path);
    }
  });
});

test("stage: deterministic, same input gives the same tree hash and bytes in another place, time and umask", () => {
  const a = fixture();
  const b = fixture();
  const oldMask = process.umask(0o077);
  try {
    const ma = stage({ repo: a.repo, tree: a.tree });
    // Different mtimes on every input, a different umask, a different path.
    const old = new Date("2020-01-01T00:00:00Z");
    for (const p of ["packages/protocol/src/index.ts", "packages/protocol/src/sub/a.ts", "node_modules/zod/index.js"]) utimesSync(join(b.repo, p), old, old);
    process.umask(0o022);
    const mb = stage({ repo: b.repo, tree: b.tree });
    assert.equal(ma.treeSha256, mb.treeSha256);
    assert.deepEqual(readAll(a.tree, ma), readAll(b.tree, mb));
    assert.equal(read(a.tree, "stage-manifest.json"), read(b.tree, "stage-manifest.json"));
    for (const f of ma.files) assert.equal(statSync(join(a.tree, STAGE_ROOT, f.path)).mode & 0o777, 0o644, `${f.path} mode`);
    assert.equal(statSync(join(a.tree, STAGE_ROOT, "protocol")).mode & 0o777, 0o755);
    // Changing one byte of a source changes the hash.
    writeFileSync(join(b.repo, "packages/protocol/src/sub/a.ts"), "export const a = 2;\n");
    assert.notEqual(stage({ repo: b.repo, tree: b.tree }).treeSha256, ma.treeSha256);
  } finally {
    process.umask(oldMask);
    rmSync(a.base, { recursive: true, force: true });
    rmSync(b.base, { recursive: true, force: true });
  }
});

test("stage: idempotent, and removes files of deleted sources", () => {
  withFixture(({ repo, tree }) => {
    const first = stage({ repo, tree });
    const text = read(tree, "stage-manifest.json");
    const second = stage({ repo, tree });
    assert.equal(second.treeSha256, first.treeSha256);
    assert.equal(read(tree, "stage-manifest.json"), text);
    rmSync(join(repo, "packages/protocol/src/sub/a.ts"));
    writeFileSync(join(repo, "packages/protocol/src/index.ts"), "export const x = 1;\n");
    stage({ repo, tree });
    assert.equal(existsSync(join(tree, STAGE_ROOT, "protocol/sub/a.ts")), false);
  });
});

test("stage: a stage-manifest.json edited by hand is regenerated, not trusted", () => {
  withFixture(({ repo, tree }) => {
    const first = stage({ repo, tree });
    const p = join(tree, STAGE_ROOT, "stage-manifest.json");
    writeFileSync(p, readFileSync(p, "utf8").replace(first.treeSha256, "0".repeat(64)));
    assert.throws(() => verifyStaged(tree), /treeSha256 does not match/);
    assert.equal(stage({ repo, tree }).treeSha256, first.treeSha256);
  });
});

test("stage: zod version mismatch, differing pins and collisions fail", () => {
  withFixture(({ repo, tree }) => assert.throws(() => stage({ repo, tree }), /installed zod is 9\.9\.8 but packages pin 9\.9\.9/), { zodVersion: "9.9.8", pinned: "9.9.9" });
  withFixture(({ repo, tree }) => {
    put(repo, "packages/worktrees/package.json", JSON.stringify({ name: "@axis/worktrees", exports: { ".": { default: "./dist/src/index.js" } }, dependencies: { zod: "9.9.8" } }));
    assert.throws(() => stage({ repo, tree }), /different zod versions/);
  });
  withFixture(({ repo, tree }) => {
    mkdirSync(join(tree, STAGE_ROOT), { recursive: true });
    put(tree, `${STAGE_ROOT}/foreign.ts`, "export {};\n");
    assert.throws(() => stage({ repo, tree }), /collision/);
    assert.equal(existsSync(join(tree, STAGE_ROOT, "foreign.ts")), true, "a foreign file is never deleted");
  });
});
