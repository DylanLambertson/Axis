// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';

/**
 * The default worktree root under the per-OS application data directory
 * (ADR 0004 decision 7). The location is configurable by the caller.
 */
export function defaultWorktreeRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Axis', 'worktrees');
  }
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return path.win32.join(local, 'Axis', 'worktrees');
  }
  const xdg = env['XDG_DATA_HOME'];
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
  return path.join(base, 'Axis', 'worktrees');
}

/** Rejects raw input that contains a `..` segment, before any normalisation. */
export function assertNoTraversal(raw: string, what: string): void {
  if (raw.includes('\0')) throw new WorktreeError('E_POLICY', `${what} contains a NUL byte`);
  if (raw.split(/[\\/]+/).includes('..')) {
    throw new WorktreeError('E_POLICY', `${what} must not contain ".." segments`, { path: raw });
  }
}

/**
 * Canonical absolute path. The deepest existing ancestor is resolved with
 * realpath (following symlinks); components that do not exist yet are
 * appended lexically. The input must already be absolute and `..`-free.
 */
export async function canonicalise(p: string): Promise<string> {
  if (!path.isAbsolute(p)) throw new WorktreeError('E_POLICY', 'path must be absolute', { path: p });
  assertNoTraversal(p, 'path');
  const resolved = path.resolve(p);
  const pending: string[] = [];
  let cursor = resolved;
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return pending.length ? path.join(real, ...pending.reverse()) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new WorktreeError('E_NOT_FOUND', 'no existing ancestor', { path: p });
      pending.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function fold(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

/** True when `child` equals `parent` or lies beneath it. Both must be canonical. */
export function isSameOrInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rel = path.relative(fold(parent, platform), fold(child, platform));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export interface ProtectedLocation {
  readonly label: string;
  readonly path: string;
}

/**
 * Location policy for the worktree root: the canonical root must not be equal
 * to or inside any registered repository (working tree, common dir) or any
 * existing worktree of it. Returns the canonical root.
 */
export async function validateWorktreeRoot(
  root: string,
  protectedLocations: readonly ProtectedLocation[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  assertNoTraversal(root, 'worktree root');
  const canonical = await canonicalise(root);
  for (const loc of protectedLocations) {
    if (isSameOrInside(canonical, loc.path, platform)) {
      throw new WorktreeError('E_POLICY', `worktree root is inside ${loc.label}`, {
        root: canonical,
        protectedPath: loc.path,
      });
    }
  }
  return canonical;
}

/** Windows-reserved and otherwise unsafe path characters become `_`. */
export function sanitiseName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 40);
  return cleaned || 'repo';
}
