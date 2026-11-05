// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Policy } from "@axis/daemon";
import type { CommitInput } from "@axis/git-ops";
import { GitRefusal } from "../src/index.js";
import { gitRig, gitUnavailable, type GitClient, type GitRig, type GitRigOptions } from "./git-rig.js";

const SKIP = gitUnavailable();
const allowAll: Policy = { evaluate: () => ({ effect: "allow" }) };

async function setup(t: TestContext, options: GitRigOptions = {}, actor = "user"): Promise<{ r: GitRig; c: GitClient }> {
  const r = await gitRig(options);
  t.after(() => r.cleanup());
  return { r, c: await r.connect(actor) };
}

/** Changes a file and reviews it: the three values `commit` sends back. */
async function review(r: GitRig, c: GitClient, content = "one\n", workspaceId = r.workspaceId) {
  r.write("a.txt", content);
  const res = await c.rpc("axis.review", "diff", { workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const { head, branch, treeHash } = res.result as { head: string; branch: string; treeHash: string };
  assert.ok(treeHash);
  return { reviewedTreeHash: treeHash, expectedParent: head, expectedBranch: branch };
}
const commit = (c: GitClient, r: GitRig, req: Record<string, unknown>, key = randomUUID()) => c.rpc("axis.git", "commit", { workspaceId: r.workspaceId, message: "add a", ...req }, key);
const noLeak = (r: GitRig, m: { error?: unknown }): void => {
  const text = JSON.stringify(m.error);
  assert.ok(!text.includes(r.root), "no path in the error");
  assert.ok(!text.includes("remote.git"));
};

test("commit: the commit holds exactly the reviewed tree on the reviewed parent, the branch moves, and no repository hook runs", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const marker = join(r.root, "hook-ran");
  r.write(".git/hooks/pre-commit", `#!/bin/sh\necho ran > "${marker}"\n`);
  try {
    r.git("config", "core.hooksPath", join(r.repo, ".git/hooks"));
    (await import("node:fs")).chmodSync(join(r.repo, ".git/hooks/pre-commit"), 0o755);
  } catch {
    /* a platform without modes: the hook is simply not executable, and still must not run */
  }
  const req = await review(r, c);
  const res = await commit(c, r, req);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const { commit: sha, tree } = res.result as { commit: string; tree: string };
  assert.equal(tree, req.reviewedTreeHash);
  assert.equal(r.git("rev-parse", `${sha}^{tree}`).trim(), req.reviewedTreeHash);
  assert.equal(r.git("rev-parse", `${sha}^`).trim(), req.expectedParent);
  assert.equal(r.head(), sha);
  assert.equal(r.git("log", "-1", "--format=%s").trim(), "add a");
  assert.equal(existsSync(marker), false, "B2: a bound commit runs no hook (H9-hooks)");
  // The reviewed tree is spent: HEAD is new, so the same tree is no longer one the host remembers.
  const again = await commit(c, r, req);
  assert.equal(again.error?.code, "E_CONFLICT");
  assert.equal(again.error?.details?.["reason"], "stale");
  assert.equal(r.head(), sha);
});

test("commit: expectedBranch is checked against the JOURNAL before anything is prepared", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const req = await review(r, c);
  // The journal now says the workspace's branch is another one; the tree entry still names axis/feat.
  r.gate.branchOverride = "axis/other";
  const res = await commit(c, r, req);
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(res.error?.details?.["reason"], "head_moved");
  assert.equal(r.calls.prepare, 0, "the handle was never handed to prepareCommit");
  assert.equal(r.calls.executeCommit, 0);
  assert.equal(r.head(), req.expectedParent);
  // A request naming a branch other than the journal's, with a tree of the right branch, is refused the same way.
  r.gate.branchOverride = undefined;
  const other = await commit(c, r, { ...req, expectedBranch: "axis/other" });
  assert.equal(other.error?.details?.["reason"], "head_moved");
  assert.equal(r.calls.prepare, 0);
  noLeak(r, res);
});

test("commit: a parent that is not the reviewed one is head_moved, a tree no diff produced is stale, and neither prepares anything", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const req = await review(r, c);
  const wrongParent = await commit(c, r, { ...req, expectedParent: "1".repeat(40) });
  assert.equal(wrongParent.error?.details?.["reason"], "head_moved");
  const guess = await commit(c, r, { ...req, reviewedTreeHash: "2".repeat(40) });
  assert.equal(guess.error?.code, "E_CONFLICT");
  assert.equal(guess.error?.details?.["reason"], "stale");
  // A tree the diff of ANOTHER workspace produced is not this workspace's.
  const second = r.newWorkspace();
  const foreign = await review(r, c, "two\n", second);
  const cross = await commit(c, r, foreign);
  assert.equal(cross.error?.details?.["reason"], "stale");
  assert.equal(r.calls.prepare, 0);
  assert.equal(r.head(), req.expectedParent);
});

test("commit: a file changed after the review is refused stale, the branch does not move and the person's staging is untouched", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  r.write("staged.txt", "mine\n");
  r.git("add", "staged.txt");
  const before = r.git("write-tree").trim();
  const req = await review(r, c);
  r.write("a.txt", "changed after the review\n");
  const res = await commit(c, r, req);
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(res.error?.details?.["reason"], "stale");
  assert.equal(r.head(), req.expectedParent);
  assert.equal(r.git("write-tree").trim(), before, "the index is what the person left");
  noLeak(r, res);
});

