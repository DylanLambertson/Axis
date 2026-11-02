// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Enforces the ADR 0005 D2 boundary on packages/*: what each package may import,
// and which dependencies its package.json may declare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));

/** Packages that must stay free of Node imports (contracts shared with the web target). */
const NO_NODE = new Set(["protocol"]);

/** Import specifiers in TypeScript source: static, side-effect, re-export and dynamic imports. */
export function importSpecifiers(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
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

/** Why a specifier is not allowed in `pkg`, or null when it is. */
export function violation(pkg, spec) {
  if (spec.startsWith("./") || spec.startsWith("../")) return null;
  if (spec === "zod" || spec.startsWith("zod/")) return null;
  if (spec.startsWith("@axis/")) return null;
  if (spec.startsWith("node:")) return NO_NODE.has(pkg) ? "node:* is not allowed in this package" : null;
  return "only relative, zod, @axis/* and node:* imports are allowed";
}

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) yield p;
  }
}

const packages = readdirSync(packagesDir).filter((n) => statSync(join(packagesDir, n)).isDirectory());

test("there is at least one package", () => assert.ok(packages.length > 0));

for (const pkg of packages) {
  test(`${pkg}: src imports stay inside the allowlist`, () => {
    const bad = [];
    for (const file of sourceFiles(join(packagesDir, pkg, "src"))) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const why = violation(pkg, spec);
        if (why) bad.push(`${file}: ${spec} (${why})`);
      }
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
