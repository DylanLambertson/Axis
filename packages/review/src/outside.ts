// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// "Files changed outside the agent" (design §10; DRF-2 to DRF-4). The run-base diff decides what changed; the watcher
// ledger can only add evidence about who wrote it, and a dropped event never hides a change.
import type { WorktreeRef } from "@axis/git-ops";
import { escapeForDisplay, pathProblem } from "./display.js";
import { mapUnexpected, unavailable } from "./errors.js";
import { assertOid, resolveObject, reviewGitFor, type ReviewGit } from "./gitcall.js";
import { resolveLimits } from "./limits.js";
import { snapshotWorktree } from "./snapshot.js";
import type { ReviewDeps } from "./types.js";

export interface OutsideAgentInput {
  readonly worktree: WorktreeRef;
  /** The commit at `refs/axis/runbase/<runId>` (or its tree): HEAD plus the whole worktree when the run started. */
  readonly runBase: string;
  /** The worktree tree taken when the run ended (or a commit of it). Absent while the run is still active. */
  readonly runEnd?: string;
  /** Paths the watcher saw written by something other than the run. May be incomplete. */
  readonly ledger: Iterable<string>;
  /** False when the watcher reported that it dropped events (overflow). */
  readonly ledgerComplete: boolean;
  /** A worktree tree already taken (for example by a review that just started), to avoid reading the worktree again. */
  readonly current?: string;
}

export interface OutsidePath {
  readonly path: string;
  readonly displayPath: string;
  /** `after-run`: differs between the run end and now (needs no watcher). `ledger`: the watcher saw it. */
  readonly evidence: "after-run" | "ledger" | "both";
}

export interface OutsideAgentReport {
  /** Everything that differs from the run base: the authoritative set. */
  readonly changedSinceRunBase: number;
  /** Paths changed outside the agent, bounded to maxFiles; `outsideCount` is the true count (up to the diff limit). */
  readonly outsideAgent: readonly OutsidePath[];
  readonly outsideCount: number;
  /** Changed paths with no evidence that someone else wrote them. They are still in the changes list. */
  readonly unattributedCount: number;
  /** The watcher dropped events: there may be more outside-agent paths than shown ("at least N"). */
  readonly attributionIncomplete: boolean;
  /** A list or the ledger was longer than its bound; counts are lower bounds. */
  readonly truncated: boolean;
}

async function changedPaths(git: ReviewGit, a: string, b: string, max: number): Promise<{ paths: Set<string>; truncated: boolean }> {
  const r = await git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", a, b]);
  if (r.code !== 0) throw unavailable("could not compare two worktree states");
  const paths = new Set<string>();
  let truncated = r.truncated === true;
  for (const n of r.stdout.split("\0")) {
    if (n === "") continue;
    if (paths.size >= max) {
      truncated = true;
      break;
    }
    paths.add(n);
  }
  return { paths, truncated };
}

export function computeOutsideAgent(deps: ReviewDeps, input: OutsideAgentInput): Promise<OutsideAgentReport> {
  return mapUnexpected(async () => {
    const limits = resolveLimits(deps.limits);
    const git = await reviewGitFor(deps, input.worktree);
    const baseTree = await resolveObject(git, assertOid(input.runBase, "runBase"), "tree");
    const endTree = input.runEnd === undefined ? undefined : await resolveObject(git, assertOid(input.runEnd, "runEnd"), "tree");
    const now = input.current === undefined ? await snapshotWorktree(deps, git, baseTree) : assertOid(input.current, "current");

    const ledger = new Set<string>();
    let truncated = false;
    for (const p of input.ledger) {
      if (ledger.size >= limits.maxLedger) {
        truncated = true;
        break;
      }
      // A ledger path is evidence, never an instruction: one that is not a usable repository path is dropped.
      if (typeof p === "string" && pathProblem(p) === undefined) ledger.add(p);
    }

    const sinceBase = await changedPaths(git, baseTree, now, limits.maxFiles * 4);
    const afterRun = endTree === undefined ? { paths: new Set<string>(), truncated: false } : await changedPaths(git, endTree, now, limits.maxFiles * 4);
    truncated = truncated || sinceBase.truncated || afterRun.truncated;

    const outside: OutsidePath[] = [];
    let outsideCount = 0;
    for (const path of sinceBase.paths) {
      const a = afterRun.paths.has(path);
      const l = ledger.has(path);
      if (!a && !l) continue;
      outsideCount++;
      if (outside.length < limits.maxFiles) {
        outside.push({ path, displayPath: escapeForDisplay(path, { maxLength: limits.maxDisplay, cut: "middle" }), evidence: a && l ? "both" : a ? "after-run" : "ledger" });
      }
    }
    if (outsideCount > outside.length) truncated = true;
    return {
      changedSinceRunBase: sinceBase.paths.size,
      outsideAgent: outside,
      outsideCount,
      unattributedCount: sinceBase.paths.size - outsideCount,
      attributionIncomplete: !input.ledgerComplete,
      truncated,
    };
  });
}
