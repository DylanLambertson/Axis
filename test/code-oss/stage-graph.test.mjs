// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The checks that run on staged output and on the bundle graph (ADR 0005 D3, D4): verifyStaged, the scanners,
// and the metafile rules of check-daemon-graph.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { PROBE_MARKER, brandVerdict, restoreStaleProbe, mangleExemptionPresent, privateNameCount, privatesSurvive } from "../../scripts/code-oss/check-privates.mjs";
import { STAGE_ROOT, stage } from "../../scripts/code-oss/stage-packages.mjs";
import { RESTRICTED_FILE_EXCEPTIONS, RESTRICTED_MODULES, RESTRICTED_SUBPATHS, classifySpecifier, importSpecifiers, unsafeForms } from "../../scripts/code-oss/stage-scan.mjs";
import { checkStagedFile, sha256, treeHash, verifyStaged } from "../../scripts/code-oss/stage-verify.mjs";
import { put, withFixture } from "./stage-fixture.mjs";

const staged = (tree, rel) => join(tree, STAGE_ROOT, rel);

test("unsafeForms reports non-literal loads and nothing for a plain file", () => {
  assert.equal(unsafeForms("await import(name)").length, 1);
  assert.equal(unsafeForms('await import("zod"); require("./x.js")').length, 0);
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
    ["a hidden loader", "eval('1');\n", /eval reaches code/],
    ["a computed dynamic import", "export const m = () => import([\"z\", \"od\"].join(\"\"));\n", /import\(\) needs a single string literal/],
    ["node:vm", "import \"node:vm\";\n", /loads or runs code|not allowed in the protocol/],
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
  assert.ok(found.every((m) => !/\s{2}/.test(m)), `no double spaces: ${found.join("; ")}`);
  assert.match(found[0], /which only journal may import$/);
});

test("check-staged heals a probe left in the daemon entry by a killed run before any check reads it", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-heal-"));
  try {
    const entry = join(dir, "src/vs/axis/daemon/node/axisDaemonMain.ts");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, `// ${PROBE_MARKER} (leftover)\nexport const probe = 1;\n`);
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/code-oss/check-staged.mjs", import.meta.url)), "--tree", dir], { encoding: "utf8" });
    assert.equal(r.status, 1, "there is nothing staged in the scratch tree, so the run still fails");
    assert.match(r.stdout, /^0\. restored the daemon entry/);
    const overlay = readFileSync(new URL("../../code-oss/overlay/src/vs/axis/daemon/node/axisDaemonMain.ts", import.meta.url), "utf8");
    assert.equal(readFileSync(entry, "utf8"), overlay);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

const GOOD_PROBE = { attestationOwnKeys: 0, realPrincipal: true, handWritten: false, cloned: false, copied: false, ownKeys: 0, realAttestation: true, attestationHandWritten: false, attestationCloned: false, first: null, second: "ATTESTATION_USED" };

test("brandVerdict accepts a probe whose forgeries are all rejected", () => {
  assert.deepEqual(brandVerdict(GOOD_PROBE), []);
});

test("brandVerdict fails on each accepted forgery, an exposed key, a reset single-use flag and a missing result", () => {
  for (const key of ["handWritten", "cloned", "copied", "attestationHandWritten", "attestationCloned"]) {
    assert.match(brandVerdict({ ...GOOD_PROBE, [key]: true })[0], new RegExp(`${key} is true`));
  }
  assert.match(brandVerdict({ ...GOOD_PROBE, ownKeys: 1 })[0], /ownKeys is 1/);
  assert.match(brandVerdict({ ...GOOD_PROBE, second: null })[0], /second is null/);
  assert.match(brandVerdict({ ...GOOD_PROBE, realPrincipal: false })[0], /realPrincipal/);
  assert.match(brandVerdict({ ...GOOD_PROBE, attestationOwnKeys: 2 })[0], /attestationOwnKeys is 2/);
  assert.equal(brandVerdict(null).length, 11);
});

test("the committed brand probe imports the brand classes and mints through the daemon-only modules", () => {
  const text = readFileSync(new URL("../../scripts/code-oss/brand-probe.ts", import.meta.url), "utf8");
  for (const want of ["journal/principal.js", "journal/daemon-principal.js", "runs/attestation.js", "runs/daemon-attestation.js", "structuredClone", "UserPrincipal.is", "TrustAttestation.is"]) assert.ok(text.includes(want), want);
  for (const key of Object.keys(GOOD_PROBE)) assert.ok(new RegExp(`\\b${key}\\b`).test(text), `probe reports ${key}`);
});

test("restoreStaleProbe puts the overlay entry back over a leftover probe, and leaves a real entry alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-probe-"));
  try {
    const entry = join(dir, "entry.ts");
    const overlay = join(dir, "overlay.ts");
    writeFileSync(overlay, "export const real = 1;\n");
    writeFileSync(entry, `// ${PROBE_MARKER} (x)\nexport const probe = 1;\n`);
    assert.equal(restoreStaleProbe(entry, overlay), true);
    assert.equal(readFileSync(entry, "utf8"), "export const real = 1;\n");
    assert.equal(restoreStaleProbe(entry, overlay), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed probe carries the marker the stale-probe guard looks for, and tries to reset the single-use flag", () => {
  const text = readFileSync(new URL("../../scripts/code-oss/brand-probe.ts", import.meta.url), "utf8");
  assert.ok(text.includes(PROBE_MARKER));
  assert.match(text, /typeof holder\[key\] === 'boolean'/);
});

