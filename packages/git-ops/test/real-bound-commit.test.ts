// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Hostile real-git tests for the bound commit (design G2, G3, G5): HEAD moved by another process, an operation in
// progress, a branch switch, a stale review and racing commits. Each uses real git directories and no git version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitOpsError, OPERATION_MARKERS, executeCommit, planCommit, type CommitInput, type GitOpsDeps } from "../src/index.js";
import { around, foreignCommit, isDaemon, isPtyCommitTree, reviewed, subOf } from "./boundFixture.js";
import { fixture, refusal, type Fixture } from "./realFixture.js";

const head = (f: Fixture, ref = "HEAD"): string => f.git("rev-parse", ref).trim();

async function refused(p: Promise<unknown>, reason: string, code = "E_CONFLICT"): Promise<GitOpsError> {
  const e = await refusal(p);
  assert.equal(e.code, code, e.message);
  assert.equal(e.details?.["reason"], reason, e.message);
  return e;
}

test("a bound commit has the reviewed tree on exactly the expected parent, one parent, and a normalised message", async () => {
  const f = fixture();
  const input = reviewed(f, "feat: add b  \n\n\n\nbody  \n");
  const r = await executeCommit(f.deps, input);
  assert.equal(head(f), r.commit);
  assert.equal(r.tree, input.reviewedTreeHash);
  assert.equal(f.git("rev-list", "--parents", "-n", "1", "HEAD").trim(), `${r.commit} ${input.expectedParent}`);
  assert.equal(f.git("log", "-1", "--format=%B", "HEAD"), "feat: add b\n\nbody\n\n");
  assert.equal(f.git("log", "-1", "--format=%an <%ae>").trim(), "Dylan Lambertson <me@dylanlambertson.dev>");
  assert.equal(f.git("status", "--porcelain").trim(), "", "index and worktree match the new HEAD");
  assert.match(f.git("reflog", "-1", "HEAD"), /axis: commit/);
});

test("G3: HEAD moved by another process (commit-tree + update-ref) after the plan and before commit is refused, and the foreign commit stays", async () => {
  const f = fixture();
  const input = reviewed(f);
  await planCommit(f.deps, input);
  const x = foreignCommit(f);
  await refused(executeCommit(f.deps, input), "head_moved");
  assert.equal(head(f), x, "the branch still points at the foreign commit");
  assert.ok(f.git("ls-tree", "--name-only", "HEAD").includes("other.txt"), "its file was not reverted");
});

test("G3: HEAD moved while the pty commit-tree runs is caught before the ref update", async () => {
  const f = fixture();
  const input = reviewed(f);
  let x = "";
  const deps = around(f, isPtyCommitTree, { before: () => { x = foreignCommit(f); } });
  await refused(executeCommit(deps, input), "head_moved");
  assert.equal(head(f), x);
});

test("G3: HEAD moved after every check, right before the ref update, loses the compare-and-swap", async () => {
  const f = fixture();
  const input = reviewed(f);
  let x = "";
  const deps = around(f, isDaemon("update-ref"), { before: () => { x = foreignCommit(f); } });
  await refused(executeCommit(deps, input), "head_moved");
  assert.equal(head(f), x, "the foreign commit was not overwritten");
  assert.ok(f.git("ls-tree", "--name-only", "HEAD").includes("other.txt"));
});

