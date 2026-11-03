// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';
import type { HardenedGit } from './hardenedGit.js';

export const MAX_SNAPSHOT_FILE_BYTES = 50 * 1024 * 1024;

export interface SnapshotResult {
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  /** Worktree-relative paths left out because they exceed the size limit. */
  readonly skippedLarge: readonly string[];
}

const IDENTITY = ['-c', 'user.name=Axis', '-c', 'user.email=axis@localhost.invalid'];

export function zeroOid(sample: string): string {
  return '0'.repeat(sample.length);
}

/**
 * Creates `ref` pointing at `sha` only if it does not exist yet (compare and
 * swap against the all-zero oid). Existing refs are never overwritten.
 */
export async function createRefOnce(git: HardenedGit, cwd: string, ref: string, sha: string): Promise<void> {
  const res = await git.run(['update-ref', ref, sha, zeroOid(sha)], { cwd, allowFailure: true });
  if (res.code !== 0) {
    throw new WorktreeError('E_CONFLICT', 'ref already exists or could not be created', { reason: 'ref-exists', ref });
  }
}

/** Deletes `ref` only while it still points at `expectedSha`. */
export async function deleteRefIf(git: HardenedGit, cwd: string, ref: string, expectedSha: string): Promise<void> {
  await git.run(['update-ref', '-d', ref, expectedSha], { cwd, allowFailure: true });
}

export interface WorktreeScan {
  /** Regular files to record. */
  readonly files: string[];
  readonly symlinks: string[];
  /** Tracked paths that no longer exist on disk. */
  readonly removed: string[];
  readonly skippedLarge: string[];
  /** Untracked directories (nested repositories), FIFOs, sockets and devices: not in any snapshot. */
  readonly skippedUnsupported: string[];
  readonly executable: ReadonlySet<string>;
}

/** Lists what a snapshot would hold, applying the size limit. Runs no filter. */
export async function scanWorktree(git: HardenedGit, worktree: string, maxFileBytes: number): Promise<WorktreeScan> {
  const [cachedOut, othersOut] = await Promise.all([
    git.run(['ls-files', '-z', '--cached'], { cwd: worktree }),
    git.run(['ls-files', '-z', '--others', '--exclude-standard'], { cwd: worktree }),
  ]);
  const cached = new Set(cachedOut.stdout.split('\0').filter((p) => p !== ''));
  const candidates = [...new Set([...cached, ...othersOut.stdout.split('\0').filter((p) => p !== '')])];
  const scan = {
    files: [] as string[], symlinks: [] as string[], removed: [] as string[], skippedLarge: [] as string[],
    skippedUnsupported: [] as string[], executable: new Set<string>(),
  };
  for (const rel of candidates) {
    let st;
    try {
      st = await fs.lstat(path.join(worktree, rel));
    } catch {
      scan.removed.push(rel);
      continue;
    }
    if (st.isDirectory()) {
      if (!cached.has(rel)) scan.skippedUnsupported.push(rel); // nested repository; a tracked gitlink keeps HEAD's entry
    } else if (st.isSymbolicLink()) scan.symlinks.push(rel);
    else if (st.isFile()) {
      if (st.size > maxFileBytes) scan.skippedLarge.push(rel);
      else {
        scan.files.push(rel);
        if (process.platform !== 'win32' && (st.mode & 0o111) !== 0) scan.executable.add(rel);
      }
    } else scan.skippedUnsupported.push(rel);
  }
  return scan;
}

/** Hashes working files into the object store byte for byte, with filters off. */
async function hashRaw(git: HardenedGit, worktree: string, rels: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const batch = rels.filter((r) => !/[\r\n]/.test(r));
  if (batch.length > 0) {
    const res = await git.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      cwd: worktree, input: batch.join('\n') + '\n',
    });
    const shas = res.stdout.split('\n').filter(Boolean);
    if (shas.length !== batch.length) throw new WorktreeError('E_INTERNAL', 'hash-object returned an unexpected result');
    batch.forEach((r, i) => out.set(r, shas[i] as string));
  }
  for (const r of rels.filter((p) => /[\r\n]/.test(p))) {
    out.set(r, await git.text(['hash-object', '-w', '--no-filters', '--', r], { cwd: worktree }));
  }
  return out;
}

/**
 * Writes a snapshot commit of a worktree to a NEW `ref` (policies 7): HEAD,
 * plus the tracked and untracked-but-not-ignored working files, excluding any
 * file over `maxFileBytes`. A temporary index in a private daemon directory keeps the
 * worktree's real index untouched and out of reach of an agent. Content is hashed with `--no-filters` and entered with
 * `update-index --index-info`, so no clean/smudge/process driver, attribute or
 * end-of-line conversion can run or alter the bytes.
 */
export async function writeSnapshotRef(
  git: HardenedGit,
  worktree: string,
  ref: string,
  message: string,
  maxFileBytes: number,
  /** A private directory (see `privateDir`) for the temporary index; never `$TMPDIR`. */
  scratchDir: string,
): Promise<SnapshotResult> {
  const tmp = await fs.mkdtemp(path.join(scratchDir, 'snap-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    await git.run(['read-tree', 'HEAD'], { cwd: worktree, extraEnv: env });
    const scan = await scanWorktree(git, worktree, maxFileBytes);
    const blobs = await hashRaw(git, worktree, scan.files);
    const lines: string[] = [];
    for (const rel of scan.files) {
      lines.push(`${scan.executable.has(rel) ? '100755' : '100644'} ${blobs.get(rel) as string}\t${rel}\0`);
    }
    for (const rel of scan.symlinks) {
      const target = await fs.readlink(path.join(worktree, rel));
      const sha = await git.text(['hash-object', '-w', '--no-filters', '--stdin'], { cwd: worktree, input: target });
      lines.push(`120000 ${sha}\t${rel}\0`);
    }
    const head = await git.text(['rev-parse', 'HEAD'], { cwd: worktree });
    for (const rel of scan.removed) lines.push(`0 ${zeroOid(head)}\t${rel}\0`);
    if (lines.length > 0) {
      await git.run(['update-index', '-z', '--index-info'], { cwd: worktree, extraEnv: env, input: lines.join('') });
    }
    const tree = await git.text(['write-tree'], { cwd: worktree, extraEnv: env });
    const commit = await git.text(
      [...IDENTITY, 'commit-tree', tree, '-p', 'HEAD', '-m', message],
      { cwd: worktree },
    );
    await createRefOnce(git, worktree, ref, commit);
    return { ref, commit, tree, skippedLarge: scan.skippedLarge };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
