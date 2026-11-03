// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Axis push (threat model GIT-3, GIT-SNAP-1 re-take, PSH-1, GIT-7; gate 1a/L24). Explicit refspec only.
import { OBJECT_ID, REMOTE_NAME, branchFor, checkWorktree, daemonGitFor, platformOf, prefix, type DaemonGit } from "./args.js";
import { findOverride, overrideMessage, withNoPrompt } from "./env.js";
import { assertPushUrl, protocolAllowList } from "./pushUrl.js";
import { scanOutgoing } from "./scan.js";
import { GitOpsError, conflict, denied, invalid, mapUnexpected, redactUrls, sanitizeText } from "./errors.js";
import type { GitOpsDeps, GitRunRequest, SecretFinding, WorktreeRef } from "./types.js";

export interface PushInput {
  readonly worktree: WorktreeRef;
  /** A configured remote name. Never a URL. */
  readonly remote: string;
  /** `axis/<slug>`. */
  readonly branch: string;
  /**
   * The workspace's recorded base, or the last SHA Axis pushed, from the journal: a full object id. The scanned range
   * is `baseSha..tip`. Refs under refs/remotes are never used for this: the code in the worktree can write them and they go stale.
   */
  readonly baseSha: string;
  /**
   * Paths (exact, repository-relative) that may be pushed although git treats them as binary. In refuse mode any other
   * binary path refuses the push, because a `-diff` attribute or a NUL byte hides content from pattern matching.
   */
  readonly allowedBinaryPaths?: readonly string[];
}

export interface PushPlan {
  readonly worktree: WorktreeRef;
  readonly remote: string;
  readonly branch: string;
  /** The scanned commit, which is what is pushed. */
  readonly tip: string;
  /** Exactly `<tip>:refs/heads/axis/<slug>`. */
  readonly refspec: string;
  /** Runs in the pty process. */
  readonly command: GitRunRequest;
  /** Rule names, paths and lines only; never the matched text. */
  readonly findings: readonly SecretFinding[];
  readonly requiresConfirmation: boolean;
  /** Why confirmation is required: matches, binary content. Never the matched text. */
  readonly reasons: readonly string[];
}

/** The pinned source: the scanned tip, by object id, so a commit made after the scan cannot ride along. */
export function pushRefspec(tip: string, slug: string): string {
  return `${tip}:refs/heads/axis/${slug}`;
}

/** True only for the one refspec Axis pushes: a full object id into refs/heads/axis/<slug>. No '+', wildcard, tag or delete. */
export function isAllowedRefspec(spec: string): boolean {
  const m = /^([0-9a-f]{40}|[0-9a-f]{64}):refs\/heads\/axis\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/.exec(spec);
  return m !== null;
}

