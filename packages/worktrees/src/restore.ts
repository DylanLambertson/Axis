// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import { constants as fsc, promises as fs, type BigIntStats } from 'node:fs';
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

/** A directory's identity: the device and inode it had when it was verified. */
interface DirId {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** True while `dir` is still the canonical directory it was verified to be, and still the very directory with identity `id`. */
async function stillThere(dir: string, id: DirId): Promise<boolean> {
  if ((await fs.realpath(dir).catch(() => null)) !== dir) return false;
  const st = await fs.stat(dir, { bigint: true }).catch(() => null);
  return st !== null && st.isDirectory() && st.dev === id.dev && st.ino === id.ino;
}

/** True when `st` is the very entry `own` identifies. */
function same(st: BigIntStats | null, own: DirId): boolean {
  return st !== null && st.dev === own.dev && st.ino === own.ino;
}

/**
 * Unlinks our own temp file by the path it was created under, only if that path still names the very entry we created
 * (device and inode, never a directory): if a parent was swapped for a symlink the path leads to our own file in the
 * other directory and it is removed there, but anything else sitting at the path is never touched.
 */
async function unlinkOwnTemp(file: string, own: DirId | null): Promise<void> {
  if (own === null) return;
  const st = await fs.lstat(file, { bigint: true }).catch(() => null);
  if (st !== null && same(st, own) && !st.isDirectory()) await fs.unlink(file).catch(() => undefined);
}

/** Test seams: run between the steps of a restore, to move things on a real filesystem at the racy instants. */
export interface RestoreHooks {
  /** After the directory's identity is recorded, before the temp entry is created. */
  readonly beforeCreate?: (tmp: string, dir: string) => Promise<void> | void;
  /** After the temp entry exists and its identity is recorded, before the directory is re-checked. */
  readonly afterCreate?: (tmp: string, dir: string) => Promise<void> | void;
}

/**
 * Writes `content` to `rel` inside `worktree` (canonical) without following a
 * final symlink. Missing directories are created one level at a time with
 * symlink checks; the content goes to a sibling temp file that is renamed over
 * the target. A regular file is created through a descriptor opened with
 * O_CREAT|O_EXCL|O_NOFOLLOW (where the platform has it), and the descriptor is
 * the identity of the temp file (`fstat`), not the path. The containing
 * directory's device and inode are recorded before the temp file is created and
 * compared again immediately before the rename and once more after it; a
 * directory that was swapped (for another directory or a symlink) is refused.
 * A failed check never deletes the target by path: cleanup unlinks only the
 * temp entry we created, by the path it was opened under, and only while that
 * path still names the same device and inode.
 *
 * Residual race: Node has no `openat`, so a parent swapped in the instant between
 * the last check and the rename can still place the file outside the worktree
 * (it is then reported, and only our own temp file is ever removed). Closing it
 * fully needs a descriptor-relative rename from the pty or helper layer.
 */
export async function writeRestoredEntry(
  worktree: string,
  rel: string,
  entry: TreeEntry,
  content: Buffer,
  hooks: RestoreHooks = {},
): Promise<string> {
  const parts = rel.split('/');
  const dir = await mkdirSafe(worktree, parts.slice(0, -1), 0o755);
  const name = parts.at(-1) as string;
  const target = path.join(dir, name);
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isDirectory()) {
    throw new WorktreeError('E_CONFLICT', 'a directory exists where the file should be restored', { relPath: rel });
  }
  const dirStat = await fs.stat(dir, { bigint: true });
  const dirId: DirId = { dev: dirStat.dev, ino: dirStat.ino };
  const changed = (): WorktreeError =>
    new WorktreeError('E_POLICY_DENIED', 'restore target directory changed during the operation', { relPath: rel });
  const tmp = path.join(dir, `.${name}.axis-restore-${randomBytes(8).toString('hex')}`);
  let own: DirId | null = null;
  try {
    await hooks.beforeCreate?.(tmp, dir);
    if (entry.mode === '120000') {
      await fs.symlink(content.toString('utf8'), tmp);
      const st = await fs.lstat(tmp, { bigint: true });
      own = { dev: st.dev, ino: st.ino };
    } else {
      const mode = entry.mode === '100755' ? 0o755 : 0o644;
      const fh = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), mode);
      try {
        const st = await fh.stat({ bigint: true });
        own = { dev: st.dev, ino: st.ino };
        await fh.writeFile(content);
        if (entry.mode === '100755') await fh.chmod(0o755);
      } finally {
        await fh.close();
      }
    }
    await hooks.afterCreate?.(tmp, dir);
    if (!(await stillThere(dir, dirId))) throw changed();
    // The path must still name the entry we created (and nothing else) at the instant of the rename.
    if (!same(await fs.lstat(tmp, { bigint: true }).catch(() => null), own)) throw changed();
    await fs.rename(tmp, target);
  } catch (e) {
    await unlinkOwnTemp(tmp, own);
    throw e;
  }
  if (!(await stillThere(dir, dirId))) {
    // Report only: the target path now resolves elsewhere, so it is never removed by path.
    throw changed();
  }
  return target;
}