test("G3: a commit that is not on the expected parent, or lacks the reviewed tree, is never put on the branch", async () => {
  const base = async (swap: (argv: readonly string[], f: Fixture) => string[]): Promise<{ e: GitOpsError; f: Fixture; tip: string }> => {
    const f = fixture();
    f.git("commit", "-q", "--allow-empty", "-m", "second");
    const input = reviewed(f);
    const tip = head(f);
    const inner = f.deps.runner;
    const deps: GitOpsDeps = { ...f.deps, runner: { run: (req) => inner.run(isPtyCommitTree(req) ? { ...req, argv: swap(req.argv, f) } : req) } };
    return { e: await refusal(executeCommit(deps, input)), f, tip };
  };
  const wrongParent = await base((argv, f) => argv.map((a) => (a === head(f) ? head(f, "main") : a)));
  assert.equal(wrongParent.e.code, "E_INTERNAL");
  assert.equal(head(wrongParent.f), wrongParent.tip);
  const twoParents = await base((argv, f) => [...argv.slice(0, -1), "-p", head(f, "main"), argv.at(-1) as string]);
  assert.equal(twoParents.e.code, "E_INTERNAL", "a merge commit is not what was reviewed");
  assert.equal(head(twoParents.f), twoParents.tip);
  const wrongTree = await base((argv, f) => argv.map((a, i) => (i === argv.length - 1 ? f.git("rev-parse", "HEAD^{tree}").trim() : a)));
  assert.equal(wrongTree.e.code, "E_INTERNAL");
  assert.equal(head(wrongTree.f), wrongTree.tip);
});

test("G3: a branch switch after the review is refused, and neither branch moves", async () => {
  const f = fixture();
  const input = reviewed(f);
  f.git("checkout", "-q", "-b", "axis/other");
  const feat = head(f, "refs/heads/axis/feat");
  await refused(executeCommit(f.deps, input), "head_moved");
  assert.equal(head(f, "refs/heads/axis/feat"), feat);
  assert.equal(head(f, "refs/heads/axis/other"), feat);
  assert.equal(f.seen.filter(isPtyCommitTree).length, 0, "commit-tree never ran");
});

test("G3: a switch to the branch after check, before the update, is refused too", async () => {
  const f = fixture();
  const input = reviewed(f);
  const deps = around(f, isPtyCommitTree, { before: () => { f.git("checkout", "-q", "-b", "axis/other"); } });
  await refused(executeCommit(deps, input), "head_moved");
  assert.equal(head(f, "refs/heads/axis/feat"), input.expectedParent);
});

test("G3: expectedParent and expectedBranch are validated before git runs", async () => {
  const f = fixture();
  const input = reviewed(f);
  for (const bad of [{ expectedParent: "HEAD" }, { expectedParent: "A".repeat(40) }, { expectedParent: 5 as unknown as string }, { expectedBranch: "main" }, { expectedBranch: "--x" }]) {
    const e = await refusal(executeCommit(f.deps, { ...input, ...bad }));
    assert.ok(e.code === "E_INVALID_ARGUMENT" || e.code === "E_POLICY_DENIED", `${JSON.stringify(bad)} ${e.code}`);
  }
  const { expectedParent: _drop, ...noParent } = input;
  assert.equal((await refusal(executeCommit(f.deps, noParent))).code, "E_INVALID_ARGUMENT", "expectedBranch alone is not a pin");
  assert.equal(f.seen.filter(isPtyCommitTree).length, 0);
});

// Spelled out on purpose: a test that loops over OPERATION_MARKERS would shrink with a mutation of the list.
const EXPECTED_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "BISECT_START"];
const MARKERS_AS_DIR = new Set(["rebase-merge", "rebase-apply", "sequencer"]);

test("G5: every operation marker refuses (bound and unbound), at the review-bypass shape where the index already equals the reviewed tree", async () => {
  assert.deepEqual([...OPERATION_MARKERS], EXPECTED_MARKERS);
  for (const marker of EXPECTED_MARKERS) {
    for (const bound of [true, false]) {
      const f = fixture();
      const input = reviewed(f);
      const p = join(f.wt.gitDir, marker);
      if (MARKERS_AS_DIR.has(marker)) mkdirSync(p);
      else writeFileSync(p, `${input.expectedParent}\n`);
      const { expectedParent: _a, expectedBranch: _b, ...unbound } = input;
      const before = head(f);
      await refused(executeCommit(f.deps, bound ? input : (unbound as CommitInput)), "operation_in_progress");
      assert.equal(head(f), before, `${marker} bound=${bound}`);
      assert.equal(f.seen.filter((r) => r.context === "pty" && ["commit", "commit-tree"].includes(subOf(r))).length, 0, marker);
    }
  }
});

