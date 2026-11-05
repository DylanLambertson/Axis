// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review 4: R4-1 (the common-dir guard snapshot blocks on a FIFO or reads through a link).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { snapshotGuardFiles } from '../src/gitSnap.js';
import { makeFixture, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const posixOnly = { skip: process.platform === 'win32' ? 'no FIFOs on win32' : false };

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

describe('R4-1: the guard snapshot reads common-dir files without blocking or following links', () => {
  it('real time: guard files toggled between a file and a FIFO never hang the snapshot or status()', { ...posixOnly, timeout: 120_000 }, async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    const common = path.join(fx.repo, '.git');
    mkdirSync(path.join(common, 'info'), { recursive: true });
    mkdirSync(path.join(common, 'hooks'), { recursive: true });
    // Several agent-writable guard files, each flipped by its own loop with atomic renames.
    const targets = ['info/attributes', 'hooks/pre-commit', 'hooks/post-checkout', 'config.worktree'];
    const loops = targets.map((t, i) => {
      const dir = path.dirname(path.join(common, t));
      const name = path.basename(t);
      writeFileSync(path.join(dir, `.r${i}`), `# guard ${i}\n`);
      return spawn('/bin/sh', ['-c',
        `cd "${dir}" && while :; do rm -f .f${i}; mkfifo .f${i}; mv -f .f${i} ${name}; cp .r${i} .s${i}; mv -f .s${i} ${name}; done`],
      { stdio: 'ignore' });
    });
    let calls = 0;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await within(snapshotGuardFiles(common), 10_000, `snapshotGuardFiles call ${calls + 1}`);
        if (calls % 50 === 0) await within(fx.manager.status(ws.path).catch(() => undefined), 10_000, `status() at call ${calls + 1}`);
        calls++;
      }
    } finally {
      loops.forEach((l) => l.kill('SIGKILL'));
    }
    assert.ok(calls > 50, `only ${calls} snapshot calls ran`);
  });

  it('a FIFO guard file is skipped without blocking, and a symlinked one records its target, not the content', posixOnly, async () => {
    const fx = fresh();
    const common = path.join(fx.repo, '.git');
    const files = await snapshotGuardFiles(common);
    assert.match(files['config']?.sha256 ?? '', /^[0-9a-f]{64}$/);
    mkdirSync(path.join(common, 'info'), { recursive: true });
    execFileSync('mkfifo', [path.join(common, 'info', 'attributes')]);
    const again = await within(snapshotGuardFiles(common), 10_000, 'snapshotGuardFiles with a FIFO');
    assert.equal(again['info/attributes'], undefined);
    const secret = path.join(fx.tmp, 'secret');
    writeFileSync(secret, 'TOP-SECRET\n');
    rmSync(path.join(common, 'info', 'attributes'));
    symlinkSync(secret, path.join(common, 'info', 'attributes'));
    const linked = await snapshotGuardFiles(common);
    assert.equal(linked['info/attributes']?.text, `symlink:${secret}`);
  });
});
