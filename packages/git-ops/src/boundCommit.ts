// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// G3: the commit is made from the reviewed tree and the expected parent with `commit-tree`, and the branch is moved by
// compare-and-swap, so it cannot land on a parent other than the reviewed one and cannot overwrite a racing commit.
import { OBJECT_ID, type DaemonGit } from "./args.js";
import { GitOpsError, conflict, headMoved, internal } from "./errors.js";
import { assertNoOperation } from "./operation.js";
import type { CommitPlan, CommitResult } from "./commit.js";
import type { GitOpsDeps } from "./types.js";

const line = (r: { stdout: string }): string => r.stdout.trim();

/** Nothing was written to the branch. */
const notUpdated = { updated: false } as const;

/**
 * Runs the plan's `commit-tree` (pty context), verifies the object it made, re-checks HEAD, the branch and the operation
 * state, and only then moves `refs/heads/<branch>` from the expected parent to the new commit in one atomic update.
 * A failure before the update leaves the branch alone (a dangling commit object is the only residue).
 */
export async function runBound(deps: GitOpsDeps, plan: CommitPlan, git: DaemonGit): Promise<CommitResult> {
  const r = await deps.runner.run(plan.command);
  if (r.code !== 0) throw conflict(`git commit-tree failed (exit ${r.code}); the branch was not updated`);
  const commit = line(r);
  if (!OBJECT_ID.test(commit)) throw internal("commit-tree did not return a commit id; the branch was not updated", notUpdated);

  // Verify the object itself: exactly one parent, the expected one, and the reviewed tree.
  const parents = await git(["rev-list", "--parents", "-n", "1", "--end-of-options", commit]);
  const ids = line(parents).split(" ");
  if (parents.code !== 0 || ids.length !== 2 || ids[0] !== commit || ids[1] !== plan.parent) {
    throw internal(`the new commit ${commit} is not built on the reviewed base ${plan.parent}; the branch was not updated`, notUpdated);
  }
  const tree = await git(["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]);
  if (tree.code !== 0 || line(tree) !== plan.reviewedTreeHash) {
    throw internal(`the new commit ${commit} does not hold the reviewed tree; the branch was not updated`, notUpdated);
  }

  // Immediately before the ref update: the branch and the operation state are asked again. That the branch is still on the
  // expected parent is not asked here: the compare-and-swap below is the one check that cannot race.
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0 || line(head) !== plan.branch) throw headMoved("HEAD is no longer on the reviewed branch; the branch was not updated");
  await assertNoOperation(git, plan.worktree, deps);

  // `symbolic-ref HEAD` resolves a chain of symbolic refs, so the name below is a real branch. The old value makes this a compare-and-swap: it fails if the branch is anywhere but the expected parent.
  const ref = `refs/heads/${plan.branch}`;
  const update = await git(["update-ref", "-m", "axis: commit", ref, commit, plan.parent]);
  if (update.code !== 0) {
    const now = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (now.code !== 0 || line(now) !== plan.parent) throw headMoved("the branch moved while the commit was made; it was left as it is");
    throw new GitOpsError(
      "E_CONFLICT",
      "the branch could not be updated (git refused the compare-and-swap, for example a lock); it was left as it is",
      { reason: "ref_update_failed" },
    );
  }
  const after = await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (after.code !== 0 || line(after) !== commit) {
    throw internal(`the branch no longer points at the new commit ${commit}`, { updated: true, rolledBack: false });
  }
  return { commit, tree: plan.reviewedTreeHash };
}
