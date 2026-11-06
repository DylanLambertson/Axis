// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REF-1 against run-made commits: the run controls HEAD, so a commit (on the branch or a detached HEAD) must not turn a
// secret into "already shared" content. Only the workspace's recorded base commit is trusted.

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeError } from '../src/index.js';
import { makeFixture, sh, write, type Fixture } from './helpers.js';

const PEM = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----';

const refs = (repo: string, prefix: string): string => sh(repo, 'for-each-ref', '--format=%(refname)', prefix);

async function refusal(p: Promise<unknown>): Promise<WorktreeError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof WorktreeError, String(e));
    return e;
  }
  return assert.fail('a ref was written');
}

describe('snapshot secret scan of run-made history (REF-1)', () => {
  let fx: Fixture;
  let wt: string;
  beforeEach(async () => {
    fx = makeFixture();
    wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'hist' })).path;
  });
  afterEach(() => fx.cleanup());

  const commitSecret = (file = 'creds.txt'): void => {
    write(path.join(wt, file), `user\n${PEM}\n`);
    sh(wt, 'add', '--', file);
    sh(wt, 'commit', '-q', '-m', 'wip');
  };

  it('a secret committed on the workspace branch refuses the backup', async () => {
    commitSecret();
    write(path.join(wt, 'a.txt'), 'changed\n');
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.deepEqual(e.details['findings'], [{ rule: 'private-key-block', line: 2, path: 'creds.txt' }]);
    assert.equal(refs(fx.repo, 'refs/axis/backup'), '');
  });

  it('a secret committed on a detached HEAD refuses the backup', async () => {
    sh(wt, 'checkout', '-q', '--detach');
    commitSecret('deep/x.cfg');
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.deepEqual(e.details['findings'], [{ rule: 'private-key-block', line: 2, path: 'deep/x.cfg' }]);
  });

  it('a secret committed and then deleted is still pinned by the parent chain, so it refuses', async () => {
    commitSecret();
    sh(wt, 'rm', '-q', '--', 'creds.txt');
    sh(wt, 'commit', '-q', '-m', 'oops');
    assert.equal(existsSync(path.join(wt, 'creds.txt')), false);
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.details['reason'], 'snapshot-secret');
  });

  it('a secret in a run-made commit message refuses and names the commit', async () => {
    sh(wt, 'commit', '-q', '--allow-empty', '-m', `note\n\n${PEM}`);
    const id = sh(wt, 'rev-parse', 'HEAD').trim();
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.deepEqual(e.details['findings'], [{ rule: 'private-key-block', line: 3, commit: id }]);
  });

  it('finalise refuses to pin an unscanned commit as the archive, with nothing to back up', async () => {
    commitSecret();
    const e = await refusal(fx.manager.finalise({ path: wt, outcome: 'archived' }));
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.equal(refs(fx.repo, 'refs/axis/archive'), '');
  });

  it('remove refuses to pin an unscanned branch tip as the branch backup, before anything is written or deleted', async () => {
    write(path.join(wt, 'ok.txt'), 'fine\n');
    sh(wt, 'add', '--', 'ok.txt');
    sh(wt, 'commit', '-q', '-m', 'fine');
    await fx.manager.finalise({ path: wt, outcome: 'archived' });
    commitSecret();
    const e = await refusal(fx.manager.remove({ path: wt, deleteBranch: true }));
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.equal(refs(fx.repo, 'refs/axis/backup'), '');
    assert.ok(existsSync(wt));
    assert.notEqual(refs(fx.repo, 'refs/heads/axis/hist'), '');
  });

  it('clean run-made commits are scanned and pass, and content the base already holds is not refused', async () => {
    write(path.join(wt, 'ok.txt'), 'fine\n');
    sh(wt, 'add', '--', 'ok.txt');
    sh(wt, 'commit', '-q', '-m', 'fine');
    write(path.join(wt, 'a.txt'), 'changed\n');
    const r = await fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') });
    assert.equal(sh(fx.repo, 'show', `${r.backupRef}:ok.txt`), 'fine\n');
    const fin = await fx.manager.finalise({ path: wt, outcome: 'archived' });
    assert.ok(fin.archiveRef.startsWith('refs/axis/archive/'));
    const rm = await fx.manager.remove({ path: wt, deleteBranch: true });
    assert.ok(rm.branchBackupRef?.startsWith('refs/axis/backup/'));
    rmSync(wt, { recursive: true, force: true });
  });
});