test("checkStagedFile alone (the re-check) refuses unsafe forms, loader built-ins and the protocol node ban", () => {
  const files = new Set(["protocol/a.ts", "other/a.ts", "vendor/zod/index.js"]);
  assert.throws(() => checkStagedFile("protocol/a.ts", "export const m = () => import(name);\n", files), /^StageError: staged protocol\/a\.ts: .*import\(\) needs/);
  assert.throws(() => checkStagedFile("protocol/a.ts", "eval('1');\n", files), /staged protocol\/a\.ts: .*eval reaches code/);
  assert.throws(() => checkStagedFile("other/a.ts", 'import "node:vm";\n', files), /staged other\/a\.ts: node:vm loads or runs code/);
  assert.throws(() => checkStagedFile("protocol/a.ts", 'import "node:path";\n', files), /node:\* is not allowed in the protocol package/);
  assert.throws(() => checkStagedFile("other/a.ts", 'export { userPrincipal } from "../journal/daemon-principal.js";\n', new Set([...files, "journal/daemon-principal.ts"])), /mint module/);
  assert.throws(() => checkStagedFile("vendor/zod/index.js", "export const z = () => import(name);\n", files), /import\(\) needs/);
  checkStagedFile("vendor/zod/index.js", 'export const f = new Function("a", "return a");\n', files); // pinned third-party code
  checkStagedFile("other/a.ts", 'import { join } from "node:path";\nexport const j = join;\n', files);
});

test("the daemon host's review handler is the one exact file outside the daemon that may import the principal subpath", () => {
  const exportsOf = (n) => ({ journal: [".", "./daemon-principal"] })[n] ?? null;
  const spec = "@axis/journal/daemon-principal";
  assert.equal(classifySpecifier(spec, "daemon-host", exportsOf, "handlers/review.ts").kind, "axis");
  for (const file of ["handlers/other.ts", "handlers/review.tsx", "handlers/sub/review.ts", "handlers/Review.ts", "Handlers/review.ts", "review.ts", null]) {
    assert.throws(() => classifySpecifier(spec, "daemon-host", exportsOf, file), (e) => typeof e === "string", String(file));
  }
  assert.throws(() => classifySpecifier(spec, "providers", exportsOf, "handlers/review.ts"), (e) => typeof e === "string");
  assert.deepEqual([...RESTRICTED_FILE_EXCEPTIONS.get(spec).get("daemon-host")], ["handlers/review.ts"]);
  const text = readFileSync(new URL("../packages/imports.test.mjs", import.meta.url), "utf8");
  assert.ok(text.includes('["@axis/journal/daemon-principal", ["src/handlers/review.ts"]]'), "matches HOST_FILE_RULES");
});

