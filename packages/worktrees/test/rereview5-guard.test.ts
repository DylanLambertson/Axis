// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review 5: R5-1 (a symlinked or huge hooks directory is read through and walked without a bound).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildGitSnapshot, diffGitSnapshots, snapshotGuardFiles } from '../src/gitSnap.js';
import { makeFixture, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX symlinks only' : false };
const SECRET = 'TOP-SECRET-R5-key-material';

function baselines(fx: Fixture): string[] {
  const admin = path.join(fx.repo, '.git', 'worktrees');
  return readdirSync(admin).map((d) => path.join(admin, d, 'axis-gitsnap.json')).filter((f) => existsSync(f));
}

function secretDir(fx: Fixture, name: string, file: string): string {
  const dir = path.join(fx.tmp, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, file), `${SECRET}\n`);
  return dir;
}

describe('R5-1: guard directories are never read through a symlink, and the walk is bounded', () => {
  it('a symlinked hooks directory is recorded as a link; its files never reach the snapshot or the baseline', posixOnly, async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    const dir = secretDir(fx, 'ssh', 'id_rsa');
    rmSync(path.join(fx.repo, '.git', 'hooks'), { recursive: true, force: true });
    symlinkSync(dir, path.join(fx.repo, '.git', 'hooks'));
    const snap = await fx.manager.takeGitSnapshot(ws.path);
    assert.ok(!JSON.stringify(snap).includes(SECRET), 'secret text in the snapshot');
    assert.equal(snap.files['hooks']?.text, `symlink:${dir}`);
    assert.ok(Object.keys(snap.files).every((k) => !k.startsWith('hooks/')), 'the link was walked');
    await fx.manager.acknowledgeDrift(ws.path);
    for (const b of baselines(fx)) assert.ok(!readFileSync(b, 'utf8').includes(SECRET), `secret text persisted in ${b}`);
  });

  it('a guard file under a symlinked directory (info -> elsewhere) is not read through the link', posixOnly, async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    const dir = secretDir(fx, 'elsewhere', 'attributes');
    rmSync(path.join(fx.repo, '.git', 'info'), { recursive: true, force: true });
    symlinkSync(dir, path.join(fx.repo, '.git', 'info'));
    const snap = await fx.manager.takeGitSnapshot(ws.path);
    assert.ok(!JSON.stringify(snap).includes(SECRET), 'secret text in the snapshot');
    assert.equal(snap.files['info/attributes']?.text, `symlink:${dir}`, 'the link itself is what drifts');
  });

  it('a hooks tree with more files than the cap is truncated during the walk, and the truncation always drifts', async () => {
    const fx = fresh();
    const common = path.join(fx.repo, '.git');
    const many = path.join(common, 'hooks', 'many');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 2100; i++) writeFileSync(path.join(many, `f${i}`), `${i}\n`);
    const a = await snapshotGuardFiles(common);
    const hooks = Object.keys(a).filter((k) => k.startsWith('hooks/'));
    assert.ok(hooks.length <= 2001, `walked ${hooks.length} entries`);
    assert.ok(hooks.some((k) => k.endsWith('<truncated>')), 'no truncation marker');
    const b = await snapshotGuardFiles(common);
    const now = new Date();
    assert.ok(diffGitSnapshots(buildGitSnapshot(a, [], now), buildGitSnapshot(b, [], now)).length > 0, 'truncation hid drift');
  });

  it('a guard file over the byte budget is not read and always drifts', async () => {
    const fx = fresh();
    const common = path.join(fx.repo, '.git');
    writeFileSync(path.join(common, 'hooks', 'huge'), Buffer.alloc(17 * 1024 * 1024, 0x61));
    const a = await snapshotGuardFiles(common);
    const b = await snapshotGuardFiles(common);
    const now = new Date();
    const drift = diffGitSnapshots(buildGitSnapshot(a, [], now), buildGitSnapshot(b, [], now));
    assert.ok(drift.some((d) => d.id === 'file:hooks/huge'), 'an unread file compared as unchanged');
  });
});
