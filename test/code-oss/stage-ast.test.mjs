// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// One test per rule of the module scanner (scripts/code-oss/stage-ast.mjs): removing any rule fails one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importSpecifiers, unsafeForms, rewriteSpecifiers, scanModules } from "../../scripts/code-oss/stage-ast.mjs";

const specs = (src, file) => importSpecifiers(src, file).sort();
const bad = (src, file) => unsafeForms(src, file);

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

// ---- hidden names, Function constructors and mint re-exports, found on the syntax tree ----

const MINT = '"@axis/journal/daemon-principal"';

test("hidden loader names are found as identifiers, property names, string keys and escaped identifiers", () => {
  for (const name of ["createRequire", "getBuiltinModule", "dlopen", "eval", "mainModule", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"]) {
    assert.equal(bad(`const x = ${name};`).length, 1, `identifier ${name}`);
    assert.equal(bad(`o.${name}("x");`).length, 1, `property ${name}`);
    assert.equal(bad(`o["${name}"]("x");`).length, 1, `string key ${name}`);
    assert.equal(bad(`o[\`${name}\`]("x");`).length, 1, `template key ${name}`);
  }
  assert.equal(bad("const e = \\u0065val; e(1);").length, 1, "unicode-escaped identifier");
  assert.equal(bad('o["\\u0065val"](1);').length, 1, "unicode-escaped string key");
});

test("a mention in a comment or an unrelated string is not a loader", () => {
  assert.deepEqual(bad('// createRequire eval\n/* getBuiltinModule */ const s = "createRequire"; const requireX = 1; const created = 2;'), []);
});

test("the Function constructor is refused, the Function type is not", () => {
  assert.equal(bad('Function("return 1")();').length, 1);
  assert.equal(bad('new Function("return 1");').length, 1);
  assert.equal(bad('globalThis["Function"]("x");').length >= 1, true);
  assert.deepEqual(bad("export const f: Function = () => 1; export type G = Function;"), []);
});

test(".constructor is refused where it builds code and allowed for ordinary reflection", () => {
  assert.equal(bad('(() => {}).constructor("return 1")();').length >= 1, true);
  assert.equal(bad('(async function () {}).constructor("x");').length >= 1, true);
  assert.equal(bad('const f = () => 1; f.constructor("x");').length >= 1, true);
  assert.equal(bad('x.constructor.constructor("x");').length >= 1, true);
  assert.equal(bad('x["constructor"]["constructor"]("x");').length >= 1, true);
  assert.deepEqual(bad("const n = err.constructor.name; extra.constructor = 5; class C { constructor() {} }"), []);
});

test("process.binding, module.require and friends are refused", () => {
  assert.equal(bad('process.binding("fs");').length, 1);
  assert.equal(bad('process["binding"]("fs");').length, 1);
  assert.equal(bad('module.require("fs");').length, 1);
  assert.equal(bad('module["constructor"]._load("fs");').length >= 1, true);
  assert.deepEqual(bad("const binding = 1; o.binding; module.exports;"), []);
});

test("element access with a computed key on process, globalThis, global and module is refused", () => {
  for (const base of ["process", "globalThis", "global", "module"]) {
    assert.match(bad(`${base}[k]("x");`)[0], /computed key/, base);
    assert.equal(bad(`${base}["ev" + "al"]("x");`).length >= 1, true, base);
  }
  assert.deepEqual(bad('const a = other[k]; const b = process["env"]; const c = globalThis["x"];'), []);
});

test("vendored mode keeps the module-loading rules and skips the hidden-name rules", () => {
  const code = 'const f = new Function("a", "return a"); const c = f.constructor;';
  assert.equal(bad(code).length >= 1, true);
  assert.deepEqual(unsafeForms(code, "z.js", { vendored: true }), []);
  assert.equal(unsafeForms("import(name)", "z.js", { vendored: true }).length, 1);
  assert.equal(unsafeForms("export const = ;", "z.js", { vendored: true }).length >= 1, true);
});

test("re-exporting a mint module is refused in every form, whatever the comments and strings around it", () => {
  const forms = [
    `export { userPrincipal } from ${MINT};`,
    `export * from ${MINT};`,
    `export * as p from ${MINT};`,
    `export { userPrincipal as mint } from ${MINT};`,
    `export type { UserPrincipal } from ${MINT};`,
    `export { attestTrust } from "@axis/runs/daemon-attestation";`,
    `export { userPrincipal } from "./daemon-principal.js";`,
    `import { userPrincipal } from ${MINT};\nexport { userPrincipal };`,
    `import { userPrincipal as mint } from ${MINT};\nexport { a, mint as other, b };`,
    `import * as ns from ${MINT};\nexport { ns };`,
    `import d from ${MINT};\nexport default d;`,
    `import { userPrincipal } from ${MINT};\nexport const mint = userPrincipal;`,
    `import { userPrincipal } from ${MINT};\nexport const bag = { mint: userPrincipal };`,
    `import { userPrincipal } from ${MINT};\nexport const principal = userPrincipal();`,
    `import { userPrincipal } from ${MINT};\nexport default userPrincipal;`,
    `import p = require(${MINT});\nexport { p };`,
    `export import p = require(${MINT});`,
    `export const loaded = await import(${MINT});`,
    `export default await import(${MINT});`,
  ];
  for (const f of forms) {
    assert.equal(bad(f).filter((m) => /mint module/.test(m)).length >= 1, true, f);
    // The reviewed bypass: two strings that look like comment delimiters around the line.
    const hidden = `export const probeOpen = "/*";\n${f}\nexport const probeClose = "*/";`;
    assert.equal(bad(hidden).filter((m) => /mint module/.test(m)).length >= 1, true, hidden);
  }
});

test("using a mint module without exporting it is allowed", () => {
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nexport function connect() { return userPrincipal(); }`), []);
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nexport const connect = () => userPrincipal();`), []);
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nconst p = userPrincipal();\nexport function use() { return p; }`), []);
  assert.deepEqual(bad('export { userPrincipal } from "./other.js";'), []);
  assert.deepEqual(bad(`// export * from ${MINT};\n/* import { a } from ${MINT}; export { a }; */`), []);
});
