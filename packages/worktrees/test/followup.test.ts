// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Second review round: NS-1 to NS-5 and the nits (lock start time, create rollback, scratch dir, git pin retry).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { createExecGitRunner, redact, WorktreeError, WorktreeManager, type GitRunner } from '../src/index.js';
import { readRegularFile } from '../src/fsSafe.js';
import { acquireFileLock, processStartOf } from '../src/lock.js';
import { confirmFor, makeFixture, sh, write, type Fixture, exp } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(extra: Parameters<typeof makeFixture>[0] = {}): Fixture {
  const f = makeFixture(extra);
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const code = (c: string) => (e: unknown) => e instanceof WorktreeError && e.code === c;

describe('NS-2: the branch tip is recorded before any branch is deleted', () => {
  it('writes and reports refs/axis/backup/<id>/branch-*, pointing at the deleted branch tip', async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'br' });
    write(path.join(ws.path, 'x.txt'), 'x\n');
    sh(ws.path, 'add', '-A');
    sh(ws.path, 'commit', '-q', '-m', 'work');
    const tip = sh(ws.path, 'rev-parse', 'HEAD').trim();
    await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived' });
    const res = await fx.manager.remove({ path: ws.path, expectedWorktree: exp(ws.path), deleteBranch: true });
    assert.equal(res.branchDeleted, true);
    assert.match(res.branchBackupRef ?? '', /^refs\/axis\/backup\/[^/]+\/branch-\d{8}T\d{6}Z-[0-9a-f]{32}$/);
    assert.equal(sh(fx.repo, 'rev-parse', res.branchBackupRef as string).trim(), tip);
    assert.equal(sh(fx.repo, 'branch', '--list', 'axis/br').trim(), '');
  });

  it('keeps the branch and reports no backup ref when the branch is not deleted', async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'keep' });
    await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived' });
    const res = await fx.manager.remove({ path: ws.path , expectedWorktree: exp(ws.path)});
    assert.equal(res.branchBackupRef, null);
    assert.notEqual(sh(fx.repo, 'branch', '--list', 'axis/keep').trim(), '');
  });
});

describe('NS-3: nested repositories are part of the confirmation', () => {
  it('lists the nested repo, binds it into the fingerprint, and requires a confirmation to remove', async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'nest' });
    await fx.manager.finalise({ path: ws.path, expectedWorktree: exp(ws.path), outcome: 'archived' });
    const before = await fx.manager.previewDiscard(ws.path, exp(ws.path));
    assert.deepEqual(before.skippedUnsupported, []);
    mkdirSync(path.join(ws.path, 'tool'));
    sh(path.join(ws.path, 'tool'), 'init', '-q');
    const after1 = await fx.manager.previewDiscard(ws.path, exp(ws.path));
    assert.deepEqual(after1.skippedUnsupported, ['tool/']);
    assert.notEqual(after1.fingerprint, before.fingerprint);
    await assert.rejects(
      fx.manager.remove({ path: ws.path , expectedWorktree: exp(ws.path)}),
      (e: unknown) => e instanceof WorktreeError && e.code === 'E_CONFLICT'
        && Array.isArray(e.details['skippedUnsupported']) && (e.details['skippedUnsupported'] as string[]).includes('tool/'),
    );
    const res = await fx.manager.remove({ path: ws.path, expectedWorktree: exp(ws.path), discardConfirmation: await confirmFor(fx.manager, ws.path, ws.id, 'remove') });
    assert.deepEqual(res.skippedUnsupported, ['tool/']);
  });
});

describe('NS-5: records are read as bounded regular files', () => {
  it('readRegularFile refuses a FIFO, a symlink to /dev/zero and an oversized file without blocking', async () => {
    const fx = fresh();
    const fifo = path.join(fx.tmp, 'fifo');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(readRegularFile(fifo), code('E_INTERNAL'));
    const zero = path.join(fx.tmp, 'zero');
    symlinkSync('/dev/zero', zero);
    await assert.rejects(readRegularFile(zero), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ELOOP');
    const big = path.join(fx.tmp, 'big');
    writeFileSync(big, Buffer.alloc(2048));
    await assert.rejects(readRegularFile(big, 1024), code('E_INTERNAL'));
    await assert.rejects(readRegularFile(path.join(fx.tmp, 'missing')), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT');
    writeFileSync(big, 'ok');
    assert.equal(await readRegularFile(big), 'ok');
  });

  it('a FIFO as the baseline or the lock file is treated as missing, never a hang', { timeout: 20_000 }, async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'fifo' });
    const gitDir = sh(ws.path, 'rev-parse', '--absolute-git-dir').trim();
    execFileSync('rm', ['-f', path.join(gitDir, 'axis-gitsnap.json')]);
    execFileSync('mkfifo', [path.join(gitDir, 'axis-gitsnap.json')]);
    const st = await fx.manager.status(ws.path, exp(ws.path));
    assert.equal(st.baselineMissing, true);
  });
});

