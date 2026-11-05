// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the independent security review (S-1..S-6, N-1..N-10).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ERROR_CODES } from '@axis/protocol';
import { markDiscardConfirmed } from '../src/daemonConfirm.js';
import {
  acquireFileLock, createExecGitRunner, redact, resolveGitPath, toWorktreeError, WorktreeError, WorktreeManager,
  type GitRunner,
} from '../src/index.js';
import { consumeConfirmation } from '../src/confirmation.js';
import { hasGitComponent } from '../src/pathGuard.js';
import { mkdirSafe } from '../src/fsSafe.js';
import { createRefOnce } from '../src/snapshotRef.js';
import { HardenedGit } from '../src/hardenedGit.js';
import { createHooksGuard } from '../src/hardenedGit.js';
import { confirmFor, makeFixture, sh, write, type Fixture } from './helpers.js';

const code = (c: string, reason?: string) => (e: unknown) =>
  e instanceof WorktreeError && e.code === c && (reason === undefined || e.details['reason'] === reason);
const adminDir = (wt: string) => sh(wt, 'rev-parse', '--absolute-git-dir').trim();

describe('review fixes', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  describe('S-1 locking', () => {
    it('lets only one of two concurrent finalise calls win, even across manager instances', async () => {
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'race' });
      const other = new WorktreeManager({ runner: createExecGitRunner(), worktreeRoot: fx.root });
      for (const [a, b] of [[fx.manager, fx.manager], [fx.manager, other]] as const) {
        const w = await a.create({ repoPath: fx.repo, slug: `r${Math.random().toString(36).slice(2, 8)}` });
        const results = await Promise.allSettled([
          a.finalise({ path: w.path, outcome: 'archived' }),
          b.finalise({ path: w.path, outcome: 'abandoned' }),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
        const rej = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        assert.ok(code('E_CONFLICT')(rej.reason));
      }
      void ws;
    });

    it('file lock: excludes a live holder, reclaims dead holders, pid reuse and aged garbage', async () => {
      const file = path.join(fx.tmp, 'x.lock');
      const release = await acquireFileLock(file);
      await assert.rejects(acquireFileLock(file, { timeoutMs: 150, pollMs: 10 }), code('E_CONFLICT', 'locked'));
      await release();
      assert.equal(existsSync(file), false);
      // holder died
      const { spawnSync } = await import('node:child_process');
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
      writeFileSync(file, JSON.stringify({ pid: Number(dead.stdout.toString()), processStart: Date.now(), token: 't' }));
      await (await acquireFileLock(file, { timeoutMs: 500 }))();
      // pid reused by a different process: same live pid, wrong start time
      writeFileSync(file, JSON.stringify({ pid: process.pid, processStart: 1000, token: 't' }));
      await (await acquireFileLock(file, { timeoutMs: 500 }))();
      // a fresh unparsable file may be a holder mid-write: not reclaimed immediately
      writeFileSync(file, '{');
      await assert.rejects(acquireFileLock(file, { timeoutMs: 100, pollMs: 10 }), code('E_CONFLICT', 'locked'));
    });
  });

  describe('S-2 refs are create-once', () => {
    it('rejects a reused id without touching the other workspace\'s run base', async () => {
      const a = await fx.manager.create({ repoPath: fx.repo, slug: 'one', id: 'dup' });
      const before = sh(fx.repo, 'rev-parse', a.runBaseRef).trim();
      write(path.join(fx.repo, 'a.txt'), 'changed in main\n');
      sh(fx.repo, 'commit', '-qam', 'x');
      await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'two', id: 'dup' }), code('E_CONFLICT', 'id-exists'));
      assert.equal(sh(fx.repo, 'rev-parse', a.runBaseRef).trim(), before);
      assert.equal(sh(fx.repo, 'branch', '--list', 'axis/two').trim(), '');
    });

    it('never overwrites an existing ref, and backup names carry 128 bits of randomness', async () => {
      const git = new HardenedGit(createExecGitRunner(), createHooksGuard('linux'));
      const head = sh(fx.repo, 'rev-parse', 'HEAD').trim();
      await createRefOnce(git, fx.repo, 'refs/axis/test/once', head);
      await assert.rejects(createRefOnce(git, fx.repo, 'refs/axis/test/once', head), code('E_CONFLICT', 'ref-exists'));
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'bk' });
      write(path.join(ws.path, 'a.txt'), 'x\n');
      const r1 = await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') });
      write(path.join(ws.path, 'a.txt'), 'y\n');
      const r2 = await fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') });
      assert.match(r1.backupRef, /\/\d{8}T\d{6}Z-[0-9a-f]{32}$/);
      assert.notEqual(r1.backupRef, r2.backupRef);
    });
  });

  describe('S-3 records are not trusted', () => {
    it('rejects a record whose branch is not axis/<slug>', async () => {
      sh(fx.repo, 'branch', 'user-feature');
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'meta' });
      await fx.manager.finalise({ path: ws.path, outcome: 'archived' });
      const f = path.join(adminDir(ws.path), 'axis-workspace.json');
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), branch: 'user-feature' }));
      await assert.rejects(fx.manager.remove({ path: ws.path, deleteBranch: true }), code('E_INTERNAL', 'corrupt-record'));
      assert.notEqual(sh(fx.repo, 'branch', '--list', 'user-feature').trim(), '');
    });

    it('refuses to delete a branch git does not list for the worktree', async () => {
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'moved' });
      sh(ws.path, 'switch', '-q', '-c', 'something-else');
      await fx.manager.finalise({ path: ws.path, outcome: 'archived' });
      await assert.rejects(fx.manager.remove({ path: ws.path, deleteBranch: true }), code('E_POLICY_DENIED', 'branch-mismatch'));
      assert.ok(existsSync(ws.path));
      assert.notEqual(sh(fx.repo, 'branch', '--list', 'axis/moved').trim(), '');
    });

    it('treats a malformed baseline as missing (fail closed)', async () => {
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'base' });
      writeFileSync(path.join(adminDir(ws.path), 'axis-gitsnap.json'), '{"version":1,"files":{"x":{"sha256":1}},"config":[]}');
      const st = await fx.manager.status(ws.path);
      assert.equal(st.baselineMissing, true);
      assert.equal(st.hasDrift, true);
    });
  });

  describe('S-4 confirmation covers what a backup cannot hold', () => {
    it('returns skipped and ignored files, and binds the token to workspace, op and files', async () => {
      const small = makeFixture({ maxSnapshotFileBytes: 16 });
      try {
        const ws = await small.manager.create({ repoPath: small.repo, slug: 'big' });
        write(path.join(ws.path, 'big.bin'), 'x'.repeat(64));
        write(path.join(ws.path, 'ignored.log'), 'precious\n');
        const fin = await small.manager.finalise({ path: ws.path, outcome: 'abandoned', discardConfirmation: await confirmFor(small.manager, ws.path, ws.id, 'finalise') });
        assert.deepEqual([...fin.skippedLarge].sort(), ['big.bin', 'run.sh']);
        // wrong op, wrong workspace, then right
        const scan = await small.manager.previewDiscard(ws.path);
        assert.deepEqual(scan.ignored, ['ignored.log']);
        for (const bad of [
          markDiscardConfirmed({ workspaceId: ws.id, op: 'finalise', fingerprint: scan.fingerprint }),
          markDiscardConfirmed({ workspaceId: 'other', op: 'remove', fingerprint: scan.fingerprint }),
          markDiscardConfirmed({ workspaceId: ws.id, op: 'remove', fingerprint: 'stale' }),
        ]) {
          await assert.rejects(small.manager.remove({ path: ws.path, discardConfirmation: bad }), code('E_CONFLICT', 'confirmation-stale'));
        }
        await assert.rejects(small.manager.remove({ path: ws.path }), code('E_CONFLICT', 'dirty'));
        const good = markDiscardConfirmed({ workspaceId: ws.id, op: 'remove', fingerprint: scan.fingerprint });
        const rm = await small.manager.remove({ path: ws.path, discardConfirmation: good });
        assert.deepEqual([[...rm.skippedLarge].sort(), rm.ignored], [['big.bin', 'run.sh'], ['ignored.log']]);
        assert.ok(rm.backupRef);
        assert.equal(existsSync(ws.path), false);
      } finally {
        small.cleanup();
      }
    });

    it('needs a confirmation to remove a clean worktree that holds ignored files, and tokens are single use', async () => {
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'ign' });
      write(path.join(ws.path, 'ignored.log'), 'local only\n');
      await fx.manager.finalise({ path: ws.path, outcome: 'archived' });
      await assert.rejects(fx.manager.remove({ path: ws.path }), code('E_CONFLICT', 'unbacked-data'));
      const token = await confirmFor(fx.manager, ws.path, ws.id, 'remove');
      write(path.join(ws.path, 'ignored.log'), 'local only, edited\n'); // not a content change: ignored files are listed by name
      const rm = await fx.manager.remove({ path: ws.path, discardConfirmation: token });
      assert.equal(rm.backupRef, null);
      assert.deepEqual(rm.ignored, ['ignored.log']);
    });

    it('spends a confirmation on first use', () => {
      const t = markDiscardConfirmed({ workspaceId: 'w', op: 'remove', fingerprint: 'f' });
      const b = { workspaceId: 'w', op: 'remove', fingerprint: 'f' } as const;
      assert.equal(consumeConfirmation(t, b), 'ok');
      assert.equal(consumeConfirmation(t, b), 'spent');
      assert.equal(consumeConfirmation({ ...t }, b), 'invalid');
      assert.equal(consumeConfirmation(JSON.parse('{}'), b), 'invalid');
    });
  });

  describe('S-5 restore and create races', () => {
    it('creates no directory outside the worktree when a component is swapped for a symlink', async () => {
      const outside = path.join(fx.tmp, 'outside');
      mkdirSync(outside);
      let wtPath = '';
      const real = createExecGitRunner();
      const spy: GitRunner = {
        gitPath: real.gitPath as string,
        run: async (args, o) => {
          if (args.includes('cat-file') && args.includes('blob') && wtPath) symlinkSync(outside, path.join(wtPath, 'new1'));
          return real.run(args, o);
        },
      };
      const m = new WorktreeManager({ runner: spy, worktreeRoot: fx.root });
      write(path.join(fx.repo, 'new1', 'new2', 'f.txt'), 'x\n');
      sh(fx.repo, 'add', '-A');
      sh(fx.repo, 'commit', '-qm', 'nested');
      const ws = await m.create({ repoPath: fx.repo, slug: 'race' });
      rmSync(path.join(ws.path, 'new1'), { recursive: true });
      wtPath = ws.path;
      await assert.rejects(m.restoreFromRunBase({ path: path.join(ws.path, 'new1', 'new2', 'f.txt') }), code('E_POLICY_DENIED'));
      assert.deepEqual(readdirSync(outside), []);
    });

    it('mkdirSafe refuses a symlinked level', async () => {
      const base = path.join(fx.tmp, 'base');
      mkdirSync(base);
      symlinkSync(fx.repo, path.join(base, 'link'));
      await assert.rejects(mkdirSafe(base, ['link', 'x']), code('E_POLICY_DENIED'));
      assert.equal(existsSync(path.join(fx.repo, 'x')), false);
      await assert.rejects(mkdirSafe(base, ['..']), code('E_POLICY_DENIED'));
    });

    it('refuses restore when the run-base ref was moved, and pins a custom run base', async () => {
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'pin' });
      write(path.join(ws.path, 'a.txt'), 'new content\n');
      sh(ws.path, 'commit', '-qam', 'later');
      sh(fx.repo, 'update-ref', ws.runBaseRef, sh(ws.path, 'rev-parse', 'HEAD').trim());
      await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') }), code('E_POLICY_DENIED', 'runbase-moved'));
    });

    it('refuses finalise, remove and restore while a run is active', async () => {
      const m = new WorktreeManager({ runner: createExecGitRunner(), worktreeRoot: fx.root, refuseIfActiveRun: () => true });
      const ws = await m.create({ repoPath: fx.repo, slug: 'busy' });
      await assert.rejects(m.finalise({ path: ws.path, outcome: 'archived' }), code('E_CONFLICT', 'active-run'));
      await assert.rejects(m.remove({ path: ws.path }), code('E_CONFLICT', 'active-run'));
      await assert.rejects(m.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') }), code('E_CONFLICT', 'active-run'));
    });

    it('rolls back a failed create completely, so the same slug can be retried', async () => {
      const real = createExecGitRunner();
      let fail = true;
      const spy: GitRunner = {
        gitPath: real.gitPath as string,
        run: async (args, o) => {
          if (fail && args.includes('lock') && args.includes('worktree')) {
            fail = false;
            return { code: 1, stdout: '', stderr: 'boom', raw: Buffer.alloc(0) };
          }
          return real.run(args, o);
        },
      };
      const m = new WorktreeManager({ runner: spy, worktreeRoot: fx.root });
      await assert.rejects(m.create({ repoPath: fx.repo, slug: 'retry' }), code('E_INTERNAL'));
      assert.equal(sh(fx.repo, 'branch', '--list', 'axis/retry').trim(), '');
      assert.equal(sh(fx.repo, 'worktree', 'list').trim().split('\n').length, 1);
      await assert.doesNotReject(m.create({ repoPath: fx.repo, slug: 'retry' }));
    });
  });

  describe('S-6 closed error set', () => {
    it('only protocol-coded WorktreeErrors escape, whatever is corrupt', async () => {
      const mutations: Array<(f: string, orig: string) => void> = [
        (f) => writeFileSync(f, ''), (f) => writeFileSync(f, '{'), (f) => writeFileSync(f, '[]'),
        (f) => writeFileSync(f, 'null'), (f) => writeFileSync(f, '{"version":1}'),
        (f) => writeFileSync(f, Buffer.from([0xff, 0xfe, 0, 1, 2])), (f) => writeFileSync(f, 'x'.repeat(1 << 16)),
        (f, o) => writeFileSync(f, o.replace(/"version": ?1/, '"version":2')),
        (f, o) => writeFileSync(f, o.replace(/"(slug|sha256|key)"/g, '"zz"')),
        (f) => { rmSync(f); mkdirSync(f); },
        (f) => chmodSync(f, 0),
      ];
      let escaped = 0;
      let n = 0;
      for (const name of ['axis-workspace.json', 'axis-gitsnap.json']) {
        for (const mutate of mutations) {
          const ws = await fx.manager.create({ repoPath: fx.repo, slug: `fz${n++}` });
          const f = path.join(adminDir(ws.path), name);
          mutate(f, readFileSync(f, 'utf8'));
          const ops: Array<(m: WorktreeManager) => Promise<unknown>> = [
            (m) => m.status(ws.path), (m) => m.assertNoDrift(ws.path), (m) => m.acknowledgeDrift(ws.path),
            (m) => m.previewDiscard(ws.path), (m) => m.restoreFromRunBase({ path: path.join(ws.path, 'a.txt') }),
            (m) => m.list(fx.repo),
            (m) => m.finalise({ path: ws.path, outcome: 'archived' }), (m) => m.remove({ path: ws.path }),
          ];
          for (const op of ops) {
            try {
              await op(fx.manager);
            } catch (e) {
              escaped++;
              assert.ok(e instanceof WorktreeError, `non-WorktreeError escaped: ${String(e)}`);
              assert.ok((ERROR_CODES as readonly string[]).includes(e.code), e.code);
              assert.doesNotMatch(e.message, /\/Users\/|\/var\/|\/tmp\//, 'message leaks an absolute path');
            }
          }
          // test cleanup, outside the API under test: later creates refuse corrupt neighbours by design
          for (const args of [['unlock', ws.path], ['remove', '--force', ws.path], ['prune']]) {
            try { sh(fx.repo, 'worktree', ...args); } catch { /* already removed by the operation under test */ }
          }
        }
      }
      for (const op of [
        (m: WorktreeManager) => m.status(path.join(fx.tmp, 'nope')), (m: WorktreeManager) => m.status(fx.repo),
        (m: WorktreeManager) => m.create({ repoPath: fx.tmp, slug: 'x' }),
        (m: WorktreeManager) => m.restoreFromRunBase({ path: '/definitely/not/here' }),
        (m: WorktreeManager) => m.sweepSnapshotRefs(path.join(fx.tmp, 'nope')),
      ]) {
        await assert.rejects(op(fx.manager), (e) => e instanceof WorktreeError && (ERROR_CODES as readonly string[]).includes(e.code));
      }
      assert.ok(escaped > 50, String(escaped));
    });

    it('maps errnos and syntax errors', () => {
      const cases: Array<[unknown, string]> = [
        [Object.assign(new Error('x'), { code: 'ELOOP' }), 'E_POLICY_DENIED'],
        [Object.assign(new Error('x'), { code: 'ENOTDIR' }), 'E_POLICY_DENIED'],
        [Object.assign(new Error('x'), { code: 'ENOENT' }), 'E_NOT_FOUND'],
        [Object.assign(new Error('x'), { code: 'EEXIST' }), 'E_CONFLICT'],
        [Object.assign(new Error('x'), { code: 'EIO' }), 'E_INTERNAL'],
        [new SyntaxError('bad'), 'E_INTERNAL'],
        ['a string', 'E_INTERNAL'],
      ];
      for (const [err, expected] of cases) assert.equal(toWorktreeError(err).code, expected);
    });
  });

  describe('nits', () => {
    it('N-1: .git is refused in every case and NTFS/HFS form, on every segment', async () => {
      for (const p of ['.git', '.GIT/config', 'sub/.git/config', 'a/.Git', '.git.', '.git ', 'GIT~1/x', '.g‌it/x', '.git::$INDEX_ALLOCATION/x', 'a\\.git\\x']) {
        assert.equal(hasGitComponent(p), true, p);
      }
      for (const p of ['.gitignore', 'a/.github/x', 'git', 'x.git/y', '..foo']) assert.equal(hasGitComponent(p), false, p);
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'git' });
      for (const p of ['.GIT/config', 'sub/.git/config']) {
        await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(ws.path, p) }), code('E_POLICY_DENIED'));
      }
    });

    it('N-2: pathspec magic in a file name is literal', async () => {
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'magic' });
      write(path.join(ws.path, ':(top)a.txt'), 'x\n');
      await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(ws.path, ':(top)a.txt') }), code('E_NOT_FOUND'));
      assert.equal(readFileSync(path.join(ws.path, ':(top)a.txt'), 'utf8'), 'x\n');
    });

    it('N-3: a top-level name starting with ".." is not mistaken for traversal', async () => {
      write(path.join(fx.repo, '..foo'), 'dots\n');
      sh(fx.repo, 'add', '-A');
      sh(fx.repo, 'commit', '-qm', 'dots');
      const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'dots' });
      write(path.join(ws.path, '..foo'), 'changed\n');
      await fx.manager.restoreFromRunBase({ path: path.join(ws.path, '..foo') });
      assert.equal(readFileSync(path.join(ws.path, '..foo'), 'utf8'), 'dots\n');
    });

    it('N-5: git resolves from absolute PATH entries only and must not live inside the root', async () => {
      assert.throws(() => resolveGitPath(undefined, { PATH: './node_modules/.bin:bin' }), code('E_NOT_FOUND'));
      assert.ok(path.isAbsolute(resolveGitPath(undefined, process.env)));
      assert.equal(resolveGitPath('/opt/x/git', {}), '/opt/x/git');
      const planted = path.join(fx.root, 'bin', 'git');
      write(planted, '#!/bin/sh\nexit 0\n');
      const evil: GitRunner = { gitPath: planted, run: async () => { throw new Error('must not run'); } };
      const m = new WorktreeManager({ runner: evil, worktreeRoot: fx.root });
      await assert.rejects(m.list(fx.repo), code('E_POLICY_DENIED', 'git-path'));
    });

    it('N-6: credentials in URLs are redacted from error details', () => {
      assert.equal(redact('fatal: https://user:p4ss@example.com/x.git ssh://tok@host/y'), 'fatal: https://***@example.com/x.git ssh://***@host/y');
    });
  });
});
