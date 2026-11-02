// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/**
 * Writes a snapshot commit of a worktree to `ref` (policies 7): HEAD, plus the
 * tracked and untracked-but-not-ignored working files, excluding any file over
 * `maxFileBytes`. A temporary index keeps the worktree's real index untouched,
 * and only objects and the one ref are written to the shared common dir.
 */
export async function writeSnapshotRef(
  git: HardenedGit,
  worktree: string,
  ref: string,
  message: string,
  maxFileBytes: number = MAX_SNAPSHOT_FILE_BYTES,
): Promise<SnapshotResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-snap-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    await git.run(['read-tree', 'HEAD'], { cwd: worktree, extraEnv: env });
    const listed = await git.run(
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: worktree },
    );
    const candidates = [...new Set(listed.stdout.split('\0').filter((p) => p !== ''))];
    const include: string[] = [];
    const skippedLarge: string[] = [];
    for (const rel of candidates) {
      let st;
      try {
        st = await fs.lstat(path.join(worktree, rel));
      } catch {
        include.push(rel); // deleted from disk: --remove records the deletion
        continue;
      }
      if (st.isDirectory()) continue; // nested repo / gitlink: keep HEAD's entry
      if (st.isFile() && st.size > maxFileBytes) {
        skippedLarge.push(rel);
        continue;
      }
      include.push(rel);
    }
    if (include.length > 0) {
      await git.run(['update-index', '--add', '--remove', '-z', '--stdin'], {
        cwd: worktree,
        extraEnv: env,
        input: include.join('\0') + '\0',
      });
    }
    const tree = await git.text(['write-tree'], { cwd: worktree, extraEnv: env });
    const commit = await git.text(
      [...IDENTITY, 'commit-tree', tree, '-p', 'HEAD', '-m', message],
      { cwd: worktree },
    );
    await git.run(['update-ref', ref, commit], { cwd: worktree });
    return { ref, commit, tree, skippedLarge };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
