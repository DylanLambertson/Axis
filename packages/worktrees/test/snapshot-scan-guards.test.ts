// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REF-1 guards that only show under a moving HEAD, a changing file or a size bound: each test here fails without its guard.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createExecGitRunner, WorktreeError, type GitRunner, type SnapshotScanner } from '../src/index.js';
import { createHooksGuard, HardenedGit } from '../src/hardenedGit.js';
import { baseTree, scanHistory } from '../src/snapshotHistory.js';
import { snapshotTestHooks } from '../src/snapshotRef.js';
import { startSnapshotScan } from '../src/snapshotScan.js';
import { confirmFor, makeFixture, sh, write, type Fixture } from './helpers.js';

const PEM = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----';
const quiet: SnapshotScanner = { limits: { maxBytes: 300, maxBinaryBytes: 10 }, scan: async () => [] };
const BIG = 'w'.repeat(1201);

async function refusal(p: Promise<unknown>): Promise<WorktreeError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof WorktreeError, String(e));
    return e;
  }
  return assert.fail('not refused');
}

/** The real runner, with a hook that sees (and may change) every call and its result. */
function hooked(
  after: (args: readonly string[], input: unknown, r: Awaited<ReturnType<GitRunner['run']>>) => Awaited<ReturnType<GitRunner['run']>> | void,
  before: (args: readonly string[]) => void = () => undefined,
): GitRunner {
  const real = createExecGitRunner();
  return {
    ...(real.gitPath === undefined ? {} : { gitPath: real.gitPath }),
    run: async (args, opts) => {
      before(args);
      const r = await real.run(args, opts);
      return after(args, opts.input, r) ?? r;
    },
  };
}

