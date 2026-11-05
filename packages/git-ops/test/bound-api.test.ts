// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The bound-commit contract with a fake runner (shapes and refusals), and the daemonGitFor/checkWorktree exports (G4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { GitOpsError, OBJECT_ID, checkWorktree, daemonGitFor, executeCommit, planCommit } from "../src/index.js";
import { FakeRunner, HEAD, TREE, WT, healthy, makeDeps, sub } from "./helpers.js";
import { fixture } from "./realFixture.js";

const input = { worktree: WT, reviewedTreeHash: TREE, message: "feat: add thing  \n\n\n\nbody\n", expectedParent: HEAD, expectedBranch: "axis/feat" };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return `${e.code}${e.details?.["reason"] ? `:${String(e.details["reason"])}` : ""}`;
  }
  return "OK";
}

test("a bound plan is a commit-tree of the reviewed tree on the expected parent, with the message on stdin", async () => {
  const plan = await planCommit(makeDeps(new FakeRunner(healthy())), input);
  assert.equal(plan.bound, true);
  assert.equal(plan.command.context, "pty");
  assert.deepEqual(sub(plan.command.argv), ["commit-tree", "-p", HEAD, "-F", "-", TREE]);
  assert.equal(plan.command.stdin, "feat: add thing\n\nbody\n");
  assert.ok(plan.command.argv.includes("i18n.commitEncoding=utf-8"));
});

test("without expectedParent the plan is the older `git commit`, unchanged", async () => {
  const { expectedParent: _p, expectedBranch: _b, ...old } = input;
  const plan = await planCommit(makeDeps(new FakeRunner(healthy())), old);
  assert.equal(plan.bound, false);
  assert.deepEqual(sub(plan.command.argv), ["commit", "-F", "-", "--no-edit"]);
});

test("a moved HEAD, another branch, or a malformed pin is refused before any pty call", async () => {
  const mk = (over: Record<string, unknown>, run = new FakeRunner(healthy())) => ({ run, p: planCommit(makeDeps(run), { ...input, ...over }) });
  for (const [over, want] of [
    [{ expectedParent: "d".repeat(40) }, "E_CONFLICT:head_moved"],
    [{ expectedBranch: "axis/other" }, "E_CONFLICT:head_moved"],
    [{ expectedParent: "HEAD" }, "E_INVALID_ARGUMENT"],
    [{ expectedBranch: "main" }, "E_POLICY_DENIED"],
  ] as const) {
    const { run, p } = mk(over);
    assert.equal(await code(p), want, JSON.stringify(over));
    assert.equal(run.ptyCalls().filter((c) => sub(c.argv)[0] !== "config").length, 0);
  }
  const { expectedParent: _p, ...noParent } = input;
  assert.equal(await code(planCommit(makeDeps(new FakeRunner(healthy())), noParent)), "E_INVALID_ARGUMENT");
});

test("an index that cannot be listed, or a git-path answer that cannot be read, refuses (fails closed)", async () => {
  const lsFail = new FakeRunner(healthy((s) => (s[0] === "ls-files" ? { code: 128 } : undefined)));
  assert.equal(await code(planCommit(makeDeps(lsFail), input)), "E_UNAVAILABLE");
  const noPaths = new FakeRunner(healthy((s) => (s[0] === "rev-parse" && s[1] === "--git-path" ? { stdout: "only-one\n" } : undefined)));
  assert.equal(await code(planCommit(makeDeps(noPaths), input)), "E_UNAVAILABLE");
  const blank = new FakeRunner(healthy((s) => (s[0] === "rev-parse" && s[1] === "--git-path" ? { stdout: `${"/g/x\n".repeat(8)}\n` } : undefined)));
  assert.equal(await code(planCommit(makeDeps(blank), input)), "E_UNAVAILABLE", "an empty path is not 'absent'");
  const stat = makeDeps(new FakeRunner(healthy()), { fileExists: async () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } });
  assert.equal(await code(planCommit(stat, input)), "E_UNAVAILABLE");
  const present = makeDeps(new FakeRunner(healthy()), { fileExists: (p) => p.endsWith("/MERGE_HEAD") });
  assert.equal(await code(planCommit(present, input)), "E_CONFLICT:operation_in_progress");
});

test("a commit-tree that prints something else is refused with nothing updated", async () => {
  const run = new FakeRunner(healthy((s) => (s[0] === "commit-tree" ? { stdout: "not an id\n" } : undefined)));
  assert.equal(await code(executeCommit(makeDeps(run), input)), "E_INTERNAL");
  assert.ok(run.ptyCalls().some((c) => sub(c.argv)[0] === "commit-tree"), "the bound path ran commit-tree");
  assert.ok(!run.subs().some((s) => s[0] === "update-ref" || s[0] === "rev-list"), "the unvalidated text never reaches a git argument");
});

test("G4: daemonGitFor takes GIT_INDEX_FILE only, as an absolute path; checkWorktree and OBJECT_ID are exported", async () => {
  const f = fixture();
  const idx = join(f.root, "private-index");
  const git = await daemonGitFor(f.wt, f.deps, { GIT_INDEX_FILE: idx });
  const empty = await git(["write-tree"]);
  assert.equal(empty.stdout.trim(), "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "the private (empty) index was used, not the real one");
  assert.ok(OBJECT_ID.test(empty.stdout.trim()));
  const real = await (await daemonGitFor(f.wt, f.deps))(["write-tree"]);
  assert.notEqual(real.stdout.trim(), empty.stdout.trim());
  for (const bad of [{ GIT_DIR: "/x" }, { GIT_WORK_TREE: "/x" }, { GIT_CONFIG_COUNT: "1" }, { GIT_INDEX_FILE: "relative" }, { GIT_INDEX_FILE: "/a\0b" }, { PATH: "/x" }]) {
    await assert.rejects(daemonGitFor(f.wt, f.deps, bad), (e: unknown) => e instanceof GitOpsError && e.code === "E_INVALID_ARGUMENT", JSON.stringify(bad));
  }
  assert.throws(() => checkWorktree({ workTree: "rel", gitDir: "/g" }, "linux"), GitOpsError);
});
