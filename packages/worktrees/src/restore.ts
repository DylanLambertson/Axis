// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';
import { mkdirSafe } from './fsSafe.js';

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
 * Writes `content` to `rel` inside `worktree` (canonical) without following a
 * final symlink. Missing directories are created one level at a time with
 * symlink checks; the content goes to a sibling temp file that is renamed over
 * the target, and the containing directory is re-verified afterwards. If it
 * was swapped meanwhile, the written file is removed and the call fails.
 */
export async function writeRestoredEntry(
  worktree: string,
  rel: string,
  entry: TreeEntry,
  content: Buffer,
): Promise<string> {
  const parts = rel.split('/');
  const dir = await mkdirSafe(worktree, parts.slice(0, -1), 0o755);
  const name = parts.at(-1) as string;
  const target = path.join(dir, name);
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isDirectory()) {
    throw new WorktreeError('E_CONFLICT', 'a directory exists where the file should be restored', { relPath: rel });
  }
  const tmp = path.join(dir, `.${name}.axis-restore-${randomBytes(8).toString('hex')}`);
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
  const realDir = await fs.realpath(dir).catch(() => null);
  if (realDir !== dir) {
    await fs.rm(target, { force: true });
    throw new WorktreeError('E_POLICY_DENIED', 'restore target directory changed during the operation', { relPath: rel });
  }
  return target;
}
