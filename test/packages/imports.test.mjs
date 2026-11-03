// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Enforces the ADR 0005 D2 boundary on packages/*: what each package may import,
// and which dependencies its package.json may declare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));

/** Packages that must stay free of Node imports (contracts shared with the web target). */
const NO_NODE = new Set(["protocol"]);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Dynamic `import(...)` or `require(...)` whose argument is not a plain string literal. */
export function nonLiteralLoads(source) {
  const text = stripComments(source);
  const found = [];
  for (const m of text.matchAll(/\b(import|require)\s*\(\s*(?!['"][^'"`$]*['"]\s*\))([^)]{0,40})/g)) {
    found.push(`${m[1]}(${m[2].trim()}`);
  }
  return found;
}

/** Import specifiers in TypeScript source: static, side-effect, re-export and dynamic imports. */
export function importSpecifiers(source) {
  const text = stripComments(source);
  const found = [];
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.push(m[1]);
  return found;
}

/**
 * Why a specifier is not allowed in `pkg`, or null when it is. The node:*
 * ban for contract packages (D2.4) applies to shipped sources under `src/`;
 * tests and test-support entry points (`test/`, `contract/`) may use node:*.
 * A call without a file is judged as `src/`.
 */
export function violation(pkg, spec, file = null, pkgDir = null) {
  const inSrc = file === null || pkgDir === null || relative(pkgDir, file).split(sep)[0] === "src";
  if (spec.startsWith("./") || spec.startsWith("../")) {
    if (file === null || pkgDir === null) return null;
    const target = resolve(dirname(file), spec);
    const rel = relative(pkgDir, target);
    return rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel
      ? "relative import leaves the package directory"
      : null;
  }
  if (spec === "zod" || spec.startsWith("zod/")) return null;
  if (spec.startsWith("@axis/")) return null;
  if (spec.startsWith("node:")) return NO_NODE.has(pkg) && inSrc ? "node:* is not allowed in this package" : null;
  return "only relative, zod, @axis/* and node:* imports are allowed";
}

/** Directories never scanned: build output and installed dependencies. */
const SKIP_DIRS = new Set(["dist", "node_modules"]);

/**
 * Every TypeScript file in a package, not only `src/`: `contract/` is a
 * published entry point other packages import, and `test/` runs in CI (N9).
 */
export function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* sourceFiles(p);
      continue;
    }
    if (p.endsWith(".ts") && !p.endsWith(".d.ts")) yield p;
  }
}

const packages = readdirSync(packagesDir).filter((n) => statSync(join(packagesDir, n)).isDirectory());

test("there is at least one package", () => assert.ok(packages.length > 0));

for (const pkg of packages) {
  test(`${pkg}: imports stay inside the allowlist (whole package)`, () => {
    const bad = [];
    const pkgDir = join(packagesDir, pkg);
    for (const file of sourceFiles(pkgDir)) {
      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        const why = violation(pkg, spec, file, pkgDir);
        if (why) bad.push(`${file}: ${spec} (${why})`);
      }
      for (const call of nonLiteralLoads(source)) bad.push(`${file}: ${call} (dynamic load needs a string literal)`);
    }
    assert.deepEqual(bad, []);
  });

  test(`${pkg}: package.json declares only zod and @axis/* dependencies`, () => {
    const json = JSON.parse(readFileSync(join(packagesDir, pkg, "package.json"), "utf8"));
    assert.equal(json.type, "module");
    assert.equal(json.private, true);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(json[field] ?? {})) {
        assert.ok(name === "zod" || name.startsWith("@axis/"), `${field}.${name}`);
      }
    }
    if (json.dependencies?.zod !== undefined) assert.equal(json.dependencies.zod, "4.6.6");
  });
}

test("scanner: finds every import form and ignores comments", () => {
  const src = `
    import a from "zod";
    import type { B } from '../b.js';
    export * from "./c.js";
    export { d } from "node:fs";
    import "vs/base/common/lifecycle";
    const e = await import("electron");
    // import x from "ignored";
    /* import y from "ignored2"; */
    const s = "https://example.com//not-a-comment";
  `;
  assert.deepEqual(importSpecifiers(src).sort(), [
    "../b.js", "./c.js", "electron", "node:fs", "vs/base/common/lifecycle", "zod",
  ]);
});

test("scanner: policy", () => {
  assert.equal(violation("protocol", "vs/base/common/event"), "only relative, zod, @axis/* and node:* imports are allowed");
  assert.equal(violation("protocol", "electron") !== null, true);
  assert.equal(violation("protocol", "node:fs") !== null, true);
  assert.equal(violation("worktrees", "node:fs"), null);
  assert.equal(violation("worktrees", "@axis/protocol"), null);
  assert.equal(violation("worktrees", "zod"), null);
  assert.equal(violation("worktrees", "fs") !== null, true);
});

test("scanner: relative imports must stay inside the package", () => {
  const dir = join(packagesDir, "protocol");
  const file = join(dir, "src", "a.ts");
  assert.equal(violation("protocol", "./b.js", file, dir), null);
  assert.equal(violation("protocol", "../test/x.js", file, dir), null);
  assert.notEqual(violation("protocol", "../../worktrees/src/x.js", file, dir), null);
  assert.notEqual(violation("protocol", "../../../vendor/code-oss/x.js", file, dir), null);
  assert.notEqual(violation("protocol", "../../protocol-evil/x.js", file, dir), null);
});

test("scanner: dynamic loads need a string literal", () => {
  assert.deepEqual(nonLiteralLoads(`const a = await import("zod"); const b = require('./x.js');`), []);
  assert.equal(nonLiteralLoads("await import(name)").length, 1);
  assert.equal(nonLiteralLoads("await import(`./x/${n}.js`)").length, 1);
  assert.equal(nonLiteralLoads("await import('./x/' + n)").length, 1);
  assert.equal(nonLiteralLoads("require(path)").length, 1);
  assert.deepEqual(nonLiteralLoads('// import(name)\n/* require(x) */'), []);
});

test("scanner: walks the whole package except dist and node_modules", () => {
  const dir = join(packagesDir, "protocol");
  const files = [...sourceFiles(dir)].map((f) => relative(dir, f));
  assert.ok(files.some((f) => f.startsWith(`src${sep}`)));
  assert.ok(files.some((f) => f.startsWith(`test${sep}`)), "tests are scanned");
  assert.ok(files.every((f) => !f.startsWith(`dist${sep}`) && !f.startsWith(`node_modules${sep}`)));
});

test("scanner: node:* is banned in protocol src, allowed in its tests and test-support entry points", () => {
  const dir = join(packagesDir, "protocol");
  assert.notEqual(violation("protocol", "node:fs", join(dir, "src", "a.ts"), dir), null);
  assert.equal(violation("protocol", "node:test", join(dir, "test", "a.test.ts"), dir), null);
  assert.equal(violation("protocol", "node:test", join(dir, "contract", "index.ts"), dir), null);
  assert.notEqual(violation("protocol", "electron", join(dir, "contract", "index.ts"), dir), null, "the rest of the allowlist still applies");
  assert.notEqual(violation("protocol", "vs/base/common/event", join(dir, "test", "a.test.ts"), dir), null);
});
