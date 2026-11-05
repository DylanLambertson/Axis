// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review 3: R3-1 (snapshot content follows a swapped symlink or blocks on a FIFO) and
// R3-2 (status() blocks on a FIFO): file content is read only from the scanned regular file.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { createExecGitRunner, WorktreeError, WorktreeManager, type GitRunner } from '../src/index.js';
import { makeFixture, sh, write, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const posixOnly = { skip: process.platform === 'win32' ? 'no FIFOs or POSIX symlinks on win32' : false };
const SECRET = 'TOP-SECRET-outside-the-worktree\n';

/** Rejects if `p` has not settled within `ms`: a hang becomes a test failure instead of a stuck run. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * A runner that calls `swap()` once, right before the first git call that follows the
 * snapshot scan's `ls-files --others` (that is, after the scan has lstat-ed every path).
 */
function swapAfterScan(swap: () => void): { runner: GitRunner; arm(): void; fired(): boolean } {
  const real = createExecGitRunner();
  let state: 'idle' | 'armed' | 'scanned' | 'done' = 'idle';
  return {
    runner: {
      ...(real.gitPath !== undefined ? { gitPath: real.gitPath } : {}),
      run(args, o) {
        if (state === 'scanned') {
          state = 'done';
          swap();
        }
        if (state === 'armed' && args.includes('ls-files') && args.includes('--others') && !args.includes('--ignored')) {
          state = 'scanned';
        }
        return real.run(args, o);
      },
    },
    arm: () => { state = 'armed'; },
    fired: () => state === 'done',
  };
}

async function backupContent(fx: Fixture, attempt: Promise<{ backupRef: string }>, rel: string): Promise<string | null> {
  let backupRef: string;
  try {
    ({ backupRef } = await attempt);
  } catch (e) {
    assert.ok(e instanceof WorktreeError, String(e));
    return null; // refusing the snapshot is a correct outcome
  }
  try {
    return sh(fx.repo, 'cat-file', 'blob', `${backupRef}:${rel}`);
  } catch {
    return null;
  }
}

describe('R3-1: snapshot content is read in-process from the scanned file only', () => {
  it('a regular file swapped for a symlink after the scan does not copy the target into the backup', posixOnly, async () => {
    const fx = fresh();
    const secret = path.join(fx.tmp, 'secret.txt');
    writeFileSync(secret, SECRET);
    let leak = '';
    const hook = swapAfterScan(() => { unlinkSync(leak); symlinkSync(secret, leak); });
    const m = new WorktreeManager({ runner: hook.runner, worktreeRoot: fx.root });
    const ws = await m.create({ repoPath: fx.repo, slug: 'agent' });
    leak = path.join(ws.path, 'leak.txt');
    write(leak, 'harmless\n');
    write(path.join(ws.path, 'a.txt'), 'edit\n');
    hook.arm();
    const got = await backupContent(fx, m.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') }), 'leak.txt');
    assert.ok(hook.fired(), 'the swap hook never ran: the test is vacuous');
    assert.notEqual(got, SECRET, 'the symlink target was copied into the agent-readable backup');
  });

  it('a tracked path under a directory replaced by a symlink is not read through the link', posixOnly, async () => {
    const fx = fresh();
    const outside = path.join(fx.tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'id.txt'), SECRET);
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    // Agent, inside its own worktree: stage d/id.txt, then point d at a directory it wants read.
    write(path.join(ws.path, 'd', 'id.txt'), 'placeholder\n');
    sh(ws.path, 'add', 'd/id.txt');
    rmSync(path.join(ws.path, 'd'), { recursive: true });
    symlinkSync(outside, path.join(ws.path, 'd'));
    write(path.join(ws.path, 'a.txt'), 'edit\n');
    const got = await backupContent(fx, fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') }), 'd/id.txt');
    assert.notEqual(got, SECRET, 'a file outside the worktree was copied into the backup through a directory symlink');
    const st = await fx.manager.status(ws.path);
    // As git does, a path beyond a symlinked directory is gone, not modified: nothing outside was opened.
    assert.equal(st.dirty.find((d) => d.path === 'd/id.txt')?.worktree, 'D', 'status compared a file outside the worktree');
  });

  it('a regular file swapped for a FIFO after the scan fails closed instead of hanging', { ...posixOnly, timeout: 30_000 }, async () => {
    const fx = fresh();
    let pipe = '';
    const hook = swapAfterScan(() => { unlinkSync(pipe); execFileSync('mkfifo', [pipe]); });
    const m = new WorktreeManager({ runner: hook.runner, worktreeRoot: fx.root });
    const ws = await m.create({ repoPath: fx.repo, slug: 'agent' });
    pipe = path.join(ws.path, 'pipe.txt');
    write(pipe, 'harmless\n');
    write(path.join(ws.path, 'a.txt'), 'edit\n');
    hook.arm();
    await within(
      m.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') }).then(() => undefined, () => undefined),
      15_000, 'restoreFromRunBase with a FIFO swapped in',
    );
    assert.ok(hook.fired(), 'the swap hook never ran: the test is vacuous');
    // The repository mutex is free again: a second operation on the same repository completes.
    await within(m.create({ repoPath: fx.repo, slug: 'next' }), 15_000, 'create after the FIFO swap');
  });

});

describe('R3-2: status() never blocks on a FIFO and never reads past a symlink', () => {
  it('real time: a tracked file toggled between a file and a FIFO never hangs status()', { ...posixOnly, timeout: 90_000 }, async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    // Atomic renames: the path always exists, so an lstat that sees a file is often followed by an open of a FIFO.
    const loop = spawn('/bin/sh', ['-c',
      `cd "${ws.path}" && printf 'alpha-x\\n' > .r; while :; do rm -f .f; mkfifo .f; mv -f .f a.txt; cp .r .r2; mv -f .r2 a.txt; done`],
    { stdio: 'ignore' });
    let calls = 0;
    try {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && calls < 200) {
        await within(fx.manager.status(ws.path).catch(() => undefined), 10_000, `status() call ${calls + 1}`);
        calls++;
      }
    } finally {
      loop.kill('SIGKILL');
    }
    assert.ok(calls > 5, `only ${calls} status() calls ran`);
  });

  it('a FIFO or a symlink to a device in place of a tracked file reads as modified', posixOnly, async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    unlinkSync(path.join(ws.path, 'a.txt'));
    execFileSync('mkfifo', [path.join(ws.path, 'a.txt')]);
    unlinkSync(path.join(ws.path, 'sub', 'b.txt'));
    symlinkSync('/dev/zero', path.join(ws.path, 'sub', 'b.txt'));
    const st = await within(fx.manager.status(ws.path), 10_000, 'status()');
    assert.equal(st.dirty.find((d) => d.path === 'a.txt')?.worktree, 'M');
    assert.equal(st.dirty.find((d) => d.path === 'sub/b.txt')?.worktree, 'M');
  });
});
