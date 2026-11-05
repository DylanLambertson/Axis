// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review 3: R3-3 (the no-filter allow-list is too broad, and run() falls back to the
// racy scan instead of refusing) and R3-1's hang half (a git call blocked on a FIFO must time out).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { createExecGitRunner, createHooksGuard, WorktreeError, type GitRunner } from '../src/index.js';
import { HardenedGit, runsNoFilters } from '../src/hardenedGit.js';
import { makeFixture, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const posixOnly = { skip: process.platform === 'win32' ? 'no FIFOs or POSIX symlinks on win32' : false };

/** Rejects if `p` has not settled within `ms`: a hang becomes a test failure instead of a stuck run. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

describe('R3-1: a hung git call fails closed', () => {
  it('every git call has a timeout, so a git process blocked on a FIFO fails closed', { ...posixOnly, timeout: 30_000 }, async () => {
    const fx = fresh();
    const fifo = path.join(fx.tmp, 'index-fifo');
    execFileSync('mkfifo', [fifo]);
    const seen: Array<number | undefined> = [];
    const real = createExecGitRunner();
    const spy: GitRunner = { gitPath: real.gitPath as string, run: (a, o) => { seen.push(o.timeoutMs); return real.run(a, o); } };
    const git = new HardenedGit(spy, createHooksGuard('linux'), { timeoutMs: 1000 });
    // git opens GIT_INDEX_FILE and blocks in open() on a FIFO with no writer.
    await within(
      assert.rejects(git.run(['write-tree'], { cwd: fx.repo, extraEnv: { GIT_INDEX_FILE: fifo } }), (e: unknown) => e instanceof WorktreeError && e.code === 'E_INTERNAL'),
      10_000, 'write-tree on a FIFO index',
    );
    seen.length = 0;
    await new HardenedGit(spy, createHooksGuard('linux')).run(['rev-parse', 'HEAD'], { cwd: fx.repo });
    assert.ok(seen.length > 0 && seen.every((t) => typeof t === 'number' && t > 0), `default timeout missing: ${String(seen)}`);
  });
});

describe('R3-3: the allow-list is exact and run() refuses everything else', () => {
  it('rejects flags that run a filter or an editor, and caller-supplied global options', () => {
    for (const no of [
      ['ls-files', '-m'], ['ls-files', '--modified', '-z'], ['ls-files', '-z', '--eol'], ['ls-files', '-d'],
      ['branch', '--edit-description'], ['branch', '-D', '--edit-description', 'x'], ['config', '--edit'], ['config', '-e'],
      ['hash-object', '-w', '--no-filters', '--stdin-paths'], ['hash-object', '--no-filters', '--', 'a.txt'],
      ['hash-object', '--no-filters', '--path=a.txt', '--stdin'], ['cat-file', '--textconv', 'HEAD:a'], ['cat-file', '-p', 'HEAD:a'],
      ['-C', '/tmp', 'rev-parse', 'HEAD'], ['-c', 'core.editor=sh', 'commit-tree', 't'], ['--exec-path=/x', 'rev-parse'],
      ['ls-tree', '--format=x', 'HEAD'], ['update-index', '-z', '--index-info', '--add'], ['read-tree', '--reset', 'HEAD'],
      ['worktree', 'repair'], ['worktree', 'add', '--no-checkout', '--checkout', 'p'], ['rev-list', '--filter=blob:none', 'HEAD'],
    ]) assert.equal(runsNoFilters(no), false, no.join(' '));
  });

  it('accepts every exact command shape the manager uses', () => {
    for (const ok of [
      ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], ['symbolic-ref', '-q', '--short', 'HEAD'],
      ['show-ref', '--verify', '--quiet', 'refs/heads/x'], ['check-ref-format', '--branch', 'axis/x'],
      ['for-each-ref', '--format=%(refname)', 'refs/axis/runbase'], ['update-ref', '-d', 'refs/x', 'abc'],
      ['branch', '-D', '--', 'axis/x'], ['merge-base', '--is-ancestor', '--end-of-options', 'a', 'b'],
      ['rev-list', '--left-right', '--count', '--end-of-options', 'a...HEAD'], ['ls-tree', '-r', '-l', '-z', '--full-tree', 'HEAD'],
      ['ls-tree', '-z', '--end-of-options', 'abc', '--', '-weird-name'], ['cat-file', 'blob', 'abc'], ['cat-file', '--batch-check'],
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], ['ls-files', '-s', '-z'],
      ['write-tree'], ['-c', 'user.name=Axis', '-c', 'user.email=a@b', 'commit-tree', 't', '-p', 'HEAD', '-m', '-starts-with-dash'],
      ['hash-object', '-w', '--no-filters', '--stdin'], ['update-index', '-z', '--index-info'],
      ['config', '--show-origin', '--show-scope', '--null', '--list'],
      ['worktree', 'add', '--no-checkout', '-b', 'axis/x', '--', 'p', 'sha'], ['worktree', 'lock', '--reason', 'axis:1', '--', 'p'],
      ['worktree', 'unlock', '--', 'p'], ['worktree', 'remove', '--force', '--', 'p'], ['worktree', 'prune'],
      ['worktree', 'list', '--porcelain', '-z'],
    ]) assert.equal(runsNoFilters(ok), true, ok.join(' '));
  });

  it('run() refuses a command off the allow-list without calling git at all', async () => {
    const fx = fresh();
    const calls: string[][] = [];
    const real = createExecGitRunner();
    const spy: GitRunner = { gitPath: real.gitPath as string, run: (a, o) => { calls.push([...a]); return real.run(a, o); } };
    const git = new HardenedGit(spy, createHooksGuard('linux'));
    for (const args of [['status', '--porcelain'], ['ls-files', '-m'], ['config', '--edit'], ['branch', '--edit-description']]) {
      await assert.rejects(git.run(args, { cwd: fx.repo }), (e: unknown) => e instanceof WorktreeError && e.code === 'E_INTERNAL', args.join(' '));
    }
    assert.deepEqual(calls, [], 'git ran (or a filter scan ran) for a refused command');
  });
});
