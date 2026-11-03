// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { constants as fsc, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';

/**
 * Creates `components` beneath `base` (which must already exist and be
 * canonical), one level at a time. Every level is lstat-ed and must be a real
 * directory, never a symlink, so a path swapped for a link mid-operation is
 * caught before anything is created through it.
 */
export async function mkdirSafe(base: string, components: readonly string[], mode = 0o700): Promise<string> {
  let cur = base;
  for (const c of components) {
    if (c === '' || c === '.' || c === '..' || c.includes('/') || c.includes('\\') || c.includes('\0')) {
      throw new WorktreeError('E_POLICY_DENIED', 'unsafe path component', { component: c });
    }
    cur = path.join(cur, c);
    let st = await fs.lstat(cur).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (st === null) {
      await fs.mkdir(cur, { mode });
      st = await fs.lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new WorktreeError('E_POLICY_DENIED', 'path component is a symlink or not a directory', { path: cur });
    }
  }
  return cur;
}

/** Creates a canonical absolute directory chain, verifying every created level. */
export async function ensureDirChain(canonical: string, mode = 0o700): Promise<void> {
  const pending: string[] = [];
  let cursor = canonical;
  for (;;) {
    try {
      if ((await fs.stat(cursor)).isDirectory()) break;
      throw new WorktreeError('E_POLICY_DENIED', 'a non-directory sits in the path', { path: cursor });
    } catch (e) {
      if (e instanceof WorktreeError) throw e;
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      pending.push(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new WorktreeError('E_NOT_FOUND', 'no existing ancestor');
      cursor = parent;
    }
  }
  await mkdirSafe(cursor, pending.reverse(), mode);
}

export const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Reads a small text file that must be a regular file. It is opened with
 * O_NOFOLLOW and O_NONBLOCK, so a FIFO or a symlink to a device cannot block a
 * thread or feed the daemon unbounded data, then `fstat`-ed on the open handle
 * and size-capped before any byte is read. Missing files reject with ENOENT;
 * anything else that is wrong rejects with E_INTERNAL.
 */
export async function readRegularFile(file: string, maxBytes = MAX_RECORD_BYTES): Promise<string> {
  const flags = fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0);
  const fh = await fs.open(file, flags);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new WorktreeError('E_INTERNAL', 'record is not a regular file', { reason: 'corrupt-record' });
    if (st.size > maxBytes) throw new WorktreeError('E_INTERNAL', 'record is too large', { reason: 'corrupt-record' });
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * A directory only this user can enter, for scratch files (such as the
 * temporary index of a snapshot) that must not live in the agent-writable
 * `$TMPDIR`. `dir`'s parent must already exist and be canonical. A symlink,
 * a non-directory or a directory owned by somebody else is refused.
 */
export async function privateDir(dir: string): Promise<string> {
  await mkdirSafe(path.dirname(dir), [path.basename(dir)], 0o700);
  const st = await fs.lstat(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new WorktreeError('E_POLICY_DENIED', 'the scratch directory is owned by another user', { path: dir });
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
  return dir;
}
