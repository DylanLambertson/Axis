// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The checks that run on staged output and on the bundle graph (ADR 0005 D3, D4): verifyStaged, the scanners,
// and the metafile rules of check-daemon-graph.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { mangleExemptionPresent, privateNameCount, privatesSurvive } from "../../scripts/code-oss/check-privates.mjs";
import { STAGE_ROOT, stage } from "../../scripts/code-oss/stage-packages.mjs";
import { RESTRICTED_MODULES, RESTRICTED_SUBPATHS, classifySpecifier, hiddenLoaders, importSpecifiers, maskComments, nonLiteralLoads } from "../../scripts/code-oss/stage-scan.mjs";
import { checkStagedFile, sha256, treeHash, verifyStaged } from "../../scripts/code-oss/stage-verify.mjs";
import { put, withFixture } from "./stage-fixture.mjs";

const staged = (tree, rel) => join(tree, STAGE_ROOT, rel);

test("importSpecifiers sees every import form, comments included", () => {
  const src = 'import a from "zod";\nimport type { B } from "../b.js";\nexport * from "./c.js";\nexport * as d from "./d.js";\nimport "./e.js";\nimport f = require("node:fs");\nconst g = await import("electron");\n// import x from "in-comment";\n';
  assert.deepEqual(importSpecifiers(src).sort(), ["../b.js", "./c.js", "./d.js", "./e.js", "electron", "in-comment", "node:fs", "zod"]);
});

test("importSpecifiers with code:true ignores comments but keeps strings that contain //", () => {
  const src = 'import a from "zod"; // import x from "no"\n/* import "y" */ const u = "http://x"; import b from "./b.js";\nconst r = /["\']/; import c from "./c.js";\n';
  assert.deepEqual(importSpecifiers(src, { code: true }).sort(), ["./b.js", "./c.js", "zod"]);
  assert.equal(maskComments("a // b\nc").split("\n").length, 2);
});

test("nonLiteralLoads and hiddenLoaders", () => {
  assert.equal(nonLiteralLoads("await import(name)").length, 1);
  assert.equal(nonLiteralLoads('await import("zod"); require("./x.js")').length, 0);
  assert.deepEqual(hiddenLoaders("createRequire(import.meta.url); process.getBuiltinModule('x'); eval('1'); new  Function('a'); import.meta.resolve('x'); process.binding('x');").length, 6);
  assert.deepEqual(hiddenLoaders("export const x = 1;"), []);
});

test("classifySpecifier: the allowlist is relative, zod, declared @axis subpaths and node:*", () => {
  const exportsOf = (n) => ({ protocol: ["."], journal: [".", "./daemon-principal"] })[n] ?? null;
  assert.equal(classifySpecifier("./a.js", "x", exportsOf).kind, "relative");
  assert.equal(classifySpecifier("zod", "x", exportsOf).kind, "zod");
  assert.equal(classifySpecifier("node:path/posix", "x", exportsOf).kind, "node");
  assert.deepEqual(classifySpecifier("@axis/protocol", "x", exportsOf), { kind: "axis", name: "protocol", subpath: null });
  assert.equal(classifySpecifier("@axis/journal/daemon-principal", "daemon", exportsOf).subpath, "./daemon-principal");
  for (const bad of ["fs", "electron", "vs/base/common/lifecycle", "zod/v4", "node:", "node:fs;x", "@axis/", "@axis/nope", "@axis/protocol/x", "@axis/journal/daemon-principal", "@zod/x"]) {
    assert.throws(() => classifySpecifier(bad, "providers", exportsOf), (e) => typeof e === "string", bad);
  }
});

test("the restricted-module table matches test/packages/imports.test.mjs", () => {
  const text = readFileSync(new URL("../packages/imports.test.mjs", import.meta.url), "utf8");
  for (const [spec, importers] of RESTRICTED_SUBPATHS) {
    const m = new RegExp(`\\["${spec.replace(/[/]/g, "\\/")}", new Set\\(\\[([^\\]]*)\\]\\)\\]`).exec(text);
    assert.ok(m, `${spec} is no longer restricted in imports.test.mjs`);
    assert.deepEqual([...importers].sort(), m[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean).sort(), spec);
  }
  for (const r of RESTRICTED_MODULES.filter((m) => m.importers.size > 0)) assert.ok(RESTRICTED_SUBPATHS.has([...RESTRICTED_SUBPATHS.keys()].find((k) => k.startsWith(`@axis/${r.pkg}/`))), r.file);
});

