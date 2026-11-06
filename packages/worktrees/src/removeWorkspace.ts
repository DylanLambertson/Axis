// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { requireDiscardConfirmation, scanDiscard } from './discard.js';
import type { DiscardConfirmation } from './confirmation.js';
import { parseWorktreeList, type RepoLocation } from './discovery.js';
import { WorktreeError } from './errors.js';
import type { HardenedGit } from './hardenedGit.js';
import type { WorkspaceMeta } from './meta.js';
import { assertHistoryClean, createRefOnce } from './snapshotRef.js';
import type { SnapshotScanner } from './snapshotScan.js';
import type { RemoveResult } from './types.js';

export interface RemoveHost {
  readonly git: HardenedGit;
  readonly maxFile: number;
  guardExecutionDrift(repo: RepoLocation, workTree: string): Promise<void>;
  writeBackup(workTree: string, meta: WorkspaceMeta, why: string): Promise<string>;
  /** REF-1 scanner for what the branch backup pins; undefined means the default (refuse mode). */
  readonly snapshotScanner: SnapshotScanner | undefined;
  now(): Date;
}

export interface RemoveParams {
  readonly repo: RepoLocation;
  readonly workTree: string;
  readonly meta: WorkspaceMeta;
  readonly deleteBranch: boolean;
  readonly token: DiscardConfirmation | undefined;
}

/** Runs inside the workspace lock. */
export async function removeWorkspace(host: RemoveHost, p: RemoveParams): Promise<RemoveResult> {
  const { git } = host;
  const { repo, workTree, meta } = p;
  if (meta.state !== 'FINALISED') {
    throw new WorktreeError('E_CONFLICT', 'workspace must be finalised before removal', { reason: 'not-finalised' });
  }
  const archiveRef = `refs/axis/archive/${meta.id}`;
  if (!(await git.ok(['rev-parse', '--verify', '--quiet', '--end-of-options', archiveRef], { cwd: workTree }))) {
    throw new WorktreeError('E_CONFLICT', 'archive ref is missing', { reason: 'no-archive' });
  }
  await host.guardExecutionDrift(repo, workTree);
  // Run from the main checkout's path: git only reads it here and the worktree is about to vanish.
  const entries = parseWorktreeList((await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: workTree })).stdout);
  const main = entries[0];
  const cwd = main && !main.bare ? main.path : repo.commonDir;
  if (p.deleteBranch) {
    // Never delete on the word of the record alone: git must agree this path has that branch, and the
    // directory must carry the slug Axis created it under (the record is agent-writable).
    const mine = entries.find((e) => path.resolve(e.path) === workTree || e.path === workTree);
    if (
      !mine || mine.branch !== `refs/heads/${meta.branch}` || meta.branch !== `axis/${meta.slug}`
      || path.basename(workTree) !== meta.slug
    ) {
      throw new WorktreeError('E_POLICY_DENIED', 'refusing to delete a branch git does not list for this worktree', { reason: 'branch-mismatch' });
    }
  }
  const scan = await scanDiscard(git, workTree, host.maxFile);
  const { needsBackup } = requireDiscardConfirmation('remove', meta.id, scan, p.token);
  // REF-1: what the branch backup would pin beyond the base is scanned before anything is written.
  const tip = p.deleteBranch ? await git.text(['rev-parse', '--verify', '--end-of-options', `refs/heads/${meta.branch}`], { cwd: workTree }) : null;
  if (tip !== null) await assertHistoryClean(git, workTree, meta.baseSha, tip, host.snapshotScanner);
  const backupRef = needsBackup ? await host.writeBackup(workTree, meta, 'remove') : null;
  // The branch tip is recorded before anything is deleted, so a wrong record can never orphan commits.
  let branchBackupRef: string | null = null;
  if (tip !== null) {
    const ts = host.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    branchBackupRef = `refs/axis/backup/${meta.id}/branch-${ts}-${randomBytes(16).toString('hex')}`;
    await createRefOnce(git, workTree, branchBackupRef, tip);
  }
  await git.run(['worktree', 'unlock', '--', workTree], { cwd, allowFailure: true });
  // Always --force: Axis's own filter-free check and confirmation above replace git's, which would run `git status`.
  await git.run(['worktree', 'remove', '--force', '--', workTree], { cwd });
  await git.run(['worktree', 'prune'], { cwd });
  let branchDeleted = false;
  if (p.deleteBranch) {
    await git.run(['branch', '-D', '--', meta.branch], { cwd });
    branchDeleted = true;
  }
  return {
    removed: true as const, archiveRef, backupRef, branchDeleted, branchBackupRef,
    skippedLarge: scan.skippedLarge, ignored: scan.ignored, skippedUnsupported: scan.skippedUnsupported,
  };
}
