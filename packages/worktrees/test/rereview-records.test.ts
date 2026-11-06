// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review attack suite: the original attacks replayed against the daemon (B-1, B-2, NB-1, NB-2, S-1 to S-6).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
   existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
  promises as fsp,
} from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { markDiscardConfirmed } from '../src/daemonConfirm.js';
import { createExecGitRunner, WorktreeError, WorktreeManager } from '../src/index.js';
import { confirmFor, sh, write, exp } from './helpers.js';
import { fresh, PROTOCOL, raw, gitDirOf } from './rereview-support.js';
// --------------------------------------------------------------------------------------------
describe('re-review S-2: compare-and-swap refs/axis/*', () => {
  it('concurrent creates with a reused id: exactly one wins, in one manager and across two instances', async () => {
    const fx = fresh();
    const m2 = new WorktreeManager({ runner: createExecGitRunner(), worktreeRoot: fx.root });
    const r = await Promise.allSettled([
      fx.manager.create({ repoPath: fx.repo, slug: 'one', id: 'dup' }),
      fx.manager.create({ repoPath: fx.repo, slug: 'two', id: 'dup' }),
      m2.create({ repoPath: fx.repo, slug: 'three', id: 'dup' }),
    ]);
    const ok = r.filter((x) => x.status === 'fulfilled');
    assert.equal(ok.length, 1, JSON.stringify(r.map((x) => x.status === 'rejected' ? (x.reason as WorktreeError).code : 'ok')));
    for (const x of r) if (x.status === 'rejected') assert.equal((x.reason as WorktreeError).code, 'E_CONFLICT');
    const winner = (ok[0] as PromiseFulfilledResult<{ path: string }>).value;
    const meta = JSON.parse(readFileSync(path.join(gitDirOf(winner.path), 'axis-workspace.json'), 'utf8'));
    assert.equal(sh(fx.repo, 'rev-parse', 'refs/axis/runbase/dup').trim(), meta.runBaseSha);
  });

  it('concurrent creates with a reused id across two OS processes', async () => {
    const fx = fresh();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const idx = path.join(here, '..', 'src', 'index.js');
    const child = (slug: string) => new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e',
        `import {WorktreeManager,createExecGitRunner} from ${JSON.stringify(idx)};
         const m=new WorktreeManager({runner:createExecGitRunner(),worktreeRoot:${JSON.stringify(fx.root)}});
         m.create({repoPath:${JSON.stringify(fx.repo)},slug:${JSON.stringify(slug)},id:'xproc'})
          .then(()=>console.log('ok'),(e)=>console.log(e.code));`], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => resolve(out.trim()));
    });
    const res = await Promise.all([child('p-one'), child('p-two'), child('p-three')]);
    assert.deepEqual(res.slice().sort(), ['E_CONFLICT', 'E_CONFLICT', 'ok'], res.join(','));
  });

  it('an id stays reserved after its workspace is removed, and a forged pre-existing run-base ref is not overwritten', async () => {
    const fx = fresh();
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'one', id: 'gone' });
    await fx.manager.finalise({ path: a.path, expectedWorktree: exp(a.path), outcome: 'archived' });
    await fx.manager.remove({ path: a.path , expectedWorktree: exp(a.path)});
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'two', id: 'gone' }), (e: WorktreeError) => e.code === 'E_CONFLICT');
    const evil = sh(fx.repo, 'commit-tree', '-m', 'evil', `${sh(fx.repo, 'rev-parse', 'HEAD^{tree}').trim()}`).trim();
    sh(fx.repo, 'update-ref', 'refs/axis/runbase/forged', evil);
    await assert.rejects(fx.manager.create({ repoPath: fx.repo, slug: 'three', id: 'forged' }), (e: WorktreeError) => e.code === 'E_CONFLICT');
    assert.equal(sh(fx.repo, 'rev-parse', 'refs/axis/runbase/forged').trim(), evil);
  });

  it('concurrent finalise across two OS processes: one wins', async () => {
    const fx = fresh();
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'race' });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const idx = path.join(here, '..', 'src', 'index.js');
    const child = (outcome: string) => new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e',
        `import {WorktreeManager,createExecGitRunner} from ${JSON.stringify(idx)};
         const m=new WorktreeManager({runner:createExecGitRunner(),worktreeRoot:${JSON.stringify(fx.root)}});
         m.finalise({path:${JSON.stringify(a.path)}, expectedWorktree: exp(${JSON.stringify(a.path)}),outcome:${JSON.stringify(outcome)}})
          .then(()=>console.log('ok'),(e)=>console.log(e.code));`], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => resolve(out.trim()));
    });
    const res = await Promise.all([child('archived'), child('abandoned'), child('archived')]);
    assert.deepEqual(res.slice().sort(), ['E_CONFLICT', 'E_CONFLICT', 'ok'], res.join(','));
  });
});

