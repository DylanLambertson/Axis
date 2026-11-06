// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecretScanner, PatchReader, unquotePath } from '@axis/secret-scan';
import { WorktreeError } from '../src/index.js';
import { binaryViews, entryPatches, isBinary, quotePath, startSnapshotScan, type SnapshotScanner } from '../src/snapshotScan.js';

const PEM = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----';
const TOKEN = ['gh', 'p_'].join('') + 'Ab1'.repeat(12);
const LIMITS = { maxBinaryBytes: 10, maxBytes: 1 << 20 };

/** The path the scanner's own reader takes from a patch: what a finding would name. */
function readerPath(text: string): string | undefined {
  const r = new PatchReader();
  for (const line of text.split('\n')) {
    const ev = r.read(line);
    if (ev?.t === 'file') return ev.path;
  }
  return undefined;
}

function texts(rel: string, bytes: Buffer, limits = LIMITS, mode: '100644' | '100755' | '120000' = '100644'): string[] {
  const p = entryPatches({ rel, mode, bytes }, limits);
  assert.notEqual(p, 'too-large');
  return (p as { texts: string[] }).texts;
}

async function refusal(f: () => unknown): Promise<WorktreeError> {
  try {
    await f();
  } catch (e) {
    assert.ok(e instanceof WorktreeError);
    return e;
  }
  return assert.fail('not refused');
}

describe('entry patches for the scanner', () => {
  it('quotes names git would quote, and the scanner reads every one back exactly', () => {
    for (const rel of ['plain.txt', 'with space/x y', 'tab\there', 'new\nline', 'quote"d', 'back\\slash', 'bell\x07', 'café/日本', 'ends with b/ b/x']) {
      const q = quotePath(`b/${rel}`);
      assert.equal(unquotePath(q).slice(2), rel, rel);
      assert.ok(!q.includes('\n') && !q.includes('\t'), rel);
      assert.equal(readerPath(texts(rel, Buffer.from('x\n'))[0] as string), rel, rel);
    }
    assert.equal(quotePath('b/plain'), 'b/plain');
    assert.equal(quotePath('b/a\x01'), '"b/a\\001"');
  });

  it('writes one added line per content line, with the hunk count the scanner trusts', () => {
    assert.deepEqual(texts('f', Buffer.from('a\n\nb\r\nc'), LIMITS, '100755'), [
      ['diff --git a/f b/f', 'new file mode 100755', '--- /dev/null', '+++ b/f', '@@ -0,0 +1,4 @@', '+a', '+', '+b\r', '+c', ''].join('\n'),
    ]);
    assert.equal(texts('e', Buffer.alloc(0))[0]?.includes('@@'), false);
  });

  it('marks a binary over the budget instead of sending its bytes', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x41]);
    assert.equal(isBinary(bytes), true);
    assert.equal(isBinary(Buffer.concat([Buffer.alloc(8000, 0x41), Buffer.from([0])])), false, 'only the first 8000 bytes decide');
    const big = texts('b.bin', bytes, { maxBinaryBytes: 3, maxBytes: 1 << 20 });
    assert.equal(big.length, 1);
    assert.match(big[0] as string, /^Binary files \/dev\/null and b\/b\.bin differ$/m);
    assert.doesNotMatch(big[0] as string, /^\+A$/m);
    assert.match(texts('b.bin', bytes, { maxBinaryBytes: 4, maxBytes: 1 << 20 })[0] as string, /^@@ -0,0 \+1,2 @@\n\+\x00\xff\n\+A\n$/m);
  });

  it('a symlink target is text', () => {
    assert.match(texts('l', Buffer.from('../t'), { maxBinaryBytes: 1, maxBytes: 1 << 20 }, '120000')[0] as string, /^\+\.\.\/t$/m);
  });

  it('text over the byte cap is too large before it is split: by bytes, and by decoded length', () => {
    assert.equal(entryPatches({ rel: 'x', mode: '100644', bytes: Buffer.alloc(41, 0x41) }, { maxBinaryBytes: 1, maxBytes: 10 }), 'too-large');
    assert.equal(entryPatches({ rel: 'x', mode: '100644', bytes: Buffer.alloc(11, 0x41) }, { maxBinaryBytes: 1, maxBytes: 10 }), 'too-large');
    assert.notEqual(entryPatches({ rel: 'x', mode: '100644', bytes: Buffer.from('é'.repeat(10)) }, { maxBinaryBytes: 1, maxBytes: 10 }), 'too-large');
  });

  it('the real scanner finds a secret on the right line of an entry patch', async () => {
    const found = await createSecretScanner().scan(texts('n.txt', Buffer.from(`a\nb\n${PEM}\n`))[0] as string, { part: 'patch' });
    assert.deepEqual(found, [{ rule: 'private-key-block', path: 'n.txt', line: 3 }]);
  });
});

