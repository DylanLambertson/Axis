// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { daemonGitFor, OBJECT_ID } from "@axis/git-ops";
import { MAX_REVIEW_FILES, MAX_REVIEW_PATH } from "@axis/protocol";
import { ReviewBinding, ReviewError, ReviewSession, checkFresh, prepareCommit, type ProtectedPathMatcher, type ReviewDeps, type ReviewLimits, type TempIndexProvider } from "@axis/review";
import type { GitPort } from "../ports/git.js";
import { ReviewRefusal, type BuiltTree, type CommitPreparer, type ReviewHandle, type ReviewRound, type ReviewService } from "../ports/review.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";

/**
 * The binding of the review port over `@axis/review` (with `review-tempindex.ts`, the only files that import it, design section 2.1).
 *
 * The session is built with `maxFiles` and `maxDisplay` at the wire's bounds, so a change set the reply could not list in
 * full fails the review (`too_large`) instead of being cut. Every `ReviewError` becomes a `ReviewRefusal` that carries the
 * code and the closed `reason` only: the review's own messages can name display paths, and nothing here forwards them.
 */
export interface ReviewBindingDeps {
  readonly git: GitPort;
  readonly locator: WorktreeLocator;
  readonly tempIndex: TempIndexProvider;
  readonly fileExists: (absolutePath: string) => Promise<boolean>;
  readonly protectedPaths?: ProtectedPathMatcher;
  /** Lower bounds only (tests); never above the wire's. */
  readonly limits?: Partial<ReviewLimits>;
}

const HEADS = "refs/heads/";

function refuse(e: unknown): never {
  if (e instanceof ReviewRefusal) throw e;
  if (e instanceof ReviewError) {
    const reason = e.details?.["reason"];
    throw new ReviewRefusal(e.code, typeof reason === "string" ? reason : undefined);
  }
  const code = (e as { code?: unknown } | null)?.code;
  // An error with an own code from git-ops (a refusal of its own) keeps only the code; anything else is "unavailable".
  throw new ReviewRefusal(typeof code === "string" && /^E_[A-Z_]{2,30}$/.test(code) ? code : "E_UNAVAILABLE");
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return refuse(e);
  }
}

function reviewDepsOf(deps: ReviewBindingDeps): ReviewDeps {
  const limits: Partial<ReviewLimits> = {
    ...deps.limits,
    maxFiles: Math.min(deps.limits?.maxFiles ?? MAX_REVIEW_FILES, MAX_REVIEW_FILES),
    maxDisplay: Math.min(deps.limits?.maxDisplay ?? MAX_REVIEW_PATH, MAX_REVIEW_PATH),
  };
  return {
    git: deps.git,
    tempIndex: deps.tempIndex,
    fileExists: deps.fileExists,
    ...(deps.protectedPaths === undefined ? {} : { protectedPaths: deps.protectedPaths }),
    limits,
  };
}

export function createReviewService(deps: ReviewBindingDeps): ReviewService {
  const reviewDeps = reviewDepsOf(deps);

  return {
    open: (workspaceId, ctx) =>
      guarded(async (): Promise<ReviewRound> => {
        const worktree = await deps.locator.locate(workspaceId);
        if (ctx.signal.aborted) throw new ReviewRefusal("E_CANCELLED");
        const git = await daemonGitFor(worktree, deps.git);
        const head = (await git(["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
        if (!OBJECT_ID.test(head)) throw new ReviewRefusal("E_POLICY_DENIED", "no_head");
        const sym = await git(["symbolic-ref", "--quiet", "HEAD"]);
        const ref = sym.stdout.trim();
        const branch = sym.code === 0 && ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null;
        const session = await ReviewSession.start(reviewDeps, { worktree, against: head });
        return {
          head,
          branch,
          files: session.files.map((f) => ({
            path: f.path,
            ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
            status: f.status,
            kind: f.kind,
            newMode: f.newMode,
            newOid: f.newOid,
            ...(f.similarity === undefined ? {} : { similarity: f.similarity }),
            ...(f.additions === undefined ? {} : { additions: f.additions }),
            ...(f.deletions === undefined ? {} : { deletions: f.deletions }),
            unsafePath: f.unsafePath,
            protectedRules: f.protectedRules,
            ...(f.fileLevelReason === undefined ? {} : { fileLevelReason: f.fileLevelReason }),
            warnings: f.warnings,
          })),
          skipped: session.skipped.map((s) => ({ path: s.path, size: s.size })),
          skippedCount: session.skippedCount,
          hasCutLines: (path) => guarded(() => session.hasCutLines(path)),
          accept: (path, options) => {
            try {
              session.acceptFile(path, options.acceptTruncated ? { acceptTruncated: true } : {});
            } catch (e) {
              refuse(e);
            }
          },
          build: () =>
            guarded(async (): Promise<BuiltTree> => {
              const binding = await session.build();
              if (binding.branch === null || !binding.branch.startsWith(HEADS)) throw new ReviewRefusal("E_POLICY_DENIED", "detached_head");
              return { reviewedTree: binding.reviewedTree, head: binding.head, branch: binding.branch.slice(HEADS.length), handle: binding as unknown as ReviewHandle };
            }),
        };
      }),
  };
}

/**
 * Narrowing for the git handler (ticket H9): the review package's own binding behind an opaque handle. The check here is
 * a type guard only; `prepareCommit` of `@axis/review` is the real brand check and must be what H9 relies on.
 */
export function reviewBindingOf(handle: ReviewHandle): ReviewBinding {
  if (!(handle instanceof ReviewBinding)) throw new ReviewRefusal("E_INTERNAL");
  return handle;
}

/**
 * The commit side of the review binding (ticket H9): `prepareCommit`, its `handoff`, `checkFresh` for `assertReviewFresh`,
 * and the put-back of the person's own index when a prepared commit is refused. `prepareCommit` is the brand check: the
 * handle is passed to it before anything is read from it. Every failure is a `ReviewRefusal` (code and closed reason).
 */
export function createCommitPreparer(deps: ReviewBindingDeps): CommitPreparer {
  const reviewDeps = reviewDepsOf(deps);
  return {
    prepare: (handle, ctx) =>
      guarded(async () => {
        if (ctx.signal.aborted) throw new ReviewRefusal("E_CANCELLED");
        const prepared = await prepareCommit(reviewDeps, reviewBindingOf(handle));
        return {
          handoff: (message, author) => guarded(() => prepared.handoff(message, author)),
          restoreIndex: async (): Promise<void> => {
            const previous = prepared.previousIndexTree;
            if (previous === undefined) return;
            try {
              const git = await daemonGitFor(prepared.worktree, deps.git);
              // Only while HEAD is still the reviewed commit: a commit that may have landed is never rewound under the person.
              const head = (await git(["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
              // And only while the index still holds what Axis staged: anything the person staged since is theirs. A window of one
              // git call remains between this check and `read-tree` (closing it would need the restore to hold index.lock).
              const staged = (await git(["write-tree"])).stdout.trim();
              if (head === prepared.head && staged === prepared.reviewedTreeHash) await git(["read-tree", previous]);
            } catch {
              // The index is the person's staging only; a failed put-back is not worth masking the refusal that caused it.
            }
          },
        };
      }),
    assertFresh: (handle) =>
      guarded(async () => {
        const fresh = await checkFresh(reviewDeps, reviewBindingOf(handle));
        if (!fresh.fresh) throw new ReviewRefusal("E_CONFLICT", fresh.reason);
      }),
  };
}
