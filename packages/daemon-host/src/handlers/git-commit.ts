// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Handler, HandlerContext } from "@axis/daemon";
import { gitCommitRequestSchema } from "@axis/protocol";
import type { PreparedCommitPort } from "../ports/review.js";
import { gitFailure } from "./git-errors.js";
import { locate, mapError, portContext, requireUser, workspaceFor, type GitHandlerDeps } from "./git-common.js";

/**
 * `axis.git/1.commit` (tier 2, idempotency required). The commit is of the tree the user reviewed, on the parent and branch
 * they reviewed it on, and of nothing else.
 *
 * Order, all under the project mutex and with the journal row read INSIDE it:
 *  1. the request's `expectedBranch` must be the workspace's own branch in the JOURNAL (never whatever a process checked out);
 *  2. the reviewed tree must be one a `diff` of THIS workspace produced (`lookupReviewedTree`: a guess, another workspace's
 *     tree, a tree from before a restart or one forgotten for the bound is `stale`), and its parent and branch must be the
 *     request's. Only plain data of the stored entry is read here; the opaque `handle` is passed, unread, to
 *     `CommitPreparer.prepare`, whose `prepareCommit` is the real brand check (a forged handle is refused there);
 *  3. `prepare` re-checks HEAD, the branch, any operation in progress and every file, and stages the reviewed tree;
 *  4. `handoff` and `executeCommit` (the freshness check `assertReviewFresh` runs inside it, as its last step before git).
 * A refusal after step 3 puts the person's own staging back, unless the branch may already have moved.
 *
 * DECISION B2 (OPEN, ticket H9-hooks): the commit runs NO repository hook (`commit-tree` plus a compare-and-swap
 * `update-ref` run none, and the daemon never runs one). Nothing is audited as "made without hooks". See docs/packages.md.
 *
 * Idempotency: a handler that throws frees the key (the daemon marks it unknown only when a handler returns or is aborted).
 * That is safe here because the commit is pinned: a retry of a commit that did land finds the branch off the reviewed
 * parent and is refused `head_moved`, never a second commit. After the branch moved this handler never throws.
 */
export function createGitCommitHandler(deps: GitHandlerDeps): Handler {
  return async (context: HandlerContext, payload: never) => {
    requireUser(context);
    const request = gitCommitRequestSchema.safeParse(payload);
    if (!request.success) throw gitFailure("E_INVALID_ARGUMENT");
    const { workspaceId, reviewedTreeHash, expectedParent, expectedBranch, message, author } = request.data;
    const { signal } = context;
    try {
      const first = workspaceFor(deps, workspaceId, "commit", true);
      return await deps.mutex.run(
        first.projectId,
        async () => {
          const ws = workspaceFor(deps, workspaceId, "commit", true);
          if (ws.projectId !== first.projectId) throw gitFailure("E_NOT_FOUND");
          if (expectedBranch !== ws.branch) throw gitFailure("E_CONFLICT", "head_moved");
          const entry = deps.trees.lookupReviewedTree(workspaceId, reviewedTreeHash);
          if (entry.parent !== expectedParent || entry.branch !== expectedBranch) throw gitFailure("E_CONFLICT", "head_moved");
          await locate(deps, workspaceId); // a workspace whose worktree is gone is refused before any git call
          if (signal.aborted) throw gitFailure("E_CANCELLED");

          const prepared = await deps.review.prepare(entry.handle, portContext(context));
          let landed = false;
          try {
            const input = await prepared.handoff(message, author);
            // What the binding hands over must be what was asked for: a hand-over of another tree or parent is refused.
            if (input.reviewedTreeHash !== reviewedTreeHash || input.expectedParent !== expectedParent || input.expectedBranch !== expectedBranch) {
              throw gitFailure("E_CONFLICT", "head_moved");
            }
            if (signal.aborted) throw gitFailure("E_CANCELLED");
            const result = await deps.ops.executeCommit({ workspaceId, assertFresh: () => deps.review.assertFresh(entry.handle) }, input);
            landed = true;
            return finish(deps, workspaceId, result);
          } catch (e) {
            // The branch is moved only by the compare-and-swap at the very end; a failure that says it happened leaves the index alone.
            if ((e as { updated?: unknown } | null)?.updated === true) forgetTrees(deps, workspaceId); // it did land: the reviewed tree is spent
            else if (!landed) await restore(prepared);
            throw e;
          }
        },
        signal,
      );
    } catch (e) {
      throw mapError(deps, e, signal);
    }
  };
}

async function restore(prepared: PreparedCommitPort): Promise<void> {
  try {
    await prepared.restoreIndex();
  } catch {
    // restoreIndex never throws by contract; a port that does must not hide the refusal.
  }
}

/**
 * After the branch moved: forget the trees of the workspace (HEAD is new, every one is stale) and answer. Never throws:
 * the reply is not re-validated here, because a throw would free the idempotency key of a commit that landed (the daemon
 * checks the reply against the contract itself, and marks the key unknown if it is wrong).
 */
function finish(deps: GitHandlerDeps, workspaceId: string, result: { readonly commit: string; readonly tree: string }) {
  forgetTrees(deps, workspaceId);
  return { commit: result.commit, tree: result.tree };
}

function forgetTrees(deps: GitHandlerDeps, workspaceId: string): void {
  try {
    deps.trees.forget(workspaceId);
  } catch {
    // The lookup only ever refuses more; a failure to forget is not a failure of the commit.
  }
}
