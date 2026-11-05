// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// One test per rule of the module scanner (scripts/code-oss/stage-ast.mjs): removing any rule fails one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importSpecifiers, unsafeForms, rewriteSpecifiers, scanModules } from "../../scripts/code-oss/stage-ast.mjs";

const specs = (src, file) => importSpecifiers(src, file).sort();
const bad = (src, file, opts) => unsafeForms(src, file, opts);

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
  assert.deepEqual(bad("const binding = 1; o.binding; o.module; const x = { module: 1, process: 2 };"), []);
  assert.match(bad("module.exports = 1;")[0], /module used other than/);
  assert.match(bad('process._linkedBinding("x");')[0], /process used other than/);
});

test("element access with a computed key on process, globalThis, global and module is refused", () => {
  for (const base of ["process", "globalThis", "global", "module"]) {
    assert.match(bad(`${base}[k]("x");`)[0], /computed key/, base);
    assert.equal(bad(`${base}["ev" + "al"]("x");`).length >= 1, true, base);
  }
  assert.deepEqual(bad('const a = other[k]; const b = process["env"]; const c = globalThis["fetch"];'), []);
  assert.match(bad('const c = globalThis["x"];')[0], /globalThis used other than/);
});

test("vendored mode keeps the module-loading rules and skips the hidden-name rules", () => {
  const code = 'const f = new Function("a", "return a"); const c = f.constructor;';
  assert.equal(bad(code).length >= 1, true);
  assert.deepEqual(unsafeForms(code, "z.js", { vendored: true }), []);
  assert.equal(unsafeForms("import(name)", "z.js", { vendored: true }).length, 1);
  assert.equal(unsafeForms("export const = ;", "z.js", { vendored: true }).length >= 1, true);
});

test("a mint function may only be called: every way of keeping, passing or exporting it is refused", () => {
  const imp = `import { userPrincipal } from ${MINT};\n`;
  const forms = [
    `export { userPrincipal } from ${MINT};`,
    `export * from ${MINT};`,
    `export * as p from ${MINT};`,
    `export { userPrincipal as mint } from ${MINT};`,
    `export type { UserPrincipal } from ${MINT};`,
    `export { attestTrust } from "@axis/runs/daemon-attestation";`,
    `export { userPrincipal } from "./daemon-principal.js";`,
    `${imp}export { userPrincipal };`,
    `${imp}export { userPrincipal as mint };`,
    `${imp}const p = userPrincipal;\nexport { p };`,
    `${imp}const p = userPrincipal;\nexport const q = () => p();`,
    `${imp}export const mint = userPrincipal;`,
    `${imp}export const bag = { mint: userPrincipal };`,
    `${imp}export const bag = { userPrincipal };`,
    `${imp}export const list = [userPrincipal];`,
    `${imp}export const list = [...[userPrincipal]];`,
    `${imp}export default userPrincipal;`,
    `${imp}export class K { static f = userPrincipal; }`,
    `${imp}export function get() { return userPrincipal; }`,
    `${imp}export const get = () => userPrincipal;`,
    `${imp}export function pass(f: (g: unknown) => void) { f(userPrincipal); }`,
    `${imp}export function viaBind() { return userPrincipal.bind(null); }`,
    `${imp}export function viaCall() { return userPrincipal.call(null); }`,
    `${imp}export function viaIndex() { return (userPrincipal as any)["name"]; }`,
    `${imp}export const { name } = { name: userPrincipal };`,
    `import * as ns from ${MINT};\nexport { ns };`,
    `import * as ns from ${MINT};\nexport const f = ns.userPrincipal;`,
    `import * as ns from ${MINT};\nexport import p = ns.userPrincipal;`,
    `import * as ns from ${MINT};\nexport const all = ns;`,
    `import * as ns from ${MINT};\nexport const keys = Object.keys(ns);`,
    `import d from ${MINT};\nexport default d;`,
    `import p = require(${MINT});\nexport { p };`,
    `export import p = require(${MINT});`,
    `export const loaded = await import(${MINT});`,
    `export default await import(${MINT});`,
    `const r = require(${MINT});`,
    `import { mintUserPrincipal } from "./principal.js";\nexport { mintUserPrincipal };`,
    `export { mintUserPrincipal } from "./principal.js";`,
    `export { mintTrustAttestation as m } from "./attestation.js";`,
    `import { mintTrustAttestation } from "./attestation.js";\nexport const f = mintTrustAttestation;`,
  ];
  for (const f of forms) {
    assert.equal(bad(f).length >= 1, true, f);
    // The reviewed bypass: two strings that look like comment delimiters around the line.
    const hidden = `export const probeOpen = "/*";\n${f}\nexport const probeClose = "*/";`;
    assert.equal(bad(hidden).length >= 1, true, hidden);
  }
});

test("the raw mint symbol is never imported or exported, in any form", () => {
  for (const f of ["export const MINT = Symbol('x');", "const MINT = Symbol('x'); export { MINT };", "const K = Symbol('x'); export { K as MINT };", 'export { MINT } from "./principal.js";', 'import { MINT } from "./principal.js";', 'import { MINT as m } from "./principal.js";', "export function MINT() {}", "export class MINT {}"]) {
    assert.equal(bad(f).length >= 1, true, f);
  }
  assert.deepEqual(bad("const MINT = Symbol('x'); export function mintIt() { return new Thing(MINT); }"), []);
});

