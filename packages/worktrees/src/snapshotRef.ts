// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';
import { readPinnedFile, underRealDirs, type FileIdentity } from './fsSafe.js';
import type { HardenedGit } from './hardenedGit.js';
import { defaultSnapshotScanner, startSnapshotScan, type SnapshotScanner } from './snapshotScan.js';

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
  /** What the scan's lstat saw for each entry of `files`; content is read only while this still holds. */
  readonly ids: ReadonlyMap<string, FileIdentity & { readonly size: number }>;
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
    skippedUnsupported: [] as string[], executable: new Set<string>(), ids: new Map<string, FileIdentity & { size: number }>(),
  };
  const dirs = new Map<string, Promise<boolean>>();
  for (const rel of candidates) {
    if (!(await underRealDirs(worktree, rel, dirs))) {
      // Beyond a symlinked directory: never followed. Tracked means gone (as git sees it).
      (cached.has(rel) ? scan.removed : scan.skippedUnsupported).push(rel);
      continue;
    }
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
        scan.ids.set(rel, { dev: st.dev, ino: st.ino, size: st.size });
        if (process.platform !== 'win32' && (st.mode & 0o111) !== 0) scan.executable.add(rel);
      }
    } else scan.skippedUnsupported.push(rel);
  }
  return scan;
}

const changed = (rel: string): WorktreeError =>
  new WorktreeError('E_CONFLICT', 'a file changed while it was being read', { reason: 'file-changed', relPath: rel });

/** Reads `rel` only while it is still the scanned regular file, exactly `size` bytes; anything else is E_CONFLICT. */
async function readScanned(worktree: string, rel: string, id: FileIdentity & { size: number }, onChunk: (b: Buffer) => void): Promise<void> {
  if ((await readPinnedFile(worktree, rel, id, id.size, onChunk)) !== id.size) throw changed(rel);
}

/** Blob ids of the snapshot's base, by path, from the temporary index `read-tree HEAD` filled. */
async function baseBlobs(git: HardenedGit, worktree: string, env: Record<string, string>): Promise<Map<string, string>> {
  const out = await git.run(['ls-files', '-z', '-s'], { cwd: worktree, extraEnv: env });
  const map = new Map<string, string>();
  for (const rec of out.stdout.split('\0')) {
    const m = /^\d{6} ([0-9a-f]{40,64}) \d\t([\s\S]+)$/.exec(rec);
    if (m) map.set(m[2] as string, m[1] as string);
  }
  return map;
}

const blobId = (algo: 'sha1' | 'sha256', bytes: Buffer): string => createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

interface Hashed {
  readonly blobs: Map<string, string>;
  /** Symlink targets as read once, with their blob ids. */
  readonly links: Map<string, { readonly target: Buffer; readonly sha: string }>;
}

/**
 * Reads every file the scan found through `readPinnedFile` and every symlink target once, computes their blob ids, and
 * secret-scans each one whose blob is not already the base's at that path (REF-1, docs/design/snapshot-scan.md). Writes
 * nothing: a refusal leaves no object behind.
 */
async function hashAndScan(
  git: HardenedGit, worktree: string, scan: WorktreeScan, algo: 'sha1' | 'sha256', env: Record<string, string>, scanner: SnapshotScanner,
): Promise<Hashed> {
  const check = startSnapshotScan(scanner);
  const base = await baseBlobs(git, worktree, env);
  const blobs = new Map<string, string>();
  for (const rel of scan.files) {
    const id = scan.ids.get(rel) as FileIdentity & { size: number };
    const chunks: Buffer[] = [];
    await readScanned(worktree, rel, id, (b) => chunks.push(b));
    const bytes = Buffer.concat(chunks);
    const sha = blobId(algo, bytes);
    blobs.set(rel, sha);
    if (base.get(rel) !== sha) await check.add({ rel, mode: scan.executable.has(rel) ? '100755' : '100644', bytes });
  }
  const links = new Map<string, { target: Buffer; sha: string }>();
  for (const rel of scan.symlinks) {
    const target = Buffer.from(await fs.readlink(path.join(worktree, rel)), 'utf8');
    const sha = blobId(algo, target);
    links.set(rel, { target, sha });
    if (base.get(rel) !== sha) await check.add({ rel, mode: '120000', bytes: target });
  }
  check.finish();
  return { blobs, links };
}