test("G5: a real merge conflict whose index was replaced by the reviewed tree (MERGE_HEAD left) would record two parents; it is refused", async () => {
  const f = fixture();
  f.git("checkout", "-q", "-b", "axis/side", "main");
  writeFileSync(join(f.wt.workTree, "a.txt"), "side\n");
  f.git("commit", "-qam", "side");
  f.git("checkout", "-q", "axis/feat");
  writeFileSync(join(f.wt.workTree, "a.txt"), "feat\n");
  f.git("commit", "-qam", "feat");
  assert.throws(() => f.git("merge", "-q", "axis/side"), /./);
  assert.ok(f.git("ls-files", "-u").length > 0, "the merge left unmerged entries");
  const tip = head(f);
  // What a review's staging does: replace the whole index with the reviewed tree. The unmerged entries go; MERGE_HEAD stays.
  writeFileSync(join(f.wt.workTree, "a.txt"), "feat\n");
  f.git("add", "-A");
  const input = reviewed(f);
  assert.equal(f.git("ls-files", "-u"), "");
  await refused(executeCommit(f.deps, input), "operation_in_progress");
  assert.equal(head(f), tip);
});

test("G5: unmerged index entries alone (no marker file) refuse with the same reason", async () => {
  const f = fixture();
  f.git("checkout", "-q", "-b", "axis/side", "main");
  writeFileSync(join(f.wt.workTree, "a.txt"), "side\n");
  f.git("commit", "-qam", "side");
  f.git("checkout", "-q", "axis/feat");
  writeFileSync(join(f.wt.workTree, "a.txt"), "feat\n");
  f.git("commit", "-qam", "feat");
  assert.throws(() => f.git("merge", "-q", "axis/side"), /./);
  f.git("merge", "--quit");
  assert.ok(f.git("ls-files", "-u").length > 0);
  const tree = f.git("rev-parse", "HEAD^{tree}").trim();
  await refused(executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "m", expectedParent: head(f) }), "operation_in_progress");
});

test("G5: MERGE_HEAD or CHERRY_PICK_HEAD appearing after check and before the ref update is refused, and nothing moves", async () => {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    const f = fixture();
    const input = reviewed(f);
    let created = false;
    // The first daemon call after the pty commit-tree is the verification: the marker exists from then on.
    let ptyDone = false;
    const inner = f.deps.runner;
    const deps: GitOpsDeps = {
      ...f.deps,
      runner: {
        run: async (req) => {
          if (ptyDone && !created) {
            created = true;
            writeFileSync(join(f.wt.gitDir, marker), `${input.expectedParent}\n`);
          }
          const r = await inner.run(req);
          if (isPtyCommitTree(req)) ptyDone = true;
          return r;
        },
      },
    };
    await refused(executeCommit(deps, input), "operation_in_progress");
    assert.equal(head(f), input.expectedParent, marker);
  }
});

test("G5: a rebase in a LINKED worktree is that worktree's own directory; the main worktree's state does not matter", async () => {
  const f = fixture();
  const lw = join(f.root, "linked");
  f.git("worktree", "add", "-q", "-b", "axis/lw", lw, "axis/feat");
  const wt = { workTree: lw, gitDir: f.git("-C", lw, "rev-parse", "--absolute-git-dir").trim() };
  assert.notEqual(wt.gitDir, f.wt.gitDir);
  const input = reviewed(f, "m", wt, "axis/lw");
  // A rebase in the MAIN worktree is not this worktree's operation.
  mkdirSync(join(f.wt.gitDir, "rebase-merge"));
  // A rebase in the linked one is.
  mkdirSync(join(wt.gitDir, "rebase-merge"));
  await refused(executeCommit(f.deps, input), "operation_in_progress");
  assert.equal(head(f, "refs/heads/axis/lw"), input.expectedParent);
  // Control: with the linked worktree's own marker gone the same commit succeeds, so the refusal was about that marker.
  const { rmSync } = await import("node:fs");
  rmSync(join(wt.gitDir, "rebase-merge"), { recursive: true });
  const r = await executeCommit(f.deps, input);
  assert.equal(head(f, "refs/heads/axis/lw"), r.commit);
});

