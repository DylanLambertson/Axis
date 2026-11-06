// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The host minters may be reached only from the composition points: the barrel hop (a handler importing the public index, which
// re-exports the composition and so the minters) and chains of helpers are refused on the esbuild metafile and on the staged files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { minterReachViolations } from "../../scripts/code-oss/graph-reach.mjs";
import { RESTRICTED_MODULES, mayImportRestricted } from "../../scripts/code-oss/stage-scan.mjs";
import { STAGE_ROOT, checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";

const P = (rel) => `${STAGE_ROOT}/${rel}`;
const ENTRY = "src/vs/axis/daemon/node/axisDaemonMain.ts";
const stagedOf = (p) => (p.startsWith(`${STAGE_ROOT}/`) ? p.slice(STAGE_ROOT.length + 1) : null);
const FILES = ["index.ts", "compose.ts", "compose-parts.ts", "gate/run-trust.ts", "gate/worktrees-confirm.ts", "handlers/git.ts", "handlers/helper.ts"].map((f) => `daemon-host/${f}`);
const manifest = { zod: null, files: FILES.map((path) => ({ path })) };
/** A metafile of the given edges (importer -> targets); an importer starting with "src/" is outside the staged tree. */
const graph = (edges) => {
  const inputs = {};
  const at = (f) => (f.startsWith("src/") ? f : P(f));
  for (const [from, targets] of Object.entries(edges)) {
    inputs[at(from)] ??= { imports: [] };
    for (const t of targets) {
      inputs[at(from)].imports.push({ path: at(t), kind: "import-statement" });
      inputs[at(t)] ??= { imports: [] };
    }
  }
  return { inputs };
};
const D = (f) => `daemon-host/${f}`;
/** The real shape: the overlay entry loads the index, which loads the composition root, which loads minters and handlers. */
const GOOD = {
  [ENTRY]: [D("index.ts")],
  [D("index.ts")]: [D("compose.ts"), D("gate/run-trust.ts"), D("gate/worktrees-confirm.ts"), D("handlers/git.ts")],
  [D("compose.ts")]: [D("gate/run-trust.ts"), D("gate/worktrees-confirm.ts"), D("handlers/git.ts"), D("compose-parts.ts")],
  [D("handlers/git.ts")]: [D("handlers/helper.ts")],
};

test("the legitimate composition graph passes both checks", () => {
  assert.deepEqual(checkMetafile(graph(GOOD), manifest), []);
  assert.deepEqual(minterReachViolations(graph(GOOD), stagedOf), []);
});

test("a handler importing the public index (the barrel hop) is refused on the metafile, directly and through a helper", () => {
  for (const from of ["handlers/git.ts", "compose-parts.ts"]) {
    const found = checkMetafile(graph({ ...GOOD, [D(from)]: [D("index.ts")] }), manifest);
    assert.ok(found.some((v) => v.includes(D(from)) && /index\.ts/.test(v)), `${from}: ${found.join("; ")}`);
  }
  const chain = checkMetafile(graph({ ...GOOD, [D("handlers/git.ts")]: [D("handlers/helper.ts")], [D("handlers/helper.ts")]: [D("index.ts")] }), manifest);
  assert.ok(chain.some((v) => v.startsWith(`${D("handlers/git.ts")} -> ${D("handlers/helper.ts")} -> ${D("index.ts")}:`)), chain.join("; "));
});

test("the walk is transitive: a chain of helpers to a minter or to the composition root is refused", () => {
  for (const target of ["gate/run-trust.ts", "gate/worktrees-confirm.ts", "compose.ts", "index.ts"]) {
    const found = minterReachViolations(graph({ ...GOOD, [D("handlers/git.ts")]: [D("handlers/helper.ts")], [D("handlers/helper.ts")]: [D("compose-parts.ts")], [D("compose-parts.ts")]: [D(target)] }), stagedOf);
    assert.ok(found.some((v) => v.path.join(">").endsWith(`handlers/helper.ts>${D("compose-parts.ts")}>${D(target)}`)), target);
  }
});

test("the walk alone still refuses when the restricted-module table is missing an entry (independent of the per-edge rule)", () => {
  const saved = [...RESTRICTED_MODULES];
  try {
    RESTRICTED_MODULES.length = 0; // no per-edge rules at all
    for (const target of ["gate/run-trust.ts", "gate/worktrees-confirm.ts", "compose.ts", "index.ts"]) {
      const found = checkMetafile(graph({ ...GOOD, [D("handlers/git.ts")]: [D(target)] }), manifest);
      assert.equal(found.length, 1, `${target}: ${found.join("; ")}`);
    }
    assert.deepEqual(checkMetafile(graph(GOOD), manifest), [], "the composition graph is still fine");
  } finally {
    RESTRICTED_MODULES.splice(0, RESTRICTED_MODULES.length, ...saved);
  }
});

test("only code outside the staged tree may load the public index", () => {
  const index = RESTRICTED_MODULES.find((r) => r.file === "index.ts" && r.pkg === "daemon-host");
  assert.ok(index);
  assert.equal(mayImportRestricted(index, null, null), true);
  for (const [pkg, rel] of [["daemon-host", D("handlers/git.ts")], ["daemon-host", D("compose.ts")], ["daemon-host", D("index.ts")], ["daemon", "daemon/index.ts"]]) assert.equal(mayImportRestricted(index, pkg, rel), false, rel);
  assert.deepEqual(checkMetafile(graph({ [ENTRY]: [D("index.ts")], [D("index.ts")]: [] }), manifest), []);
  // The other restricted modules still refuse the overlay entry.
  const attest = RESTRICTED_MODULES.find((r) => r.file === "daemon-attestation.ts");
  assert.equal(mayImportRestricted(attest, null, null), false);
});

test("the staged scan refuses the barrel hop and the discard token minter's other loaders", () => {
  const files = new Set(FILES);
  for (const [from, spec] of [["daemon-host/handlers/git.ts", "../index.js"], ["daemon-host/compose-parts.ts", "./index.js"], ["daemon-host/handlers/git.ts", "../gate/worktrees-confirm.js"], ["daemon-host/index.ts", "./index.js"]]) {
    assert.throws(() => checkStagedFile(from, `import "${spec}";\n`, files), /only .*may import|reaches/, `${from} ${spec}`);
  }
  assert.throws(() => checkStagedFile("daemon-host/handlers/git.ts", 'export * from "../index.js";\n', files), /index/);
  checkStagedFile("daemon-host/compose.ts", 'import "./gate/worktrees-confirm.js";\n', files);
  checkStagedFile("daemon-host/index.ts", 'export * from "./compose.js";\n', files);
});
