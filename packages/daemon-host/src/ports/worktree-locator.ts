// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { WorktreeRef } from "@axis/git-ops";

/**
 * Resolves a workspace id to its registered worktree (DMN-2, GIT-4): absolute, normalised paths from the journal,
 * realpath-checked at the moment of use, never discovered from a directory and never taken from a payload. One
 * implementation serves `@axis/git-ops`, `@axis/worktrees` and `@axis/runs`, so all of them see the same path (the
 * same shape as the `WorktreeLocator` of `@axis/runs`).
 */
export interface WorktreeLocator {
  /** Rejects `E_NOT_FOUND` for an unknown or removed workspace. */
  locate(workspaceId: string): Promise<WorktreeRef>;
}
