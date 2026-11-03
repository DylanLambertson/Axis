// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1: scan the patch of every commit that a push will send, not the net change between two trees.
import { OBJECT_ID, type DaemonGit } from "./args.js";
import { GitOpsError } from "./errors.js";
import type { GitOpsDeps, SecretFinding, WorktreeRef } from "./types.js";

/** Per-commit patch size handed to the scanner. */
export const MAX_DIFF = 8 * 1024 * 1024;

/** More commits or bytes than this are not scanned; the scan then reports `truncated` and the caller fails closed. */
export const MAX_COMMITS = 5000;
export const MAX_TOTAL = 128 * 1024 * 1024;

export interface OutgoingScan {
  readonly findings: readonly SecretFinding[];
  /** True when anything outgoing was not scanned: a patch over MAX_DIFF, more than MAX_COMMITS commits, or more than MAX_TOTAL bytes. */
  readonly truncated: boolean;
  /** Every path git treats as binary in any outgoing commit, without duplicates. */
  readonly binaryPaths: readonly string[];
}

/** Paths whose `git diff-tree --numstat -z` counts are `-\t-`. */
export function parseBinaryPaths(numstat: string): string[] {
  const out: string[] = [];
  for (const rec of numstat.split("\0")) {
    const m = /^-\t-\t([^\0]+)$/.exec(rec.replace(/^\n/, ""));
    if (m) out.push(m[1] as string);
  }
  return out;
}

function unavailable(what: string): GitOpsError {
  return new GitOpsError("E_UNAVAILABLE", `could not ${what} for the secret scan`);
}

/**
 * Runs the scanner once per commit in `base..tip`, oldest first. Merge commits are diffed against every parent (-m),
 * so a secret that exists only in a merge resolution is seen. Attributes, textconv, external diff, submodule
 * recursion and rename detection are all off; the content scanned is the content pushed.
 */
export async function scanOutgoing(deps: GitOpsDeps, git: DaemonGit, worktree: WorktreeRef, base: string, tip: string): Promise<OutgoingScan> {
  const scanner = deps.scanner;
  if (!scanner) return { findings: [], truncated: false, binaryPaths: [] };
  const list = await git(["rev-list", "--reverse", "--end-of-options", tip, `^${base}`]);
  if (list.code !== 0) throw unavailable("list the outgoing commits");
  const commits = list.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (commits.some((c) => !OBJECT_ID.test(c))) throw unavailable("list the outgoing commits");
  const findings: SecretFinding[] = [];
  let truncated = false;
  const binary = new Set<string>();
  let total = 0;
  if (commits.length > MAX_COMMITS) truncated = true;
  for (const commit of commits.slice(0, MAX_COMMITS)) {
    if (total >= MAX_TOTAL) {
      truncated = true;
      break;
    }
    const d = await git([
      "diff-tree", "-p", "--text", "-m", "--root", "--no-commit-id", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv",
      "--submodule=short", "--ignore-submodules=all", "--end-of-options", commit,
    ]);
    if (d.code !== 0) throw unavailable("compute the outgoing diff");
    // Without --text, so that git reports what it treats as binary. The patch above is --text and shows it all anyway.
    const stat = await git([
      "diff-tree", "-r", "--numstat", "-z", "-m", "--root", "--no-commit-id", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--submodule=short", "--ignore-submodules=all", "--end-of-options", commit,
    ]);
    if (stat.code !== 0) throw unavailable("list the binary files");
    const binaryPaths = parseBinaryPaths(stat.stdout);
    for (const p of binaryPaths) binary.add(p);
    const cut = d.stdout.length > MAX_DIFF;
    total += d.stdout.length;
    if (cut) truncated = true;
    for (const f of await scanner(cut ? d.stdout.slice(0, MAX_DIFF) : d.stdout, { worktree, truncated: cut, commit, binaryPaths })) findings.push({ ...f, commit });
  }
  return { findings, truncated, binaryPaths: [...binary] };
}