test("checkMetafile and checkStagedFile allow the review handler to reach the principal module, and no other daemon-host file", () => {
  const P = (rel) => `${STAGE_ROOT}/${rel}`;
  const manifest = { zod: null, files: ["journal/daemon-principal.ts", "daemon-host/handlers/review.ts", "daemon-host/handlers/x.ts"].map((p) => ({ path: p })) };
  const meta = (from) => ({ inputs: { [P(from)]: { imports: [{ path: P("journal/daemon-principal.ts"), kind: "import-statement" }] }, [P("journal/daemon-principal.ts")]: { imports: [] } } });
  assert.deepEqual(checkMetafile(meta("daemon-host/handlers/review.ts"), manifest), []);
  assert.equal(checkMetafile(meta("daemon-host/handlers/x.ts"), manifest).length, 1);
  const files = new Set(manifest.files.map((f) => f.path));
  checkStagedFile("daemon-host/handlers/review.ts", 'import { userPrincipal } from "../../journal/daemon-principal.js";\nexport const u = () => userPrincipal();\n', files);
  assert.throws(() => checkStagedFile("daemon-host/handlers/x.ts", 'import "../../journal/daemon-principal.js";\n', files), /only daemon may import/);
});

test("the daemon host's run trust minter is the one exact file outside the daemon that may import the attestation subpath", () => {
  const exportsOf = (n) => ({ runs: [".", "./daemon-attestation"] })[n] ?? null;
  const spec = "@axis/runs/daemon-attestation";
  assert.equal(classifySpecifier(spec, "daemon-host", exportsOf, "gate/run-trust.ts").kind, "axis");
  for (const file of ["gate/other.ts", "gate/run-trust.tsx", "gate/sub/run-trust.ts", "bindings/runs.ts", "handlers/cli-runs.ts", "run-trust.ts", null]) {
    assert.throws(() => classifySpecifier(spec, "daemon-host", exportsOf, file), (e) => typeof e === "string", String(file));
  }
  assert.throws(() => classifySpecifier(spec, "providers", exportsOf, "gate/run-trust.ts"), (e) => typeof e === "string");
  assert.deepEqual([...RESTRICTED_FILE_EXCEPTIONS.get(spec).get("daemon-host")], ["gate/run-trust.ts"]);
  const text = readFileSync(new URL("../packages/imports.test.mjs", import.meta.url), "utf8");
  assert.ok(text.includes('["@axis/runs/daemon-attestation", ["src/gate/run-trust.ts"]]'), "matches HOST_FILE_RULES");
  const P = (rel) => `${STAGE_ROOT}/${rel}`;
  const manifest = { zod: null, files: ["runs/daemon-attestation.ts", "daemon-host/gate/run-trust.ts", "daemon-host/bindings/runs.ts"].map((p) => ({ path: p })) };
  const meta = (from) => ({ inputs: { [P(from)]: { imports: [{ path: P("runs/daemon-attestation.ts"), kind: "import-statement" }] }, [P("runs/daemon-attestation.ts")]: { imports: [] } } });
  assert.deepEqual(checkMetafile(meta("daemon-host/gate/run-trust.ts"), manifest), []);
  assert.equal(checkMetafile(meta("daemon-host/bindings/runs.ts"), manifest).length, 1);
});

test("the host's run trust minter module is loadable only by the host's public index, not by its own package's other files", () => {
  const P = (rel) => `${STAGE_ROOT}/${rel}`;
  const manifest = { zod: null, files: ["daemon-host/gate/run-trust.ts", "daemon-host/index.ts", "daemon-host/handlers/cli-runs.ts", "daemon-host/bindings/runs.ts"].map((p) => ({ path: p })) };
  const meta = (from) => ({ inputs: { [P(from)]: { imports: [{ path: P("daemon-host/gate/run-trust.ts"), kind: "import-statement" }] }, [P("daemon-host/gate/run-trust.ts")]: { imports: [] } } });
  assert.deepEqual(checkMetafile(meta("daemon-host/index.ts"), manifest), []);
  for (const from of ["daemon-host/handlers/cli-runs.ts", "daemon-host/bindings/runs.ts"]) assert.equal(checkMetafile(meta(from), manifest).length, 1, from);
  const files = new Set(manifest.files.map((f) => f.path));
  checkStagedFile("daemon-host/index.ts", 'export * from "./gate/run-trust.js";\n', files);
  assert.throws(() => checkStagedFile("daemon-host/handlers/cli-runs.ts", 'import "../gate/run-trust.js";\n', files), /run-trust/);
});