// --------------------------------------------------------------------------------------------
describe('re-review S-3: a tampered record never deletes a user branch', () => {
  it('branch field rewritten to a user branch: refused, branch survives', async () => {
    const fx = fresh();
    sh(fx.repo, 'branch', 'user-feature');
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'meta' });
    await fx.manager.finalise({ path: a.path, expectedWorktree: exp(a.path), outcome: 'archived' });
    const f = path.join(gitDirOf(a.path), 'axis-workspace.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), branch: 'user-feature' }));
    await assert.rejects(fx.manager.remove({ path: a.path, expectedWorktree: exp(a.path), deleteBranch: true }));
    assert.notEqual(sh(fx.repo, 'branch', '--list', 'user-feature').trim(), '');
  });

  it('slug+branch rewritten to a kept axis/* branch, worktree switched to it: branch and its unarchived commits deleted', async () => {
    const fx = fresh();
    // The user removed an earlier workspace but KEPT its branch, then committed more on it.
    const kept = await fx.manager.create({ repoPath: fx.repo, slug: 'kept' });
    await fx.manager.finalise({ path: kept.path, expectedWorktree: exp(kept.path), outcome: 'archived' });
    await fx.manager.remove({ path: kept.path, expectedWorktree: exp(kept.path), deleteBranch: false });
    write(path.join(fx.repo, 'later.txt'), 'later work\n');
    sh(fx.repo, 'checkout', '-q', 'axis/kept');
    sh(fx.repo, 'add', 'later.txt');
    sh(fx.repo, 'commit', '-qm', 'user work on kept branch');
    const userTip = sh(fx.repo, 'rev-parse', 'HEAD').trim();
    sh(fx.repo, 'checkout', '-q', 'main');
    // Agent workspace.
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    await fx.manager.finalise({ path: a.path, expectedWorktree: exp(a.path), outcome: 'archived' });
    // Agent: rewrite its record (schema-valid) and switch its worktree to the user's branch.
    const f = path.join(gitDirOf(a.path), 'axis-workspace.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), slug: 'kept', branch: 'axis/kept' }));
    sh(a.path, 'checkout', '-q', 'axis/kept');
    await fx.manager.remove({ path: a.path, expectedWorktree: exp(a.path), deleteBranch: true }).catch(() => undefined);
    const stillReachable = sh(fx.repo, 'for-each-ref', '--contains', userTip, '--format=%(refname)').trim();
    assert.notEqual(stillReachable, '', 'user commits on the kept branch are no longer reachable from any ref');
  });
});

// --------------------------------------------------------------------------------------------
describe('re-review S-4: everything remove destroys is in the confirmation and the digest', () => {
  it('ignored .env is listed, part of the fingerprint, and a token goes stale when it changes', async () => {
    const fx = fresh();
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'env' });
    write(path.join(fx.repo, '.git', 'info', 'exclude'), '.env\n');
    write(path.join(a.path, '.env'), 'SECRET=1\n');
    await fx.manager.finalise({ path: a.path, expectedWorktree: exp(a.path), outcome: 'archived' });
    const scan = await fx.manager.previewDiscard(a.path, exp(a.path));
    assert.ok(scan.ignored.includes('.env'));
    const tok = markDiscardConfirmed({ workspaceId: a.id, op: 'remove', fingerprint: scan.fingerprint });
    write(path.join(a.path, '.env.local'), 'X=2\n');
    write(path.join(fx.repo, '.git', 'info', 'exclude'), '.env\n.env.local\n');
    await assert.rejects(fx.manager.remove({ path: a.path, expectedWorktree: exp(a.path), discardConfirmation: tok }), (e: WorktreeError) => e.code === 'E_CONFLICT');
  });

  it('a nested repository is deleted by remove, but is neither in the backup nor reported as unbacked', async () => {
    const fx = fresh();
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'nested' });
    const n = path.join(a.path, 'tool');
    mkdirSync(n);
    sh(n, 'init', '-q');
    write(path.join(n, 'work.txt'), 'only copy of this work\n');
    sh(n, 'add', '-A');
    sh(n, 'commit', '-qm', 'local only');
    await fx.manager.finalise({ path: a.path, expectedWorktree: exp(a.path), outcome: 'abandoned', discardConfirmation: await confirmFor(fx.manager, a.path, a.id, 'finalise') });
    const scan = await fx.manager.previewDiscard(a.path, exp(a.path));
    const res = await fx.manager.remove({ path: a.path, expectedWorktree: exp(a.path), discardConfirmation: await confirmFor(fx.manager, a.path, a.id, 'remove') });
    assert.equal(existsSync(n), false);
    const inBackup = res.backupRef ? raw(fx.repo, fx.tmp, 'ls-tree', '-r', '--name-only', res.backupRef).includes('tool/work.txt') : false;
    const reported = [...res.skippedLarge, ...res.ignored, ...res.skippedUnsupported, ...scan.skippedLarge, ...scan.skippedUnsupported].some((p) => p.startsWith('tool'));
    assert.ok(inBackup || reported, `nested repo deleted, backup ${res.backupRef} lacks it and no unbacked list names it`);
  });
});

