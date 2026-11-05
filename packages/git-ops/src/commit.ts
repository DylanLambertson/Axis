// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Axis commit (threat model GIT-3, REV-1, GIT-7; gate 1a/L24). The commit is of the tree the user reviewed, on the parent
// and branch they reviewed it on: it is built with commit-tree in the pty context and the branch is moved by compare-and-swap.
// Commit hooks do not run on this path (OPEN DECISION for the owner, see docs/packages.md "Commit hooks").
import { branchFor, checkWorktree, daemonGitFor, platformOf, prefix, OBJECT_ID, type DaemonGit } from "./args.js";
import { findOverride, identityOverrides, overrideMessage, withNoPrompt } from "./env.js";
import { runBound } from "./boundCommit.js";
import { GitOpsError, conflict, denied, headMoved, invalid, mapUnexpected } from "./errors.js";
import { assertNoOperation } from "./operation.js";
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
  /**
   * G3, REQUIRED: the full commit id HEAD pointed at when the diff was reviewed. The commit is built with `commit-tree` from
   * `reviewedTreeHash` and this parent, verified against the new object, and the branch is moved by compare-and-swap
   * from this value, so it cannot land on another parent or overwrite a commit made meanwhile. HEAD elsewhere:
   * E_CONFLICT `details.reason: "head_moved"`. A malformed id: E_INVALID_ARGUMENT.
   */
  readonly expectedParent: string;
  /**
   * G3, REQUIRED: the SHORT name of the branch that was checked out at review time, `axis/<slug>` (not `refs/heads/...`, not
   * null). A full ref or a non-string is E_INVALID_ARGUMENT, another name E_POLICY_DENIED; a different checked-out
   * branch is `head_moved`. A detached HEAD or an unborn branch cannot be committed to: E_POLICY_DENIED.
   */
  readonly expectedBranch: string;
}

export interface CommitPlan {
  readonly worktree: WorktreeRef;
  readonly branch: string;
  readonly reviewedTreeHash: string;
  readonly parent: string;
  /** `commit-tree`, run in the pty process. It prints the new commit id and moves no ref; use `executeCommit`. */
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
  if (typeof input.expectedParent !== "string" || !OBJECT_ID.test(input.expectedParent)) throw invalid("expectedParent must be a full lower-case object id");
  if (typeof input.expectedBranch !== "string" || input.expectedBranch.startsWith("refs/")) {
    throw invalid("expectedBranch must be the short branch name axis/<slug>");
  }
  branchFor(input.expectedBranch);
  const bad = findOverride(deps.env.pty);
  if (bad) throw denied(overrideMessage(bad));

  if (await deps.isCliRunActive(input.worktree)) throw denied("a CLI run is active in this workspace; commit is refused until it ends");
  await deps.assertNoDrift(input.worktree);

  const git = await daemonGitFor(input.worktree, deps);
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0) throw denied("HEAD is detached; Axis commits only on axis/<slug>");
  const { branch } = branchFor(line(head));

  if (branch !== input.expectedBranch) throw headMoved("the checked-out branch is not the one that was reviewed");
  const parentR = await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  if (parentR.code !== 0) throw denied("the branch has no commit to build on");
  if (line(parentR) !== input.expectedParent) throw headMoved("HEAD is not the commit that was reviewed; review the changes again");
  await assertNoOperation(git, input.worktree, deps);

  const index = await git(["write-tree"]);
  if (index.code !== 0) throw conflict("the index cannot be written as a tree (unmerged paths?)");
  if (line(index) !== input.reviewedTreeHash) {
    throw conflict("the index differs from the tree that was reviewed; review the changes again");
  }
  const headTree = await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"]);
  if (headTree.code === 0 && line(headTree) === input.reviewedTreeHash) throw invalid("nothing to commit");

  const pty = identityOverrides(deps.env.pty);
  for (const [v, role] of [["GIT_AUTHOR_IDENT", "author"], ["GIT_COMMITTER_IDENT", "committer"]] as const) {
    const ident = await git(["var", v]);
    if (ident.code !== 0) throw denied("no Git identity is configured; set user.name and user.email");
    const m = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(line(ident));
    if (!m) throw denied("the configured Git identity could not be read");
    if (input.author && role === "author" && (m[1] !== input.author.name || m[2] !== input.author.email)) {
      throw denied("the configured Git identity is not the one expected");
    }
    // A user's own GIT_AUTHOR_* in a shell profile is fine while it says what the config says; one that would change
    // the recorded name or email is refused.
    for (const [r, field, value] of pty) {
      if (r === role && value !== (field === "name" ? m[1] : m[2])) {
        throw denied(`the pty environment sets GIT_${role.toUpperCase()}_${field.toUpperCase()} to something other than the configured identity; unset it or make it match user.${field}`);
      }
    }
  }

  // commit-tree ignores commit.gpgsign, so the setting is read and honoured here rather than silently dropped.
  const sign = await gpgSigning(deps, input.worktree);
  const command: GitRunRequest = {
    argv: [
      ...prefix(input.worktree, deps, { context: "pty", hooks: deps.runHooks, filters: [] }),
      // A repository can set i18n.commitEncoding; the message is recorded as UTF-8 so that the secret scan reads what is pushed.
      "-c", "i18n.commitEncoding=utf-8",
      "commit-tree", ...(sign ? ["-S"] : []), "-p", input.expectedParent, "-F", "-", input.reviewedTreeHash,
    ],
    cwd: input.worktree.workTree,
    env: withNoPrompt(deps.env.pty),
    stdin: normalisedMessage(msg),
    context: "pty",
  };
  if (deps.assertReviewFresh) await reviewFresh(deps, input);
  return { plan: { worktree: input.worktree, branch, reviewedTreeHash: input.reviewedTreeHash, parent: line(parentR), command }, git };
}

