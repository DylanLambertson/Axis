// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REF-1 history (docs/design/snapshot-scan.md): a ref under refs/axis/* at, or parented on, a commit the run made keeps that
// commit's blobs and message reachable. The run controls HEAD, so the only content taken as already shared is what the
// workspace's recorded base commit holds; everything reachable from the tip beyond it is scanned before the ref is written.

import { WorktreeError } from './errors.js';
import type { HardenedGit } from './hardenedGit.js';
import { defaultSnapshotScanner, startSnapshotScan, type SnapshotScan, type SnapshotScanner } from './snapshotScan.js';

/** Objects (commits, trees, blobs) one history scan will list; more is `snapshot-unscanned`. */
export const MAX_HISTORY_OBJECTS = 100_000;
/** Bytes of objects read by one `cat-file --batch` call. */
const BATCH_BYTES = 32 * 1024 * 1024;
const OID = /^[0-9a-f]{40,64}$/;

const tooMuch = (): WorktreeError =>
  new WorktreeError('E_POLICY_DENIED', 'the snapshot was refused: its content could not be fully scanned for secrets', { reason: 'snapshot-unscanned' });

/** What the trusted base commit's tree holds: content the user's own history already has, and its `path\0blob` names. */
export interface BaseTree {
  readonly ids: ReadonlySet<string>;
  readonly pairs: ReadonlySet<string>;
}

export async function baseTree(git: HardenedGit, cwd: string, base: string): Promise<BaseTree> {
  if (!OID.test(base)) throw tooMuch();
  const out = await git.run(['ls-tree', '-r', '-z', '--end-of-options', base], { cwd });
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const rec of out.stdout.split('\0')) {
    const m = /^\d{6} blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    ids.add(m[1] as string);
    pairs.add(`${m[2] as string}\0${m[1] as string}`);
  }
  return { ids, pairs };
}

/** The blob entries of a tree object (`<mode> <name>\0<raw id>`), as `{ name, mode, id }`. Gitlinks and subtrees are left out. */
export function treeBlobs(bytes: Buffer, idBytes: number): { name: string; mode: string; id: string }[] {
  const out: { name: string; mode: string; id: string }[] = [];
  for (let at = 0; at < bytes.length;) {
    const sp = bytes.indexOf(0x20, at);
    const nul = sp < 0 ? -1 : bytes.indexOf(0, sp);
    if (nul < 0 || nul + 1 + idBytes > bytes.length) throw tooMuch();
    const mode = bytes.toString('latin1', at, sp);
    const id = bytes.toString('hex', nul + 1, nul + 1 + idBytes);
    if (mode !== '40000' && mode !== '160000') out.push({ name: bytes.toString('utf8', sp + 1, nul), mode: mode.padStart(6, '0'), id });
    at = nul + 1 + idBytes;
  }
  return out;
}

interface Obj {
  readonly id: string;
  readonly type: string;
  readonly size: number;
  readonly path: string;
}

/** Reads objects with `cat-file --batch` in bounded chunks and hands each one's bytes to `use`. */
async function readObjects(git: HardenedGit, cwd: string, objs: readonly Obj[], use: (o: Obj, bytes: Buffer) => Promise<void>): Promise<void> {
  for (let i = 0; i < objs.length;) {
    const chunk: Obj[] = [];
    let bytes = 0;
    while (i < objs.length && (chunk.length === 0 || bytes + (objs[i] as Obj).size <= BATCH_BYTES)) {
      bytes += (objs[i] as Obj).size;
      chunk.push(objs[i++] as Obj);
    }
    const raw = (await git.run(['cat-file', '--batch'], { cwd, input: chunk.map((o) => o.id).join('\n') + '\n' })).raw;
    let at = 0;
    for (const o of chunk) {
      const nl = raw.indexOf(0x0a, at);
      const header = nl < 0 ? '' : raw.toString('latin1', at, nl);
      if (header !== `${o.id} ${o.type} ${o.size}`) throw tooMuch();
      await use(o, raw.subarray(nl + 1, nl + 1 + o.size));
      at = nl + 1 + o.size + 1;
    }
  }
}