// --------------------------------------------------------------------------------------------
describe('re-review S-5: restore', () => {
  it('pathspec magic, .git, a gitlink and a parent symlink are refused or literal', async () => {
    const fx = fresh();
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'r' });
    for (const p of ['.git/config', 'sub/.GIT/x', '.git./x', 'GIT~1/config']) {
      await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(a.path, p) , expectedWorktree: exp(path.join(a.path, p))}), (e: WorktreeError) => PROTOCOL.has(e.code));
    }
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(a.path, ':(top)a.txt') , expectedWorktree: exp(path.join(a.path, ':(top)a.txt'))}), (e: WorktreeError) => e.code === 'E_NOT_FOUND');
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(a.path, '*.txt') , expectedWorktree: exp(path.join(a.path, '*.txt'))}), (e: WorktreeError) => e.code === 'E_NOT_FOUND');
    const outside = path.join(fx.tmp, 'outside');
    mkdirSync(outside);
    rmSync(path.join(a.path, 'sub'), { recursive: true });
    symlinkSync(outside, path.join(a.path, 'sub'));
    await assert.rejects(fx.manager.restoreFromRunBase({ path: path.join(a.path, 'sub', 'b.txt') , expectedWorktree: exp(path.join(a.path, 'sub', 'b.txt'))}));
    assert.equal(existsSync(path.join(outside, 'b.txt')), false);
  });

  it('a directory swapped for a symlink between the checks and the write: a file outside the worktree is clobbered', async () => {
    const fx = fresh();
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'swap' });
    const outside = path.join(fx.tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'b.txt'), 'USER DATA OUTSIDE THE WORKTREE\n');
    write(path.join(a.path, 'sub', 'b.txt'), 'agent edit\n');
    const orig = fsp.writeFile;
    let swapped = false;
    (fsp as { writeFile: typeof fsp.writeFile }).writeFile = (async (...args: Parameters<typeof fsp.writeFile>) => {
      if (!swapped && typeof args[0] === 'string' && args[0].includes('.axis-restore-')) {
        swapped = true; // a concurrent agent process wins the window after mkdirSafe's lstat
        renameSync(path.join(a.path, 'sub'), path.join(a.path, 'sub.real'));
        symlinkSync(outside, path.join(a.path, 'sub'));
      }
      return orig(...args);
    }) as typeof fsp.writeFile;
    try {
      await fx.manager.restoreFromRunBase({ path: path.join(a.path, 'sub', 'b.txt') , expectedWorktree: exp(path.join(a.path, 'sub', 'b.txt'))}).catch(() => undefined);
    } finally {
      (fsp as { writeFile: typeof fsp.writeFile }).writeFile = orig;
    }
    assert.ok(swapped);
    assert.equal(
      existsSync(path.join(outside, 'b.txt')) ? readFileSync(path.join(outside, 'b.txt'), 'utf8') : '<deleted>',
      'USER DATA OUTSIDE THE WORKTREE\n', 'daemon replaced or deleted a file outside the worktree');
  });
});