/**
 * Git's default cleanup (`stripspace`): trailing white space (space, tab, CR, VT, FF) removed from every line, runs of blank
 * lines collapsed, none at the start or end, one final newline. `commit.cleanup` and comment stripping are not applied
 * (commit-tree has neither); a non-breaking space is not white space to git and is kept.
 */
function normalisedMessage(msg: string): string {
  const lines = msg.split("\n").map((l) => l.replace(/[ \t\r\v\f]+$/, ""));
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  while (out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}

/** `commit.gpgsign` as the pty context sees it. An unreadable or non-boolean value refuses rather than commits unsigned. */
async function gpgSigning(deps: GitOpsDeps, w: WorktreeRef): Promise<boolean> {
  const r = await deps.runner.run({
    argv: [...prefix(w, deps, { context: "pty", hooks: deps.runHooks, filters: [] }), "config", "--type=bool", "--get", "commit.gpgsign"],
    cwd: w.workTree,
    env: withNoPrompt(deps.env.pty),
    context: "pty",
  });
  if (r.code === 1) return false;
  if (r.code !== 0) throw denied("commit.gpgsign could not be read as true or false");
  return r.stdout.trim() === "true";
}

/** G2. The hook refuses by throwing; a value it returns is a refusal too, so a wrong wiring cannot fail open. */
async function reviewFresh(deps: GitOpsDeps, input: CommitInput): Promise<void> {
  let returned: unknown;
  try {
    returned = await (deps.assertReviewFresh as NonNullable<GitOpsDeps["assertReviewFresh"]>)(input.worktree, input.reviewedTreeHash);
  } catch (e) {
    if (e instanceof GitOpsError && e.code !== "E_CONFLICT") throw e;
    throw new GitOpsError("E_CONFLICT", "the worktree changed after the review; review the changes again", { reason: "stale" });
  }
  if (returned !== undefined) {
    throw new GitOpsError("E_CONFLICT", "the review freshness check returned a value instead of passing; treating the review as stale", { reason: "stale" });
  }
}

/** Validates everything and returns the exact command. Nothing is written except tree objects. */
export async function planCommit(deps: GitOpsDeps, input: CommitInput): Promise<CommitPlan> {
  return mapUnexpected(async () => (await check(deps, input)).plan);
}

/**
 * Re-validates immediately before running (the plan is not trusted), then builds the commit with `commit-tree` (pty
 * context), verifies the new object (one parent, the expected one; the reviewed tree) and moves the branch with a
 * compare-and-swap from `expectedParent`. A failure before the update leaves the branch where it was; after a successful
 * update that fails its read-back the commit is NOT rolled back (E_INTERNAL, `updated: true`).
 */
export function executeCommit(deps: GitOpsDeps, input: CommitInput): Promise<CommitResult> {
  return mapUnexpected(async () => {
    const { plan, git } = await check(deps, input);
    return runBound(deps, plan, git);
  });
}
