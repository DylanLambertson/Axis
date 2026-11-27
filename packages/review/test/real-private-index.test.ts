// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-0 slice 1 (ADR 0011 decision S1, `docs/design/own-shell-plan.md` DC-0): an Axis commit never stages into the real index.
// `prepareCommit` checks the reviewed tree in a private index in the daemon's scratch directory, and git-ops builds the commit
// from the tree object, so the user's `.git/index` is byte-identical after a commit and after every refusal. Real repositories.
// Mutants: `prepareCommit` staging into the real index (`read-tree` without the private index), the put-back writing it on a
// refusal, git-ops comparing the real index with the reviewed tree (a commit over the user's own staging is then refused).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GitOpsError, executeCommit } from "@axis/git-ops";
import { ReviewSession, prepareCommit, type ReviewBinding } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./fixture.js";

const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");
const indexBytes = (f: Fixture): Buffer => readFileSync(join(f.repo, ".git", "index"));
/** One path's stage-0 entry in the real index as `mode oid`, read without writing it. */
const stagedOf = (f: Fixture, path: string): string => f.git("ls-files", "--stage", "--", path).replace(/^(\d+) (\S+) 0\t.*\n$/, "$1 $2");

/** The user's own staging, different from HEAD and from what will be reviewed: a staged new file and a staged edit. */
function userStaging(f: Fixture): Buffer {
  f.write("staged.txt", "the user's git add\n");
  f.write("keep.txt", "keep, staged by the user\n");
  f.git("add", "staged.txt", "keep.txt");
  f.write("keep.txt", "keep, edited again after staging\n");
  return indexBytes(f);
}
async function reviewedA(f: Fixture): Promise<ReviewBinding> {
  f.write("a.txt", BASE.replace("l2\n", "L2\n"));
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  s.acceptFile("a.txt");
  return s.build();
}
async function gitOpsRefusal(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  return assert.fail("expected a refusal");
}

test("a commit keeps the user's own staging in the real index, refreshes only what equalled old HEAD, and holds exactly the reviewed tree", async () => {
  const f = fixture();
  try {
    const before = userStaging(f);
    const stagedBefore = new Map(["staged.txt", "keep.txt"].map((p) => [p, stagedOf(f, p)]));
    const b = await reviewedA(f);
    const prepared = await prepareCommit(f.deps, b);
    assert.deepEqual(indexBytes(f), before, "prepare wrote nothing to the real index (kills staging into it)");
    const result = await executeCommit(f.gitOps, await prepared.handoff("accept a.txt"));
    assert.equal(result.tree, b.reviewedTree);
    assert.equal(f.git("rev-parse", "HEAD^{tree}").trim(), b.reviewedTree);
    assert.equal(f.git("rev-parse", "HEAD~1").trim(), b.head);
    // After the commit only the narrow refresh writes the index (DC-0 slice 2): a.txt, still equal to old HEAD, becomes new
    // HEAD's entry; the user's own staged entries are kept as they were.
    assert.deepEqual(result.indexRefresh, { refreshed: 1 }, "kills git-ops comparing the real index: the commit would be refused");
    for (const p of ["staged.txt", "keep.txt"]) assert.equal(stagedOf(f, p), stagedBefore.get(p), `${p}: the user's staging is kept`);
    assert.equal(stagedOf(f, "a.txt"), f.git("ls-tree", "HEAD", "a.txt").replace(/^(\d+) blob (\S+)\t.*\n$/, "$1 $2"));
    assert.equal(f.git("cat-file", "-p", "HEAD:keep.txt"), "keep\n", "the user's staged keep.txt is not committed");
    assert.throws(() => f.git("cat-file", "-e", "HEAD:staged.txt"), "the user's staged new file is not committed");
    assert.ok(f.indexes.created > 0);
    assert.equal(f.indexes.disposed, f.indexes.created, "every private index was disposed");
  } finally {
    f.cleanup();
  }
});

test("every refusal leaves the real index byte-identical: stale after review, HEAD moved after prepare, and git-ops refusing", async () => {
  // A file edited after the review: prepare refuses.
  const stale = fixture();
  try {
    const before = userStaging(stale);
    const b = await reviewedA(stale);
    stale.write("a.txt", `${BASE}late\n`);
    assert.equal((await refusal(prepareCommit(stale.deps, b))).details?.["reason"], "stale");
    assert.deepEqual(indexBytes(stale), before);
  } finally {
    stale.cleanup();
  }
  // HEAD moved between prepare and the hand-over, then between the hand-over and git-ops.
  for (const at of ["handoff", "commit"] as const) {
    const f = fixture();
    try {
      const before = userStaging(f);
      const b = await reviewedA(f);
      const prepared = await prepareCommit(f.deps, b);
      const input = at === "commit" ? await prepared.handoff("m") : undefined;
      const foreign = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "foreign").trim();
      f.git("update-ref", "refs/heads/axis/feat", foreign);
      if (input === undefined) assert.equal((await refusal(prepared.handoff("m"))).details?.["reason"], "head_moved");
      else assert.equal((await gitOpsRefusal(executeCommit(f.gitOps, input))).details?.["reason"], "head_moved");
      assert.deepEqual(indexBytes(f), before, `${at}: the refusal wrote nothing to the real index (kills the put-back)`);
    } finally {
      f.cleanup();
    }
  }
});

test("git-ops commits the reviewed tree object, not the index, and refuses an id that is not a tree", async () => {
  const f = fixture();
  try {
    const b = await reviewedA(f);
    const blob = f.git("rev-parse", "HEAD:a.txt").trim();
    for (const bad of [blob, "0".repeat(blob.length)]) {
      const e = await gitOpsRefusal(executeCommit(f.gitOps, { worktree: f.wt, reviewedTreeHash: bad, message: "m", expectedParent: f.head(), expectedBranch: "axis/feat" }));
      assert.ok(e.code === "E_CONFLICT" || e.code === "E_INVALID_ARGUMENT", `${bad}: ${e.code}`);
    }
    const result = await executeCommit(f.gitOps, { worktree: f.wt, reviewedTreeHash: b.reviewedTree, message: "m", expectedParent: f.head(), expectedBranch: "axis/feat" });
    assert.equal(result.tree, b.reviewedTree, "the index (still HEAD's) was never asked");
    assert.equal(f.git("write-tree").trim(), b.reviewedTree, "then the refresh made the index new HEAD's");
  } finally {
    f.cleanup();
  }
});

test("a sparse checkout is still refused, with the index untouched: its files outside the cone would be committed as deleted", async () => {
  const f = fixture();
  try {
    const b = await reviewedA(f);
    f.git("config", "core.sparseCheckout", "true");
    const before = indexBytes(f);
    assert.equal((await refusal(prepareCommit(f.deps, b))).code, "E_UNAVAILABLE");
    assert.deepEqual(indexBytes(f), before);
  } finally {
    f.cleanup();
  }
});

test("core.splitIndex=true: the private index writes no sharedindex file into the repository (review 1 S1)", async () => {
  const f = fixture();
  try {
    f.git("config", "core.splitIndex", "true");
    const shared = (): string[] => readdirSync(join(f.repo, ".git")).filter((n) => n.startsWith("sharedindex.")).sort();
    const before = { shared: shared(), index: indexBytes(f) };
    const b = await reviewedA(f);
    await prepareCommit(f.deps, b);
    assert.deepEqual({ shared: shared(), index: indexBytes(f) }, before, "kills a private-index call without the split-index pin");
  } finally {
    f.cleanup();
  }
});