describe('REF-1 guards', () => {
  let fx: Fixture;
  afterEach(() => {
    delete snapshotTestHooks.beforeReread;
    fx.cleanup();
  });

  it('a HEAD moved during the snapshot does not become its parent: the parent is the HEAD that was scanned', async () => {
    let wt = '';
    let secret = '';
    let moved = false;
    fx = makeFixture({
      runner: hooked((args) => {
        if (!moved && secret !== '' && args.includes('ls-files') && args.includes('--others')) {
          moved = true;
          execFileSync('git', ['update-ref', 'refs/heads/axis/race', secret], { cwd: wt });
        }
      }),
    });
    wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'race' })).path;
    const scanned = sh(wt, 'rev-parse', 'HEAD').trim();
    write(path.join(wt, 'creds.txt'), `${PEM}\n`);
    sh(wt, 'add', '--', 'creds.txt');
    sh(wt, 'commit', '-q', '-m', 'secret');
    secret = sh(wt, 'rev-parse', 'HEAD').trim();
    sh(wt, 'reset', '-q', '--hard', scanned);
    write(path.join(wt, 'a.txt'), 'changed\n');
    const r = await fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') });
    assert.ok(moved, 'HEAD was moved mid-snapshot');
    assert.equal(sh(fx.repo, 'rev-parse', `${r.backupRef}^`).trim(), scanned);
    assert.throws(() => sh(fx.repo, 'merge-base', '--is-ancestor', secret, r.backupRef), 'the moved-to commit is not reachable from the backup');
  });

  it('finalise archives the HEAD it read only after scanning it, even when a backup is written and HEAD moves before it', async () => {
    let wt = '';
    let base = '';
    let moved = false;
    fx = makeFixture({
      runner: hooked(() => undefined, (args) => {
        // Before the backup resolves HEAD: it then sees the base, while finalise already read the secret commit.
        if (!moved && base !== '' && args.includes('HEAD^{commit}')) {
          moved = true;
          execFileSync('git', ['update-ref', 'refs/heads/axis/fin', base], { cwd: wt });
        }
      }),
    });
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'fin' });
    wt = ws.path;
    write(path.join(wt, 'creds.txt'), `${PEM}\n`);
    sh(wt, 'add', '--', 'creds.txt');
    sh(wt, 'commit', '-q', '-m', 'secret');
    sh(wt, 'rm', '-q', '--cached', '--', 'creds.txt');
    write(path.join(wt, 'creds.txt'), 'gone\n');
    write(path.join(wt, 'a.txt'), 'dirty\n');
    const confirmation = await confirmFor(fx.manager, wt, ws.id, 'finalise');
    base = sh(fx.repo, 'rev-parse', 'HEAD').trim();
    const e = await refusal(fx.manager.finalise({ path: wt, outcome: 'archived', discardConfirmation: confirmation }));
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.equal(sh(fx.repo, 'for-each-ref', 'refs/axis/archive'), '');
  });

  it('a file changed between the hash and the re-read is a conflict, never scanned as the new bytes', async () => {
    fx = makeFixture();
    const wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'swap' })).path;
    const file = path.join(wt, 'notes.txt');
    write(file, 'x'.repeat(PEM.length) + '\n');
    snapshotTestHooks.beforeReread = (rel) => {
      if (rel === 'notes.txt') writeFileSync(file, `${PEM}\n`);
    };
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.deepEqual([e.code, e.details['reason']], ['E_CONFLICT', 'file-changed']);
  });

  it('a working file too large to scan is refused without a second read', async () => {
    fx = makeFixture({ snapshotScanner: quiet });
    const wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'big' })).path;
    write(path.join(wt, 'big.txt'), BIG);
    write(path.join(wt, 'small.txt'), 'ok\n');
    const reread: string[] = [];
    snapshotTestHooks.beforeReread = (rel) => void reread.push(rel);
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.deepEqual(e.details['findings'], [{ rule: 'scan-incomplete', path: 'big.txt' }]);
    assert.deepEqual(reread, ['small.txt']);
  });

  it('a committed blob too large to scan is refused without being read from the object store', async () => {
    const batches: string[] = [];
    fx = makeFixture({
      snapshotScanner: quiet,
      runner: hooked((args, input) => void (args.includes('--batch') && batches.push(String(input)))),
    });
    const wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'hbig' })).path;
    write(path.join(wt, 'big.txt'), BIG);
    sh(wt, 'add', '--', 'big.txt');
    sh(wt, 'commit', '-q', '-m', 'big');
    const blob = sh(wt, 'rev-parse', 'HEAD:big.txt').trim();
    const e = await refusal(fx.manager.finalise({ path: wt, outcome: 'archived' }));
    assert.deepEqual(e.details['findings'], [{ rule: 'scan-incomplete', path: 'big.txt' }]);
    assert.ok(batches.length > 0 && batches.every((b) => !b.includes(blob)), 'the big blob was never requested');
  });

  it('an object read back with a header that does not match what was asked is unscanned', async () => {
    let corrupt = false;
    fx = makeFixture({
      runner: hooked((args, _i, r) => {
        if (!corrupt || !args.includes('--batch')) return;
        const raw = Buffer.from(r.raw);
        raw[0] = raw[0] === 0x30 ? 0x31 : 0x30;
        return { ...r, raw };
      }),
    });
    const wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'hdr' })).path;
    sh(wt, 'commit', '-q', '--allow-empty', '-m', 'run');
    corrupt = true;
    const e = await refusal(fx.manager.finalise({ path: wt, outcome: 'archived' }));
    assert.equal(e.details['reason'], 'snapshot-unscanned');
  });

  it('a history over the object cap is unscanned', async () => {
    fx = makeFixture();
    const git = new HardenedGit(createExecGitRunner(), createHooksGuard(process.platform, path.join(fx.tmp, 'nohooks')));
    const base = sh(fx.repo, 'rev-parse', 'HEAD').trim();
    write(path.join(fx.repo, 'n.txt'), 'n\n');
    sh(fx.repo, 'add', '--', 'n.txt');
    sh(fx.repo, 'commit', '-q', '-m', 'n');
    const tip = sh(fx.repo, 'rev-parse', 'HEAD').trim();
    const bt = await baseTree(git, fx.repo, base);
    await scanHistory(git, fx.repo, base, tip, startSnapshotScan(quiet), quiet.limits, bt, 3);
    const e = await refusal(scanHistory(git, fx.repo, base, tip, startSnapshotScan(quiet), quiet.limits, bt, 2));
    assert.equal(e.details['reason'], 'snapshot-unscanned');
  });
});
