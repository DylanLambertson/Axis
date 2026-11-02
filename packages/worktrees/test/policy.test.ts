// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createExecGitRunner, defaultWorktreeRoot, WorktreeError, WorktreeManager } from '../src/index.js';
import { makeFixture, sh, type Fixture } from './helpers.js';

const policy = (e: unknown) => e instanceof WorktreeError && e.code === 'E_POLICY';

describe('location policy', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  const withRoot = (root: string, registeredRepos?: string[]) =>
    new WorktreeManager({ runner: createExecGitRunner(), worktreeRoot: root, ...(registeredRepos ? { registeredRepos: () => registeredRepos } : {}) });

  it('refuses a root equal to or inside the local checkout', async () => {
    for (const root of [fx.repo, path.join(fx.repo, 'wt'), path.join(fx.repo, 'sub', 'deep', 'wt'), path.join(fx.repo, '.git', 'wt')]) {
      const m = withRoot(root);
      await assert.rejects(m.create({ repoPath: fx.repo, slug: 'x' }), policy, root);
      m.dispose();
    }
  });

  it('refuses a root inside another registered repository', async () => {
    const other = path.join(fx.tmp, 'other');
    mkdirSync(other);
    sh(other, 'init', '-q');
    const m = withRoot(path.join(other, 'nested', 'wt'), [other]);
    await assert.rejects(m.create({ repoPath: fx.repo, slug: 'x' }), policy);
    m.dispose();
    // the same root is fine when that repository is not registered
    const ok = withRoot(path.join(other, 'nested', 'wt'));
    await assert.doesNotReject(ok.create({ repoPath: fx.repo, slug: 'x' }));
    ok.dispose();
  });

  it('rejects ".." segments in the root and the repository path', async () => {
    const m = withRoot(`${fx.tmp}/outside/../wt`);
    await assert.rejects(m.create({ repoPath: fx.repo, slug: 'x' }), policy);
    m.dispose();
    await assert.rejects(fx.manager.create({ repoPath: `${fx.repo}/sub/..`, slug: 'x' }), policy);
    await assert.rejects(fx.manager.restoreFromRunBase({ path: `${fx.root}/../a.txt` }), policy);
  });

  it('rejects a relative root', async () => {
    const m = withRoot('relative/wt');
    await assert.rejects(m.create({ repoPath: fx.repo, slug: 'x' }), policy);
    m.dispose();
  });

  it('rejects a root that is a symlink into the local checkout', async () => {
    const link = path.join(fx.tmp, 'link-root');
    symlinkSync(path.join(fx.repo, 'sub'), link);
    const m = withRoot(link);
    await assert.rejects(m.create({ repoPath: fx.repo, slug: 'x' }), policy);
    m.dispose();
    const viaLinkParent = withRoot(path.join(link, 'deeper'));
    await assert.rejects(viaLinkParent.create({ repoPath: fx.repo, slug: 'x' }), policy);
    viaLinkParent.dispose();
  });

  it('rejects a per-project directory that is a planted symlink', async () => {
    const first = await fx.manager.create({ repoPath: fx.repo, slug: 'first' });
    const projDir = path.dirname(first.path);
    await fx.manager.finalise({ path: first.path, outcome: 'archived' });
    await fx.manager.remove({ path: first.path });
    // swap the project dir for a symlink that points into the checkout
    const { rmSync } = await import('node:fs');
    rmSync(projDir, { recursive: true });
    symlinkSync(fx.repo, projDir);
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'second' }), policy);
    assert.equal(sh(fx.repo, 'status', '--porcelain').trim(), '');
  });

  it('uses the per-OS application data directory by default', () => {
    assert.equal(defaultWorktreeRoot({}, 'darwin', '/Users/u'), '/Users/u/Library/Application Support/Axis/worktrees');
    assert.equal(defaultWorktreeRoot({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/u'), '/xdg/Axis/worktrees');
    assert.equal(defaultWorktreeRoot({}, 'linux', '/home/u'), '/home/u/.local/share/Axis/worktrees');
    assert.equal(defaultWorktreeRoot({ XDG_DATA_HOME: 'relative' }, 'linux', '/home/u'), '/home/u/.local/share/Axis/worktrees');
    assert.equal(defaultWorktreeRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\Axis\\worktrees');
  });
});