test("commit: a refusal after the reviewed tree was staged puts the person's own index back", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { ops: (real) => ({ ...real, executeCommit: async () => { throw new GitRefusal("E_CONFLICT", "stale"); } }) });
  r.write("staged.txt", "mine\n");
  r.git("add", "staged.txt");
  const before = r.git("write-tree").trim();
  const req = await review(r, c);
  const res = await commit(c, r, req);
  assert.equal(res.error?.details?.["reason"], "stale");
  assert.equal(r.calls.restoreIndex, 1);
  assert.equal(r.git("write-tree").trim(), before, "restored, not left holding the reviewed tree");
  assert.equal(r.head(), req.expectedParent);
});

test("commit: after the branch already moved, nothing is rewound and the index is left alone", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { ops: (real) => ({ ...real, executeCommit: async () => { throw new GitRefusal("E_INTERNAL", undefined, true); } }) });
  const req = await review(r, c);
  const res = await commit(c, r, req);
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.equal(r.calls.restoreIndex, 0, "updated: the index is not put back");
  // The branch moved, so the reviewed tree is spent: a retry says stale instead of pretending it can still be committed.
  const again = await commit(c, r, req);
  assert.equal(again.error?.details?.["reason"], "stale");
});

test("commit: staging the person did after prepare is not wiped by the put-back", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, {
    review: (real) => ({
      ...real,
      prepare: async (h, ctx) => {
        const p = await real.prepare(h, ctx);
        // The person stages a file (terminal or IDE) between prepare and the refusal.
        r.write("mine.txt", "mine\n");
        r.git("add", "mine.txt");
        return p;
      },
    }),
  });
  const req = await review(r, c);
  const res = await commit(c, r, req);
  assert.equal(res.error?.details?.["reason"], "index_changed");
  assert.equal(r.calls.restoreIndex, 1);
  assert.ok(r.git("diff", "--cached", "--name-only").split("\n").includes("mine.txt"), "the person's staging is still there");
  assert.equal(r.head(), req.expectedParent);
});

test("commit: restoreIndex does not touch the index when HEAD is no longer the reviewed commit", { skip: SKIP ?? false }, async (t) => {
  let other = "";
  const { r, c } = await setup(t, {
    ops: (real) => ({
      ...real,
      executeCommit: async () => {
        // A commit lands (by another tool) before the refusal: the person's staging must not be rewound over it.
        r.git("update-ref", "refs/heads/axis/feat", other);
        throw new GitRefusal("E_UNAVAILABLE");
      },
    }),
  });
  r.write("x.txt", "x\n");
  r.git("add", "x.txt");
  r.git("commit", "-q", "-m", "elsewhere");
  other = r.head();
  r.git("reset", "-q", "--hard", r.baseSha);
  r.write("staged.txt", "mine\n");
  r.git("add", "staged.txt");
  const req = await review(r, c);
  const before = r.git("write-tree").trim();
  await commit(c, r, req);
  assert.equal(r.calls.restoreIndex, 1);
  assert.notEqual(r.git("write-tree").trim(), before, "HEAD moved, so the index was left as it was (holding the reviewed tree)");
});

test("commit: a live run in the workspace refuses it and the person's staging is put back", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { runsActive: true });
  const req = await review(r, c);
  const res = await commit(c, r, req);
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(r.head(), req.expectedParent);
});

test("commit: a handle that is not a review binding is refused by prepareCommit and nothing changes", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const req = await review(r, c);
  const real = r.trees.lookupReviewedTree(r.workspaceId, req.reviewedTreeHash);
  r.trees.record({ ...real, handle: Object.create(Object.getPrototypeOf(real.handle) as object) as never });
  const res = await commit(c, r, req);
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "E_INVALID_ARGUMENT", JSON.stringify(res.error));
  assert.equal(r.calls.executeCommit, 0);
  assert.equal(r.head(), req.expectedParent);
});

test("commit: the hand-over must be the reviewed tree on the reviewed parent and branch", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, {
    review: (real) => ({
      ...real,
      prepare: async (h, ctx) => {
        const p = await real.prepare(h, ctx);
        return { ...p, handoff: async (m, a): Promise<CommitInput> => ({ ...(await p.handoff(m, a)), reviewedTreeHash: "3".repeat(40) }) };
      },
    }),
  });
  const req = await review(r, c);
  const res = await commit(c, r, req);
  assert.equal(res.error?.details?.["reason"], "head_moved");
  assert.equal(r.calls.executeCommit, 0);
  assert.equal(r.calls.restoreIndex, 1);
});

test("commit: a retry is one commit, not two (a replay returns the stored result, a new key is refused)", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const req = await review(r, c);
  const key = randomUUID();
  const first = await commit(c, r, req, key);
  assert.equal(first.ok, true);
  const replay = await commit(c, r, req, key);
  assert.deepEqual(replay.result, first.result);
  const fresh = await commit(c, r, req, randomUUID());
  assert.equal(fresh.error?.code, "E_CONFLICT");
  assert.equal(r.git("rev-list", "--count", "HEAD").trim(), "2");
  assert.equal(r.calls.executeCommit, 1);
});

test("commit: only the user may commit, whatever the policy allows; an unknown or not ready workspace is refused", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { policy: allowAll }, "agent:planner");
  const req = await review(r, await r.connect("user"));
  const res = await commit(c, r, req);
  assert.equal(res.error?.code, "E_NOT_FOUND");
  assert.equal(r.calls.prepare, 0);
  const user = await r.connect("user");
  const unknown = await user.rpc("axis.git", "commit", { workspaceId: "nope", message: "m", ...req }, randomUUID());
  assert.equal(unknown.error?.code, "E_NOT_FOUND");
  r.journal.transitionWorkspace(r.workspaceId, "REMOVING");
  const gone = await commit(user, r, req);
  assert.equal(gone.ok, false);
  assert.equal(r.calls.prepare, 0);
  assert.equal(r.head(), req.expectedParent);
});