test("export * from a module that holds a mint symbol is refused in the holder packages, not in others", () => {
  for (const spec of ["./principal.js", "./attestation.js", "./lock.js", "../x/principal.js"]) {
    assert.equal(bad(`export * from "${spec}";`, "x.ts", { pkg: "journal" }).length, 1, spec);
    assert.equal(bad(`export * as ns from "${spec}";`, "x.ts", { pkg: "runs" }).length, 1, spec);
    assert.equal(bad(`export * from "${spec}";`).length, 1, `${spec} (unknown package is judged strictly)`);
    assert.deepEqual(bad(`export * from "${spec}";`, "x.ts", { pkg: "daemon-host" }), [], spec);
  }
  assert.deepEqual(bad('export { TrustAttestation } from "./attestation.js";', "x.ts", { pkg: "runs" }), []);
});

test("the cross-file chain is closed because every file obeys the same rules", () => {
  const holder = "const MINT = Symbol('x'); export class P { constructor(m: symbol) {} } export function mintP(): P { return new P(MINT); }";
  assert.deepEqual(bad(holder), [], "the holder is fine");
  // Step 1 leaks the symbol through an intermediate file; step 2 re-exports through the index.
  assert.equal(bad('export { MINT } from "./principal.js";').length >= 1, true);
  assert.equal(bad('export * from "./principal.js";').length >= 1, true);
  assert.equal(bad('import { MINT } from "./principal.js"; export const leak = MINT;').length >= 1, true);
  assert.equal(bad('import { mintUserPrincipal } from "./principal.js"; export const leak = mintUserPrincipal;').length >= 1, true);
  assert.equal(bad('import { userPrincipal } from "@axis/journal/daemon-principal"; export const leak = { userPrincipal };').length >= 1, true);
});

test("legitimate uses of a mint function and of mint types pass", () => {
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nexport function connect() { return userPrincipal(); }`), []);
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nexport const connect = () => userPrincipal();`), []);
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nconst p = userPrincipal();\nexport function use() { return p; }`), []);
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nexport const principal = userPrincipal();`), []);
  assert.deepEqual(bad(`import * as ns from ${MINT};\nexport const p = ns.userPrincipal();`), []);
  assert.deepEqual(bad(`import type { UserPrincipal } from ${MINT};\nexport function f(p: UserPrincipal): UserPrincipal { return p; }`), []);
  assert.deepEqual(bad(`import { userPrincipal } from ${MINT};\nexport type Make = typeof userPrincipal;`), []);
  assert.deepEqual(bad(`import { mintUserPrincipal, type UserPrincipal } from "./principal.js";\nexport function userPrincipal(): UserPrincipal { return mintUserPrincipal(); }`), []);
  assert.deepEqual(bad('export { userPrincipal } from "./other.js";'), []);
  assert.deepEqual(bad(`// export * from ${MINT};\n/* import { a } from ${MINT}; export { a }; */`), []);
});

test("test files (shipped: false) may introspect a mint module, but never re-export or import the raw symbol", () => {
  const t = { shipped: false };
  assert.deepEqual(bad(`import * as ns from ${MINT};\nexport const keys = Object.keys(ns);`, "x.test.ts", t), []);
  assert.equal(bad(`export * from ${MINT};`, "x.test.ts", t).length, 1);
  assert.equal(bad('import { MINT } from "./principal.js";', "x.test.ts", t).length, 1);
});

test("process, globalThis and global: only a direct read of a listed property is allowed, aliases and casts are not", () => {
  for (const f of ["const g = globalThis;", "const p = process;", "const g = global;", "f(process);", "return process;", "const { env } = process;", "const g = (globalThis as any);", "const k = (process as any)[name];", "(globalThis as any)[k]();", "(<any>process)[k];", "(0, process)[k];", "const x = [process];", "const o = { p: process };", "const s = globalThis ?? other;", "process.binding('fs');", "process._linkedBinding('x');", "process.mainModule;", "process.dlopen(m, f);", "globalThis.Function('x');", "globalThis.process;"]) {
    assert.equal(bad(f).length >= 1, true, f);
  }
  for (const f of ["process.platform;", "process.env.HOME;", 'process["env"].HOME;', "process.on('exit', f);", "globalThis.fetch(u);", "global.setTimeout(f, 1);", "typeof process !== 'undefined';", "type T = typeof process;", "const o = { process: 1 }; o.process;", "function f(process: number) { return 1; }"]) {
    const found = bad(f).filter((m) => !/Function constructor/.test(m));
    assert.deepEqual(f.startsWith("function f(process") ? [] : found, [], f);
  }
});

test(".constructor is refused as a read, destructuring and aliasing; .constructor.name and writes are allowed", () => {
  for (const f of ["const C = f.constructor;", "const { constructor: C } = f;", "const { constructor } = f;", "const C = f['constructor'];", "g(f.constructor);", "return f.constructor;", "const c = (f as any).constructor; c('x');", "(0, f.constructor)('x');"]) {
    assert.equal(bad(f).length >= 1, true, f);
  }
  assert.deepEqual(bad("const n = err.constructor.name; extra.constructor = 5; class C { constructor() {} }"), []);
  assert.deepEqual(bad("const C = f.constructor;", "x.test.ts", { shipped: false }), [], "test files are not shipped");
});

test("only MessageChannel and MessagePort may be imported from node:worker_threads", () => {
  for (const f of ['import { Worker } from "node:worker_threads";', 'import * as w from "node:worker_threads";', 'import w from "node:worker_threads";', 'import { MessageChannel, Worker } from "node:worker_threads";', 'import { Worker as W } from "node:worker_threads";']) {
    assert.match(bad(f)[0], /only MessageChannel and MessagePort/, f);
  }
  assert.deepEqual(bad('import { MessageChannel, type MessagePort } from "node:worker_threads";'), []);
  assert.deepEqual(bad('import type { MessagePort } from "node:worker_threads";'), []);
  assert.deepEqual(bad('import { Worker } from "node:worker_threads";', "x.ts", { shipped: false }), []);
});