test("verifyStaged accepts the hook's output and refuses each way of changing it", () => {
  const cases = [
    ["an edited file", (t) => writeFileSync(staged(t, "protocol/sub/a.ts"), "export const a = 2;\n"), /does not match the manifest/],
    ["an added file", (t) => put(t, `${STAGE_ROOT}/protocol/new.ts`, "export {};\n"), /not in the manifest/],
    ["a removed file", (t) => rmSync(staged(t, "protocol/sub/a.ts")), /missing/],
    ["a missing manifest", (t) => rmSync(staged(t, "stage-manifest.json")), /manifest/],
  ];
  for (const [name, mutate, pattern] of cases) {
    withFixture(({ repo, tree }) => {
      stage({ repo, tree });
      assert.ok(verifyStaged(tree).files.length > 0);
      mutate(tree);
      assert.throws(() => verifyStaged(tree), pattern, name);
    });
  }
});

test("the import allowlist holds on the staged files themselves, even when the manifest is forged to match", () => {
  const forged = [
    ["a bare import", 'import "electron";\n', /bare import electron/],
    ["a bare zod", 'import { z } from "zod";\n', /bare import zod/],
    ["a relative import leaving the staged tree", 'import "../../../../vs/base/common/event.js";\n', /leaves the staged tree/],
    ["a relative import to a file that is not staged", 'import "./ghost.js";\n', /does not resolve to a staged file/],
    ["a hidden loader", "eval('1');\n", /hides a load/],
    ["the principal reached by relative path from another package", 'import "../../journal/daemon-principal.js";\n', /only daemon may import/],
  ];
  for (const [name, text, pattern] of forged) {
    withFixture(({ repo, tree }) => {
      put(repo, "packages/journal/package.json", JSON.stringify({ name: "@axis/journal", exports: { ".": { default: "./dist/src/index.js" } } }));
      put(repo, "packages/journal/src/index.ts", "export const j = 1;\n");
      put(repo, "packages/journal/src/daemon-principal.ts", "export const p = 1;\n");
      stage({ repo, tree });
      const mp = staged(tree, "stage-manifest.json");
      const m = JSON.parse(readFileSync(mp, "utf8"));
      writeFileSync(staged(tree, "protocol/sub/a.ts"), text);
      m.files.find((f) => f.path === "protocol/sub/a.ts").sha256 = sha256(text);
      m.treeSha256 = treeHash(m.files);
      writeFileSync(mp, JSON.stringify(m));
      assert.throws(() => verifyStaged(tree), pattern, name);
    });
  }
});

