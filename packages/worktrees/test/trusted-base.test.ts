// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeError } from '../src/index.js';
import { makeFixture, sh, write, type Fixture, exp } from './helpers.js';

const reason = (r: string) => (e: unknown) => e instanceof WorktreeError && e.details['reason'] === r;

describe('finalise merged is judged against a trusted base branch', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  async function withUnmergedCommit() {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'feat' });
    write(path.join(ws.path, 'f.txt'), 'f\n');
    sh(ws.path, 'add', 'f.txt');
    sh(ws.path, 'commit', '-q', '-m', 'feature');
    return ws;
  }
  const metaPath = (): string => path.join(fx.repo, '.git', 'worktrees', 'feat', 'axis-workspace.json');

  it('create reports the full branch name the base resolved to, and null when the base is not a local branch', async () => {
    const main = sh(fx.repo, 'symbolic-ref', 'HEAD').trim();
    assert.equal((await fx.manager.create({ repoPath: fx.repo, slug: 'a' })).baseBranch, main);
    assert.equal((await fx.manager.create({ repoPath: fx.repo, slug: 'b', baseRef: sh(fx.repo, 'rev-parse', 'HEAD').trim() })).baseBranch, null);
  });

  it('a rewritten metadata record cannot supply the base branch when the caller passes the trusted one', async () => {
    const ws = await withUnmergedCommit();
    sh(fx.repo, 'branch', 'evil', 'axis/feat'); // a branch that does contain the workspace tip
    const file = metaPath();
    const meta = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...meta, baseBranch: 'refs/heads/evil' }));
    const trusted = sh(fx.repo, 'symbolic-ref', 'HEAD').trim();
    await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: trusted, trustedBaseTip: ws.baseSha }), reason('not-merged'));
    // Without a trusted record the legacy behaviour reads the file, which is exactly why the daemon always passes one.
    const fin = await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged' });
    assert.equal(fin.outcome, 'merged');
  });

  it('a trusted base of null refuses merged, even when the tip is in the checkout branch and the record names one', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'feat' });
    await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: null }), reason('no-base-branch'));
    assert.equal((await fx.manager.status(ws.path, exp(ws.path))).state, 'READY');
  });

  it('a trusted base that is not a full local branch name is refused', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'feat' });
    for (const bad of ['HEAD', 'main', 'refs/tags/x', 'refs/heads/a b']) {
      await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: bad }), (e) => e instanceof WorktreeError, bad);
    }
  });

  it('merged is accepted when the trusted base branch holds the tip, and the other outcomes are not affected', async () => {
    const ws = await withUnmergedCommit();
    const trusted = sh(fx.repo, 'symbolic-ref', 'HEAD').trim();
    await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: trusted, trustedBaseTip: ws.baseSha }), reason('not-merged'));
    sh(fx.repo, 'merge', '-q', '--ff-only', 'axis/feat');
    const fin = await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: trusted, trustedBaseTip: ws.baseSha });
    assert.equal(fin.outcome, 'merged');
  });

  it('archived does not need a base branch', async () => {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'feat' });
    assert.equal((await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived', trustedBaseBranch: null })).outcome, 'archived');
  });

  describe('a run that writes the shared repository without moving the base branch', () => {
    const forgedMerge = async (ws: { path: string; baseSha: string }, attack: () => void) => {
      const main = sh(fx.repo, 'symbolic-ref', 'HEAD').trim();
      attack();
      return fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: main, trustedBaseTip: ws.baseSha });
    };

    it('a replace ref on the base tip does not make the workspace look merged', async () => {
      const ws = await withUnmergedCommit();
      await assert.rejects(forgedMerge(ws, () => {
        const tip = sh(fx.repo, 'rev-parse', 'HEAD').trim();
        const work = sh(ws.path, 'rev-parse', 'HEAD').trim();
        const fake = sh(fx.repo, 'commit-tree', `${tip}^{tree}`, '-p', work, '-m', 'x').trim();
        sh(fx.repo, 'replace', tip, fake);
      }), reason('not-merged'));
    });

    it('a graft file does not make the workspace look merged, and its presence is a refusal even for a true merge', async () => {
      const ws = await withUnmergedCommit();
      await assert.rejects(forgedMerge(ws, () => {
        const tip = sh(fx.repo, 'rev-parse', 'HEAD').trim();
        mkdirSync(path.join(fx.repo, '.git', 'info'), { recursive: true });
        writeFileSync(path.join(fx.repo, '.git', 'info', 'grafts'), `${tip} ${sh(ws.path, 'rev-parse', 'HEAD').trim()}\n`);
      }), reason('not-merged'));
      sh(fx.repo, 'merge', '-q', '--ff-only', 'axis/feat');
      await assert.rejects(fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: sh(fx.repo, 'symbolic-ref', 'HEAD').trim(), trustedBaseTip: ws.baseSha }), reason('not-merged'));
    });

    it('a deleted base plus a lookalike refs/heads/refs/heads/<name> is no base, not a merged one', async () => {
      const ws = await withUnmergedCommit();
      await assert.rejects(forgedMerge(ws, () => {
        const main = sh(fx.repo, 'symbolic-ref', 'HEAD').trim();
        const work = sh(ws.path, 'rev-parse', 'HEAD').trim();
        sh(fx.repo, 'update-ref', '-d', main);
        sh(fx.repo, 'update-ref', `refs/heads/${main}`, work);
      }), reason('no-base-branch'));
    });
  });
});
