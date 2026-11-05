// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Discard confirmation tokens: short lived on a monotonic clock, single use, bound to workspace and operation.

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { consumeConfirmation, CONFIRMATION_TTL_MS } from '../src/confirmation.js';
import { markDiscardConfirmed } from '../src/daemonConfirm.js';
import { createExecGitRunner, WorktreeError, WorktreeManager, type GitRunner } from '../src/index.js';
import { makeFixture, write, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
after(() => fixtures.forEach((f) => f.cleanup()));
const b = { workspaceId: 'w', op: 'remove', fingerprint: 'f' } as const;

describe('confirmation tokens', () => {
  it('expire after the ttl on the injected monotonic clock (default 30 s)', () => {
    assert.equal(CONFIRMATION_TTL_MS, 30_000);
    let t = 1_000;
    const tok = markDiscardConfirmed(b, { now: () => t });
    t += CONFIRMATION_TTL_MS - 1;
    const live = markDiscardConfirmed(b, { now: () => t });
    assert.equal(consumeConfirmation(live, b), 'ok');
    t += 1; // the first token is now exactly at its deadline
    assert.equal(consumeConfirmation(tok, b), 'expired');
    assert.equal(consumeConfirmation(tok, b), 'spent', 'an expired token stays dead');
    const custom = markDiscardConfirmed(b, { now: () => t, ttlMs: 5 });
    t += 5;
    assert.equal(consumeConfirmation(custom, b), 'expired');
  });

  it('are single use, and a wrong workspace or operation neither succeeds nor spends them', () => {
    const tok = markDiscardConfirmed(b);
    assert.equal(consumeConfirmation(tok, { ...b, workspaceId: 'other' }), 'mismatch');
    assert.equal(consumeConfirmation(tok, { ...b, op: 'finalise' }), 'mismatch');
    assert.equal(consumeConfirmation(tok, { ...b, fingerprint: 'g' }), 'mismatch');
    assert.equal(consumeConfirmation(tok, b), 'ok');
    assert.equal(consumeConfirmation(tok, b), 'spent');
  });

  it('are spent by the first finalise that accepts them, even when it then fails', async () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const real = createExecGitRunner();
    let failCommit = false;
    const runner: GitRunner = {
      ...(real.gitPath !== undefined ? { gitPath: real.gitPath } : {}),
      run: async (args, o) => (failCommit && args.includes('commit-tree') ? { ...(await real.run(['--version'], o)), code: 1 } : real.run(args, o)),
    };
    const m = new WorktreeManager({ runner, worktreeRoot: fx.root });
    const ws = await m.create({ repoPath: fx.repo, slug: 'spent' });
    write(path.join(ws.path, 'a.txt'), 'dirty\n');
    const scan = await m.previewDiscard(ws.path);
    failCommit = true; // the backup snapshot fails after the token was accepted
    const token = markDiscardConfirmed({ workspaceId: ws.id, op: 'finalise', fingerprint: scan.fingerprint });
    await assert.rejects(m.finalise({ path: ws.path, outcome: 'archived', discardConfirmation: token }), WorktreeError);
    failCommit = false;
    await assert.rejects(
      m.finalise({ path: ws.path, outcome: 'archived', discardConfirmation: token }),
      (e: unknown) => e instanceof WorktreeError && e.code === 'E_CONFLICT' && e.details['reason'] === 'confirmation-spent',
    );
  });

  it('are refused by finalise and remove once expired, with a distinct reason', async () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'old' });
    write(path.join(ws.path, 'a.txt'), 'dirty\n');
    const scan = await fx.manager.previewDiscard(ws.path);
    let t = 0;
    const token = markDiscardConfirmed({ workspaceId: ws.id, op: 'finalise', fingerprint: scan.fingerprint }, { now: () => t });
    t = CONFIRMATION_TTL_MS;
    await assert.rejects(
      fx.manager.finalise({ path: ws.path, outcome: 'archived', discardConfirmation: token }),
      (e: unknown) => e instanceof WorktreeError && e.code === 'E_CONFLICT' && e.details['reason'] === 'confirmation-expired',
    );
  });
});