test("checkMetafile: a clean graph passes; each violation is named", () => {
  const manifest = { zod: "4.6.6", files: ["protocol/index.ts", "daemon/index.ts", "journal/index.ts", "journal/daemon-principal.ts", "vendor/zod/index.js"].map((p) => ({ path: p })) };
  const P = (rel) => `${STAGE_ROOT}/${rel}`;
  const imp = (path, external = false) => ({ path, kind: "import-statement", ...(external ? { external: true } : {}) });
  const good = {
    inputs: {
      "src/vs/axis/daemon/node/axisDaemonMain.ts": { imports: [imp(P("protocol/index.ts"))] },
      [P("protocol/index.ts")]: { imports: [imp(P("vendor/zod/index.js")), imp("node:path", true)] },
      [P("vendor/zod/index.js")]: { imports: [] },
      [P("daemon/index.ts")]: { imports: [imp(P("journal/daemon-principal.ts"))] },
      [P("journal/index.ts")]: { imports: [imp(P("journal/daemon-principal.ts"))] },
      [P("journal/daemon-principal.ts")]: { imports: [] },
    },
  };
  const text = "var version = { major: 4, minor: 6, patch: 6 };";
  assert.deepEqual(checkMetafile(good, manifest, { bundledText: text, treeZod: "4.4.3" }), []);
  // esbuild reports an import it dropped as unused (a type-only import) as external with its relative specifier.
  good.inputs[P("protocol/index.ts")].imports.push(imp("../vendor/zod/index.js", true));
  assert.deepEqual(checkMetafile(good, manifest, { bundledText: text, treeZod: "4.4.3" }), []);
  const mutate = (fn) => {
    const m = structuredClone(good);
    fn(m.inputs);
    return m;
  };
  const cases = [
    ["a bare zod stays external", (i) => i[P("protocol/index.ts")].imports.push(imp("zod", true)), /external import "zod"/],
    ["an electron external", (i) => i[P("protocol/index.ts")].imports.push(imp("electron", true)), /external import "electron"/],
    ["the overlay importing bare zod", (i) => i["src/vs/axis/daemon/node/axisDaemonMain.ts"].imports.push(imp("zod", true)), /imports bare "zod"/],
    ["an elided relative import naming no staged file", (i) => i[P("protocol/index.ts")].imports.push(imp("./ghost.js", true)), /external import "\.\/ghost\.js"/],
    ["a staged module reaching vs/*", (i) => i[P("protocol/index.ts")].imports.push(imp("src/vs/base/common/event.ts")), /outside the staged tree/],
    ["an input from node_modules", (i) => { i["node_modules/zod/index.js"] = { imports: [] }; }, /node_modules/],
    ["an input the hook did not write", (i) => { i[P("protocol/extra.ts")] = { imports: [] }; }, /not written by the staging hook/],
    ["the overlay entry importing the principal", (i) => i["src/vs/axis/daemon/node/axisDaemonMain.ts"].imports.push(imp(P("journal/daemon-principal.ts"))), /only journal and daemon may import/],
    ["another package importing the principal", (i) => { i[P("protocol/index.ts")].imports.push(imp(P("journal/daemon-principal.ts"))); }, /only journal and daemon may import/],
  ];
  for (const [name, fn, pattern] of cases) {
    const found = checkMetafile(mutate(fn), manifest, { bundledText: text, treeZod: "4.4.3" });
    assert.ok(found.some((v) => pattern.test(v)), `${name}: ${found.join("; ")}`);
  }
  assert.ok(checkMetafile(good, manifest, { bundledText: "var v = { major: 4, minor: 4, patch: 3 };", treeZod: "4.4.3" }).some((v) => /does not contain zod 4\.6\.6/.test(v)));
  assert.ok(checkMetafile(good, manifest, { bundledText: `${text} { major: 4, minor: 4, patch: 3 }`, treeZod: "4.4.3" }).some((v) => /tree's zod 4\.4\.3/.test(v)));
});

test("checkStagedFile: vendored code cannot reach Axis code, Axis code can reach only vendor/zod, and mint holders stay private", () => {
  const set = new Set(["vendor/zod/index.js", "vendor/other/x.js", "vendor/zod/a.js", "protocol/index.ts", "journal/principal.ts", "journal/index.ts", "daemon/index.ts"]);
  assert.throws(() => checkStagedFile("vendor/zod/a.js", 'import "../../protocol/index.js";', set), /vendored code reaches/);
  assert.throws(() => checkStagedFile("vendor/zod/a.js", 'import "node:fs";', set), /vendored code imports/);
  assert.throws(() => checkStagedFile("protocol/index.ts", 'import "../vendor/other/x.js";', set), /unknown vendored module/);
  assert.throws(() => checkStagedFile("daemon/index.ts", 'import "../journal/principal.js";', set), /only .* may import/);
  checkStagedFile("journal/index.ts", 'import "./principal.js";', set);
  checkStagedFile("protocol/index.ts", 'import "../vendor/zod/index.js";', set);
});

test("checkMetafile: another package reaching a mint holder is refused", () => {
  const manifest = { zod: null, files: ["journal/principal.ts", "audit/lock.ts", "daemon/index.ts"].map((p) => ({ path: p })) };
  const P = (rel) => `${STAGE_ROOT}/${rel}`;
  const meta = { inputs: { [P("daemon/index.ts")]: { imports: [{ path: P("journal/principal.ts"), kind: "import-statement" }, { path: P("audit/lock.ts"), kind: "import-statement" }] }, [P("journal/principal.ts")]: { imports: [] }, [P("audit/lock.ts")]: { imports: [] } } };
  const found = checkMetafile(meta, manifest);
  assert.equal(found.length, 2, found.join("; "));
});

test("check-privates: counts # names on tokens, sees the exemption, and flags mangled bundles", () => {
  assert.equal(privateNameCount('class A { #x = 1; get() { return this.#x; } } const s = "#not"; // #nor\n'), 2);
  assert.equal(privateNameCount("class A { $a = 1; }"), 0);
  const upstream = "\t\t\t\tif (file.path.endsWith('.js') && doManglePrivates && !isExtensionHostBundle(file.path)) {\n";
  assert.equal(mangleExemptionPresent(upstream), false);
  const patched = "const keepAxisPrivates = file.path.replaceAll('\\\\', '/').includes('/vs/axis/');\nif (file.path.endsWith('.js') && doManglePrivates && !isExtensionHostBundle(file.path) && !keepAxisPrivates) {\n";
  assert.equal(mangleExemptionPresent(patched), true);
  assert.equal(mangleExemptionPresent(`${patched}${upstream}`), false, "a second, ungated mangle condition");
  assert.deepEqual(privatesSurvive({ file: "a.js", sourcePrivates: 3, builtText: "class A { #a = 1; }" }), []);
  assert.deepEqual(privatesSurvive({ file: "a.js", sourcePrivates: 0, builtText: "class A { $a = 1; }" }), []);
  assert.match(privatesSurvive({ file: "a.js", sourcePrivates: 3, builtText: "class A { $a = 1; }" })[0], /mangled into plain properties/);
});
