// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import type { DriftItem } from './gitSnap.js';

export interface WorktreeInfo {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly prunable: boolean;
  readonly isMain: boolean;
  /** Created by Axis: inside the worktree root and carries a workspace record. */
  readonly managed: boolean;
  /** A linked worktree Axis did not create. */
  readonly external: boolean;
  readonly id: string | null;
}

export interface CreateInput {
  /** Any path inside the source repository (normally the local checkout). */
  readonly repoPath: string;
  readonly slug: string;
  /** Defaults to HEAD of the repoPath checkout. */
  readonly baseRef?: string;
  /** Workspace id; generated when omitted. */
  readonly id?: string;
}

export interface CreatedWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly branch: string;
  readonly path: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly runBaseRef: string;
  readonly skippedLarge: readonly string[];
  readonly localCheckout: string | null;
}

export interface DirtyFile {
  readonly path: string;
  readonly index: string;
  readonly worktree: string;
  readonly origPath?: string;
}

export interface WorkspaceStatus {
  readonly id: string;
  readonly branch: string | null;
  readonly head: string;
  readonly baseSha: string;
  readonly state: 'READY' | 'FINALISED';
  readonly dirty: readonly DirtyFile[];
  /** Commits in HEAD that are not in the recorded base SHA. */
  readonly ahead: number;
  /** Commits in the recorded base SHA that are not in HEAD. */
  readonly behind: number;
  /** Commits on the base branch's current tip that HEAD lacks; null when not applicable. */
  readonly baseBranchBehind: number | null;
  readonly drift: readonly DriftItem[];
  readonly baselineMissing: boolean;
  /** True when drift exists or the baseline is missing (fail closed). */
  readonly hasDrift: boolean;
}

export type FinaliseOutcome = 'merged' | 'archived' | 'abandoned';

export interface FinaliseResult {
  readonly archiveRef: string;
  readonly archiveSha: string;
  readonly backupRef: string | null;
  readonly outcome: FinaliseOutcome;
}

export interface RemoveResult {
  readonly removed: true;
  readonly archiveRef: string;
  readonly backupRef: string | null;
  readonly branchDeleted: boolean;
}

export interface RestoreResult {
  readonly path: string;
  readonly relPath: string;
  readonly runBaseRef: string;
  readonly backupRef: string;
}

export function parsePorcelainStatus(stdout: string): DirtyFile[] {
  const records = stdout.split('\0');
  const out: DirtyFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] as string;
    if (rec.length < 4) continue;
    const index = rec[0] as string;
    const worktree = rec[1] as string;
    const file = rec.slice(3);
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      out.push({ path: file, index, worktree, origPath: (records[++i] as string | undefined) ?? '' });
    } else {
      out.push({ path: file, index, worktree });
    }
  }
  return out;
}
