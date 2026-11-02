// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildGitEnv, createExecGitRunner, parseWorktreeList, projectDirName, repoHash, resolveRepo,
  WorktreeError, WorktreeManager, type GitRunner,
} from '../src/index.js';
import { makeFixture, sh, type Fixture } from './helpers.js';

describe('GIT-ENV-1', () => {
  const dirty = {
    PATH: '/usr/bin', HOME: '/h', USER: 'u', LANG: 'en_US.UTF-8', LC_ALL: 'C', TMPDIR: '/t',
    GIT_DIR: '/x', GIT_WORK_TREE: '/y', GIT_CONFIG_GLOBAL: '/z', GIT_SSH_COMMAND: 'evil', GIT_ASKPASS: 'a',
    GIT_INDEX_FILE: 'i', GITHUB_TOKEN: 't', GH_TOKEN: 't', SSH_AUTH_SOCK: '/s', AWS_SECRET_ACCESS_KEY: 'k',
    SERVICE_API_KEY: 'k', NPM_TOKEN: 'k', HTTPS_PROXY: 'p', GIT_TERMINAL_PROMPT: '1', EDITOR: 'vim',
  };

  it('keeps the allow-list, forces GIT_TERMINAL_PROMPT=0 and drops the rest', () => {
    assert.deepEqual(buildGitEnv(dirty, 'linux'), {
      PATH: '/usr/bin', HOME: '/h', USER: 'u', LANG: 'en_US.UTF-8', LC_ALL: 'C', TMPDIR: '/t', GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('applies case-insensitively on Windows', () => {
    const env = buildGitEnv({ Path: 'C:\\x', SystemRoot: 'C:\\Windows', GIT_DIR: 'g', Token: 't' }, 'win32');
    assert.deepEqual(Object.keys(env).sort(), ['GIT_TERMINAL_PROMPT', 'Path', 'SystemRoot']);
  });

  it('is what the real runner hands to the child process', { skip: process.platform === 'win32' }, async () => {
    const runner = createExecGitRunner({ gitPath: '/usr/bin/env', baseEnv: dirty });
    const res = await runner.run([], { cwd: process.cwd() });
    const names = res.stdout.split('\n').filter(Boolean).map((l) => l.split('=')[0]).sort();
    assert.deepEqual(names, ['GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'USER']);
    assert.match(res.stdout, /^GIT_TERMINAL_PROMPT=0$/m);
    const withIndex = await runner.run([], { cwd: process.cwd(), extraEnv: { GIT_INDEX_FILE: '/tmp/i' } });
    assert.match(withIndex.stdout, /^GIT_INDEX_FILE=\/tmp\/i$/m);
  });

  it('never goes through a shell', async () => {
    const runner = createExecGitRunner({ gitPath: '/usr/bin/env' });
    // a metacharacter-laden argument reaches the program verbatim
    const res = await runner.run(['echo', '$(touch /tmp/axis-shell-test);`id`'], { cwd: process.cwd() });
    assert.equal(res.stdout.trim(), '$(touch /tmp/axis-shell-test);`id`');
  });

  it('wraps every manager git call with hardening and a clean runner contract', async () => {
    const calls: string[][] = [];
    const real = createExecGitRunner();
    const spy: GitRunner = { run: (args, o) => { calls.push([...args]); return real.run(args, o); } };
    const fx = makeFixture();
    try {
      const m = new WorktreeManager({ runner: spy, worktreeRoot: fx.root });
      const ws = await m.create({ repoPath: fx.repo, slug: 'spy' });
      await m.status(ws.path);
      assert.ok(calls.length > 10);
      for (const c of calls) {
        assert.ok(c.some((a) => a.startsWith('core.hooksPath=') && a.length > 'core.hooksPath='.length), c.join(' '));
        assert.ok(c.includes('core.fsmonitor=false'), c.join(' '));
      }
      m.dispose();
    } finally {
      fx.cleanup();
    }
  });

  it('reports a missing git binary as E_GIT', async () => {
    const runner = createExecGitRunner({ gitPath: '/nonexistent/git' });
    await assert.rejects(runner.run(['--version'], { cwd: process.cwd() }), (e) => e instanceof WorktreeError && e.code === 'E_GIT');
  });
});

describe('discovery', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('follows a .git file through gitdir and commondir', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'disc' });
    const dotGit = path.join(ws.path, '.git');
    const main = await resolveRepo(fx.repo);
    assert.equal(main.linked, false);
    assert.equal(main.commonDir, path.join(fx.repo, '.git'));
    for (const start of [ws.path, path.join(ws.path, 'sub')]) {
      const wt = await resolveRepo(start);
      assert.equal(wt.linked, true);
      assert.equal(wt.commonDir, main.commonDir);
      assert.equal(wt.workTree, ws.path);
      assert.equal(path.dirname(wt.gitDir), path.join(main.commonDir, 'worktrees'));
    }
    assert.match(sh(ws.path, 'rev-parse', '--git-dir'), /worktrees/);
    assert.ok(dotGit);
  });

  it('handles relative gitdir and commondir values and a missing gitdir', async () => {
    const common = path.join(fx.tmp, 'c', '.git');
    mkdirSync(path.join(common, 'worktrees', 'w'), { recursive: true });
    mkdirSync(path.join(common, 'objects'));
    mkdirSync(path.join(common, 'refs'));
    writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(common, 'worktrees', 'w', 'commondir'), '../..\n');
    const wt = path.join(fx.tmp, 'c', 'linked');
    mkdirSync(wt);
    writeFileSync(path.join(wt, '.git'), 'gitdir: ../.git/worktrees/w\n');
    const r = await resolveRepo(wt);
    assert.equal(r.commonDir, realpathSync(common));
    assert.equal(r.linked, true);
    writeFileSync(path.join(wt, '.git'), 'gitdir: ../.git/worktrees/missing\n');
    await assert.rejects(resolveRepo(wt), (e) => e instanceof WorktreeError && e.code === 'E_NOT_FOUND');
    writeFileSync(path.join(wt, '.git'), 'garbage\n');
    await assert.rejects(resolveRepo(wt), (e) => e instanceof WorktreeError && e.code === 'E_NOT_FOUND');
    await assert.rejects(resolveRepo(fx.tmp), (e) => e instanceof WorktreeError && e.code === 'E_NOT_FOUND');
  });

  it('detects a bare repository', async () => {
    const bare = path.join(fx.tmp, 'bare.git');
    sh(fx.tmp, 'clone', '-q', '--bare', fx.repo, bare);
    const r = await resolveRepo(bare);
    assert.deepEqual([r.workTree, r.linked, r.commonDir], [null, false, realpathSync(bare)]);
    assert.match(projectDirName(r.commonDir, null), /^bare-[0-9a-f]{8}$/);
  });

  it('names projects <name>-<first 8 hex of sha256(common dir)>', () => {
    const common = '/some/repo/.git';
    const expect = createHash('sha256').update(common).digest('hex').slice(0, 8);
    assert.equal(repoHash(common, 'linux'), expect);
    assert.equal(projectDirName(common, '/some/my repo!', 'linux'), `my_repo_-${expect}`);
    assert.notEqual(repoHash('/a/.git', 'linux'), repoHash('/b/.git', 'linux'));
  });

  it('parses worktree list --porcelain -z', () => {
    const out = 'worktree /r\0HEAD aaa\0branch refs/heads/main\0\0worktree /w\0HEAD bbb\0detached\0locked why not\0\0worktree /gone\0HEAD ccc\0branch refs/heads/x\0prunable gitdir file points to non-existent location\0\0';
    const l = parseWorktreeList(out);
    assert.equal(l.length, 3);
    assert.deepEqual([l[1]?.detached, l[1]?.locked, l[1]?.lockReason, l[2]?.prunable], [true, true, 'why not', true]);
  });
});
