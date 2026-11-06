// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// FU-STAGE (RR-6): the graph walk refuses an empty or incomplete metafile, and the source lint follows package subpath exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMetafile, checkTree } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { metafileGaps } from "../../scripts/code-oss/graph-reach.mjs";
import { rmSync } from "node:fs";
import { stage, stageableExports } from "../../scripts/code-oss/stage-packages.mjs";
import { fixture, put } from "./stage-fixture.mjs";
import { classifySpecifier } from "../../scripts/code-oss/stage-scan.mjs";
import { STAGE_ROOT } from "../../scripts/code-oss/stage-verify.mjs";

const P = (rel) => `${STAGE_ROOT}/${rel}`;
const stagedOf = (p) => (p.startsWith(`${STAGE_ROOT}/`) ? p.slice(STAGE_ROOT.length + 1) : null);
const manifest = { zod: null, files: ["daemon-host/handlers/git.ts", "daemon-host/handlers/helper.ts", "daemon-host/gate/run-trust.ts"].map((path) => ({ path })) };
const imp = (path) => ({ path, kind: "import-statement" });

test("an empty metafile is refused, whatever the manifest lists", () => {
  for (const mf of [{ inputs: {} }, {}, { inputs: null }]) {
    const found = checkMetafile(mf, manifest);
    assert.ok(found.length > 0 && found.every((v) => v.startsWith("incomplete metafile:")), JSON.stringify(mf));
  }
});

test("a metafile with no staged input is refused", () => {
  const found = checkMetafile({ inputs: { "src/vs/axis/daemon/node/axisDaemonMain.ts": { imports: [] } } }, manifest);
  assert.ok(found.some((v) => /no staged input/.test(v)), found.join("; "));
});

test("an edge to a staged module the metafile has no entry for is refused, even when the missing module would reach a minter", () => {
  const mf = { inputs: { [P("daemon-host/handlers/git.ts")]: { imports: [imp(P("daemon-host/handlers/helper.ts"))] } } }; // helper.ts has no entry
  const found = checkMetafile(mf, manifest);
  assert.ok(found.some((v) => v.includes("incomplete metafile") && v.includes("handlers/helper.ts")), found.join("; "));
  assert.deepEqual(metafileGaps({ inputs: { ...mf.inputs, [P("daemon-host/handlers/helper.ts")]: { imports: [] } } }, stagedOf), []);
});

test("an entry without an imports list is refused; externals and non-staged targets are not gaps", () => {
  assert.ok(metafileGaps({ inputs: { [P("daemon-host/handlers/git.ts")]: {} } }, stagedOf).some((g) => /no imports list/.test(g)));
  const ok = { inputs: { [P("daemon-host/handlers/git.ts")]: { imports: [{ path: "node:fs", kind: "import-statement", external: true }, imp("src/vs/base/x.ts")] } } };
  assert.deepEqual(metafileGaps(ok, stagedOf), []);
});

const keys = { journal: ["./daemon-principal", "./alias", "./other", "."], runs: [".", "./daemon-attestation"], protocol: ["."] };
const exportsOf = (n) => keys[n] ?? null;
const targets = { journal: { ".": "index", "./daemon-principal": "daemon-principal", "./alias": "daemon-principal", "./other": "other" } };
const targetOf = (n, k) => targets[n]?.[k];

test("a second export key onto a restricted file carries the restriction", () => {
  assert.throws(() => classifySpecifier("@axis/journal/alias", "protocol", exportsOf, "x.ts", targetOf), /may only be imported by: daemon/);
  assert.throws(() => classifySpecifier("@axis/journal/daemon-principal", "protocol", exportsOf, "x.ts", targetOf), /may only be imported by: daemon/);
  assert.equal(classifySpecifier("@axis/journal/alias", "daemon", exportsOf, "x.ts", targetOf).kind, "axis");
  assert.equal(classifySpecifier("@axis/journal/other", "protocol", exportsOf, "x.ts", targetOf).kind, "axis");
  assert.equal(classifySpecifier("@axis/journal", "protocol", exportsOf, "x.ts", targetOf).kind, "axis");
});

test("the file exception for the restricted subpath also applies through an alias", () => {
  assert.equal(classifySpecifier("@axis/journal/alias", "daemon-host", exportsOf, "handlers/review.ts", targetOf).kind, "axis");
  assert.throws(() => classifySpecifier("@axis/journal/alias", "daemon-host", exportsOf, "handlers/git.ts", targetOf), /may only be imported/);
});

