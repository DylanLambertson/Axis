// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';
import { sanitiseName } from './paths.js';

export interface RepoLocation {
  /** Canonical common directory: the repository identity. */
  readonly commonDir: string;
  /** This checkout's git dir. Equals commonDir for a main checkout or bare repo. */
  readonly gitDir: string;
  /** Canonical root of the working tree containing the start path; null for bare. */
  readonly workTree: string | null;
  /** True when gitDir differs from commonDir (a linked worktree). */
  readonly linked: boolean;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Follows a gitdir's `commondir` file (relative to the gitdir) when present. */
async function commonDirOf(gitDir: string): Promise<string> {
  const text = await readText(path.join(gitDir, 'commondir'));
  if (text === null) return gitDir;
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  if (!line) return gitDir;
  return fs.realpath(path.resolve(gitDir, line));
}

/** Parses a `.git` file: `gitdir: <path>`. Returns the canonical git dir. */
async function gitDirFromFile(dotGit: string): Promise<string> {
  const text = await readText(dotGit);
  const match = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match?.[1]) {
    throw new WorktreeError('E_NOT_FOUND', '.git file has no gitdir line', { path: dotGit });
  }
  const target = path.resolve(path.dirname(dotGit), match[1]);
  try {
    return await fs.realpath(target);
  } catch {
    throw new WorktreeError('E_NOT_FOUND', '.git file points at a missing gitdir', { path: dotGit, gitdir: target });
  }
}

async function looksLikeGitDir(p: string): Promise<boolean> {
  return (await isDir(path.join(p, 'objects'))) && (await isDir(path.join(p, 'refs'))) &&
    (await readText(path.join(p, 'HEAD'))) !== null;
}

/**
 * Locates the repository that contains `start` without spawning a process.
 * Handles a `.git` directory, a `.git` file (linked worktree or submodule, via
 * gitdir and commondir), and bare repositories.
 */
export async function resolveRepo(start: string): Promise<RepoLocation> {
  let cursor: string;
  try {
    cursor = await fs.realpath(start);
  } catch {
    throw new WorktreeError('E_NOT_FOUND', 'path does not exist', { path: start });
  }
  if (!(await isDir(cursor))) cursor = path.dirname(cursor);

  for (;;) {
    const dotGit = path.join(cursor, '.git');
    let st;
    try {
      st = await fs.lstat(dotGit);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) {
      const gitDir = await fs.realpath(dotGit);
      const commonDir = await commonDirOf(gitDir);
      return { commonDir, gitDir, workTree: cursor, linked: commonDir !== gitDir };
    }
    if (st?.isFile()) {
      const gitDir = await gitDirFromFile(dotGit);
      const commonDir = await commonDirOf(gitDir);
      return { commonDir, gitDir, workTree: cursor, linked: commonDir !== gitDir };
    }
    if (await looksLikeGitDir(cursor)) {
      return { commonDir: cursor, gitDir: cursor, workTree: null, linked: false };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new WorktreeError('E_NOT_FOUND', 'not inside a git repository', { path: start });
    cursor = parent;
  }
}

/** Repository identity hash: SHA-256 over the canonical common dir, first 8 hex digits. */
export function repoHash(commonDir: string, platform: NodeJS.Platform = process.platform): string {
  const key = platform === 'win32' ? commonDir.toLowerCase() : commonDir;
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** `<project>-<hash>`: the per-repository directory under the worktree root. */
export function projectDirName(
  commonDir: string,
  mainWorkTree: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  const base =
    mainWorkTree !== null
      ? path.basename(mainWorkTree)
      : path.basename(commonDir).replace(/\.git$/i, '');
  return `${sanitiseName(base)}-${repoHash(commonDir, platform)}`;
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  /** Full ref name such as refs/heads/axis/foo; null when detached or bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly prunable: boolean;
}

/** Parses `git worktree list --porcelain -z` output. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: {
    path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean;
    locked: boolean; lockReason: string | null; prunable: boolean;
  } | null = null;
  const flush = (): void => {
    if (cur) entries.push(cur);
    cur = null;
  };
  for (const record of stdout.split('\0')) {
    if (record === '') {
      flush();
      continue;
    }
    const space = record.indexOf(' ');
    const key = space === -1 ? record : record.slice(0, space);
    const value = space === -1 ? '' : record.slice(space + 1);
    if (key === 'worktree') {
      flush();
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') {
      cur.locked = true;
      cur.lockReason = value || null;
    } else if (key === 'prunable') cur.prunable = true;
  }
  flush();
  return entries;
}
