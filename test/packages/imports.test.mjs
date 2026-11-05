// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Enforces the ADR 0005 D2 boundary on packages/*: what each package may import,
// and which dependencies its package.json may declare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenLoaders, isScriptFile, principalReexports } from "./loaders.mjs";

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
 * Subpaths of @axis/journal and the only packages that may import them. The user principal is minted by the
 * daemon's connection layer from the attested connection; nothing else may be able to create one. Any other
 * `@axis/journal/...` deep import is refused. Other packages' subpaths (for example `@axis/providers/contract`)
 * are unrestricted, as before.
 */
const JOURNAL_SUBPATHS = new Map([["@axis/journal/daemon-principal", new Set(["daemon"])]]);

/** The trust attestation is minted by the daemon's connection layer from main's attestation (threat model TRU-2). */
const RUNS_SUBPATHS = new Map([["@axis/runs/daemon-attestation", new Set(["daemon"])]]);

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
  if (spec.startsWith("@axis/journal/")) {
    const allowed = JOURNAL_SUBPATHS.get(spec);
    if (allowed === undefined) return "deep imports into @axis/journal are not allowed";
    return allowed.has(pkg) ? null : "this subpath may only be imported by the daemon integration code";
  }
  if (spec.startsWith("@axis/runs/")) {
    const allowed = RUNS_SUBPATHS.get(spec);
    if (allowed === undefined) return "deep imports into @axis/runs are not allowed";
    return allowed.has(pkg) ? null : "this subpath may only be imported by the daemon integration code";
  }
  if (spec.startsWith("@axis/")) return null;
  if (spec.startsWith("node:")) return NO_NODE.has(pkg) && inSrc ? "node:* is not allowed in this package" : null;
  return "only relative, zod, @axis/* and node:* imports are allowed";
}

/** Directories never scanned: build output and installed dependencies. */
const SKIP_DIRS = new Set(["dist", "node_modules"]);

/**
 * Every script file in a package (.js, .mjs, .cjs, .ts, .mts, .cts, .tsx, .jsx; not declaration files), not only `src/`: `contract/` is a
 * published entry point other packages import, and `test/` runs in CI (N9).
 */
export function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* sourceFiles(p);
      continue;
    }
    if (isScriptFile(p)) yield p;
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
      for (const name of forbiddenLoaders(source)) bad.push(`${file}: ${name} (loads a module without a visible specifier)`);
      for (const re of principalReexports(source)) bad.push(`${file}: ${re} (the user-principal subpath must not be re-exported)`);
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

test("scanner: the user-principal subpath is restricted to the daemon; other journal deep imports are refused", () => {
  assert.equal(violation("journal", "@axis/audit"), null);
  assert.equal(violation("daemon", "@axis/journal"), null);
  assert.equal(violation("daemon", "@axis/journal/daemon-principal"), null);
  for (const pkg of ["protocol", "audit", "journal", "worktrees", "git-ops", "pty-policy", "providers", "challenge"]) {
    assert.notEqual(violation(pkg, "@axis/journal/daemon-principal"), null, pkg);
  }
  assert.notEqual(violation("daemon", "@axis/journal/dist/src/principal.js"), null);
  assert.notEqual(violation("daemon", "@axis/journal/src/principal"), null);
  // Other packages' own subpaths stay allowed, as on main.
  assert.equal(violation("daemon", "@axis/providers/contract"), null);
});

test("scanner: the trust-attestation subpath is restricted to the daemon; other runs deep imports are refused", () => {
  assert.equal(violation("daemon", "@axis/runs"), null);
  assert.equal(violation("daemon", "@axis/runs/daemon-attestation"), null);
  for (const pkg of ["protocol", "audit", "journal", "runs", "git-ops", "pty-policy", "providers", "challenge"]) {
    assert.notEqual(violation(pkg, "@axis/runs/daemon-attestation"), null, pkg);
  }
  assert.notEqual(violation("daemon", "@axis/runs/dist/src/attestation.js"), null);
  assert.notEqual(violation("daemon", "@axis/runs/src/attestation"), null);
});

