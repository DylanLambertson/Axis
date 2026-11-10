// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeError, verifyMerged } from '../src/index.js';
import { makeFixture, sh, write, type Fixture, exp } from './helpers.js';

const reason = (r: string) => (e: unknown) => e instanceof WorktreeError && e.details['reason'] === r;

/** FU-WT-BASE2: `merged` needs the base branch to still descend from the tip it had when the workspace was created. */
describe('finalise merged refuses a base that no longer descends from its recorded tip', () => {
  let fx: Fixture;
  let main: string;
  beforeEach(() => { fx = makeFixture(); main = sh(fx.repo, 'symbolic-ref', 'HEAD').trim(); });
  afterEach(() => fx.cleanup());

  async function workspaceWithCommit() {
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'feat' });
    write(path.join(ws.path, 'f.txt'), 'f\n');
    sh(ws.path, 'add', 'f.txt');
    sh(ws.path, 'commit', '-q', '-m', 'feature');
    return { ...ws, head: sh(ws.path, 'rev-parse', 'HEAD').trim() };
  }
  /**
   * The run moves its own branch onto history without the base tip (here a root commit with the same tree), so its head
   * no longer descends from the tip; any base that holds such a head cannot descend from the tip either.
   */
  function rebaseOffTip(ws: { path: string }): string {
    const root = sh(ws.path, 'commit-tree', 'HEAD^{tree}', '-m', 'unrelated root').trim();
    sh(ws.path, 'reset', '-q', '--hard', root);
    return root;
  }
  const finalise = (ws: { path: string }, tip: string | null | undefined, branch: string | null = main) =>
    fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'merged', trustedBaseBranch: branch, ...(tip === undefined ? {} : { trustedBaseTip: tip }) });

  it('the control: a real fast-forward of the base onto the work is merged', async () => {
    const ws = await workspaceWithCommit();
    sh(fx.repo, 'merge', '-q', '--ff-only', 'axis/feat');
    assert.equal((await finalise(ws, ws.baseSha)).outcome, 'merged');
  });

  it('a base reset to an unrelated commit is base-rewritten, before any merge question', async () => {
    const ws = await workspaceWithCommit();
    sh(fx.repo, 'update-ref', main, sh(fx.repo, 'commit-tree', `${ws.baseSha}^{tree}`, '-m', 'unrelated').trim());
    await assert.rejects(finalise(ws, ws.baseSha), reason('base-rewritten'));
    assert.equal((await fx.manager.status(ws.path, exp(ws.path))).state, 'READY');
  });

  it('a run that rewrites its branch off the tip and points the base at it is refused, though the base holds the head', async () => {
    const ws = await workspaceWithCommit();
    const head = rebaseOffTip(ws);
    sh(fx.repo, 'update-ref', main, head);
    sh(fx.repo, 'merge-base', '--is-ancestor', head, main); // without the tip check this would be "merged"
    await assert.rejects(finalise(ws, ws.baseSha), reason('base-rewritten'));
  });

  it('rewritten base history (the tip amended away, the work rebased onto it and fast-forwarded) is refused', async () => {
    const ws = await workspaceWithCommit();
    const amended = sh(fx.repo, 'commit-tree', `${ws.baseSha}^{tree}`, '-m', 'amended base').trim(); // same tree, new history
    const work = sh(ws.path, 'commit-tree', 'HEAD^{tree}', '-p', amended, '-m', 'feature, rebased').trim();
    sh(ws.path, 'reset', '-q', '--hard', work);
    sh(fx.repo, 'update-ref', main, work);
    await assert.rejects(finalise(ws, ws.baseSha), reason('base-rewritten'));
  });

  it('the residual this does not close: a base fast-forwarded onto the run\'s own commits still reads as merged', async () => {
    const ws = await workspaceWithCommit();
    sh(fx.repo, 'update-ref', main, ws.head); // indistinguishable from a real merge by refs alone (threat model WT-3)
    assert.equal((await finalise(ws, ws.baseSha)).outcome, 'merged');
  });

  it('a base turned into a symbolic ref to the workspace branch is refused, though it descends from the tip', async () => {
    const ws = await workspaceWithCommit();
    sh(fx.repo, 'symbolic-ref', main, 'refs/heads/axis/feat');
    await assert.rejects(finalise(ws, ws.baseSha), reason('base-rewritten'));
  });

  it('a deleted base is no base', async () => {
    const ws = await workspaceWithCommit();
    sh(fx.repo, 'checkout', '-q', '--detach');
    sh(fx.repo, 'update-ref', '-d', main);
    await assert.rejects(finalise(ws, ws.baseSha), reason('no-base-branch'));
  });

  it('a tip that was never recorded (an older workspace) refuses even a real merge', async () => {
    const ws = await workspaceWithCommit();
    sh(fx.repo, 'merge', '-q', '--ff-only', 'axis/feat');
    await assert.rejects(finalise(ws, null), reason('no-base-branch'));
    await assert.rejects(finalise(ws, undefined), reason('no-base-branch'));
    for (const bad of ['', 'abc', ws.baseSha.toUpperCase(), `${ws.baseSha} `]) await assert.rejects(finalise(ws, bad), reason('no-base-branch'), bad);
    assert.equal((await finalise(ws, ws.baseSha)).outcome, 'merged');
  });

  it('a recorded tip whose object no longer exists is refused', async () => {
    const ws = await workspaceWithCommit();
    sh(fx.repo, 'merge', '-q', '--ff-only', 'axis/feat');
    await assert.rejects(finalise(ws, 'e'.repeat(ws.baseSha.length)), reason('base-rewritten'));
  });

  it('the base-rewritten verdict comes before the merge check and is not reached for an unrecorded tip', async () => {
    const calls: string[][] = [];
    const probe = {
      cwd: fx.repo,
      run: async (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === 'rev-parse') return { code: 0, stdout: 'info/grafts-absent-here\n' };
        if (args[0] === 'show-ref') return { code: 0, stdout: `${'b'.repeat(40)} ${main}\n` };
        if (args[0] === 'symbolic-ref') return { code: 1, stdout: '' };
        return { code: args[2] === 'a'.repeat(40) ? 1 : 0, stdout: '' }; // the tip is not an ancestor; the head is
      },
    };
    assert.equal(await verifyMerged(probe, 'c'.repeat(40), main, 'a'.repeat(40)), 'base-rewritten');
    assert.deepEqual(calls.at(-1), ['merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)]);
    calls.length = 0;
    assert.equal(await verifyMerged(probe, 'c'.repeat(40), main, null), 'no-base-branch');
    assert.deepEqual(calls, [], 'no git call without a recorded tip');
  });
});

describe('create keeps a base branch only when its exact ref holds the base sha', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('a tag that shadows the branch name gives a base sha the branch does not hold: no base branch is recorded', async () => {
    const main = sh(fx.repo, 'symbolic-ref', '--short', 'HEAD').trim();
    const before = sh(fx.repo, 'rev-parse', 'HEAD').trim();
    write(path.join(fx.repo, 'n.txt'), 'n\n');
    sh(fx.repo, 'add', 'n.txt');
    sh(fx.repo, 'commit', '-q', '-m', 'newer');
    sh(fx.repo, 'tag', main, before); // `<main>` now resolves to the tag (refs/tags wins over refs/heads)
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'a', baseRef: main });
    assert.equal(ws.baseSha, before);
    assert.equal(ws.baseBranch, null);
    const plain = await fx.manager.create({ repoPath: fx.repo, slug: 'b', baseRef: `refs/heads/${main}` });
    assert.equal(plain.baseBranch, `refs/heads/${main}`);
    assert.equal(plain.baseSha, sh(fx.repo, 'rev-parse', `refs/heads/${main}`).trim());
  });
});
