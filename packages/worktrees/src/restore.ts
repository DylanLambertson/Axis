// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';

export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

/** Parses one record of `git ls-tree -z` output (`<mode> SP <type> SP <sha> TAB <path>`). */
export function parseLsTree(stdout: string): TreeEntry | null {
  const record = stdout.split('\0').find((r) => r !== '');
  if (!record) return null;
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t/.exec(record);
  return m ? { mode: m[1] as string, type: m[2] as string, sha: m[3] as string } : null;
}

/**
 * Writes `content` to `target` (already canonical, inside `worktree`) without
 * following a final symlink: the content goes to a sibling temp file that is
 * renamed over the target, and every directory above it is re-verified with
 * realpath to still sit inside the worktree (WT-1).
 */
export async function writeRestoredEntry(
  worktree: string,
  target: string,
  entry: TreeEntry,
  content: Buffer,
): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const realDir = await fs.realpath(dir);
  if (realDir !== dir) {
    throw new WorktreeError('E_POLICY', 'restore target directory changed during the operation', { dir });
  }
  const rel = path.relative(worktree, realDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorktreeError('E_POLICY', 'restore target escapes the worktree', { target });
  }
  try {
    if ((await fs.lstat(target)).isDirectory()) {
      throw new WorktreeError('E_CONFLICT', 'a directory exists where the file should be restored', { target });
    }
  } catch (e) {
    if (e instanceof WorktreeError) throw e;
  }
  const tmp = path.join(dir, `.${path.basename(target)}.axis-restore-${randomBytes(4).toString('hex')}`);
  try {
    if (entry.mode === '120000') {
      await fs.symlink(content.toString('utf8'), tmp);
    } else {
      await fs.writeFile(tmp, content, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
      if (entry.mode === '100755') await fs.chmod(tmp, 0o755);
    }
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
