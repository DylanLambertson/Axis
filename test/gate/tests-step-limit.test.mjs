// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The gate's tests step never ends "FAILED" with no suite named: a run that overruns the step's time limit names the suite it was
// running and says it timed out, and the limit is its own setting, not a fixed 20 minutes for every suite together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("../../scripts/gate.mjs", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const SKIP = "diff-check,gitleaks,line-limit,wording,node-version,typecheck";

function runGate(suites, extra = {}) {
  const env = { ...process.env, AXIS_TEST_ALL_SUITES_JSON: JSON.stringify(suites), AXIS_TEST_ALL_SEAM: "runner-self-test", GATE_SKIP: SKIP, ...extra };
  delete env.CI;
  delete env.GATE_OVERLAY_TREE;
  delete env.AXIS_REQUIRE_OVERLAY_TESTS;
  const r = spawnSync(process.execPath, [gate], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const ok = ["@fake/fast", process.execPath, ["-e", 'console.log("\\u2139 pass 1\\n\\u2139 fail 0")']];
// Prints a line, then waits far longer than any limit below; the runner kills it by group.
const slow = ["@fake/slow", process.execPath, ["-e", 'console.log("\\u2714 started (1ms)"); setTimeout(() => {}, 600000)']];

test("gate tests step: a run over the step limit names the suite that was running and says it timed out", () => {
  const r = runGate([ok, slow], { AXIS_GATE_TESTS_TIMEOUT_MS: "3000" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ended without a summary \(timed out after 3s\) while running @fake\/slow/, r.out);
});

test("gate tests step: a bad limit setting is refused by name, never read as no limit", () => {
  for (const bad of ["0", "-1", "1.5", "abc", ""]) {
    const r = runGate([ok], { AXIS_GATE_TESTS_TIMEOUT_MS: bad });
    assert.equal(r.code, 1, `${JSON.stringify(bad)}: ${r.out}`);
    assert.match(r.out, /AXIS_GATE_TESTS_TIMEOUT_MS/, r.out);
  }
});

test("gate tests step: a run inside the limit passes (the limit is not read as the suite's own)", () => {
  const r = runGate([ok], { AXIS_GATE_TESTS_TIMEOUT_MS: "60000" });
  assert.match(r.out, /PASS +tests/, r.out); // the verdict is INCOMPLETE because the other steps are skipped here
});