/** The branch must still be checked out and still point at the scanned commit. */
async function confirmTip(git: DaemonGit, branch: string, tip: string): Promise<void> {
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const now = await git(["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  if (head.code !== 0 || head.stdout.trim() !== branch || now.code !== 0 || now.stdout.trim() !== tip) {
    throw conflict("the branch changed after it was scanned; review and push again");
  }
}

async function check(deps: GitOpsDeps, input: PushInput): Promise<{ plan: PushPlan; git: DaemonGit }> {
  checkWorktree(input.worktree, platformOf(deps));
  if (typeof input.remote !== "string" || input.remote.startsWith("-") || !REMOTE_NAME.test(input.remote)) {
    throw invalid("the remote must be a configured remote name, not a URL or an option");
  }
  const { branch, slug } = branchFor(input.branch);
  if (typeof input.baseSha !== "string" || !OBJECT_ID.test(input.baseSha)) {
    throw invalid("baseSha must be the journaled base commit as a full lower-case object id");
  }
  const bad = findOverride(deps.env.pty);
  if (bad) throw denied(overrideMessage(bad));

  if (await deps.isCliRunActive(input.worktree)) throw denied("a CLI run is active in this workspace; push is refused until it ends");

  const git = await daemonGitFor(input.worktree, deps);
  const remotes = (await git(["remote"])).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!remotes.includes(input.remote)) throw invalid("the remote is not configured in this repository");
  const urls = await git(["remote", "get-url", "--push", "--all", "--", input.remote]);
  if (urls.code !== 0) throw invalid("the remote has no push URL");
  for (const u of urls.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) assertPushUrl(u);
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== branch) throw denied("the worktree is not on the branch being pushed");
  const tip = await git(["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  if (tip.code !== 0) throw invalid("the branch has no commits");
  const tipSha = tip.stdout.trim();
  if (!OBJECT_ID.test(tipSha)) throw invalid("the branch has no commits");
  const refspec = pushRefspec(tipSha, slug);
  if (!isAllowedRefspec(refspec)) throw denied("refspec not allowed");

  const base = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.baseSha}^{commit}`]);
  if (base.code !== 0) throw conflict("the recorded base commit is not in this repository");
  const ancestor = await git(["merge-base", "--is-ancestor", input.baseSha, tipSha]);
  if (ancestor.code !== 0) throw conflict("the recorded base is not an ancestor of the branch; the history was rewritten");

  // The GIT-SNAP-1 re-take comes last so nothing can change between it and the push.
  await deps.assertNoDrift(input.worktree);

  const { findings, binaryPaths, truncated } = await scanOutgoing(deps, git, input.worktree, input.baseSha, tipSha);
  const refuse = (deps.scanMode ?? "warn") === "refuse";
  const reasons: string[] = [];
  if (findings.length > 0) {
    const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
    const commits = [...new Set(findings.map((f) => (f.commit ?? "").slice(0, 12)))].join(", ");
    const why = `the outgoing history matches ${findings.length} secret pattern(s) (${rules}) in commit(s) ${commits}`;
    if (refuse) throw denied(why);
    reasons.push(why);
  }
  if (truncated) {
    // Padding a push with filler must not hide what follows it: an incomplete scan fails closed.
    const why = "the outgoing history is too large to scan completely";
    if (refuse) throw denied(`${why}, so the push is refused`);
    reasons.push(`${why}; content past the limit was not scanned`);
  }
  if (binaryPaths.length > 0) {
    const allowed = new Set(input.allowedBinaryPaths ?? []);
    const unlisted = binaryPaths.filter((p) => !allowed.has(p));
    const shown = (ps: readonly string[]): string => sanitizeText(ps.slice(0, 5).join(", ")) + (ps.length > 5 ? ` and ${ps.length - 5} more` : "");
    if (refuse && unlisted.length > 0) throw denied(`the outgoing history contains binary or non-diffable files that cannot be scanned: ${shown(unlisted)}`);
    if (!refuse) reasons.push(`binary or non-diffable files cannot be fully scanned: ${shown(binaryPaths)}`);
  }

  const argv = [
    ...prefix(input.worktree, deps, { context: "pty", hooks: deps.runHooks, filters: [] }),
    ...protocolAllowList(),
    "push", "--no-follow-tags", "--no-recurse-submodules", ...(deps.runHooks ? [] : ["--no-verify"]),
    "--", input.remote, refspec,
  ];
  const command: GitRunRequest = { argv, cwd: input.worktree.workTree, env: withNoPrompt(deps.env.pty), context: "pty" };
  return { plan: { worktree: input.worktree, remote: input.remote, branch, tip: tipSha, refspec, command, findings, requiresConfirmation: reasons.length > 0, reasons }, git };
}

/** Validates everything and returns the exact push command and any secret findings. */
export async function planPush(deps: GitOpsDeps, input: PushInput): Promise<PushPlan> {
  return mapUnexpected(async () => (await check(deps, input)).plan);
}

/** Re-validates immediately before pushing. A plan with findings needs `confirmed: true`. */
export function executePush(deps: GitOpsDeps, input: PushInput, opts: { readonly confirmed?: boolean } = {}): Promise<void> {
  return mapUnexpected(() => runPush(deps, input, opts));
}

async function runPush(deps: GitOpsDeps, input: PushInput, opts: { readonly confirmed?: boolean }): Promise<void> {
  const { plan, git } = await check(deps, input);
  if (plan.requiresConfirmation && opts.confirmed !== true) {
    throw new GitOpsError("E_APPROVAL_REQUIRED", `confirm to push: ${plan.reasons.join("; ")}`);
  }
  await confirmTip(git, plan.branch, plan.tip);
  const r = await deps.runner.run(plan.command);
  if (r.code !== 0) throw new GitOpsError("E_UNAVAILABLE", `git push failed (exit ${r.code}): ${redactUrls(sanitizeText(r.stderr)).slice(0, 500)}`);
}
