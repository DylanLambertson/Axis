// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REF-1 (docs/design/snapshot-scan.md): a snapshot whose added entries hold a secret pattern, or cannot be scanned, is
// refused before any object or ref is written, and nothing of the content reaches the error.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createSecretScanner } from '@axis/secret-scan';
import { WorktreeError, type SnapshotScanner } from '../src/index.js';
import { makeFixture, sh, write, type Fixture } from './helpers.js';

// Built at run time so no secret pattern sits in this file.
const PEM = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----';
const TOKEN_NAME = ['gh', 'p_'].join('') + 'Ab1'.repeat(12);

/** True when the repository's object store holds `content` as a blob. */
function hasBlob(repo: string, content: string | Buffer): boolean {
  const id = execFileSync('git', ['hash-object', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['cat-file', '-e', id], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const backupRefs = (repo: string): string => sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/axis/backup');

/** Everything a caller or a log could see of the error. */
const visible = (e: WorktreeError): string => JSON.stringify({ m: e.message, d: e.details, s: e.stack });

async function refusal(p: Promise<unknown>): Promise<WorktreeError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof WorktreeError, 'a WorktreeError');
    return e;
  }
  assert.fail('the snapshot was written');
}

/** A real scanner that also records what it was asked. */
function recording(inner: SnapshotScanner = createSecretScanner()): SnapshotScanner & { calls: { text: string; binaryPaths?: readonly string[] }[] } {
  const calls: { text: string; binaryPaths?: readonly string[] }[] = [];
  return {
    calls,
    limits: inner.limits,
    scan: (text, meta) => {
      calls.push({ text, ...(meta.binaryPaths === undefined ? {} : { binaryPaths: meta.binaryPaths }) });
      return inner.scan(text, meta);
    },
  };
}

