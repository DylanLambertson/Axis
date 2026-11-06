// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Workspace } from "@axis/journal";
import { worktreeFailure } from "./errors.js";
import type { ManagerShape, ManagerStatus } from "./shapes.js";

/**
 * The repair of an interrupted finalise: git's own record says FINALISED while the journal still says READY (a crash, or
 * a failed journal write, between the two steps). That record lives in the workspace's git directory, which a finished
 * run can write, so it is NOT believed: the state is re-verified with git itself before the journal records anything,
 * and every failed check is one closed refusal that leaves the workspace needing attention.
 *
 *  - the worktree is clean (a finalise that discards work needs the user's confirmation, which this path never had);
 *  - git configuration did not drift;
 *  - `refs/axis/archive/<id>` resolves, and to exactly the worktree's HEAD;
 *  - the outcome is not taken from the caller or the record: `merged` is accepted only when git itself finds HEAD in the
 *    base branch, and the two outcomes that claim no merge (`archived`, `abandoned`) cannot be told apart by git, so the
 *    caller's choice of one of those is recorded.
 *
 * Returns the outcome to record.
 */
export async function verifyFinalised(
  manager: Pick<ManagerShape, "assertNoDrift" | "resolveCommit" | "isMerged">,
  repoPath: string,
  ws: Workspace,
  live: ManagerStatus,
  workTree: string,
  requested: "merged" | "archived" | "abandoned",
): Promise<"merged" | "archived" | "abandoned"> {
  if (live.dirty.length > 0) throw worktreeFailure("E_CONFLICT", "dirty");
  await manager.assertNoDrift(workTree, { path: workTree, id: ws.id });
  const archived = await manager.resolveCommit(repoPath, `refs/axis/archive/${ws.id}`).catch(() => undefined);
  if (archived === undefined) throw worktreeFailure("E_CONFLICT", "no_archive");
  if (archived !== live.head) throw worktreeFailure("E_CONFLICT", "unverified");
  if (requested === "merged") {
    if (!(await manager.isMerged(repoPath, live.head, ws.baseRef))) throw worktreeFailure("E_CONFLICT", "not_merged");
    return "merged";
  }
  return requested;
}