describe('UTF-16 and other NUL-bearing text', () => {
  const text = `x\n${PEM}\n${TOKEN}\n`;
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.from(le).swap16();
  const bom = (b: Buffer, mark: number[]): Buffer => Buffer.concat([Buffer.from(mark), b]);
  for (const [name, bytes] of [
    ['UTF-16LE', le], ['UTF-16LE with BOM', bom(le, [0xff, 0xfe])], ['UTF-16BE', be], ['UTF-16BE with BOM', bom(be, [0xfe, 0xff])],
    ['UTF-32LE', Buffer.from([...text].flatMap((c) => [c.charCodeAt(0), 0, 0, 0]))],
  ] as const) {
    it(`a secret in ${name} is found and refuses`, async () => {
      const check = startSnapshotScan(createSecretScanner());
      await check.add({ rel: 'out.txt', mode: '100644', bytes });
      const e = await refusal(() => check.finish());
      assert.equal(e.details['reason'], 'snapshot-secret');
      const rules = new Set((e.details['findings'] as { rule: string }[]).map((f) => f.rule));
      assert.ok(rules.has('private-key-block') && rules.has('github-token'), [...rules].join());
    });
  }

  it('non-ASCII UTF-16 text is decoded in both byte orders', () => {
    const t = 'clé=日本';
    const views = binaryViews(Buffer.from(t, 'utf16le'));
    assert.ok(views.includes(t));
    assert.ok(binaryViews(Buffer.from(Buffer.from(t, 'utf16le')).swap16()).includes(t));
  });
});

describe('the scan of one snapshot', () => {
  it('refuses once its whole-snapshot time is spent, and a NaN clock counts as spent', async () => {
    let t = 0;
    const s: SnapshotScanner = { limits: LIMITS, scan: async () => [] };
    const check = startSnapshotScan(s, () => t, 100);
    await check.add({ rel: 'a', mode: '100644', bytes: Buffer.from('x') });
    t = 100;
    await check.add({ rel: 'b', mode: '100644', bytes: Buffer.from('x') });
    t = 101;
    assert.equal((await refusal(() => check.add({ rel: 'c', mode: '100644', bytes: Buffer.from('x') }))).details['reason'], 'snapshot-unscanned');
    t = Number.NaN;
    assert.equal((await refusal(() => check.addMessage('0'.repeat(40), 'm'))).details['reason'], 'snapshot-unscanned');
    check.finish();
  });

  it('an answer whose getters throw the content back is unscanned and keeps nothing', async () => {
    const s: SnapshotScanner = {
      limits: LIMITS,
      scan: async (text) => [{ get rule(): string { throw new Error(text); } } as never],
    };
    const e = await refusal(() => startSnapshotScan(s).add({ rel: 'a', mode: '100644', bytes: Buffer.from(TOKEN) }));
    assert.equal(e.details['reason'], 'snapshot-unscanned');
    assert.ok(!JSON.stringify([e.message, e.details, e.stack]).includes(TOKEN));
  });

  it('a commit message is scanned as a message and names its commit, and an over-long one is unscanned', async () => {
    const seen: string[] = [];
    const real = createSecretScanner({ maxBytes: 64 });
    const s: SnapshotScanner = { limits: real.limits, scan: (t, m) => (seen.push(m.part), real.scan(t, m)) };
    const check = startSnapshotScan(s);
    await check.addMessage('a'.repeat(40), `wip\n${PEM}\n`);
    await check.addMessage('b'.repeat(40), 'x'.repeat(65));
    assert.deepEqual(seen, ['message']);
    const e = await refusal(() => check.finish());
    assert.deepEqual(e.details['findings'], [{ rule: 'private-key-block', line: 2, commit: 'a'.repeat(40) }, { rule: 'scan-incomplete', commit: 'b'.repeat(40) }]);
  });
});
