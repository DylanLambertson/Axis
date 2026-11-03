// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';
import type { HardenedGit } from './hardenedGit.js';
import type { DirtyFile } from './types.js';

interface Entry {
  readonly mode: string;
  readonly sha: string;
}

const HASH_PARALLEL = 8;

function algoFor(sha: string): 'sha1' | 'sha256' {
  return sha.length === 64 ? 'sha256' : 'sha1';
}

/** The object id git would give these bytes as a blob, with no filter or conversion applied. */
async function blobId(file: string, size: number, algo: 'sha1' | 'sha256'): Promise<string> {
  const h = createHash(algo).update(`blob ${size}\0`);
  let seen = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    seen += chunk.length;
    h.update(chunk);
  }
  if (seen !== size) throw new WorktreeError('E_CONFLICT', 'a file changed while it was being read', { reason: 'file-changed' });
  return h.digest('hex');
}

function parseIndex(stdout: string): Map<string, Entry & { stage: number }> {
  const out = new Map<string, Entry & { stage: number }>();
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const m = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]*)$/.exec(rec);
    if (!m) throw new WorktreeError('E_INTERNAL', 'unexpected ls-files output');
    const prior = out.get(m[4] as string);
    const stage = Number(m[3]);
    out.set(m[4] as string, { mode: m[1] as string, sha: m[2] as string, stage: Math.max(stage, prior?.stage ?? 0) });
  }
  return out;
}

function parseTree(stdout: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const m = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t([\s\S]*)$/.exec(rec);
    if (!m) throw new WorktreeError('E_INTERNAL', 'unexpected ls-tree output');
    out.set(m[3] as string, { mode: m[1] as string, sha: m[2] as string });
  }
  return out;
}

/** Worktree side of one tracked path: ' ' same, 'D' gone, 'M' different. */
async function worktreeState(workTree: string, rel: string, e: Entry): Promise<string> {
  const abs = path.join(workTree, rel);
  const st = await fs.lstat(abs).catch(() => null);
  if (!st) return 'D';
  if (st.isSymbolicLink()) {
    if (e.mode !== '120000') return 'M';
    const target = await fs.readlink(abs, { encoding: 'buffer' });
    const sha = createHash(algoFor(e.sha)).update(`blob ${target.length}\0`).update(target).digest('hex');
    return sha === e.sha ? ' ' : 'M';
  }
  if (!st.isFile()) return st.isDirectory() ? 'D' : 'M'; // never open a FIFO or device
  if (e.mode === '120000') return 'M';
  if (process.platform !== 'win32' && ((st.mode & 0o111) !== 0) !== (e.mode === '100755')) return 'M';
  return (await blobId(abs, st.size, algoFor(e.sha))) === e.sha ? ' ' : 'M';
}

/**
 * `git status` runs clean filters, so Axis compares files with the object store itself.
 * Filter-free replacement for `git status --porcelain`. It lists the index,
 * HEAD and untracked files with commands that run no filter driver, and
 * compares file bytes with the stored blobs in this process. Because no clean
 * filter or line-ending conversion is applied, a file that git itself would
 * call clean after conversion may show as modified here: the safe direction.
 * Submodules are ignored, as with `--ignore-submodules=all`.
 */
export async function readDirtyFilterFree(git: HardenedGit, workTree: string): Promise<DirtyFile[]> {
  const opts = { cwd: workTree };
  const [idxOut, headOut, othersOut] = await Promise.all([
    git.run(['ls-files', '-s', '-z'], opts),
    git.run(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], opts),
    git.run(['ls-files', '-z', '--others', '--exclude-standard'], opts),
  ]);
  const index = parseIndex(idxOut.stdout);
  const head = parseTree(headOut.stdout);
  const paths = [...new Set([...index.keys(), ...head.keys()])].sort();
  const dirty: DirtyFile[] = [];
  const queue = paths.filter((p) => index.get(p)?.mode !== '160000' && head.get(p)?.mode !== '160000');
  const rows = new Map<string, DirtyFile | null>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const rel = queue[next++];
      if (rel === undefined) return;
      const i = index.get(rel);
      const h = head.get(rel);
      if (i && i.stage > 0) {
        rows.set(rel, { path: rel, index: 'U', worktree: 'U' });
        continue;
      }
      const x = !i ? (h ? 'D' : ' ') : !h ? 'A' : i.sha !== h.sha || i.mode !== h.mode ? 'M' : ' ';
      const y = i ? await worktreeState(workTree, rel, i) : ' ';
      rows.set(rel, x === ' ' && y === ' ' ? null : { path: rel, index: x, worktree: y });
    }
  };
  await Promise.all(Array.from({ length: HASH_PARALLEL }, worker));
  for (const rel of queue) {
    const row = rows.get(rel);
    if (row) dirty.push(row);
  }
  for (const rel of [...new Set(othersOut.stdout.split('\0').filter(Boolean))].sort()) {
    dirty.push({ path: rel, index: '?', worktree: '?' });
  }
  return dirty;
}
