// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// FU-STAGE (RR-6): the graph walk refuses an empty or incomplete metafile, and the source lint follows package subpath exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { metafileGaps } from "../../scripts/code-oss/graph-reach.mjs";
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
