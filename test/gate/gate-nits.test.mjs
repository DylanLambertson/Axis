// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Review follow-ups to the gate's tests step and wrong-Node line (scripts/gate/lib.mjs): a forged or damaged summary, the exit wording,
// and where the pinned Node is looked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { pinnedNodeHints, validSummary, wrongNodeLine } from "../../scripts/gate/lib.mjs";

const gate = fileURLToPath(new URL("../../scripts/gate.mjs", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const good = { name: "@x/a", ok: true, pass: 3, fail: 0 };

test("validSummary: only a non-empty list of well-formed suite results counts", () => {
  assert.equal(validSummary([good]), true);
  assert.equal(validSummary([good, { name: "b", ok: false, pass: 1, fail: 2 }]), true);
  for (const bad of [[], [1], [null], [good, null], [{ name: "a", ok: true }], [{ name: "", ok: true, pass: 0, fail: 0 }], [{ name: "a", ok: "yes", pass: 0, fail: 0 }],
    [{ name: "a", ok: true, pass: -1, fail: 0 }], [{ name: "a", ok: true, pass: 1.5, fail: 0 }], {}, "x", null, undefined, 3]) {
    assert.equal(validSummary(bad), false, JSON.stringify(bad));
  }
});

test("gate tests step: a run that ends without a summary because the runner refused to start says its exit code", () => {
  const env = { ...process.env, AXIS_TEST_SUITE_TIMEOUT_MS: "abc", AXIS_TEST_ALL_SUITES_JSON: JSON.stringify([["@fake/x", process.execPath, ["-e", ""]]]), AXIS_TEST_ALL_SEAM: "runner-self-test", GATE_SKIP: "diff-check,gitleaks,line-limit,wording,node-version,typecheck" };
  delete env.CI; delete env.GATE_OVERLAY_TREE; delete env.AXIS_REQUIRE_OVERLAY_TESTS;
  const r = spawnSync(process.execPath, [gate], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  assert.match(`${r.stdout}${r.stderr}`, /ended without a summary \(exit 2\)/);
});

const fsOf = (files, dirs = []) => ({ exists: (p) => files.includes(p) || dirs.includes(p), isFile: (p) => files.includes(p) });
const base = { root: "/repo", pinned: "24.22.1", platform: "linux", arch: "x64" };

test("pinnedNodeHints: the tools directory is the default, an empty or relative AXIS_CODE_OSS_TOOLS_DIR is not used as a relative path", () => {
  const dist = "node-v24.22.1-linux-x64";
  const own = pinnedNodeHints({ ...base, env: {}, fs: fsOf([`/repo/.tools/${dist}/bin/node`]) });
  assert.deepEqual(own.hints, [`/repo/.tools/${dist}/bin`]);
  const empty = pinnedNodeHints({ ...base, env: { AXIS_CODE_OSS_TOOLS_DIR: "" }, fs: fsOf([`/repo/.tools/${dist}/bin/node`]) });
  assert.deepEqual(empty.hints, [`/repo/.tools/${dist}/bin`], "empty means unset");
  const rel = pinnedNodeHints({ ...base, env: { AXIS_CODE_OSS_TOOLS_DIR: "t" }, fs: { exists: () => true, isFile: () => false } });
  assert.ok(rel.hints.every((h) => isAbsolute(h)), `absolute: ${rel.hints}`);
});

test("pinnedNodeHints: NODE24_BIN as a directory or as the binary; one that holds no node is named, not dropped silently", () => {
  assert.deepEqual(pinnedNodeHints({ ...base, env: { NODE24_BIN: "/n/bin" }, fs: fsOf(["/n/bin/node"]) }).hints, ["/n/bin"]);
  assert.deepEqual(pinnedNodeHints({ ...base, env: { NODE24_BIN: "/n/bin/node" }, fs: fsOf(["/n/bin/node"]) }).hints, ["/n/bin"]);
  const odd = pinnedNodeHints({ ...base, env: { NODE24_BIN: "/n/bin/node24" }, fs: fsOf(["/n/bin/node24"]) });
  assert.deepEqual(odd.hints, []);
  assert.deepEqual(odd.unusable, ["/n/bin/node24"]);
  const line = wrongNodeLine({ running: "v26.0.0", pinned: "24.22.1", execPath: "/x/node", hints: [], unusable: ["/n/bin/node24"] });
  assert.match(line, /NODE24_BIN=\/n\/bin\/node24 holds no node binary/);
});

test("pinnedNodeHints: a file system that throws gives no hints instead of stopping the gate", () => {
  const boom = { exists: () => { throw new Error("EACCES"); }, isFile: () => { throw new Error("EACCES"); } };
  assert.deepEqual(pinnedNodeHints({ ...base, env: { NODE24_BIN: "/n" }, fs: boom }), { hints: [], unusable: [] });
});

test("pinnedNodeHints: no pin gives no tools-directory hint", () => {
  assert.deepEqual(pinnedNodeHints({ ...base, pinned: undefined, env: {}, fs: { exists: () => true, isFile: () => false } }).hints, []);
});

test("pinnedNodeHints: an absolute AXIS_CODE_OSS_TOOLS_DIR is used as it is, not joined under the checkout", () => {
  const dist = "node-v24.22.1-linux-x64";
  const r = pinnedNodeHints({ ...base, env: { AXIS_CODE_OSS_TOOLS_DIR: "/abs/tools" }, fs: fsOf([`/abs/tools/${dist}/bin/node`]) });
  assert.deepEqual(r.hints, [`/abs/tools/${dist}/bin`]);
});

test("pinnedNodeHints: a relative NODE24_BIN is resolved, so the advice never prints a relative path", () => {
  const dir = resolve("rel-node/bin");
  const asDir = pinnedNodeHints({ ...base, env: { NODE24_BIN: "rel-node/bin" }, fs: fsOf([join(dir, "node")]) });
  assert.deepEqual(asDir.hints, [dir]);
  const asFile = pinnedNodeHints({ ...base, env: { NODE24_BIN: "rel-node/bin/node" }, fs: fsOf([join(dir, "node")]) });
  assert.deepEqual(asFile.hints, [dir]);
  assert.ok(asDir.hints.concat(asFile.hints).every((h) => isAbsolute(h)));
});
