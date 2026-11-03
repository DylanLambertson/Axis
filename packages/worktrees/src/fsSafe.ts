// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { promises as fs } from 'node:fs';
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
