// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the independent security review (hooks directory, filter drivers).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createExecGitRunner, createHooksGuard, WorktreeError, WorktreeManager, type GitRunner } from '../src/index.js';
import { confirmFor, makeFixture, sh, write, type Fixture } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof WorktreeError && e.code === c;

describe('B-1: no writable hooks directory', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('uses /dev/null on POSIX and creates no axis-nohooks directory in TMPDIR', { skip: process.platform === 'win32' }, async () => {
    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith('axis-nohooks'));
    const calls: string[][] = [];
    const real = createExecGitRunner();
    const spy: GitRunner = { gitPath: real.gitPath as string, run: (a, o) => { calls.push([...a]); return real.run(a, o); } };
    const m = new WorktreeManager({ runner: spy, worktreeRoot: fx.root });
    await m.create({ repoPath: fx.repo, slug: 'nohooks' });
    assert.deepEqual(readdirSync(os.tmpdir()).filter((n) => n.startsWith('axis-nohooks')), before);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.ok(c.includes('core.hooksPath=/dev/null'), c.join(' '));
  });

  it('runs no hook planted in .git/hooks or in a configured hooksPath directory', async () => {
    const marker = path.join(fx.tmp, 'hook-ran');
    const hooksDir = path.join(fx.repo, '.githooks');
    for (const dir of [path.join(fx.repo, '.git', 'hooks'), hooksDir]) {
      for (const h of ['reference-transaction', 'post-checkout', 'post-commit', 'pre-auto-gc', 'post-index-change']) {
        write(path.join(dir, h), `#!/bin/sh\ntouch ${marker}\ncat >/dev/null\n`);
        chmodSync(path.join(dir, h), 0o755);
      }
    }
    sh(fx.repo, 'config', 'core.hooksPath', '.githooks');
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'hooky' });
    write(path.join(ws.path, 'a.txt'), 'edited\n');
    await fx.manager.status(ws.path);
    await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') });
    write(path.join(ws.path, 'a.txt'), 'edited again\n');
    await fx.manager.finalise({ path: ws.path, outcome: 'archived', discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'finalise') });
    await fx.manager.sweepSnapshotRefs(fx.repo);
    await fx.manager.remove({ path: ws.path, discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'remove') });
    assert.equal(existsSync(marker), false);
  });

  it('on Windows checks the dedicated directory is empty before every call (fail closed)', async () => {
    assert.throws(() => createHooksGuard('win32'), code('E_INVALID_ARGUMENT'));
    const dir = path.join(fx.tmp, 'empty-hooks');
    const guard = createHooksGuard('win32', dir);
    assert.equal(guard.path, dir);
    await assert.doesNotReject(guard.assertEmpty());
    chmodSync(dir, 0o755);
    writeFileSync(path.join(dir, 'pre-commit'), 'x');
    await assert.rejects(guard.assertEmpty(), code('E_POLICY_DENIED'));
    assert.equal(createHooksGuard('linux').path, '/dev/null');
  });
});

