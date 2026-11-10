// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review attack suite: the original attacks replayed against the daemon (B-1, B-2, NB-1, NB-2, S-1 to S-6).

import { execFileSync } from 'node:child_process';
import {
   existsSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { after } from 'node:test';
import { WorktreeError, WorktreeManager } from '../src/index.js';
import { confirmFor, makeFixture, sh, write, type Fixture, exp } from './helpers.js';
const fixtures: Fixture[] = [];
export function fresh(extra: Parameters<typeof makeFixture>[0] = {}): Fixture {
  const f = makeFixture(extra);
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

export const PROTOCOL = new Set(['E_INVALID_ARGUMENT', 'E_NOT_FOUND', 'E_CONFLICT', 'E_POLICY_DENIED', 'E_INTERNAL']);

/** Plain, UNHARDENED git, as an agent or a careless daemon would run it. */
export function raw(cwd: string, home: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  } catch {
    return '';
  }
}

export const gitDirOf = (wt: string): string => sh(wt, 'rev-parse', '--absolute-git-dir').trim();

/** Same size, new mtime: forces git to re-hash (and so run clean) on the next status/refresh. */
export function statDirty(file: string): void {
  const t = new Date(Date.now() + 120_000);
  utimesSync(file, t, t);
}

/** What the agent does after planting: rewrite its own (agent-writable) baseline so the drift guard passes. */
export async function agentRewritesBaseline(m: WorktreeManager, wt: string): Promise<void> {
  const snap = await m.takeGitSnapshot(wt);
  writeFileSync(path.join(gitDirOf(wt), 'axis-gitsnap.json'), JSON.stringify(snap));
}

export interface OpLog { op: string; outcome: string; fired: boolean }

/** Runs every daemon path that touches blobs; records after which one the marker appeared. */
export async function everyBlobPath(fx: Fixture, m: WorktreeManager, a: { path: string; id: string }, marker: string): Promise<OpLog[]> {
  const log: OpLog[] = [];
  const step = async (op: string, fn: () => Promise<unknown>): Promise<void> => {
    let outcome = 'ok';
    try {
      await fn();
    } catch (e) {
      outcome = e instanceof WorktreeError ? `${e.code}:${String(e.details['reason'] ?? e.message)}` : `RAW:${String(e)}`;
    }
    const fired = existsSync(marker);
    log.push({ op, outcome, fired });
    rmSync(marker, { force: true });
  };
  const dirtyA = (): void => {
    write(path.join(a.path, 'a.txt'), 'ALPHA\n'); // same size, different content
    statDirty(path.join(a.path, 'sub', 'b.txt'));
    statDirty(path.join(a.path, 'run.sh'));
  };
  dirtyA();
  await agentRewritesBaseline(m, a.path);
  await step('status', () => m.status(a.path, exp(a.path)));
  await step('previewDiscard', () => m.previewDiscard(a.path, exp(a.path)));
  await step('takeGitSnapshot', () => m.takeGitSnapshot(a.path));
  let b: { path: string; id: string } | null = null;
  await step('create(next workspace)', async () => {
    b = await m.create({ repoPath: fx.repo, slug: `next-${Math.random().toString(16).slice(2, 8)}` });
  });
  dirtyA();
  await agentRewritesBaseline(m, a.path);
  await step('restoreFromRunBase', () => m.restoreFromRunBase({ path: path.join(a.path, 'a.txt') , expectedWorktree: exp(path.join(a.path, 'a.txt'))}));
  dirtyA();
  await agentRewritesBaseline(m, a.path);
  await step('finalise(dirty, backup)', async () => m.finalise({
    path: a.path, expectedWorktree: exp(a.path), outcome: 'abandoned', discardConfirmation: await confirmFor(m, a.path, a.id, 'finalise'),
  }));
  dirtyA();
  await agentRewritesBaseline(m, a.path);
  await step('remove(dirty, backup, --force)', async () => m.remove({
    path: a.path, expectedWorktree: exp(a.path), discardConfirmation: await confirmFor(m, a.path, a.id, 'remove'),
  }));
  if (b !== null) {
    const bb: { path: string; id: string } = b;
    // Clean-but-stat-dirty workspace: remove without --force, so git worktree remove runs its own status child.
    await agentRewritesBaseline(m, bb.path).catch(() => undefined);
    await step('finalise(clean)', () => m.finalise({ path: bb.path, expectedWorktree: exp(bb.path), outcome: 'archived' }));
    statDirty(path.join(bb.path, 'a.txt'));
    await agentRewritesBaseline(m, bb.path).catch(() => undefined);
    await step('remove(clean, no --force)', () => m.remove({ path: bb.path , expectedWorktree: exp(bb.path)}));
  }
  await step('sweepSnapshotRefs', () => m.sweepSnapshotRefs(fx.repo, new Date(Date.now() + 365 * 86_400_000)));
  return log;
}

export function fired(log: OpLog[]): string[] {
  return log.filter((l) => l.fired).map((l) => `${l.op} [${l.outcome}]`);
}