/**
 * Scans every blob, every whole commit object, and every blob name in every tree reachable from `tip` but not from `base`
 * (`git rev-list --objects base..tip`), except what the base's own tree holds (a blob by id, a name by path and id). A name is
 * scanned for every tree that holds it, not once per blob, so content shared with the base cannot carry a new name past the
 * scan. Objects too large to scan are refused unread. Returns the blob ids whose content it scanned.
 */
export async function scanHistory(
  git: HardenedGit, cwd: string, base: string, tip: string, check: SnapshotScan, limits: SnapshotScanner['limits'], baseT: BaseTree,
  maxObjects = MAX_HISTORY_OBJECTS,
): Promise<Set<string>> {
  const scanned = new Set<string>();
  if (!OID.test(base) || !OID.test(tip)) throw tooMuch();
  if (base === tip) return scanned;
  const listed = (await git.run(['rev-list', '--objects', '--end-of-options', `${base}..${tip}`], { cwd })).stdout.split('\n').filter((l) => l !== '');
  if (listed.length > maxObjects) throw tooMuch();
  const paths = new Map<string, string>();
  for (const line of listed) {
    const sp = line.indexOf(' ');
    const id = sp < 0 ? line : line.slice(0, sp);
    if (OID.test(id) && !paths.has(id)) paths.set(id, sp < 0 ? '' : line.slice(sp + 1));
  }
  if (paths.size === 0) return scanned;
  const typed = (await git.run(['cat-file', '--batch-check'], { cwd, input: [...paths.keys()].join('\n') + '\n' })).stdout.split('\n');
  const toRead: Obj[] = [];
  for (const rec of typed) {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(rec);
    if (!m) continue;
    const o: Obj = { id: m[1] as string, type: m[2] as string, size: Number(m[3]), path: paths.get(m[1] as string) ?? '' };
    // Too large to scan: refused without reading it (a blob that is a small enough binary still gets its marker).
    const tooLarge = o.size > 4 * limits.maxBytes && (o.type !== 'blob' || o.size > limits.maxBinaryBytes);
    if (o.type === 'blob' && baseT.ids.has(o.id)) continue;
    if (o.type === 'blob') scanned.add(o.id);
    if (o.type !== 'blob' && o.type !== 'commit' && o.type !== 'tree') continue;
    if (tooLarge) check.unscannable(o.type === 'commit' ? { commit: o.id } : { path: o.path });
    else toRead.push(o);
  }
  const names = new Map<string, string>();
  await readObjects(git, cwd, toRead, async (o, bytes) => {
    if (o.type === 'commit') await check.addCommit(o.id, bytes);
    else if (o.type === 'blob') await check.add({ rel: o.path, mode: '100644', bytes });
    else {
      for (const e of treeBlobs(bytes, o.id.length / 2)) {
        const rel = o.path === '' ? e.name : `${o.path}/${e.name}`;
        if (!baseT.pairs.has(`${rel}\0${e.id}`)) names.set(rel, e.mode);
      }
    }
  });
  await check.addNames([...names].map(([rel, mode]) => ({ rel, mode })));
  return scanned;
}

/**
 * Before a ref is pointed at `tip` with no new tree (the finalise archive, the branch backup of a remove): refuses when
 * anything `tip` holds beyond the trusted base looks like a secret or cannot be scanned.
 */
export async function assertHistoryClean(git: HardenedGit, cwd: string, base: string, tip: string, scanner: SnapshotScanner = defaultSnapshotScanner()): Promise<void> {
  const check = startSnapshotScan(scanner);
  await scanHistory(git, cwd, base, tip, check, scanner.limits, await baseTree(git, cwd, base));
  check.finish();
}
