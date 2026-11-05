// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// N-2: only protocol error codes leave the package, and a timeout takes git's children with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitOpsError, createNodeRunner, executeCommit, executePush, planCommit, planPush } from "../src/index.js";
import { FakeRunner, TREE, WT, BASE, healthy, makeDeps } from "./helpers.js";
import { fixture } from "./realFixture.js";

const push = { worktree: WT, remote: "origin", branch: "axis/feat", baseSha: BASE };
const commit = { worktree: WT, reviewedTreeHash: TREE, message: "m", expectedParent: "c".repeat(40), expectedBranch: "axis/feat" };

async function outcome(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, `leaked a non-protocol error: ${String(e)}`);
    return e;
  }
  assert.fail("expected a refusal");
}

test("N-2: a missing git binary, or a throwing hook, comes out as E_UNAVAILABLE", async () => {
  const noGit = { ...makeDeps(new FakeRunner()), runner: createNodeRunner() };
  const deps = { ...noGit, env: { daemon: { PATH: "/nonexistent" }, pty: { PATH: "/nonexistent" } } };
  for (const p of [planPush(deps, push), executePush(deps, push), planCommit(deps, commit), executeCommit(deps, commit)]) {
    const e = await outcome(p);
    assert.equal(e.code, "E_UNAVAILABLE");
    assert.match(e.message, /ENOENT/);
  }
  const hooks = [
    { assertNoDrift: async () => { throw new Error("/secret/path exploded"); } },
    { isCliRunActive: () => { throw new TypeError("boom"); } },
    { scanner: async () => { throw new RangeError("scanner broke"); } },
  ];
  for (const h of hooks) {
    const e = await outcome(planPush(makeDeps(new FakeRunner(healthy()), { ...h }), push));
    assert.equal(e.code, "E_UNAVAILABLE");
    assert.doesNotMatch(e.message, /secret|boom|broke/);
  }
});

test("N-2: a timeout kills the whole process group, not just git", async () => {
  const f = fixture();
  const pidFile = join(f.root, "pid");
  const alias = `alias.slow=!sh -c 'echo $$ > "${pidFile}"; exec sleep 60' & wait`;
  const started = Date.now();
  const r = await createNodeRunner({ allowPtyContext: true, timeoutMs: 700 }).run({
    argv: ["-c", alias, "slow"], cwd: f.root, env: { PATH: process.env["PATH"] ?? "", HOME: f.home }, context: "pty",
  });
  assert.ok(Date.now() - started < 10_000, "the run ended at the timeout, not when the grandchild exited");
  assert.notEqual(r.code, 0);
  assert.ok(existsSync(pidFile), "the child started");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((res) => setTimeout(res, 200));
  assert.throws(() => process.kill(pid, 0), "the grandchild is gone");
});
