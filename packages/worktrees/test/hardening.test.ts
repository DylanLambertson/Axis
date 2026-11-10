// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the independent security review (hooks directory, filter drivers).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createExecGitRunner, createHooksGuard, WorktreeError, WorktreeManager, type GitRunner } from '../src/index.js';
import { runsNoFilters } from '../src/hardenedGit.js';
import { confirmFor, makeFixture, sh, write, type Fixture, exp } from './helpers.js';

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
    await fx.manager.status(ws.path, exp(ws.path));
    await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') , expectedWorktree: exp(path.join(ws.path, 'a.txt'))});
    write(path.join(ws.path, 'a.txt'), 'edited again\n');
    await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived', discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'finalise') });
    await fx.manager.sweepSnapshotRefs(fx.repo);
    await fx.manager.remove({ path: ws.path, expectedWorktree: exp(ws.path), discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'remove') });
    assert.equal(existsSync(marker), false);
  });

  it('on Windows points at a daemon-owned empty regular file and fails closed if it is replaced (NS-4)', async () => {
    assert.throws(() => createHooksGuard('win32'), code('E_INVALID_ARGUMENT'));
    const file = path.join(fx.tmp, 'app-data', 'nohooks');
    const guard = createHooksGuard('win32', file);
    assert.equal(guard.path, file);
    assert.equal(lstatSync(file).isFile(), true);
    await assert.doesNotReject(guard.assertInert());
    rmSync(file);
    mkdirSync(file);
    await assert.rejects(guard.assertInert(), code('E_POLICY_DENIED'));
    rmSync(file, { recursive: true });
    writeFileSync(file, 'x');
    await assert.rejects(guard.assertInert(), code('E_POLICY_DENIED'));
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
    assert.equal((await fx.manager.status(ws.path, exp(ws.path))).dirty.length, 0);
    write(path.join(ws.path, 'a.txt'), 'agent edit\n');
    write(path.join(ws.path, 'run.sh'), '#!/bin/sh\nchanged\n');
    await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'run.sh') , expectedWorktree: exp(path.join(ws.path, 'run.sh'))});
    write(path.join(ws.path, 'a.txt'), 'second edit\n');
    const fin = await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'abandoned', discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'finalise') });
    // the backup holds the raw bytes, not the clean filter's output
    assert.equal(sh(fx.repo, 'show', `${fin.backupRef}:a.txt`), 'second edit\n');
    await fx.manager.sweepSnapshotRefs(fx.repo);
    await fx.manager.remove({ path: ws.path, expectedWorktree: exp(ws.path), discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'remove') });
    none();
  });

  it('refuses daemon writes and create while filter drift is unacknowledged, and still runs no filter afterwards', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'victim' });
    plant(); // an agent in the workspace changes the shared config
    write(path.join(ws.path, 'a.txt'), 'edit\n');
    const denied = (e: unknown) => e instanceof WorktreeError && e.code === 'E_POLICY_DENIED' && e.details['reason'] === 'git-drift';
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') , expectedWorktree: exp(path.join(ws.path, 'a.txt'))}), denied);
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'next' }), denied);
    await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived' }), denied);
    none();
    await fx.manager.acknowledgeDrift(ws.path);
    await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') , expectedWorktree: exp(path.join(ws.path, 'a.txt'))});
    await fx.manager.create({ repoPath: fx.repo, slug: 'next' });
    none();
  });

  it('NB-2: every git command the manager runs is on the no-filter allow-list, and none is status', async () => {
    const calls: string[][] = [];
    const real = createExecGitRunner();
    const spy: GitRunner = { gitPath: real.gitPath as string, run: (a, o) => { calls.push([...a]); return real.run(a, o); } };
    const m = new WorktreeManager({ runner: spy, worktreeRoot: fx.root });
    const ws = await m.create({ repoPath: fx.repo, slug: 'sub' });
    write(path.join(ws.path, 'a.txt'), 'edit\n');
    write(path.join(ws.path, 'new.txt'), 'new\n');
    await m.status(ws.path, exp(ws.path));
    await m.previewDiscard(ws.path, exp(ws.path));
    await m.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') , expectedWorktree: exp(path.join(ws.path, 'a.txt'))});
    await m.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived', discardConfirmation: await confirmFor(m, ws.path, ws.id, 'finalise') });
    await m.remove({ path: ws.path, expectedWorktree: exp(ws.path), deleteBranch: true, discardConfirmation: await confirmFor(m, ws.path, ws.id, 'remove') });
    await m.sweepSnapshotRefs(fx.repo);
    assert.ok(calls.length > 20);
    for (const c of calls) assert.equal(c[0], '--literal-pathspecs');
    // The hardened prefix is added by HardenedGit; the spy sees prefix + (scan) + command, so a scan
    // (`config --get-regexp ^filter`) appearing at all would mean a command fell off the allow-list.
    assert.equal(calls.filter((c) => c.includes('--get-regexp') && c.includes('^filter\\.')).length, 0);
    assert.equal(calls.filter((c) => c.includes('status')).length, 0);
  });

  it('runsNoFilters is a closed allow-list', () => {
    for (const ok of [
      ['rev-parse', 'HEAD'], ['ls-files', '-z'], ['hash-object', '--no-filters', '--stdin'], ['cat-file', '--batch'],
      ['update-index', '--index-info'], ['worktree', 'add', '--no-checkout', 'p'], ['worktree', 'remove', '--force', 'p'],
      ['-c', 'user.name=x', 'commit-tree', 't'], ['read-tree', 'HEAD'],
    ]) assert.equal(runsNoFilters(ok), true, ok.join(' '));
    for (const no of [
      ['status'], ['checkout', 'x'], ['add', '.'], ['diff'], ['reset', '--hard'], ['worktree', 'add', 'p'], ['worktree', 'remove', 'p'],
      ['hash-object', '--stdin'], ['update-index', '--refresh'], ['read-tree', '-u', 'HEAD'], ['cat-file', '--filters', 'x'], ['stash'],
    ]) assert.equal(runsNoFilters(no), false, no.join(' '));
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
