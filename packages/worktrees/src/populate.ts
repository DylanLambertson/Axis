// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';
import type { HardenedGit } from './hardenedGit.js';
import { mkdirSafe } from './fsSafe.js';
import { hasGitComponent } from './pathGuard.js';

interface Entry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size: number;
  readonly rel: string;
}

const BATCH_BYTES = 64 * 1024 * 1024;

function parseLsTreeLong(stdout: string): Entry[] {
  const out: Entry[] = [];
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]*)$/.exec(rec);
    if (!m) throw new WorktreeError('E_INTERNAL', 'unexpected ls-tree output');
    out.push({ mode: m[1] as string, type: m[2] as string, sha: m[3] as string, size: m[4] === '-' ? 0 : Number(m[4]), rel: m[5] as string });
  }
  return out;
}

/** Reads blobs with one `cat-file --batch` process per size-bounded group. */
async function readBlobs(git: HardenedGit, cwd: string, entries: readonly Entry[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  const unique = new Map<string, number>();
  for (const e of entries) unique.set(e.sha, e.size);
  const groups: string[][] = [[]];
  let bytes = 0;
  for (const [sha, size] of unique) {
    if (bytes + size > BATCH_BYTES && (groups.at(-1) as string[]).length > 0) {
      groups.push([]);
      bytes = 0;
    }
    (groups.at(-1) as string[]).push(sha);
    bytes += size;
  }
  for (const group of groups) {
    if (group.length === 0) continue;
    const res = await git.run(['cat-file', '--batch'], { cwd, input: group.join('\n') + '\n' });
    let pos = 0;
    for (const sha of group) {
      const nl = res.raw.indexOf(0x0a, pos);
      const header = res.raw.subarray(pos, nl).toString('utf8').split(' ');
      const size = Number(header[2]);
      if (nl === -1 || header[0] !== sha || header[1] !== 'blob' || !Number.isFinite(size)) {
        throw new WorktreeError('E_INTERNAL', 'unexpected cat-file output');
      }
      blobs.set(sha, Buffer.from(res.raw.subarray(nl + 1, nl + 1 + size)));
      pos = nl + 1 + size + 1;
    }
  }
  return blobs;
}

/**
 * Checks `HEAD` out into a fresh `--no-checkout` worktree without any filter:
 * blobs are read straight from the object store and written byte for byte.
 * Each directory is created one level at a time with symlink checks, and any
 * tree path naming `.git` is refused, as git's own checkout would.
 */
export async function populateFilterFree(git: HardenedGit, worktree: string): Promise<void> {
  const listing = await git.run(['ls-tree', '-r', '-l', '-z', '--full-tree', 'HEAD'], { cwd: worktree });
  const entries = parseLsTreeLong(listing.stdout);
  for (const e of entries) {
    if (hasGitComponent(e.rel)) {
      throw new WorktreeError('E_POLICY_DENIED', 'the tree contains a .git path; refusing to check it out', { path: e.rel });
    }
  }
  const blobs = await readBlobs(git, worktree, entries.filter((e) => e.type === 'blob'));
  for (const e of entries) {
    const parts = e.rel.split('/');
    const dir = await mkdirSafe(worktree, parts.slice(0, -1), 0o755);
    const target = path.join(dir, parts.at(-1) as string);
    if (e.type === 'commit') {
      await mkdirSafe(dir, [parts.at(-1) as string], 0o755); // submodule: empty directory
    } else if (e.mode === '120000') {
      await fs.symlink((blobs.get(e.sha) as Buffer).toString('utf8'), target);
    } else {
      await fs.writeFile(target, blobs.get(e.sha) as Buffer, { flag: 'wx', mode: e.mode === '100755' ? 0o755 : 0o644 });
      if (e.mode === '100755') await fs.chmod(target, 0o755);
    }
  }
  // The index carries no stat data, so nothing here compares files through a filter; git refreshes it lazily.
  await git.run(['read-tree', 'HEAD'], { cwd: worktree });
}
