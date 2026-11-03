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

/** True while `dir` is still the canonical directory it was verified to be. */
async function stillThere(dir: string): Promise<boolean> {
  return (await fs.realpath(dir).catch(() => null)) === dir;
}

/** Unlinks our own temp file: only if the entry is still the very file we created (never a directory or a link target). */
async function unlinkOwnTemp(file: string, ino: number | null): Promise<void> {
  if (ino === null) return;
  const st = await fs.lstat(file).catch(() => null);
  if (st && st.ino === ino && !st.isDirectory()) await fs.unlink(file).catch(() => undefined);
}

/**
 * Writes `content` to `rel` inside `worktree` (canonical) without following a
 * final symlink. Missing directories are created one level at a time with
 * symlink checks; the content goes to a sibling temp file that is renamed over
 * the target. The containing directory is re-verified immediately before the
 * rename and again after it. A failed check never deletes the target by path:
 * cleanup unlinks only the temp entry we created (checked by inode).
 *
 * Residual race: Node has no `openat`, so a parent swapped for a symlink in
 * the instant between the last check and the rename can still place the file
 * outside the worktree (it is then reported, and nothing is deleted). Closing
 * it fully needs a descriptor-relative rename from the pty or journal layer.
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
  let ino: number | null = null;
  try {
    if (entry.mode === '120000') {
      await fs.symlink(content.toString('utf8'), tmp);
    } else {
      await fs.writeFile(tmp, content, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
      if (entry.mode === '100755') await fs.chmod(tmp, 0o755);
    }
    ino = (await fs.lstat(tmp)).ino;
    if (!(await stillThere(dir))) {
      throw new WorktreeError('E_POLICY_DENIED', 'restore target directory changed during the operation', { relPath: rel });
    }
    await fs.rename(tmp, target);
  } catch (e) {
    await unlinkOwnTemp(tmp, ino);
    throw e;
  }
  if (!(await stillThere(dir))) {
    // Report only: the target path now resolves elsewhere, so it is never removed by path.
    throw new WorktreeError('E_POLICY_DENIED', 'restore target directory changed during the operation', { relPath: rel });
  }
  return target;
}
