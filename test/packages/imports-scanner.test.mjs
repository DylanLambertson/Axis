// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The module scanner's own behaviour (moved out of imports.test.mjs, which holds the package rules and their tables, to
// keep each file under 500 lines): every import form found, comments and literals not mistaken for imports, dynamic loads
// with a literal only, and the package roots' exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isScriptFile } from "./loaders.mjs";
import { importSpecifiers, unsafeForms } from "../../scripts/code-oss/stage-ast.mjs";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));

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

test("scanner: string-named bindings and a quote in a comment do not hide a specifier", () => {
  assert.deepEqual(importSpecifiers('import { "z" as z } from "zod";\nexport { "default" as e } from "vs/base/common/event";\nimport /* \' */ { x } from "child_process";').sort(), ["child_process", "vs/base/common/event", "zod"]);
});

test("scanner: a regex literal after a closing parenthesis does not hide a specifier", () => {
  const trick = `if (Date.now() < 0) /'/.test(""); export { "z" as zTree } from "zod";`;
  assert.deepEqual(importSpecifiers(trick), ["zod"]);
  assert.deepEqual(importSpecifiers(`if (a) /'/.test(b); export * from "electron";`), ["electron"]);
  assert.deepEqual(importSpecifiers(`if (a) /'/.test(b); const m = import("electron");`), ["electron"]);
  assert.deepEqual(importSpecifiers(`if (a) /'/.test(b); import fs = require("fs");`), ["fs"]);
  assert.deepEqual(importSpecifiers(`const x = (a) / 2; import { y } from "./y.js";`), ["./y.js"]);
});

test("scanner: dynamic loads need a string literal", () => {
  assert.deepEqual(unsafeForms(`const a = await import("zod"); const b = require('./x.js');`), []);
  assert.equal(unsafeForms("await import(name)").length, 1);
  assert.equal(unsafeForms("await import(`./x/${n}.js`)").length, 1);
  assert.equal(unsafeForms("await import('./x/' + n)").length, 1);
  assert.equal(unsafeForms("require(path)").length, 1);
  assert.deepEqual(unsafeForms('// import(name)\n/* require(x) */'), []);
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
