// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeError } from '../src/index.js';
import { checkoutFingerprint, confirmFor, makeFixture, sh, write, type Fixture, exp } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof WorktreeError && e.code === c;

describe('worktree lifecycle', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('creates, lists and removes a workspace without touching the local checkout', async () => {
    const before = checkoutFingerprint(fx.repo);
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'fix-login' });
    assert.equal(ws.branch, 'axis/fix-login');
    assert.equal(ws.baseSha, sh(fx.repo, 'rev-parse', 'HEAD').trim());
    assert.match(path.relative(fx.root, ws.path), /^repo-[0-9a-f]{8}[\\/]fix-login$/);
    assert.equal(ws.localCheckout, fx.repo);
    assert.ok(existsSync(path.join(ws.path, 'a.txt')));
    assert.ok(sh(fx.repo, 'for-each-ref', 'refs/axis/runbase').includes(ws.runBaseRef));

    const list = await fx.manager.list(fx.repo);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.isMain, true);
    assert.equal(list[1]?.managed, true);
    assert.equal(list[1]?.id, ws.id);
    assert.equal(list[1]?.locked, true);

    const st = await fx.manager.status(ws.path, exp(ws.path));
    assert.deepEqual([st.dirty.length, st.ahead, st.behind, st.hasDrift], [0, 0, 0, false]);

    const fin = await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived' });
    assert.equal(fin.archiveSha, ws.baseSha);
    const rm = await fx.manager.remove({ path: ws.path, expectedWorktree: exp(ws.path), deleteBranch: true });
    assert.equal(rm.branchDeleted, true);
    assert.equal(existsSync(ws.path), false);
    assert.equal((await fx.manager.list(fx.repo)).length, 1);
    // rollback refs survive removal; the branch is gone but the archive keeps the commits
    assert.ok(sh(fx.repo, 'for-each-ref', 'refs/axis/archive').includes(`refs/axis/archive/${ws.id}`));
    assert.equal(sh(fx.repo, 'branch', '--list', 'axis/fix-login').trim(), '');
    assert.equal(checkoutFingerprint(fx.repo), before);
  });

  it('reports dirty files, ahead and behind', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'work' });
    write(path.join(ws.path, 'a.txt'), 'changed\n');
    write(path.join(ws.path, 'new.txt'), 'new\n');
    write(path.join(ws.path, 'ignored.log'), 'noise\n');
    sh(ws.path, 'commit', '-q', '-am', 'one');
    write(path.join(ws.path, 'sub', 'b.txt'), 'edit\n');
    const st = await fx.manager.status(ws.path, exp(ws.path));
    assert.equal(st.ahead, 1);
    assert.equal(st.behind, 0);
    assert.deepEqual(st.dirty.map((d) => d.path).sort(), ['new.txt', 'sub/b.txt']);
    assert.equal(st.baseBranchBehind, 0);
    // the base branch moves on in the local checkout; the recorded base SHA does not
    write(path.join(fx.repo, 'c.txt'), 'c\n');
    sh(fx.repo, 'add', 'c.txt');
    sh(fx.repo, 'commit', '-q', '-m', 'main moves');
    const st2 = await fx.manager.status(ws.path, exp(ws.path));
    assert.equal(st2.baseSha, ws.baseSha);
    assert.equal(st2.baseBranchBehind, 1);
  });

  it('refuses an existing branch, bad slugs, bad refs and a path that exists', async () => {
    await fx.manager.create({ repoPath: fx.repo, slug: 'dup' });
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'dup' }), code('E_CONFLICT'));
    sh(fx.repo, 'branch', 'axis/taken');
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'taken' }), code('E_CONFLICT'));
    for (const slug of ['', 'Upper', '../x', 'a/b', '-lead', 'trail-', 'a b', 'x'.repeat(65)]) {
      await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug }), code('E_INVALID_ARGUMENT'), slug);
    }
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'ok', baseRef: '--output=/tmp/x' }), code('E_INVALID_ARGUMENT'));
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'ok', baseRef: 'no-such-ref' }), code('E_NOT_FOUND'));
    // a failed create leaves nothing behind
    assert.equal((await fx.manager.list(fx.repo)).length, 2);
    assert.equal(sh(fx.repo, 'branch', '--list', 'axis/ok').trim(), '');
  });

  it('refuses dirty finalise and remove without a minted confirmation, then backs up', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'dirty' });
    write(path.join(ws.path, 'wip.txt'), 'secret work\n');
    write(path.join(ws.path, 'a.txt'), 'edited\n');
    await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'abandoned' }), (e) =>
      e instanceof WorktreeError && e.code === 'E_CONFLICT' && e.details['reason'] === 'dirty');
    // a plain object (for example parsed from JSON) is not a confirmation
    const forged = JSON.parse('{}') as never;
    await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'abandoned', discardConfirmation: forged }), code('E_CONFLICT'));
    // removal requires finalise first
    await assert.rejects(fx.manager.remove({ path: ws.path , expectedWorktree: exp(ws.path)}), (e) =>
      e instanceof WorktreeError && e.details['reason'] === 'not-finalised');

    const fin = await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'abandoned', discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'finalise') });
    assert.ok(fin.backupRef?.startsWith(`refs/axis/backup/${ws.id}/`));
    await assert.rejects(fx.manager.remove({ path: ws.path , expectedWorktree: exp(ws.path)}), code('E_CONFLICT'));
    const rm = await fx.manager.remove({ path: ws.path, expectedWorktree: exp(ws.path), discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'remove') });
    assert.ok(rm.backupRef);
    assert.equal(existsSync(ws.path), false);
    // the dirty content is recoverable from the backup, including untracked files
    assert.equal(sh(fx.repo, 'show', `${rm.backupRef}:wip.txt`), 'secret work\n');
    assert.equal(sh(fx.repo, 'show', `${rm.backupRef}:a.txt`), 'edited\n');
  });

  it('verifies a merged outcome against the base branch', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'feat' });
    write(path.join(ws.path, 'f.txt'), 'f\n');
    sh(ws.path, 'add', 'f.txt');
    sh(ws.path, 'commit', '-q', '-m', 'feature');
    await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged' }), (e) =>
      e instanceof WorktreeError && e.details['reason'] === 'not-merged');
    sh(fx.repo, 'merge', '-q', '--ff-only', 'axis/feat');
    const fin = await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged' });
    assert.equal(fin.outcome, 'merged');
  });

  it('never operates on the local checkout or an unmanaged worktree', async () => {
    await assert.rejects(fx.manager.status(fx.repo, exp(fx.repo)), code('E_POLICY_DENIED'));
    await assert.rejects(fx.manager.remove({ path: fx.repo , expectedWorktree: exp(fx.repo)}), code('E_POLICY_DENIED'));
    sh(fx.repo, 'worktree', 'add', '-q', '-b', 'other', path.join(fx.tmp, 'external'));
    const ext = path.join(fx.tmp, 'external');
    await assert.rejects(fx.manager.status(ext, exp(ext)), code('E_POLICY_DENIED'));
    const list = await fx.manager.list(fx.repo);
    assert.equal(list.find((w) => w.path === ext)?.external, true);
    assert.equal(readFileSync(path.join(ext, 'a.txt'), 'utf8'), 'alpha\n');
  });

  it('runs no repository hooks during worktree calls', async () => {
    const marker = path.join(fx.tmp, 'hook-ran');
    for (const hook of ['post-checkout', 'pre-commit', 'reference-transaction', 'post-index-change']) {
      write(path.join(fx.repo, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`);
    }
    sh(fx.repo, 'config', 'core.fsmonitor', `touch ${marker}`);
    const { chmodSync } = await import('node:fs');
    for (const hook of ['post-checkout', 'pre-commit', 'reference-transaction', 'post-index-change']) {
      chmodSync(path.join(fx.repo, '.git', 'hooks', hook), 0o755);
    }
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'hooked' });
    await fx.manager.status(ws.path, exp(ws.path));
    await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived' });
    await fx.manager.remove({ path: ws.path , expectedWorktree: exp(ws.path)});
    assert.equal(existsSync(marker), false);
  });

  it('keeps files over the size limit out of snapshots and lists them', async () => {
    const small = makeFixture({ maxSnapshotFileBytes: 1024 });
    try {
      const ws = await small.manager.create({ repoPath: small.repo, slug: 'big' });
      write(path.join(ws.path, 'huge.bin'), Buffer.alloc(4096, 1));
      write(path.join(ws.path, 'small.txt'), 'ok\n');
      const r = await small.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') , expectedWorktree: exp(path.join(ws.path, 'a.txt'))});
      const files = sh(small.repo, 'ls-tree', '-r', '--name-only', r.backupRef);
      assert.ok(files.includes('small.txt'));
      assert.ok(!files.includes('huge.bin'));
    } finally {
      small.cleanup();
    }
  });

  it('sweeps expired snapshot refs but never archive refs', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'sweep' });
    await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived' });
    assert.deepEqual(await fx.manager.sweepSnapshotRefs(fx.repo), []);
    const later = new Date(Date.now() + 31 * 24 * 3600 * 1000);
    const gone = await fx.manager.sweepSnapshotRefs(fx.repo, later);
    assert.deepEqual(gone, [ws.runBaseRef]);
    assert.ok(sh(fx.repo, 'for-each-ref', 'refs/axis/archive').includes(ws.id));
  });
});