describe('snapshot secret scan (REF-1)', () => {
  let fx: Fixture;
  afterEach(() => fx.cleanup());

  async function workspace(extra: Parameters<typeof makeFixture>[0] = {}): Promise<string> {
    fx = makeFixture(extra);
    return (await fx.manager.create({ repoPath: fx.repo, slug: 'scan' })).path;
  }

  it('refuses a backup holding a planted secret in an untracked file: no ref, no blob, the file is not restored', async () => {
    const wt = await workspace();
    const planted = `first\nsecond\n${PEM}\n`;
    write(path.join(wt, 'notes.txt'), planted);
    write(path.join(wt, 'a.txt'), 'clobbered\n');
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.code, 'E_POLICY_DENIED');
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.deepEqual(e.details['findings'], [{ rule: 'private-key-block', line: 3, path: 'notes.txt' }]);
    assert.equal(e.details['count'], 1);
    assert.equal(backupRefs(fx.repo), '');
    assert.equal(hasBlob(fx.repo, planted), false);
    assert.equal(hasBlob(fx.repo, 'clobbered\n'), false, 'no blob of the snapshot is written before the scan passes');
    assert.equal(readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'clobbered\n', 'nothing was restored');
    assert.ok(!visible(e).includes('BEGIN'));
  });

  it('scans a changed tracked file, and skips content unchanged since the base (a committed secret does not block)', async () => {
    const scanner = recording();
    fx = makeFixture({ snapshotScanner: scanner });
    write(path.join(fx.repo, 'fixture.pem'), `${PEM}\n`);
    sh(fx.repo, 'add', '-A');
    sh(fx.repo, 'commit', '-q', '-m', 'fixture');
    const wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'scan' })).path;
    assert.equal(scanner.calls.length, 0, 'a fresh run base adds nothing to scan');
    write(path.join(wt, 'a.txt'), 'changed\n');
    const r = await fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') });
    assert.ok(r.backupRef.startsWith('refs/axis/backup/'));
    assert.equal(scanner.calls.length, 1);
    assert.match(scanner.calls[0]?.text ?? '', /^\+\+\+ b\/a\.txt$/m);
    write(path.join(wt, 'sub', 'b.txt'), `bravo\n${PEM}\n`);
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.deepEqual(e.details['findings'], [{ rule: 'private-key-block', line: 2, path: 'sub/b.txt' }]);
  });

  it('a run base adds nothing to scan even with a scanner that finds everything', async () => {
    const always: SnapshotScanner = { limits: { maxBinaryBytes: 1, maxBytes: 1 << 20 }, scan: async () => [{ rule: 'jwt', line: 1 }] };
    const wt = await workspace({ snapshotScanner: always });
    write(path.join(wt, 'new.txt'), 'harmless\n');
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.deepEqual(e.details['findings'], [{ rule: 'jwt', line: 1, path: 'new.txt' }]);
  });

  it('refuses with the default scanner when none is passed', async () => {
    const wt = await workspace();
    write(path.join(wt, 'deep', 'cfg.txt'), `x\n${PEM}\n`);
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.details['reason'], 'snapshot-secret');
  });

  it('scans a small binary as binary content and refuses a large one as unscanned', async () => {
    const scanner = recording();
    const wt = await workspace({ snapshotScanner: scanner });
    const small = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${PEM}\n`)]);
    write(path.join(wt, 'small.bin'), small);
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.deepEqual(e.details['findings'], [{ rule: 'private-key-block', line: 2, path: 'small.bin' }]);
    assert.deepEqual(scanner.calls.map((c) => c.binaryPaths), Array(4).fill(['small.bin']), 'four views, all as binary');
    sh(wt, 'clean', '-fq');
    const large = Buffer.alloc(scanner.limits.maxBinaryBytes + 1);
    write(path.join(wt, 'large.bin'), large);
    const u = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(u.details['reason'], 'snapshot-unscanned');
    assert.deepEqual(u.details['findings'], [{ rule: 'binary-unscanned', path: 'large.bin' }]);
    assert.equal(hasBlob(fx.repo, large), false);
    assert.equal(backupRefs(fx.repo), '');
  });

  it('a token in a file name refuses without the name in any finding', async () => {
    const wt = await workspace();
    write(path.join(wt, `${TOKEN_NAME}.txt`), 'plain\n');
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.details['reason'], 'snapshot-secret');
    assert.deepEqual(e.details['findings'], [{ rule: 'github-token' }]);
    assert.ok(!visible(e).includes(TOKEN_NAME));
  });

  it('a symlink target is scanned like content', async (t) => {
    const wt = await workspace();
    try {
      symlinkSync(`x/${TOKEN_NAME}`, path.join(wt, 'link'));
    } catch {
      t.skip('symlinks are not available here');
      return;
    }
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.deepEqual(e.details['findings'], [{ rule: 'github-token', line: 1, path: 'link' }]);
    assert.ok(!visible(e).includes(TOKEN_NAME));
  });

  it('a text file too large for one scan is refused as unscanned, and is never sent to the scanner', async () => {
    const real = createSecretScanner({ maxBytes: 200, maxBinaryBytes: 100 });
    const scanner = recording(real);
    const wt = await workspace({ snapshotScanner: scanner });
    write(path.join(wt, 'big.txt'), 'word '.repeat(200));
    write(path.join(wt, 'small.txt'), 'ok\n');
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal(e.details['reason'], 'snapshot-unscanned');
    assert.deepEqual(e.details['findings'], [{ rule: 'scan-incomplete', path: 'big.txt' }]);
    assert.equal(scanner.calls.length, 1);
    assert.match(scanner.calls[0]?.text ?? '', /small\.txt/);
  });

  it('keeps 50 findings and counts the rest', async () => {
    const wt = await workspace();
    write(path.join(wt, 'many.txt'), `${PEM}\n`.repeat(60));
    const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
    assert.equal((e.details['findings'] as unknown[]).length, 50);
    assert.equal(e.details['count'], 60);
  });

  for (const [name, scanner] of [
    ['a scanner that throws the content back', { limits: { maxBinaryBytes: 10, maxBytes: 1 << 20 }, scan: async (t: string) => { throw new Error(t); } }],
    ['a scanner that answers no list', { limits: { maxBinaryBytes: 10, maxBytes: 1 << 20 }, scan: async () => ({ ok: true }) }],
    ['a refuse-mode scanner over its byte cap', createSecretScanner({ maxBytes: 16 })],
    ['a warn-mode scanner over its byte cap', createSecretScanner({ mode: 'warn', maxBytes: 16 })],
  ] as const) {
    it(`refuses as unscanned with ${name}, and keeps nothing it said`, async () => {
      const wt = await workspace({ snapshotScanner: scanner as unknown as SnapshotScanner });
      write(path.join(wt, 'notes.txt'), `${'plain words '.repeat(4)}\n${TOKEN_NAME}\n`);
      const e = await refusal(fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') }));
      assert.equal(e.code, 'E_POLICY_DENIED');
      assert.equal(e.details['reason'], 'snapshot-unscanned');
      assert.equal(e.message, 'the snapshot was refused: its content could not be fully scanned for secrets');
      assert.ok(!visible(e).includes(TOKEN_NAME) && !visible(e).includes('plain words'));
      assert.equal(backupRefs(fx.repo), '');
    });
  }
});

describe('a malformed scanner', () => {
  let fx: Fixture;
  afterEach(() => fx.cleanup());

  for (const [name, scanner] of [
    ['no scan function', { limits: { maxBinaryBytes: 10 } }],
    ['no limits', { scan: async () => [] }],
    ['no byte cap', { scan: async () => [], limits: { maxBinaryBytes: 10 } }],
  ] as const) {
    it(`with ${name} refuses even a run base, and the create rolls back`, async () => {
      fx = makeFixture({ snapshotScanner: scanner as unknown as SnapshotScanner });
      const e = await refusal(fx.manager.create({ repoPath: fx.repo, slug: 'bad' }));
      assert.equal(e.details['reason'], 'snapshot-unscanned');
      assert.equal(sh(fx.repo, 'for-each-ref', '--format=%(refname)', 'refs/axis', 'refs/heads/axis'), '');
    });
  }
});

describe('snapshot scan without a workspace', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('a clean change still writes its backup', async () => {
    const wt = (await fx.manager.create({ repoPath: fx.repo, slug: 'clean' })).path;
    write(path.join(wt, 'new.txt'), 'nothing secret here\n');
    write(path.join(wt, 'a.txt'), 'changed\n');
    const r = await fx.manager.restoreFromRunBase({ path: path.join(wt, 'a.txt') });
    assert.equal(sh(fx.repo, 'show', `${r.backupRef}:new.txt`), 'nothing secret here\n');
  });
});
