// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { WorktreeError } from './errors.js';
import type { RepoLocation } from './discovery.js';
import type { GitRunner } from './git.js';
import type { WorkspaceMeta } from './meta.js';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RUNBASE_RETENTION_DAYS = 7;
export const BACKUP_RETENTION_DAYS = 30;

export type ActiveRunOp = 'finalise' | 'remove' | 'restore';

export interface WorktreeManagerOptions {
  readonly runner: GitRunner;
  /** Worktree root. Defaults are the caller's job (see `defaultWorktreeRoot`). */
  readonly worktreeRoot: string;
  /** Other registered repositories the root must never sit inside. */
  readonly registeredRepos?: () => Promise<readonly string[]> | readonly string[];
  /**
   * Return true while runs or managed ptys are active in the workspace;
   * finalise, remove and restore then fail with E_CONFLICT (reason 'active-run').
   */
  readonly refuseIfActiveRun?: (workspaceId: string, op: ActiveRunOp) => boolean | Promise<boolean>;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly maxSnapshotFileBytes?: number;
  /** Windows only: the empty hooks directory under the app-data root. Defaults beside the worktree root. */
  readonly windowsEmptyHooksDir?: string;
  /** How long to wait for another process's workspace lock. */
  readonly lockTimeoutMs?: number;
}

export interface Located {
  readonly repo: RepoLocation;
  readonly workTree: string;
  readonly meta: WorkspaceMeta;
}

export function invalid(message: string, details: Record<string, unknown> = {}): WorktreeError {
  return new WorktreeError('E_INVALID_ARGUMENT', message, details);
}
