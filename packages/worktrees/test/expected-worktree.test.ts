// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createExecGitRunner, WorktreeError, WorktreeManager, type ExpectedWorktree, type GitRunner } from '../src/index.js';
import { exp, makeFixture, sh, type Fixture } from './helpers.js';

const denied = (reason: string) => (e: unknown) =>
  e instanceof WorktreeError && e.code === 'E_POLICY_DENIED' && e.details['reason'] === reason;

/** Moves workspace `b` into the place of workspace `a` (a directory swap) and points git's records at the new places. */
function swapUnder(a: string, b: string): void {
  const admin = (dir: string): string => /^gitdir: (.+)$/m.exec(readFileSync(path.join(dir, '.git'), 'utf8'))?.[1] ?? '';
  const adminA = admin(a);
  const adminB = admin(b);
  renameSync(a, `${a}.moved`);
  renameSync(b, a);
  writeFileSync(path.join(adminA, 'gitdir'), `${a}.moved${path.sep}.git\n`);
  writeFileSync(path.join(adminB, 'gitdir'), `${a}${path.sep}.git\n`);
}

describe('expected worktree on every path-based entry point', () => {
  let fx: Fixture;
  let a: { path: string; id: string };
  let b: { path: string; id: string };
  let ea: ExpectedWorktree;
  beforeEach(async () => {
    fx = makeFixture();
    a = await fx.manager.create({ repoPath: fx.repo, slug: 'wa' });
    b = await fx.manager.create({ repoPath: fx.repo, slug: 'wb' });
    ea = exp(a.path);
  });
  afterEach(() => fx.cleanup());

  it('does not remove a clean finalised workspace B that was swapped in under the path of A', async () => {
    await fx.manager.finalise({ path: a.path, expectedWorktree: ea, outcome: 'archived' });
    await fx.manager.finalise({ path: b.path, expectedWorktree: exp(b.path), outcome: 'archived' });
    swapUnder(a.path, b.path);
    await assert.rejects(fx.manager.remove({ path: a.path, expectedWorktree: ea }), denied('worktree-mismatch'));
    assert.equal(readFileSync(path.join(a.path, 'a.txt'), 'utf8'), 'alpha\n');
    assert.match(sh(fx.repo, 'for-each-ref', `refs/axis/archive/${b.id}`), /archive/);
    assert.ok(sh(fx.repo, 'worktree', 'list', '--porcelain').includes(`worktree ${a.path}`));
  });

  it('refuses when git is switched under the path in the middle of remove, before the destructive step', async () => {
    await fx.manager.finalise({ path: a.path, expectedWorktree: ea, outcome: 'archived' });
    await fx.manager.finalise({ path: b.path, expectedWorktree: exp(b.path), outcome: 'archived' });
    const base = createExecGitRunner();
    let armed = true;
    const runner: GitRunner = {
      ...base,
      run: async (args, opts) => {
        if (armed && args.includes('worktree') && args.includes('list')) {
          armed = false;
          swapUnder(a.path, b.path);
        }
        return base.run(args, opts);
      },
    };
    const m = new WorktreeManager({ runner, worktreeRoot: fx.root });
    await assert.rejects(m.remove({ path: a.path, expectedWorktree: ea }), denied('worktree-mismatch'));
    assert.equal(armed, false, 'the swap happened inside remove');
    assert.ok(existsSync(path.join(a.path, '.git')), 'the swapped-in workspace is still there');
  });

  it('refuses a path that is a symlink to another workspace, naming the symlink', async () => {
    renameSync(a.path, `${a.path}.moved`);
    symlinkSync(b.path, a.path);
    await assert.rejects(fx.manager.status(a.path, ea), denied('symlink-component'));
    await assert.rejects(fx.manager.previewDiscard(a.path, ea), denied('symlink-component'));
    await assert.rejects(fx.manager.finalise({ path: a.path, expectedWorktree: ea, outcome: 'archived' }), denied('symlink-component'));
  });

  it('refuses a path spelled through a symlinked parent, even when the expected path is spelled the same way', async () => {
    const alias = `${fx.root}-alias`;
    symlinkSync(fx.root, alias);
    const via = path.join(alias, path.basename(a.path));
    await assert.rejects(fx.manager.status(via, ea), denied('worktree-mismatch'));
    await assert.rejects(fx.manager.status(via, { path: via, id: a.id }), denied('symlink-component'));
    rmSync(alias);
  });

  it('refuses every entry point when the expected worktree names another workspace', async () => {
    const eb = exp(b.path);
    const stale = { path: a.path, id: b.id }; // right path, wrong id: the record under the path is not the expected one
    const calls: Record<string, () => Promise<unknown>> = {
      status: () => fx.manager.status(a.path, eb),
      previewDiscard: () => fx.manager.previewDiscard(a.path, eb),
      assertNoDrift: () => fx.manager.assertNoDrift(a.path, eb),
      finalise: () => fx.manager.finalise({ path: a.path, expectedWorktree: eb, outcome: 'archived' }),
      remove: () => fx.manager.remove({ path: a.path, expectedWorktree: eb }),
      restore: () => fx.manager.restoreFromRunBase({ path: path.join(a.path, 'a.txt'), expectedWorktree: eb }),
      'status (id)': () => fx.manager.status(a.path, stale),
      'previewDiscard (id)': () => fx.manager.previewDiscard(a.path, stale),
      'assertNoDrift (id)': () => fx.manager.assertNoDrift(a.path, stale),
      'finalise (id)': () => fx.manager.finalise({ path: a.path, expectedWorktree: stale, outcome: 'archived' }),
      'remove (id)': () => fx.manager.remove({ path: a.path, expectedWorktree: stale }),
      'restore (id)': () => fx.manager.restoreFromRunBase({ path: path.join(a.path, 'a.txt'), expectedWorktree: stale }),
    };
    for (const [name, call] of Object.entries(calls)) {
      await assert.rejects(call(), (e: unknown) => e instanceof WorktreeError && e.code === 'E_POLICY_DENIED', name);
    }
    assert.equal((await fx.manager.status(a.path, ea)).state, 'READY', 'nothing was changed');
  });

  it('treats a missing or malformed expected worktree as an invalid argument (restore included)', async () => {
    const bad: unknown[] = [undefined, null, 'x', { path: a.path }, { id: a.id }, { path: 'rel', id: a.id }, { path: a.path, id: '../x' }];
    for (const e of bad) {
      const invalid = (x: unknown) => x instanceof WorktreeError && x.code === 'E_INVALID_ARGUMENT';
      await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(a.path, 'a.txt'), expectedWorktree: e as never }), invalid);
      await assert.rejects(fx.manager.status(a.path, e as never), invalid);
      await assert.rejects(fx.manager.remove({ path: a.path, expectedWorktree: e as never }), invalid);
    }
  });

  it('accepts the matching expected worktree everywhere', async () => {
    assert.equal((await fx.manager.status(a.path, ea)).id, a.id);
    await fx.manager.previewDiscard(a.path, ea);
    await fx.manager.finalise({ path: a.path, expectedWorktree: ea, outcome: 'archived' });
    await fx.manager.remove({ path: a.path, expectedWorktree: ea });
    assert.equal(existsSync(a.path), false);
  });
});
