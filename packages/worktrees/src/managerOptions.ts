// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { WorktreeError } from './errors.js';
import type { RepoLocation } from './discovery.js';
import type { GitRunner } from './git.js';
import type { HardenedGit } from './hardenedGit.js';
import { deleteRefIf } from './snapshotRef.js';
import { IdSchema, type WorkspaceMeta } from './meta.js';
import { assertNoTraversal } from './paths.js';
import type { ExpectedWorktree } from './types.js';
import * as path from 'node:path';
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
  /** Windows only: a daemon-owned zero-byte file under the app-data root, used as `core.hooksPath`. Defaults beside the worktree root. */
  readonly windowsNoHooksFile?: string;
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

/** The expected worktree must be well formed before any disk is read: an absolute canonical-looking path and a workspace id. */
export function parseExpected(e: ExpectedWorktree): ExpectedWorktree {
  if (typeof e !== 'object' || e === null || typeof e.path !== 'string' || typeof e.id !== 'string') {
    throw invalid('expected worktree is required');
  }
  assertNoTraversal(e.path, 'expected worktree');
  if (!path.isAbsolute(e.path) || !IdSchema.safeParse(e.id).success) throw invalid('invalid expected worktree');
  return e;
}

/** Deletes expired run-base and backup refs by commit age, each only while it still points at the commit that was inspected. */
export async function sweepExpiredRefs(git: HardenedGit, cwd: string, now: Date): Promise<string[]> {
  const out = await git.text(
    ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/axis/runbase', 'refs/axis/backup'],
    { cwd },
  );
  const deleted: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref = '', sha = '', secs = ''] = line.split('\t');
    const days = ref.startsWith('refs/axis/runbase/') ? RUNBASE_RETENTION_DAYS : BACKUP_RETENTION_DAYS;
    if (now.getTime() - Number(secs) * 1000 > days * DAY_MS) {
      await deleteRefIf(git, cwd, ref, sha);
      deleted.push(ref);
    }
  }
  return deleted;
}