test("G2: a file edited after the review makes the commit stale: nothing is built, nothing moves", async () => {
  const f = fixture();
  const input = reviewed(f);
  const seenArgs: Array<[string, string]> = [];
  const order: string[] = [];
  const deps: GitOpsDeps = {
    ...f.deps,
    assertNoDrift: async () => { order.push("drift"); },
    assertReviewFresh: async (w, tree) => {
      order.push("fresh");
      seenArgs.push([w.workTree, tree]);
      const { readFileSync } = await import("node:fs");
      if (readFileSync(join(w.workTree, "b.txt"), "utf8") !== "two\n") throw new Error("edited");
    },
  };
  writeFileSync(join(f.wt.workTree, "b.txt"), "two, edited after the review\n");
  await refused(executeCommit(deps, input), "stale");
  assert.deepEqual(order, ["drift", "fresh"]);
  assert.deepEqual(seenArgs, [[f.wt.workTree, input.reviewedTreeHash]]);
  assert.equal(head(f), input.expectedParent);
  assert.equal(f.seen.filter(isPtyCommitTree).length, 0, "no commit was built");
  // Control: the same dependency lets an unedited worktree through.
  writeFileSync(join(f.wt.workTree, "b.txt"), "two\n");
  await executeCommit(deps, input);
  assert.notEqual(head(f), input.expectedParent);
});

test("G2: the hook refuses by throwing; a returned value is a refusal too, and another GitOpsError code passes through", async () => {
  const f = fixture();
  const input = reviewed(f);
  for (const v of [false, { fresh: false }, "ok", null, 0]) {
    const deps = { ...f.deps, assertReviewFresh: (async () => v) as unknown as () => Promise<void> };
    await refused(executeCommit(deps, input), "stale");
  }
  const unavailable = { ...f.deps, assertReviewFresh: async () => { throw new GitOpsError("E_UNAVAILABLE", "cannot snapshot"); } };
  assert.equal((await refusal(executeCommit(unavailable, input))).code, "E_UNAVAILABLE");
  assert.equal(head(f), input.expectedParent);
});

test("racing commits on one expected parent: exactly one wins, the other fails with E_CONFLICT and leaves the ref untouched", async () => {
  const f = fixture();
  const a = reviewed(f, "first");
  const b = { ...a, message: "second" };
  // Both pass every check and build their commit; neither updates the ref until both are about to.
  let arrived = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => { release = res; setTimeout(res, 5000).unref(); });
  const deps = around(f, isDaemon("update-ref"), {
    every: true,
    before: async () => { if (++arrived === 2) release(); await gate; },
  });
  const results = await Promise.allSettled([executeCommit(deps, a), executeCommit(deps, b)]);
  assert.equal(arrived, 2, "both commits reached the ref update");
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  const err = (lost[0] as PromiseRejectedResult).reason as GitOpsError;
  assert.ok(err instanceof GitOpsError);
  assert.equal(err.code, "E_CONFLICT");
  const winner = (won[0] as PromiseFulfilledResult<{ commit: string }>).value.commit;
  assert.equal(head(f), winner, "the ref holds the winner's commit");
  assert.equal(f.git("rev-list", "--count", `${a.expectedParent}..HEAD`).trim(), "1", "one commit was added, not two");
  assert.equal(f.git("rev-parse", "HEAD^").trim(), a.expectedParent);
});

test("commit.gpgsign is honoured on the bound path: a failing signer fails the commit instead of recording it unsigned", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  f.git("config", "commit.gpgsign", "true");
  const gpg = join(mkdtempSync(join(f.root, "gpg-")), "sign.sh");
  writeFileSync(gpg, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  f.git("config", "gpg.program", gpg);
  const input = reviewed(f);
  const e = await refusal(executeCommit(f.deps, input));
  assert.equal(e.code, "E_CONFLICT");
  assert.equal(head(f), input.expectedParent);
  assert.ok(f.seen.some((r) => isPtyCommitTree(r) && r.argv.includes("-S")));
});
