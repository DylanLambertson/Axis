// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Axis push (threat model GIT-3, GIT-SNAP-1 re-take, PSH-1, GIT-7; gate 1a/L24). Explicit refspec only.
import { EMPTY_TREE_SHA1, OBJECT_ID, REMOTE_NAME, branchFor, checkWorktree, daemonGitFor, platformOf, prefix, safeRef, type DaemonGit } from "./args.js";
import { findOverride, withNoPrompt } from "./env.js";
import { GitOpsError, denied, invalid, redactUrls } from "./errors.js";
import type { GitOpsDeps, GitRunRequest, SecretFinding, WorktreeRef } from "./types.js";

export interface PushInput {
  readonly worktree: WorktreeRef;
  /** A configured remote name. Never a URL. */
  readonly remote: string;
  /** `axis/<slug>`. */
  readonly branch: string;
  /** Workspace base SHA or ref, used as the diff base for the secret scan when the remote has no copy. */
  readonly base?: string;
}

export interface PushPlan {
  readonly worktree: WorktreeRef;
  readonly remote: string;
  readonly branch: string;
  /** Exactly `refs/heads/axis/<slug>:refs/heads/axis/<slug>`. */
  readonly refspec: string;
  /** Runs in the pty process. */
  readonly command: GitRunRequest;
  /** Rule names, paths and lines only; never the matched text. */
  readonly findings: readonly SecretFinding[];
  readonly requiresConfirmation: boolean;
}

const MAX_DIFF = 8 * 1024 * 1024;

export function pushRefspec(slug: string): string {
  return `refs/heads/axis/${slug}:refs/heads/axis/${slug}`;
}

/** True only for the one refspec Axis pushes: no '+', no wildcard, no tag, no delete, source equals destination. */
export function isAllowedRefspec(spec: string): boolean {
  const m = /^refs\/heads\/axis\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?):refs\/heads\/axis\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/.exec(spec);
  return m !== null && m[1] === m[2];
}

async function check(deps: GitOpsDeps, input: PushInput): Promise<{ plan: PushPlan; git: DaemonGit }> {
  checkWorktree(input.worktree, platformOf(deps));
  if (typeof input.remote !== "string" || input.remote.startsWith("-") || !REMOTE_NAME.test(input.remote)) {
    throw invalid("the remote must be a configured remote name, not a URL or an option");
  }
  const { branch, slug } = branchFor(input.branch);
  const refspec = pushRefspec(slug);
  if (!isAllowedRefspec(refspec)) throw denied("refspec not allowed");
  const bad = findOverride(deps.env.pty);
  if (bad) throw denied(`the pty git environment must not set ${bad}`);

  if (await deps.isCliRunActive(input.worktree)) throw denied("a CLI run is active in this workspace; push is refused until it ends");

  const git = await daemonGitFor(input.worktree, deps);
  const remotes = (await git(["remote"])).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!remotes.includes(input.remote)) throw invalid("the remote is not configured in this repository");
  const urls = await git(["remote", "get-url", "--push", "--all", "--", input.remote]);
  if (urls.code !== 0) throw invalid("the remote has no push URL");
  for (const u of urls.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(u)) throw denied(`the remote URL embeds credentials: ${redactUrls(u)}`);
    if (/^(ext|fd)::/i.test(u)) throw denied("the remote uses a transport that Axis does not push to");
  }
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== branch) throw denied("the worktree is not on the branch being pushed");
  const tip = await git(["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  if (tip.code !== 0) throw invalid("the branch has no commits");

  // The GIT-SNAP-1 re-take comes last so nothing can change between it and the push.
  await deps.assertNoDrift(input.worktree);

  const findings = await scan(deps, git, input, branch, tip.stdout.trim());
  if (findings.length > 0 && (deps.scanMode ?? "warn") === "refuse") {
    throw denied(`the outgoing changes match ${findings.length} secret pattern(s): ${[...new Set(findings.map((f) => f.rule))].join(", ")}`);
  }

  const argv = [
    ...prefix(input.worktree, deps, { context: "pty", hooks: deps.runHooks, filters: [] }),
    "push", "--no-follow-tags", "--no-recurse-submodules", ...(deps.runHooks ? [] : ["--no-verify"]),
    "--", input.remote, refspec,
  ];
  const command: GitRunRequest = { argv, cwd: input.worktree.workTree, env: withNoPrompt(deps.env.pty), context: "pty" };
  return { plan: { worktree: input.worktree, remote: input.remote, branch, refspec, command, findings, requiresConfirmation: findings.length > 0 }, git };
}

async function scan(deps: GitOpsDeps, git: DaemonGit, input: PushInput, branch: string, tip: string): Promise<readonly SecretFinding[]> {
  if (!deps.scanner) return [];
  let from: string | undefined;
  const tracking = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/remotes/${input.remote}/${branch}^{commit}`]);
  if (tracking.code === 0) from = tracking.stdout.trim();
  if (from === undefined && input.base !== undefined) {
    const b = OBJECT_ID.test(input.base) ? input.base : safeRef(input.base, "base");
    const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${b}^{commit}`]);
    if (r.code === 0) from = r.stdout.trim();
  }
  if (from === undefined) from = (await git(["hash-object", "-t", "tree", "--stdin"], "")).stdout.trim() || EMPTY_TREE_SHA1;
  const d = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--ignore-submodules=all", from, tip, "--"]);
  if (d.code !== 0) throw new GitOpsError("E_UNAVAILABLE", "could not compute the outgoing diff for the secret scan");
  const truncated = d.stdout.length > MAX_DIFF;
  return deps.scanner(truncated ? d.stdout.slice(0, MAX_DIFF) : d.stdout, { worktree: input.worktree, truncated });
}

/** Validates everything and returns the exact push command and any secret findings. */
export async function planPush(deps: GitOpsDeps, input: PushInput): Promise<PushPlan> {
  return (await check(deps, input)).plan;
}

/** Re-validates immediately before pushing. A plan with findings needs `confirmed: true`. */
export async function executePush(deps: GitOpsDeps, input: PushInput, opts: { readonly confirmed?: boolean } = {}): Promise<void> {
  const { plan } = await check(deps, input);
  if (plan.requiresConfirmation && opts.confirmed !== true) {
    throw new GitOpsError("E_APPROVAL_REQUIRED", "the outgoing changes match secret patterns; confirm to push");
  }
  const r = await deps.runner.run(plan.command);
  if (r.code !== 0) throw new GitOpsError("E_UNAVAILABLE", `git push failed (exit ${r.code}): ${redactUrls(r.stderr).slice(0, 500)}`);
}