/**
 * Stores the scanned files' bytes as blobs, with no filter or conversion. Git
 * is never given a worktree path (it would follow a symlink or block on a FIFO
 * swapped in after the scan): each file is read in this process through
 * `readPinnedFile`, and only blobs missing from the object store are written,
 * from memory, with `hash-object --stdin`. A stored blob must have the id that
 * was scanned, so what is written is what `hashAndScan` saw.
 */
async function storeMissing(git: HardenedGit, worktree: string, scan: WorktreeScan, h: Hashed): Promise<void> {
  const ids = [...new Set([...h.blobs.values(), ...[...h.links.values()].map((l) => l.sha)])];
  if (ids.length === 0) return;
  const check = await git.run(['cat-file', '--batch-check'], { cwd: worktree, input: ids.join('\n') + '\n' });
  const present = new Set(check.stdout.split('\n').filter((l) => / blob \d+$/.test(l)).map((l) => l.split(' ')[0]));
  const written = new Set<string>();
  for (const [rel, sha] of h.blobs) {
    if (present.has(sha) || written.has(sha)) continue;
    const id = scan.ids.get(rel) as FileIdentity & { size: number };
    const chunks: Buffer[] = [];
    await readScanned(worktree, rel, id, (b) => chunks.push(b));
    const stored = await git.text(['hash-object', '-w', '--no-filters', '--stdin'], { cwd: worktree, input: Buffer.concat(chunks) });
    if (stored !== sha) throw changed(rel);
    written.add(sha);
  }
  for (const [rel, link] of h.links) {
    if (present.has(link.sha) || written.has(link.sha)) continue;
    const stored = await git.text(['hash-object', '-w', '--no-filters', '--stdin'], { cwd: worktree, input: link.target });
    if (stored !== link.sha) throw changed(rel);
    written.add(link.sha);
  }
}

/**
 * Writes a snapshot commit of a worktree to a NEW `ref` (policies 7): HEAD,
 * plus the tracked and untracked-but-not-ignored working files, excluding any
 * file over `maxFileBytes`. A temporary index in a private daemon directory keeps the
 * worktree's real index untouched and out of reach of an agent. Content is read in
 * this process (see `hashAndScan`), stored with `--no-filters` and entered with
 * `update-index --index-info`, so no clean/smudge/process driver, attribute or
 * end-of-line conversion can run or alter the bytes. Every added entry is
 * secret-scanned first; a finding refuses before any object is written.
 */
export async function writeSnapshotRef(
  git: HardenedGit,
  worktree: string,
  ref: string,
  message: string,
  maxFileBytes: number,
  /** A private directory (see `privateDir`) for the temporary index; never `$TMPDIR`. */
  scratchDir: string,
  /** REF-1 scanner; absent means `createSecretScanner()` (refuse mode), never no scan. */
  scanner: SnapshotScanner = defaultSnapshotScanner(),
): Promise<SnapshotResult> {
  const tmp = await fs.mkdtemp(path.join(scratchDir, 'snap-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    await git.run(['read-tree', 'HEAD'], { cwd: worktree, extraEnv: env });
    const scan = await scanWorktree(git, worktree, maxFileBytes);
    const head = await git.text(['rev-parse', 'HEAD'], { cwd: worktree });
    const hashed = await hashAndScan(git, worktree, scan, head.length === 64 ? 'sha256' : 'sha1', env, scanner);
    await storeMissing(git, worktree, scan, hashed);
    const lines: string[] = [];
    for (const rel of scan.files) {
      lines.push(`${scan.executable.has(rel) ? '100755' : '100644'} ${hashed.blobs.get(rel) as string}\t${rel}\0`);
    }
    for (const [rel, link] of hashed.links) lines.push(`120000 ${link.sha}\t${rel}\0`);
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