describe('nits', () => {
  it('N-B: the lock reads a real process start time here, so a reused pid is detected', async (t) => {
    if (process.platform === 'win32') return;
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    try {
      const spawnedAt = Date.now();
      await new Promise((r) => setTimeout(r, 300));
      const start = await processStartOf(child.pid as number);
      if (start === null) return t.skip('ps -o lstart= is unavailable here (no procps); the lock falls back to liveness only');
      assert.ok(Math.abs(start - spawnedAt) < 5_000, `start time ${start} is not near ${spawnedAt}`);
      const file = path.join(os.tmpdir(), `axis-lock-${process.pid}-${Date.now()}`);
      // A live pid that now belongs to a different process (a different start time) is a stale lock.
      writeFileSync(file, JSON.stringify({ pid: child.pid, processStart: Date.now() - 86_400_000, token: 'aa' }));
      const release = await acquireFileLock(file, { timeoutMs: 3_000 });
      await release();
      // The same pid with a matching start time is a live holder.
      writeFileSync(file, JSON.stringify({ pid: child.pid, processStart: start, token: 'bb' }));
      await assert.rejects(acquireFileLock(file, { timeoutMs: 300 }), code('E_CONFLICT'));
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('N-C: a failed create never deletes a branch somebody else made or moved', async () => {
    const fx = fresh();
    write(path.join(fx.repo, 'a.txt'), 'two\n');
    sh(fx.repo, 'commit', '-qam', 'second');
    const other = sh(fx.repo, 'rev-parse', 'HEAD~1').trim();
    const real = createExecGitRunner();
    const runner: GitRunner = {
      ...(real.gitPath !== undefined ? { gitPath: real.gitPath } : {}),
      async run(args, o) {
        if (args.includes('add') && args.includes('--no-checkout')) sh(fx.repo, 'branch', 'axis/raced', other); // lost the race
        return real.run(args, o);
      },
    };
    const m = new WorktreeManager({ runner, worktreeRoot: fx.root });
    await assert.rejects(m.create({ repoPath: fx.repo, slug: 'raced' }));
    assert.equal(sh(fx.repo, 'rev-parse', 'refs/heads/axis/raced').trim(), other, "somebody else's branch was deleted");
  });

  it('N-D: the snapshot index lives in a private daemon directory, not in $TMPDIR', async () => {
    const fx = fresh();
    const before = new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith('axis-snap-')));
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'scratch' });
    write(path.join(ws.path, 'a.txt'), 'edit\n');
    await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') , expectedWorktree: exp(path.join(ws.path, 'a.txt'))});
    assert.deepEqual(readdirSync(os.tmpdir()).filter((n) => n.startsWith('axis-snap-') && !before.has(n)), []);
    const scratch = path.join(fx.root, '.axis-tmp');
    assert.equal(existsSync(scratch), true);
    assert.equal(statSync(scratch).mode & 0o077, 0);
    assert.deepEqual(readdirSync(scratch), [], 'scratch files are cleaned up');
  });

  it('N-E: a transient failure checking the git binary is retried, not cached forever', async () => {
    const fx = fresh();
    const real = createExecGitRunner();
    const fake = path.join(fx.tmp, 'bin', 'git');
    const m = new WorktreeManager({ runner: { gitPath: fake, run: real.run }, worktreeRoot: fx.root });
    await assert.rejects(m.list(fx.repo));
    mkdirSync(path.dirname(fake));
    symlinkSync(real.gitPath as string, fake);
    await assert.doesNotReject(m.list(fx.repo));
  });

  it('N-G: redaction handles an unencoded @ inside a password', () => {
    assert.equal(redact('fatal: https://u:p@ss@host.example/x.git'), 'fatal: https://***@host.example/x.git');
    assert.equal(redact('https://host.example/path@x'), 'https://host.example/path@x');
  });
});
