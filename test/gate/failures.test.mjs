// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The gate keeps a failing package's failing test names and assertion messages (scripts/gate/failures.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { failureDigest, splitSuites } from "../../scripts/gate/failures.mjs";

const gate = fileURLToPath(new URL("../../scripts/gate.mjs", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));

const FAILING = [
  "✔ quiet passing test (1ms)",
  "✖ the one that flakes (12ms)",
  "ℹ pass 1",
  "ℹ fail 1",
  "",
  "✖ failing tests:",
  "",
  "test at dist/test/x.test.js:5:1",
  "✖ the one that flakes (12ms)",
  "  AssertionError [ERR_ASSERTION]: both commits reached the ref update",
  "  1 !== 2",
].join("\\n");

// A suite that prints node:test's spec failure report and exits 1, and one that passes.
const suites = [
  ["@fake/broken", process.execPath, ["-e", `console.log("${FAILING}"); process.exit(1)`]],
  ["@fake/fine", process.execPath, ["-e", 'console.log("\\u2714 a passing test that must stay quiet (1ms)\\n\\u2139 pass 1\\n\\u2139 fail 0")']],
];

function runGate() {
  const env = { ...process.env, AXIS_TEST_ALL_SUITES_JSON: JSON.stringify(suites), AXIS_TEST_ALL_SEAM: "runner-self-test", GATE_SKIP: "diff-check,gitleaks,line-limit,wording,node-version,typecheck" };
  delete env.CI;
  const r = spawnSync(process.execPath, [gate], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("gate: a failing package prints its failing test's name and assertion message and saves its full output", () => {
  const r = runGate();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /@fake\/broken: failing tests/, r.out);
  assert.match(r.out, /✖ the one that flakes/, "the failing test's name");
  assert.match(r.out, /AssertionError \[ERR_ASSERTION\]: both commits reached the ref update/, "its assertion message");
  const path = /== full output: (\S+)/.exec(r.out)?.[1];
  assert.ok(path !== undefined && existsSync(path), `the full output path is printed and exists: ${r.out}`);
  try {
    assert.match(readFileSync(path, "utf8"), /quiet passing test/, "the saved file holds the failing package's whole output");
  } finally { rmSync(dirname(path), { recursive: true, force: true }); }
});

test("gate: a passing package prints no test lines", () => {
  const r = runGate();
  assert.doesNotMatch(r.out, /a passing test that must stay quiet/, r.out);
  assert.doesNotMatch(r.out, /@fake\/fine: failing tests/);
  const path = /== full output: (\S+)/.exec(r.out)?.[1];
  if (path !== undefined) rmSync(dirname(path), { recursive: true, force: true });
});

test("failureDigest: a TAP 'not ok' failure is named with its message; a clean run gives nothing", () => {
  const tap = "ok 1 - fine\nnot ok 2 - broken thing\n  ---\n  error: 'boom'\n  ...\n# pass 1\n# fail 1";
  assert.match(failureDigest(tap), /not ok 2 - broken thing[\s\S]*error: 'boom'/);
  assert.equal(failureDigest("✔ fine (1ms)\nℹ pass 1\nℹ fail 0"), "");
});

test("failureDigest: each failure keeps only its first 15 lines and the digest is capped", () => {
  const block = (n) => `test at f.js:${n}:1\n✖ t${n}\n${Array.from({ length: 40 }, (_, i) => `  line ${i}`).join("\n")}`;
  const text = `✖ failing tests:\n\n${block(1)}\n\n${block(2)}`;
  const d = failureDigest(text);
  assert.match(d, /✖ t1/);
  assert.match(d, /✖ t2/);
  assert.doesNotMatch(d, /line 30/);
});

test("splitSuites: one block per suite, each ending at the runner's own line", () => {
  const s = splitSuites("a out\n\n== a: ok (1 pass, 0 fail)\n\nb out\n== b: FAILED (0 pass, 1 fail, exit 1)\n");
  assert.deepEqual(s.map((x) => [x.name, x.ok]), [["a", true], ["b", false]]);
  assert.match(s[1].text, /^b out/);
});