// --------------------------------------------------------------------------------------------
describe('re-review S-6: only protocol errors escape', () => {
  const corrupt: Array<[string, (gitDir: string, wt: string) => void]> = [
    ['garbage bytes', (g) => writeFileSync(path.join(g, 'axis-workspace.json'), Buffer.from([0xff, 0xfe, 0, 1, 2]))],
    ['null', (g) => writeFileSync(path.join(g, 'axis-workspace.json'), 'null')],
    ['array', (g) => writeFileSync(path.join(g, 'axis-workspace.json'), '[]')],
    ['deep nesting', (g) => writeFileSync(path.join(g, 'axis-workspace.json'), '['.repeat(200_000) + ']'.repeat(200_000))],
    ['wrong types', (g) => writeFileSync(path.join(g, 'axis-workspace.json'), JSON.stringify({ version: 1, id: 5, state: {} }))],
    ['__proto__', (g) => writeFileSync(path.join(g, 'axis-workspace.json'), '{"__proto__":{"state":"READY"}}')],
    ['record is a directory', (g) => { rmSync(path.join(g, 'axis-workspace.json')); mkdirSync(path.join(g, 'axis-workspace.json')); }],
    ['record is a dangling symlink', (g) => { rmSync(path.join(g, 'axis-workspace.json')); symlinkSync('/nonexistent/x', path.join(g, 'axis-workspace.json')); }],
    ['baseline garbage', (g) => writeFileSync(path.join(g, 'axis-gitsnap.json'), '{"version":1,"files":5}')],
    ['lock garbage', (g) => writeFileSync(path.join(g, 'axis.lock'), '\0\0\0')],
    ['commondir garbage', (g) => writeFileSync(path.join(g, 'commondir'), '/nonexistent/\n')],
    ['.git file garbage', (_g, wt) => writeFileSync(path.join(wt, '.git'), 'gitdir: \0\n')],
    ['.git file is a directory loop', (_g, wt) => { rmSync(path.join(wt, '.git')); symlinkSync(path.join(wt, '.git'), path.join(wt, '.git')); }],
  ];
  for (const [name, mutate] of corrupt) {
    it(`fuzz: ${name}`, async () => {
      const fx = fresh({ lockTimeoutMs: 300 });
      const a = await fx.manager.create({ repoPath: fx.repo, slug: 'fz' });
      mutate(gitDirOf(a.path), a.path);
      const calls: Array<() => Promise<unknown>> = [
        () => fx.manager.status(a.path, exp(a.path)), () => fx.manager.previewDiscard(a.path, exp(a.path)), () => fx.manager.assertNoDrift(a.path, exp(a.path)),
        () => fx.manager.acknowledgeDrift(a.path), () => fx.manager.list(fx.repo),
        () => fx.manager.restoreFromRunBase({ path: path.join(a.path, 'a.txt') , expectedWorktree: exp(path.join(a.path, 'a.txt'))}),
        () => fx.manager.finalise({ path: a.path, expectedWorktree: exp(a.path), outcome: 'archived' }), () => fx.manager.remove({ path: a.path , expectedWorktree: exp(a.path)}),
        () => fx.manager.sweepSnapshotRefs(fx.repo), () => fx.manager.create({ repoPath: fx.repo, slug: 'fz2' }),
      ];
      for (const c of calls) {
        try {
          await c();
        } catch (e) {
          assert.ok(e instanceof WorktreeError && PROTOCOL.has(e.code), `${name}: escaped ${String(e)}`);
          assert.ok(!/\/(Users|private|var|tmp)\//.test(e.message), `${name}: message leaks a path: ${e.message}`);
        }
      }
    });
  }

  it('a FIFO planted as the workspace record is refused instead of hanging the daemon', { timeout: 20_000 }, async () => {
    const fx = fresh();
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'fifo' });
    const rec = path.join(gitDirOf(a.path), 'axis-workspace.json');
    rmSync(rec);
    execFileSync('mkfifo', [rec]);
    const outcome = await Promise.race([
      fx.manager.status(a.path, exp(a.path)).then(() => 'resolved', (e: unknown) => `rejected ${String(e)}`),
      new Promise((r) => setTimeout(() => r('HUNG'), 5_000)),
    ]);
    if (outcome === 'HUNG') {
      // unblock the threadpool so the test process can exit (a writer on a FIFO blocks without a reader)
      const w = spawn('/bin/sh', ['-c', `printf x > '${rec}'`], { stdio: 'ignore' });
      await new Promise((r) => w.on('close', r));
    }
    assert.match(String(outcome), /^rejected /, 'a FIFO record must be refused with an error');
    assert.notEqual(outcome, 'HUNG', 'status() never settled');
  });
});
