// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// One test per rule of the module scanner (scripts/code-oss/stage-ast.mjs): removing any rule fails one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importSpecifiers, nonLiteralLoads, rewriteSpecifiers, scanModules } from "../../scripts/code-oss/stage-ast.mjs";

const specs = (src, file) => importSpecifiers(src, file).sort();
const bad = (src, file) => nonLiteralLoads(src, file);

test("every import form names its specifier", () => {
  assert.deepEqual(specs('import a from "a";'), ["a"]);
  assert.deepEqual(specs('import type { B } from "b";'), ["b"]);
  assert.deepEqual(specs('import "c";'), ["c"]);
  assert.deepEqual(specs('export * from "d";'), ["d"]);
  assert.deepEqual(specs('export * as n from "e";'), ["e"]);
  assert.deepEqual(specs('export { x } from "f";'), ["f"]);
  assert.deepEqual(specs('export { "x" as y } from "g";'), ["g"]);
  assert.deepEqual(specs('import { "x" as y } from "h";'), ["h"]);
  assert.deepEqual(specs('import i = require("i");'), ["i"]);
  assert.deepEqual(specs('const j = await import("j");'), ["j"]);
  assert.deepEqual(specs('const k = require("k");'), ["k"]);
  assert.deepEqual(specs('export type T = import("l").X;'), ["l"]);
  assert.deepEqual(specs("const m = await import(`m`);"), ["m"]);
  assert.deepEqual(specs('const n = await import("n", { with: { type: "json" } });'), ["n"]);
});

test("a specifier is its decoded value, so escapes cannot hide it", () => {
  assert.deepEqual(specs('import "\\x65lectron";'), ["electron"]);
});

test("comments, strings and regular expressions are not code", () => {
  assert.deepEqual(specs('// import x from "no"\n/* export * from "no2" */ const s = "import y from \\"no3\\""; const r = /import "no4"/;'), []);
});

test("a slash after ), } or a keyword does not desynchronise the scan (the reviewed bypasses)", () => {
  assert.deepEqual(specs(`if (Date.now() < 0) /'/.test(""); export { "z" as zTree } from "zod";`), ["zod"]);
  assert.deepEqual(specs(`export function f(): void {} /'/.test(""); export * from "zod";`), ["zod"]);
  assert.deepEqual(specs(`export default /'/.test(""); export * from "electron";`), ["electron"]);
  assert.deepEqual(specs("const t = `${`}`}'`; export * from \"electron\";"), ["electron"]);
  assert.deepEqual(specs('export const a = "/*"; export * from "zod"; export const b = "*/";'), ["zod"]);
  assert.deepEqual(specs('export { z } from/* y */"zod";'), ["zod"]);
  assert.deepEqual(specs(`const x = (a) / 2; import { y } from "./y.js";`), ["./y.js"]);
});

test("the reviewed computed dynamic import is reported", () => {
  const src = `export const probeOpen = "/*"; export function probeBlock(): void {} /'/.test(""); export const probeLoad = (): Promise<unknown> => import(/* x */["z", "od"].join("")); export const probeClose = "*/";`;
  assert.equal(bad(src).length, 1);
  assert.match(bad(src)[0], /import\(\) needs a single string literal/);
});

test("import() with a variable, a concatenation or a template substitution is reported", () => {
  assert.equal(bad("import(name)").length, 1);
  assert.equal(bad('import("a" + "b")').length, 1);
  assert.equal(bad("import(`./${n}.js`)").length, 1);
  assert.equal(bad("import()").length, 1);
  assert.equal(bad('import("a", {}, 3)').length, 1);
});

test("require() with a non-literal or extra argument is reported", () => {
  assert.equal(bad("require(name)").length, 1);
  assert.equal(bad('require("a" + "b")').length, 1);
  assert.equal(bad('require("a", "b")').length, 1);
});

test("require used as a value is reported, require as a property or method name is not", () => {
  assert.match(bad("const r = require;")[0], /require used as a value/);
  assert.match(bad('export const m = [require].map((r) => r("fs"));')[0], /require used as a value/);
  assert.deepEqual(bad("const o = { require: 1 }; o.require; class C { require() {} }; interface I { require: number }"), []);
});

test("import.meta is allowed only as .url, .dirname and .filename", () => {
  assert.deepEqual(bad("const u = import.meta.url; const d = import.meta.dirname; const f = import.meta.filename;"), []);
  assert.match(bad('import.meta.resolve("x")')[0], /import\.meta can reach modules/);
  assert.match(bad('(import.meta as any)["resolve"]("x")')[0], /import\.meta can reach modules/);
  assert.match(bad("const m = import.meta;")[0], /import\.meta can reach modules/);
});

test("triple-slash and AMD directives are reported", () => {
  assert.match(bad('/// <reference path="./x.ts" />\nexport {};')[0], /directive/);
  assert.match(bad('/// <reference types="node" />\nexport {};')[0], /directive/);
  assert.match(bad('/// <reference lib="dom" />\nexport {};')[0], /directive/);
  assert.match(bad('/// <amd-dependency path="x" />\nexport {};')[0], /directive/);
});

test("a syntax error is reported, never silently accepted", () => {
  assert.match(bad("export const = ;")[0], /syntax error/);
});

test("a clean file reports nothing", () => {
  assert.deepEqual(bad('import { a } from "./a.js";\nexport const b = await import("./b.js");\nexport const c = require("./c.js");'), []);
});

test("the file extension selects the grammar (JavaScript for .js)", () => {
  assert.deepEqual(specs('import a from "a"; export const x = a;', "m.js"), ["a"]);
  assert.deepEqual(bad("const x = <T>(v) => v;", "m.js").length > 0, true);
});

test("refs carry the offsets of the text between the quotes, in source order", () => {
  const src = 'import a from "aa";\nexport * from "bb";';
  const r = scanModules(src).refs.sort((x, y) => x.start - y.start);
  assert.deepEqual(r.map((x) => src.slice(x.start, x.end)), ["aa", "bb"]);
});

test("rewriteSpecifiers rewrites every form, leaves comments and unresolved specifiers alone", () => {
  const src = 'import a from "zod";\n// import "zod";\nexport * from "@axis/p";\nconst b = import("zod");\nimport "./keep.js";\n';
  const out = rewriteSpecifiers(src, "src/vs/axis/packages/w/sub/f.ts", (s) => (s === "zod" ? "src/vs/axis/packages/vendor/zod/index.js" : s === "@axis/p" ? "src/vs/axis/packages/p/index.js" : null));
  assert.equal(out, 'import a from "../../vendor/zod/index.js";\n// import "zod";\nexport * from "../../p/index.js";\nconst b = import("../../vendor/zod/index.js");\nimport "./keep.js";\n');
});