describe('B-2: filter drivers never run in the daemon', () => {
  let fx: Fixture;
  const markers = () => ['c', 's', 'p'].map((n) => path.join(fx.tmp, `filter-${n}`));
  const plant = () => {
    const [c, s, p] = markers() as [string, string, string];
    sh(fx.repo, 'config', 'filter.c.clean', `touch ${c}; sed s/^/CLEAN:/`);
    sh(fx.repo, 'config', 'filter.s.smudge', `touch ${s}; tr a-z A-Z`);
    sh(fx.repo, 'config', 'filter.p.process', `touch ${p}; cat`);
    sh(fx.repo, 'config', 'filter.p.required', 'true');
    write(path.join(fx.repo, '.git', 'info', 'attributes'), 'a.txt filter=c\nsub/b.txt filter=s\nrun.sh filter=p\n');
  };
  const none = () => assert.deepEqual(markers().filter(existsSync), []);
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('does not execute clean, smudge or process drivers in create, status, restore, finalise, remove or sweep', async () => {
    plant();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'filtered' });
    none();
    // bytes are checked out raw, never smudged
    assert.equal(readFileSync(path.join(ws.path, 'sub', 'b.txt'), 'utf8'), 'bravo\n');
    assert.equal((await fx.manager.status(ws.path)).dirty.length, 0);
    write(path.join(ws.path, 'a.txt'), 'agent edit\n');
    write(path.join(ws.path, 'run.sh'), '#!/bin/sh\nchanged\n');
    await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'run.sh') });
    write(path.join(ws.path, 'a.txt'), 'second edit\n');
    const fin = await fx.manager.finalise({ path: ws.path, outcome: 'abandoned', discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'finalise') });
    // the backup holds the raw bytes, not the clean filter's output
    assert.equal(sh(fx.repo, 'show', `${fin.backupRef}:a.txt`), 'second edit\n');
    await fx.manager.sweepSnapshotRefs(fx.repo);
    await fx.manager.remove({ path: ws.path, discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'remove') });
    none();
  });

  it('refuses daemon writes and create while filter drift is unacknowledged, and still runs no filter afterwards', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'victim' });
    plant(); // an agent in the workspace changes the shared config
    write(path.join(ws.path, 'a.txt'), 'edit\n');
    const denied = (e: unknown) => e instanceof WorktreeError && e.code === 'E_POLICY_DENIED' && e.details['reason'] === 'git-drift';
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') }), denied);
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'next' }), denied);
    await assert.rejects(fx.manager.finalise({ path: ws.path, outcome: 'archived' }), denied);
    none();
    await fx.manager.acknowledgeDrift(ws.path);
    await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') });
    await fx.manager.create({ repoPath: fx.repo, slug: 'next' });
    none();
  });

  it('passes --ignore-submodules=all to status and --literal-pathspecs everywhere', async () => {
    const calls: string[][] = [];
    const real = createExecGitRunner();
    const spy: GitRunner = { gitPath: real.gitPath as string, run: (a, o) => { calls.push([...a]); return real.run(a, o); } };
    const m = new WorktreeManager({ runner: spy, worktreeRoot: fx.root });
    const ws = await m.create({ repoPath: fx.repo, slug: 'sub' });
    await m.status(ws.path);
    const statusCalls = calls.filter((c) => c.includes('status'));
    assert.ok(statusCalls.length > 0);
    for (const c of statusCalls) assert.ok(c.includes('--ignore-submodules=all'));
    for (const c of calls) assert.equal(c[0], '--literal-pathspecs');
  });

  it('refuses to check out a tree that contains a .git path, and rolls back cleanly', async () => {
    const blob = sh(fx.repo, 'hash-object', '-w', '--stdin').trim();
    void blob;
    const { execFileSync } = await import('node:child_process');
    const inner = execFileSync('git', ['mktree'], { cwd: fx.repo, input: `100644 blob ${blob}\tconfig\n`, encoding: 'utf8' }).trim();
    let tree: string;
    try {
      tree = execFileSync('git', ['mktree', '--missing'], { cwd: fx.repo, input: `040000 tree ${inner}\t.GIT\n100644 blob ${blob}\tok.txt\n`, encoding: 'utf8' }).trim();
    } catch {
      return; // this git refuses to even build such a tree: nothing to defend against
    }
    const commit = sh(fx.repo, 'commit-tree', tree, '-m', 'evil').trim();
    sh(fx.repo, 'branch', 'evil', commit);
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'evil', baseRef: 'evil' }), code('E_POLICY_DENIED'));
    assert.equal(sh(fx.repo, 'branch', '--list', 'axis/evil').trim(), '');
    assert.equal(existsSync(path.join(fx.root)) ? readdirSync(fx.root).flatMap((d) => readdirSync(path.join(fx.root, d))).includes('evil') : false, false);
    void mkdirSync;
  });
});
