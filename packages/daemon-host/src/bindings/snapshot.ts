// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { AxisError } from "@axis/audit";
import { judgeDrift, takeStableSnapshot, type Snapshot } from "@axis/git-snapshot";
import type { RunSnapshotter, RunWorktree, SnapshotContext } from "@axis/runs";

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
}

/** Builds the run snapshotter once the host has resolved git (`ComposeOptions.snapshotter`). */
export type RunSnapshotterFactory = (deps: RunSnapshotterDeps) => RunSnapshotter;

/** Snapshots held between `before` and `after`; the oldest goes first (a run whose spawn failed never reaches `after`). */
export const MAX_HELD_SNAPSHOTS = 64;
/** Per take: a stable snapshot is two or three takes and must fit the supervisor's 10 s `snapshotTimeoutMs`. */
export const SNAPSHOT_TAKE_MS = 3000;
const MAX_COMMONDIR_BYTES = 4096;

interface Held {
  readonly worktree: RunWorktree;
  readonly commonDir: string;
  readonly snapshot: Snapshot;
}

const refused = (reason: string): AxisError => new AxisError("E_UNAVAILABLE", "The git snapshot could not be taken", { reason });

/** `$GIT_COMMON_DIR` of a linked worktree, from its git dir's `commondir` file (bounded; git itself re-checks it in the link check). */
async function commonDirOf(gitDir: string): Promise<string> {
  const file = resolve(gitDir, "commondir");
  let text: string;
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_COMMONDIR_BYTES) throw refused("commondir_unreadable");
    text = await readFile(file, "utf8");
  } catch (e) {
    throw e instanceof AxisError ? e : refused("commondir_unreadable");
  }
  const line = text.split("\n", 1)[0]?.replace(/\r$/, "") ?? "";
  if (line.length === 0 || line.includes("\0") || line.includes("�")) throw refused("commondir_unreadable");
  try {
    return await realpath(isAbsolute(line) ? line : resolve(gitDir, line));
  } catch {
    throw refused("commondir_unreadable");
  }
}

export function createRunSnapshotter(deps: RunSnapshotterDeps, maxHeld = MAX_HELD_SNAPSHOTS): RunSnapshotter {
  if (typeof deps?.gitPath !== "string" || !isAbsolute(deps.gitPath)) throw new AxisError("E_INVALID_ARGUMENT", "The snapshotter needs the host's git path", { reason: "snapshotter_required" });
  const held = new Map<string, Held>();
  const take = (h: { readonly worktree: RunWorktree; readonly commonDir: string }): Promise<Snapshot> =>
    takeStableSnapshot({
      worktreePath: h.worktree.workTree,
      commonDir: h.commonDir,
      expectedGitDir: h.worktree.gitDir,
      gitPath: deps.gitPath,
      env: deps.env,
      limits: { maxMillis: SNAPSHOT_TAKE_MS },
    });
  return {
    async before(ctx: SnapshotContext): Promise<void> {
      const worktree = Object.freeze({ workTree: ctx.worktree.workTree, gitDir: ctx.worktree.gitDir });
      const commonDir = await commonDirOf(worktree.gitDir);
      const snapshot = await take({ worktree, commonDir });
      // The library's own criterion: a snapshot that cannot be judged against itself cannot be a run's baseline.
      if (judgeDrift({ baseline: snapshot, current: snapshot }).status !== "clean") throw refused("snapshot_refused");
      held.delete(ctx.runId);
      held.set(ctx.runId, { worktree, commonDir, snapshot });
      for (const id of held.keys()) {
        if (held.size <= maxHeld) break;
        held.delete(id);
      }
    },
    async after(ctx: SnapshotContext): Promise<{ readonly drift: boolean }> {
      const base = held.get(ctx.runId);
      held.delete(ctx.runId);
      if (base === undefined) throw refused("no_baseline");
      // Re-taken over the paths of `before`: a run that re-pointed the worktree's `.git` is a link mismatch, so `refused`, so drift.
      const current = await take(base);
      return { drift: judgeDrift({ baseline: base.snapshot, current }).status !== "clean" };
    },
  };
}

/** The production factory the process entry passes (`ComposeOptions.snapshotter`). */
export const gitSnapshotRunSnapshotter: RunSnapshotterFactory = (deps) => createRunSnapshotter(deps);
