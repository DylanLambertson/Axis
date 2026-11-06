// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { AxisError } from "@axis/audit";
import { judgeDrift, takeStableSnapshot, type Snapshot } from "@axis/git-snapshot";
import { DEFAULT_LIMITS, type RunSnapshotter, type RunWorktree, type SnapshotContext } from "@axis/runs";

/**
 * GIT-SNAP-1 around a CLI run (ticket H13, docs/design/git-snapshot.md section 8): `@axis/git-snapshot` is the one owner.
 * `before` refuses the launch when the snapshot cannot be judged; `after` compares the run's own before and after snapshots and
 * reports `drift` for anything but `clean`. No held snapshot makes `after` throw (the supervisor records `unknown`, never "no drift").
 */
export interface RunSnapshotterDeps {
  /** The host's single absolute git (design 5a). Never re-resolved here. */
  readonly gitPath: string;
  /** The host's environment copy; `@axis/git-snapshot` passes on only the GIT-ENV-1 allow-list. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The registered repository root of a workspace's project, from the journal (main registered it; a run cannot change it).
   * The common dir is `<root>/.git` and never comes from a file in the git directory, which a run can rewrite.
   */
  readonly projectRoot: (workspaceId: string) => string | undefined;
}

/** Builds the run snapshotter once the host has resolved git (`ComposeOptions.snapshotter`). */
export type RunSnapshotterFactory = (deps: RunSnapshotterDeps) => RunSnapshotter;

/**
 * Workspaces with a held snapshot; the oldest goes first. Held per WORKSPACE (one run at a time each), so a launch that was
 * cancelled after `before` is replaced by the workspace's next `before` and cannot push out another workspace's live baseline.
 */
export const MAX_HELD_SNAPSHOTS = 64;
/** Per take, and takes per stable snapshot: together well inside the supervisor's `snapshotTimeoutMs` (10 s), with room to spawn git. */
export const SNAPSHOT_TAKE_MS = 3000;
export const SNAPSHOT_ATTEMPTS = 2;
/** The supervisor's bound on one `before` or `after` (a slower snapshot reads as failed there: refused before, unknown after). */
export const SUPERVISOR_SNAPSHOT_MS = DEFAULT_LIMITS.snapshotTimeoutMs;

interface Held {
  readonly runId: string;
  readonly worktree: RunWorktree;
  readonly commonDir: string;
  readonly snapshot: Snapshot;
}

const refused = (reason: string): AxisError => new AxisError("E_UNAVAILABLE", "The git snapshot could not be taken", { reason });

/**
 * `$GIT_COMMON_DIR` from trusted facts only (review h13 B1): the project's registered root gives `<root>/.git`, which must be a real
 * directory (no symlink, no `.git` file), and the located git dir must be `<common>/worktrees/<name>` by its path. The worktree's
 * `commondir` and `.git` files are NOT read here: the snapshot's link check compares what git reads from them with this value, so a
 * run that rewrites either is a link mismatch (`refused`): the next launch is refused instead of taking a decoy as its baseline.
 */
async function commonDirFor(root: string | undefined, gitDir: string): Promise<string> {
  if (typeof root !== "string" || !isAbsolute(root)) throw refused("project_unknown");
  let common: string;
  try {
    const dotGit = join(root, ".git");
    if (!(await lstat(dotGit)).isDirectory()) throw refused("common_dir_mismatch");
    common = await realpath(dotGit);
  } catch (e) {
    throw e instanceof AxisError ? e : refused("common_dir_mismatch");
  }
  let real: string;
  try {
    real = await realpath(gitDir);
  } catch {
    throw refused("common_dir_mismatch");
  }
  // `worktrees/<name>` swapped for a symlink to a decoy resolves elsewhere and is refused here too.
  if (basename(dirname(real)) !== "worktrees" || dirname(dirname(real)) !== common) throw refused("common_dir_mismatch");
  return common;
}

export function createRunSnapshotter(deps: RunSnapshotterDeps, maxHeld = MAX_HELD_SNAPSHOTS): RunSnapshotter {
  if (typeof deps?.gitPath !== "string" || !isAbsolute(deps.gitPath) || typeof deps.projectRoot !== "function") throw new AxisError("E_INVALID_ARGUMENT", "The snapshotter needs the host's git path", { reason: "snapshotter_required" });
  const held = new Map<string, Held>();
  const take = (h: { readonly worktree: RunWorktree; readonly commonDir: string }): Promise<Snapshot> =>
    takeStableSnapshot({
      worktreePath: h.worktree.workTree,
      commonDir: h.commonDir,
      expectedGitDir: h.worktree.gitDir,
      gitPath: deps.gitPath,
      env: deps.env,
      limits: { maxMillis: SNAPSHOT_TAKE_MS },
      attempts: SNAPSHOT_ATTEMPTS,
    });
  return {
    async before(ctx: SnapshotContext): Promise<void> {
      const worktree = Object.freeze({ workTree: ctx.worktree.workTree, gitDir: ctx.worktree.gitDir });
      const commonDir = await commonDirFor(deps.projectRoot(ctx.workspaceId), worktree.gitDir);
      const snapshot = await take({ worktree, commonDir });
      // The library's own criterion: a snapshot that cannot be judged against itself cannot be a run's baseline.
      if (judgeDrift({ baseline: snapshot, current: snapshot }).status !== "clean") throw refused("snapshot_refused");
      held.delete(ctx.workspaceId);
      held.set(ctx.workspaceId, { runId: ctx.runId, worktree, commonDir, snapshot });
      for (const id of held.keys()) {
        if (held.size <= maxHeld) break;
        held.delete(id);
      }
    },
    async after(ctx: SnapshotContext): Promise<{ readonly drift: boolean }> {
      const base = held.get(ctx.workspaceId);
      if (base === undefined || base.runId !== ctx.runId) throw refused("no_baseline");
      held.delete(ctx.workspaceId);
      // Re-taken over the paths of `before`: a run that re-pointed the worktree's `.git` is a link mismatch, so `refused`, so drift.
      const current = await take(base);
      return { drift: judgeDrift({ baseline: base.snapshot, current }).status !== "clean" };
    },
  };
}

/** The production factory the process entry passes (`ComposeOptions.snapshotter`). */
export const gitSnapshotRunSnapshotter: RunSnapshotterFactory = (deps) => createRunSnapshotter(deps);
