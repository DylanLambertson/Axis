// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// NB-1 (empty filter name) and NB-2 (no per-call scan race): the daemon runs no command that can reach a filter.

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { createExecGitRunner, createHooksGuard } from '../src/index.js';
import { HardenedGit } from '../src/hardenedGit.js';
import { readDirtyFilterFree } from '../src/dirty.js';
import { makeFixture, sh, write, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const hardened = (): HardenedGit => new HardenedGit(createExecGitRunner(), createHooksGuard('linux'));

describe('NB-1: a filter with an empty name is neutralised', () => {
  it('blanks `[filter ""]` for a command that is off the allow-list (best effort path)', async () => {
    const fx = fresh();
    const marker = path.join(fx.tmp, 'PWNED-empty');
    // Written as text: `git config` refuses some spellings of an empty subsection on some versions.
    appendFileSync(path.join(fx.repo, '.git', 'config'), `\n[filter ""]\n\tclean = touch '${marker}'; cat\n`);
    write(path.join(fx.repo, '.git', 'info', 'attributes'), '* filter=\n');
    write(path.join(fx.repo, 'a.txt'), 'ALPHA\n');
    const t = new Date(Date.now() + 120_000);
    utimesSync(path.join(fx.repo, 'a.txt'), t, t);
    // Non-vacuity: plain git status runs the driver.
    sh(fx.repo, 'status', '--porcelain');
    assert.equal(existsSync(marker), true, 'fixture is vacuous: plain git did not run the empty-name filter');
    rmSync(marker);
    await hardened().run(['status', '--porcelain'], { cwd: fx.repo });
    assert.equal(existsSync(marker), false, 'empty-name filter executed through HardenedGit');
  });
});

describe('NB-2: filter-free dirty detection', () => {
  it('reports the same dirty set as a user would expect, without any git status', async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'dirty' });
    const clean = await fx.manager.status(ws.path);
    assert.deepEqual(clean.dirty, []);
    write(path.join(ws.path, 'a.txt'), 'changed\n');
    unlinkSync(path.join(ws.path, 'sub', 'b.txt'));
    chmodSync(path.join(ws.path, 'run.sh'), 0o644);
    write(path.join(ws.path, 'new.txt'), 'n\n');
    write(path.join(ws.path, 'ignored.log'), 'x\n');
    sh(ws.path, 'add', 'a.txt');
    sh(ws.path, 'rm', '-q', '--cached', 'run.sh');
    const d = await readDirtyFilterFree(hardened(), ws.path);
    const by: Record<string, string> = {};
    for (const e of d) by[e.path] = (by[e.path] ? `${by[e.path]},` : '') + e.index + e.worktree;
    assert.equal(by['a.txt'], 'M ');
    assert.equal(by['run.sh'], 'D ,??'); // removed from the index, still on disk
    assert.equal(by['sub/b.txt'], ' D');
    assert.equal(by['new.txt'], '??');
    assert.equal(by['ignored.log'], undefined);
  });

  it('symlinks and the exec bit are compared, and a FIFO is never opened', async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'kinds' });
    symlinkSync('a.txt', path.join(ws.path, 'link'));
    sh(ws.path, 'add', 'link');
    sh(ws.path, 'commit', '-q', '-m', 'link');
    assert.deepEqual(await readDirtyFilterFree(hardened(), ws.path), []);
    unlinkSync(path.join(ws.path, 'link'));
    symlinkSync('sub/b.txt', path.join(ws.path, 'link'));
    chmodSync(path.join(ws.path, 'run.sh'), 0o644);
    const d = await readDirtyFilterFree(hardened(), ws.path);
    assert.deepEqual(d.map((e) => `${e.path}:${e.index}${e.worktree}`).sort(), ['link: M', 'run.sh: M']);
    const { execFileSync } = await import('node:child_process');
    unlinkSync(path.join(ws.path, 'a.txt'));
    execFileSync('mkfifo', [path.join(ws.path, 'a.txt')]);
    const d2 = await readDirtyFilterFree(hardened(), ws.path); // would hang if the FIFO were opened
    assert.ok(d2.some((e) => e.path === 'a.txt' && e.worktree === 'M'));
  });

  it('real time: an agent toggling .git/config in a loop never gets a driver run by status polling', { timeout: 60_000 }, async () => {
    const fx = fresh();
    const marker = path.join(fx.tmp, 'PWNED-loop');
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'loop' });
    write(path.join(fx.repo, '.git', 'info', 'attributes'), '* filter=race\n* filter=\n');
    const cfg = path.join(fx.repo, '.git', 'config');
    const clean = readFileSync(cfg, 'utf8');
    const evil = `${clean}\n[filter "race"]\n\tclean = touch '${marker}'; cat\n[filter ""]\n\tclean = touch '${marker}'; cat\n`;
    const script = `while true; do cp '${cfg}.evil' '${cfg}.n' && mv '${cfg}.n' '${cfg}'; cp '${cfg}.clean' '${cfg}.n' && mv '${cfg}.n' '${cfg}'; done`;
    writeFileSync(`${cfg}.evil`, evil);
    writeFileSync(`${cfg}.clean`, clean);
    const loop = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 25; i++) {
        const t = new Date(Date.now() + 120_000 + i);
        utimesSync(path.join(ws.path, 'a.txt'), t, t);
        await fx.manager.status(ws.path).catch(() => undefined); // drift or other refusals are fine; execution is not
        await fx.manager.previewDiscard(ws.path).catch(() => undefined);
      }
    } finally {
      loop.kill('SIGKILL');
    }
    assert.equal(existsSync(marker), false, 'a filter driver ran during status polling');
  });
});
