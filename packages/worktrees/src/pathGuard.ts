// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';
import { assertNoTraversal } from './paths.js';

// Zero-width and bidi characters that HFS+ ignores when comparing names.
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * Mirrors git's verify_path rules for the `.git` name: case-insensitive, HFS
 * ignorables dropped, NTFS trailing dots/spaces and `::$stream` suffixes
 * stripped, and the NTFS short name `git~1`.
 */
export function isGitName(component: string): boolean {
  let s = component.replace(HFS_IGNORABLE, '');
  const colon = s.indexOf(':');
  if (colon !== -1) s = s.slice(0, colon);
  s = s.replace(/[. ]+$/, '').toLowerCase();
  return s === '.git' || s === 'git~1';
}

/** True when any path component, in either separator style, names `.git`. */
export function hasGitComponent(rel: string): boolean {
  return rel.split(/[\\/]+/).some(isGitName);
}

/** A relative path that climbs out of its base (not merely a name starting with "..") . */
export function isOutsideRel(rel: string): boolean {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

/** The path is inside `expected` (lexically) and none of its parent components below it is a symlink. */
export async function assertUnder(expected: string, p: string): Promise<void> {
  assertNoTraversal(expected, 'expected worktree');
  const root = path.resolve(expected);
  const rel = path.relative(root, path.resolve(p));
  if (rel === '' || isOutsideRel(rel)) throw new WorktreeError('E_POLICY_DENIED', 'path is outside the worktree');
  let cur = root;
  for (const part of rel.split(path.sep).slice(0, -1)) {
    cur = path.join(cur, part);
    const st = await fs.lstat(cur).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (st === null) return; // the rest does not exist yet: nothing to follow
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new WorktreeError('E_POLICY_DENIED', 'a parent folder of the path is a symlink', { reason: 'symlink-component' });
    }
  }
}
