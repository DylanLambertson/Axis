// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeError } from '../src/index.js';
import { makeFixture, sh, write, type Fixture } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof WorktreeError && e.code === c;

describe('restoreFromRunBase', () => {
  let fx: Fixture;
  let wt: string;
  let id: string;
  beforeEach(async () => {
    fx = makeFixture();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'rb' });
    wt = ws.path;
    id = ws.id;
  });
  afterEach(() => fx.cleanup());

  it('restores an overwritten file and keeps a backup of the overwritten content', async () => {
    write(path.join(wt, 'a.txt'), 'clobbered by a run\n');
    const r = await fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') });
    assert.equal(readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'alpha\n');
    assert.equal(r.relPath, 'a.txt');
    assert.ok(r.backupRef.startsWith(`refs/axis/backup/${id}/`));
    assert.equal(sh(fx.repo, 'show', `${r.backupRef}:a.txt`), 'clobbered by a run\n');
  });

  it('restores a deleted file in a deleted directory, and keeps the exec bit', async () => {
    rmSync(path.join(wt, 'sub'), { recursive: true });
    unlinkSync(path.join(wt, 'run.sh'));
    await fx.manager.restoreFromRunBase({ path: path.join(wt, 'sub', 'b.txt') });
    assert.equal(readFileSync(path.join(wt, 'sub', 'b.txt'), 'utf8'), 'bravo\n');
    await fx.manager.restoreFromRunBase({ path: path.join(wt, 'run.sh') });
    assert.ok((lstatSync(path.join(wt, 'run.sh')).mode & 0o100) !== 0);
  });

  it('includes user edits made after create in the run base only if present at create', async () => {
    write(path.join(wt, 'late.txt'), 'created after the run base\n');
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(wt, 'late.txt') }), code('E_NOT_FOUND'));
    assert.equal(readFileSync(path.join(wt, 'late.txt'), 'utf8'), 'created after the run base\n');
  });

  it('replaces a symlink planted over a file without writing through it', async () => {
    const victim = path.join(fx.tmp, 'victim.txt');
    write(victim, 'precious\n');
    unlinkSync(path.join(wt, 'a.txt'));
    symlinkSync(victim, path.join(wt, 'a.txt'));
    await fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') });
    assert.equal(readFileSync(victim, 'utf8'), 'precious\n');
    assert.equal(lstatSync(path.join(wt, 'a.txt')).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'alpha\n');
  });

  it('refuses paths outside the worktree, through symlinked directories, and inside .git', async () => {
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(fx.repo, 'a.txt') }), code('E_POLICY_DENIED'));
    // a directory symlink inside the worktree that points at the local checkout
    rmSync(path.join(wt, 'sub'), { recursive: true });
    symlinkSync(fx.repo, path.join(wt, 'sub'));
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(wt, 'sub', 'a.txt') }), code('E_POLICY_DENIED'));
    assert.equal(readFileSync(path.join(fx.repo, 'a.txt'), 'utf8'), 'alpha\n');
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(wt, '.git') }), code('E_POLICY_DENIED'));
    await assert.rejects(fx.manager.restoreFromRunBase({ path: `${wt}/a.txt/../../x` }), code('E_POLICY_DENIED'));
  });

  it('restores a symlink entry and honours a custom run id', async () => {
    symlinkSync('a.txt', path.join(wt, 'ln'));
    sh(wt, 'add', 'ln');
    sh(wt, 'commit', '-q', '-m', 'ln');
    const snap = await import('../src/snapshotRef.js');
    const { HardenedGit } = await import('../src/hardenedGit.js');
    const { createExecGitRunner } = await import('../src/index.js');
    await snap.writeSnapshotRef(new HardenedGit(createExecGitRunner(), fx.tmp), wt, 'refs/axis/runbase/run-1', 'run');
    unlinkSync(path.join(wt, 'ln'));
    write(path.join(wt, 'ln'), 'now a file\n');
    await fx.manager.restoreFromRunBase({ path: path.join(wt, 'ln'), runId: 'run-1' });
    assert.equal(readlinkSync(path.join(wt, 'ln')), 'a.txt');
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(wt, 'ln'), runId: 'missing' }), code('E_NOT_FOUND'));
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(wt, 'ln'), runId: 'bad/id' }), code('E_INVALID_ARGUMENT'));
  });

  it('refuses a directory where the file belongs and an unmanaged worktree', async () => {
    rmSync(path.join(wt, 'a.txt'));
    mkdirSync(path.join(wt, 'a.txt'));
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }), code('E_CONFLICT'));
    assert.ok(existsSync(path.join(wt, 'a.txt')));
  });
});
