// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Axis commit (threat model GIT-3, REV-1, GIT-7; gate 1a/L24). The daemon orchestrates; git runs in the pty
// process, so repository hooks never run in the daemon. The commit is of the tree the user reviewed.
import { branchFor, checkWorktree, daemonGitFor, platformOf, prefix, OBJECT_ID, type DaemonGit } from "./args.js";
import { findOverride, withNoPrompt } from "./env.js";
import { GitOpsError, conflict, denied, internal, invalid, mapUnexpected } from "./errors.js";
import type { GitOpsDeps, GitRunRequest, WorktreeRef } from "./types.js";

export interface CommitInput {
  readonly worktree: WorktreeRef;
  /** The tree hash recorded when the user reviewed the diff (REV-1). */
  readonly reviewedTreeHash: string;
  readonly message: string;
  /**
   * Optional identity the user expects. It is only compared with what the repository config yields and is never
   * passed to git: author and committer come from the config, never from Axis.
   */
  readonly author?: { readonly name: string; readonly email: string };
}

export interface CommitPlan {
  readonly worktree: WorktreeRef;
  readonly branch: string;
  readonly reviewedTreeHash: string;
  readonly parent: string;
  /** Runs in the pty process. */
  readonly command: GitRunRequest;
}

export interface CommitResult {
  readonly commit: string;
  readonly tree: string;
}

const MAX_MESSAGE = 64 * 1024;

function line(r: { stdout: string }): string {
  return r.stdout.trim();
}

async function check(deps: GitOpsDeps, input: CommitInput): Promise<{ plan: CommitPlan; git: DaemonGit }> {
  const platform = platformOf(deps);
  checkWorktree(input.worktree, platform);
  if (!OBJECT_ID.test(input.reviewedTreeHash)) throw invalid("reviewedTreeHash must be a full lower-case object id");
  const msg = input.message;
  if (typeof msg !== "string" || msg.trim().length === 0 || msg.length > MAX_MESSAGE || msg.includes("\0")) {
    throw invalid("the commit message must be non-empty text of at most 64 KiB without NUL");
  }
  const bad = findOverride(deps.env.pty);
  if (bad) throw denied(`the pty git environment must not set ${bad}`);

  if (await deps.isCliRunActive(input.worktree)) throw denied("a CLI run is active in this workspace; commit is refused until it ends");
  await deps.assertNoDrift(input.worktree);

  const git = await daemonGitFor(input.worktree, deps);
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0) throw denied("HEAD is detached; Axis commits only on axis/<slug>");
  const { branch } = branchFor(line(head));

  const index = await git(["write-tree"]);
  if (index.code !== 0) throw conflict("the index cannot be written as a tree (unmerged paths?)");
  if (line(index) !== input.reviewedTreeHash) {
    throw conflict("the index differs from the tree that was reviewed; review the changes again");
  }
  const parentR = await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  if (parentR.code !== 0) throw denied("the branch has no commit to build on");
  const headTree = await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"]);
  if (headTree.code === 0 && line(headTree) === input.reviewedTreeHash) throw invalid("nothing to commit");

  for (const v of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const ident = await git(["var", v]);
    if (ident.code !== 0) throw denied("no Git identity is configured; set user.name and user.email");
    if (input.author && v === "GIT_AUTHOR_IDENT") {
      const m = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(line(ident));
      if (!m || m[1] !== input.author.name || m[2] !== input.author.email) {
        throw denied("the configured Git identity is not the one expected");
      }
    }
  }

  const argv = [
    ...prefix(input.worktree, deps, { context: "pty", hooks: deps.runHooks, filters: [] }),
    "commit", "-F", "-", "--no-edit",
    ...(deps.runHooks ? [] : ["--no-verify"]),
  ];
  const command: GitRunRequest = {
    argv,
    cwd: input.worktree.workTree,
    env: withNoPrompt(deps.env.pty),
    stdin: msg,
    context: "pty",
  };
  return { plan: { worktree: input.worktree, branch, reviewedTreeHash: input.reviewedTreeHash, parent: line(parentR), command }, git };
}

/** Validates everything and returns the exact command. Nothing is written except tree objects. */
export async function planCommit(deps: GitOpsDeps, input: CommitInput): Promise<CommitPlan> {
  return mapUnexpected(async () => (await check(deps, input)).plan);
}

/**
 * Re-validates immediately before running (the plan is not trusted), runs the commit in the pty context, and
 * verifies that the new commit has the reviewed tree and sits directly on the reviewed parent.
 *
 * - A wrong tree on the expected parent is undone by compare-and-swap (new value the parent, old value the commit);
 *   the undo is reported only when `update-ref` really succeeded.
 * - Any other outcome (the parent is not the reviewed one, or the undo failed) leaves the branch alone and reports
 *   E_INTERNAL with `undone: false`: dropping a commit that someone else made is not ours to do.
 */
export function executeCommit(deps: GitOpsDeps, input: CommitInput): Promise<CommitResult> {
  return mapUnexpected(() => runCommit(deps, input));
}

async function runCommit(deps: GitOpsDeps, input: CommitInput): Promise<CommitResult> {
  const { plan, git } = await check(deps, input);
  const r = await deps.runner.run(plan.command);
  if (r.code !== 0) throw conflict(`git commit failed (exit ${r.code})`);
  const commit = line(await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]));
  const tree = line(await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"]));
  const parentR = OBJECT_ID.test(commit) ? await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^1`]) : undefined;
  const parent = parentR?.code === 0 ? line(parentR) : "";
  if (!OBJECT_ID.test(commit) || !OBJECT_ID.test(tree)) {
    throw internal("the new commit could not be read back, so it was not verified", { undone: false });
  }
  if (parent !== plan.parent) {
    throw internal(`the new commit ${commit} is not built on the reviewed base ${plan.parent}: the branch moved while the commit ran; it was not undone`, { undone: false });
  }
  if (tree === plan.reviewedTreeHash) return { commit, tree };
  const undo = await git(["update-ref", "-m", "axis: undo commit of an unreviewed tree", `refs/heads/${plan.branch}`, parent, commit]);
  if (undo.code !== 0) {
    throw internal(`the commit ${commit} did not contain the reviewed tree and could not be undone; the branch was left as it is`, { undone: false });
  }
  throw new GitOpsError("E_CONFLICT", "the commit did not contain the reviewed tree and was undone", { undone: true });
}