test("the runs package root does not export the attestation minting function", () => {
  const json = JSON.parse(readFileSync(join(packagesDir, "runs", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(json.exports).sort(), [".", "./daemon-attestation"]);
  const index = readFileSync(join(packagesDir, "runs", "src", "index.ts"), "utf8");
  assert.ok(!/attestTrust|daemon-attestation|MINT/.test(index), "src/index.ts must not expose the minting function");
});

test("the journal package root exports the principal subpath only through package.json exports", () => {
  const json = JSON.parse(readFileSync(join(packagesDir, "journal", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(json.exports).sort(), [".", "./daemon-principal"]);
  const index = readFileSync(join(packagesDir, "journal", "src", "index.ts"), "utf8");
  assert.ok(!/principal/i.test(index), "src/index.ts must not mention the principal module");
});

test("scanner: every script extension is read, declaration files are not", () => {
  for (const f of ["a.js", "a.mjs", "a.cjs", "a.ts", "a.mts", "a.cts", "a.tsx", "a.jsx", "dir/deep/x.mts"]) assert.equal(isScriptFile(f), true, f);
  for (const f of ["a.d.ts", "a.d.mts", "a.d.cts", "a.json", "a.map", "a.js.map", "a.md", "a.mtsx", "ts"]) assert.equal(isScriptFile(f), false, f);
});

test("scanner: sourceFiles yields .mts, .cts, .tsx, .jsx, .mjs and .cjs files, and skips dist and node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "axis-scan-"));
  try {
    for (const f of ["src/a.ts", "src/b.mts", "src/c.cts", "src/d.tsx", "src/e.jsx", "scripts/f.mjs", "scripts/g.cjs", "h.js", "src/i.d.ts", "src/j.d.mts", "src/k.json", "dist/l.js", "node_modules/m/n.js"]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "");
    }
    const found = [...sourceFiles(root)].map((p) => relative(root, p).split(sep).join("/")).sort();
    assert.deepEqual(found, ["h.js", "scripts/f.mjs", "scripts/g.cjs", "src/a.ts", "src/b.mts", "src/c.cts", "src/d.tsx", "src/e.jsx"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanner: a .mts file that imports and re-exports the principal is caught end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "axis-scan-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const file = join(root, "src", "leak.mts");
    writeFileSync(file, 'import { userPrincipal } from "@axis/journal/daemon-principal";\nexport { userPrincipal };\nconst r = createRequire(import.meta.url);\n');
    const bad = [];
    for (const f of sourceFiles(root)) {
      const source = readFileSync(f, "utf8");
      for (const spec of importSpecifiers(source)) {
        const why = violation("providers", spec, f, root);
        if (why) bad.push(spec);
      }
      bad.push(...forbiddenLoaders(source), ...principalReexports(source));
    }
    assert.deepEqual(bad, ["@axis/journal/daemon-principal", "createRequire", "export { userPrincipal }"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanner: loaders that hide a specifier are flagged", () => {
  assert.deepEqual(forbiddenLoaders('const r = createRequire(import.meta.url); r("@axis/journal/daemon-principal");'), ["createRequire"]);
  assert.deepEqual(forbiddenLoaders('process.getBuiltinModule("node:module").createRequire(import.meta.url)'), ["getBuiltinModule", "createRequire"]);
  assert.deepEqual(forbiddenLoaders('import { createRequire } from "node:module";'), ["createRequire"]);
  assert.deepEqual(forbiddenLoaders('// createRequire in a comment\n/* getBuiltinModule */ const a = 1;'), []);
  assert.deepEqual(forbiddenLoaders("const requireX = 1; const created = 2;"), []);
});

test("scanner: re-exporting the user-principal subpath is flagged, importing it for use is not", () => {
  const sub = '"@axis/journal/daemon-principal"';
  assert.equal(principalReexports(`export * from ${sub};`).length, 1);
  assert.equal(principalReexports(`export { userPrincipal } from ${sub};`).length, 1);
  assert.equal(principalReexports(`export type { UserPrincipal } from ${sub};`).length, 1);
  assert.equal(principalReexports(`export * as p from ${sub};`).length, 1);
  assert.equal(principalReexports(`import { userPrincipal } from ${sub};\nexport { userPrincipal };`).length, 1);
  assert.equal(principalReexports(`import { userPrincipal as mint } from ${sub};\nexport { a, userPrincipal, b };`).length, 1);
  assert.equal(principalReexports(`import { userPrincipal } from ${sub};\nexport const mint = userPrincipal;`).length, 1);
  assert.equal(principalReexports(`import { userPrincipal } from ${sub};\nexport default userPrincipal;`).length, 1);
  assert.equal(principalReexports(`import { userPrincipal } from ${sub};\nexport function connect() { return userPrincipal(); }`).length, 0);
  assert.equal(principalReexports(`export { userPrincipal } from "./other.js";`).length, 0);
  assert.equal(principalReexports(`// export * from ${sub};`).length, 0);
});