test("removing or remapping the restricted key does not free an alias onto the restricted file", () => {
  const t = { journal: { ".": "index", "./alias": "daemon-principal" } }; // "./daemon-principal" is gone
  const ex = (n) => (n === "journal" ? ["./alias", "."] : null);
  assert.throws(() => classifySpecifier("@axis/journal/alias", "protocol", ex, "x.ts", (n, k) => t[n]?.[k]), /may only be imported by: daemon/);
  assert.equal(classifySpecifier("@axis/journal/alias", "daemon", ex, "x.ts", (n, k) => t[n]?.[k]).kind, "axis");
});

test("an alias in another package onto a file with the same stem is not restricted", () => {
  const t = { runs: { ".": "index", "./x": "daemon-principal" } };
  const ex = (n) => (n === "runs" ? ["./x", "."] : null);
  assert.equal(classifySpecifier("@axis/runs/x", "protocol", ex, "x.ts", (n, k) => t[n]?.[k]).kind, "axis");
});

const SRC = new Set(["index.ts", "a.ts", "b.ts"]);
const pj = (exp) => ({ exports: { ".": { default: "./dist/src/index.js" }, ...exp } });
test("stageableExports takes a string or { types, default } and refuses every other shape", () => {
  assert.deepEqual(stageableExports("p", pj({ "./a": "./dist/src/a.js", "./b": { types: "./dist/src/b.d.ts", default: "./dist/src/b.js" } }), SRC), { ".": "index", "./a": "a", "./b": "b" });
  assert.deepEqual(stageableExports("p", pj({ "./gone": "./dist/src/missing.js" }), SRC), { ".": "index" }, "an unstaged target stays unexported");
  const bad = [
    ["a non-default condition", { "./a": { import: "./dist/src/a.js", default: "./dist/src/b.js" } }, /condition import is not supported/],
    ["a node condition", { "./a": { node: "./dist/src/a.js", default: "./dist/src/b.js" } }, /condition node/],
    ["an array", { "./a": ["./dist/src/a.js"] }, /only a string or/],
    ["a null target", { "./a": null }, /only a string or/],
    ["no default", { "./a": { types: "./dist/src/a.d.ts" } }, /needs a string "default"/],
    ["a wildcard key", { "./*": "./dist/src/*.js" }, /pattern exports/],
    ["a key that is not a subpath", { a: "./dist/src/a.js" }, /not a subpath key/],
  ];
  for (const [name, exp, re] of bad) assert.throws(() => stageableExports("p", pj(exp), SRC), re, name);
});

/** Builds a fixture whose journal package has the given exports and whose worktrees package imports `importer`; returns the fixture and a stage runner. */
const stageWith = (journalExports, importer) => {
  const f = fixture();
  put(f.repo, "packages/journal/package.json", JSON.stringify({ name: "@axis/journal", exports: journalExports }));
  put(f.repo, "packages/journal/src/index.ts", "export const j = 1;\n");
  put(f.repo, "packages/journal/src/daemon-principal.ts", "export const userPrincipal = 1;\n");
  put(f.repo, "packages/worktrees/src/confirm.ts", `import "${importer}";\nexport const confirm = 1;\n`);
  return { base: f.base, run: () => stage({ repo: f.repo, tree: f.tree }) };
};
test("stage refuses an alias export onto a restricted file, and a condition object that hides it", () => {
  const dflt = { default: "./dist/src/index.js" };
  const cases = [
    [{ ".": dflt, "./alias": { default: "./dist/src/daemon-principal.js" } }, "@axis/journal/alias", /may only be imported by: daemon/],
    [{ ".": dflt, "./alias": { import: "./dist/src/daemon-principal.js", default: "./dist/src/index.js" } }, "@axis/journal/alias", /condition import is not supported/],
  ];
  for (const [exp, spec, re] of cases) {
    const { base, run } = stageWith(exp, spec);
    try {
      assert.throws(run, re);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("checkTree refuses a build that dropped a requested entry, and passes a complete one", async () => {
  const f = fixture();
  try {
    stage({ repo: f.repo, tree: f.tree });
    put(f.tree, "node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "1.0.0" }));
    const entry = `${STAGE_ROOT}/protocol/index.ts`;
    const build = (inputs) => async () => ({ outputFiles: [], metafile: { inputs } });
    const have = { [entry]: { imports: [] } };
    const missing = await checkTree({ tree: f.tree, entries: [entry, `${STAGE_ROOT}/worktrees/index.ts`], build: build(have) });
    assert.ok(missing.violations.some((v) => /entry .*worktrees\/index\.ts is not among its inputs/.test(v)), missing.violations.join("; "));
    const ok = await checkTree({ tree: f.tree, entries: [entry], build: build(have) });
    assert.deepEqual(ok.violations, []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
