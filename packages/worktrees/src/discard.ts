// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { consumeConfirmation, type DiscardOp } from './confirmation.js';
import { WorktreeError } from './errors.js';
import type { HardenedGit } from './hardenedGit.js';
import { readDirtyFilterFree } from './dirty.js';
import { scanWorktree } from './snapshotRef.js';
import type { DirtyFile } from './types.js';

export interface DiscardScan {
  readonly dirty: readonly DirtyFile[];
  /** Files over the snapshot size limit: a backup cannot hold them. */
  readonly skippedLarge: readonly string[];
  /** Ignored files and directories: never in a snapshot (policies 7). */
  readonly ignored: readonly string[];
  /** Nested repositories and other entries a snapshot cannot hold: deleted by remove, never backed up. */
  readonly skippedUnsupported: readonly string[];
  /** Binds a confirmation to exactly this set of affected files. */
  readonly fingerprint: string;
}

export function readDirty(git: HardenedGit, cwd: string): Promise<DirtyFile[]> {
  return readDirtyFilterFree(git, cwd);
}

export async function scanDiscard(git: HardenedGit, workTree: string, maxFile: number): Promise<DiscardScan> {
  const dirty = await readDirty(git, workTree);
  const scan = await scanWorktree(git, workTree, maxFile);
  const ignoredOut = await git.run(
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: workTree },
  );
  const ignored = ignoredOut.stdout.split('\0').filter(Boolean).sort();
  const skippedLarge = [...scan.skippedLarge].sort();
  const skippedUnsupported = [...scan.skippedUnsupported].sort();
  const stats: Array<[string, string, number, number]> = [];
  for (const d of dirty) {
    const st = await fs.lstat(path.join(workTree, d.path)).catch(() => null);
    stats.push([d.path, d.index + d.worktree, st?.size ?? -1, Math.round(st?.mtimeMs ?? -1)]);
  }
  stats.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const fingerprint = createHash('sha256').update(JSON.stringify({ stats, skippedLarge, ignored, skippedUnsupported })).digest('hex');
  return { dirty, skippedLarge, ignored, skippedUnsupported, fingerprint };
}

/**
 * Enforces the confirmation rule. `finalise` needs one for uncommitted
 * changes; `remove` also needs one for anything a backup cannot hold (large
 * and ignored files), even when the worktree is otherwise clean. The token
 * must be minted for this workspace, operation and fingerprint, and is spent
 * here. Returns whether a backup snapshot must be written.
 */
export function requireDiscardConfirmation(
  op: DiscardOp, workspaceId: string, scan: DiscardScan, token: unknown,
): { needsBackup: boolean } {
  const unbacked = scan.skippedLarge.length + scan.ignored.length + scan.skippedUnsupported.length;
  const needed = scan.dirty.length > 0 || (op === 'remove' && unbacked > 0);
  if (!needed) return { needsBackup: false };
  const details = {
    reason: scan.dirty.length > 0 ? 'dirty' : 'unbacked-data',
    fingerprint: scan.fingerprint,
    files: scan.dirty.slice(0, 50).map((d) => d.path),
    count: scan.dirty.length,
    skippedLarge: scan.skippedLarge.slice(0, 50),
    ignored: scan.ignored.slice(0, 50),
    skippedUnsupported: scan.skippedUnsupported.slice(0, 50),
  };
  const result = consumeConfirmation(token, { workspaceId, op, fingerprint: scan.fingerprint });
  if (result === 'ok') return { needsBackup: scan.dirty.length > 0 };
  const why = { invalid: 'needs a verified confirmation', mismatch: 'confirmation does not match the current files', spent: 'confirmation was already used', expired: 'confirmation expired' }[result];
  throw new WorktreeError('E_CONFLICT', `${op}: ${why}`, {
    ...details,
    ...(result === 'invalid' ? {} : { reason: result === 'spent' ? 'confirmation-spent' : result === 'expired' ? 'confirmation-expired' : 'confirmation-stale' }),
  });
}
