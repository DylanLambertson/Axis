// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecretScanner, PatchReader, unquotePath } from '@axis/secret-scan';
import { entryPatch, isBinary, quotePath } from '../src/snapshotScan.js';

const PEM = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----';

/** The path the scanner's own reader takes from a patch: what a finding would name. */
function readerPath(text: string): string | undefined {
  const r = new PatchReader();
  for (const line of text.split('\n')) {
    const ev = r.read(line);
    if (ev?.t === 'file') return ev.path;
  }
  return undefined;
}

describe('entry patches for the scanner', () => {
  it('quotes names git would quote, and the scanner reads every one back exactly', () => {
    for (const rel of ['plain.txt', 'with space/x y', 'tab\there', 'new\nline', 'quote"d', 'back\\slash', 'bell\x07', 'café/日本', 'ends with b/ b/x']) {
      const q = quotePath(`b/${rel}`);
      assert.equal(unquotePath(q).slice(2), rel, rel);
      assert.ok(!q.includes('\n') && !q.includes('\t'), rel);
      assert.equal(readerPath(entryPatch({ rel, mode: '100644', bytes: Buffer.from('x\n') }, 10).text), rel, rel);
    }
    assert.equal(quotePath('b/plain'), 'b/plain');
    assert.equal(quotePath('b/a\x01'), '"b/a\\001"');
  });

  it('writes one added line per content line, with the hunk count the scanner trusts', () => {
    const { text, binary } = entryPatch({ rel: 'f', mode: '100755', bytes: Buffer.from('a\n\nb\r\nc') }, 10);
    assert.equal(binary, false);
    assert.equal(text, ['diff --git a/f b/f', 'new file mode 100755', '--- /dev/null', '+++ b/f', '@@ -0,0 +1,4 @@', '+a', '+', '+b\r', '+c', ''].join('\n'));
    assert.equal(entryPatch({ rel: 'e', mode: '100644', bytes: Buffer.alloc(0) }, 10).text.includes('@@'), false);
  });

  it('marks a binary over the budget instead of sending its bytes, and keeps one character per byte below it', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x41]);
    assert.equal(isBinary(bytes), true);
    assert.equal(isBinary(Buffer.concat([Buffer.alloc(8000, 0x41), Buffer.from([0])])), false, 'only the first 8000 bytes decide');
    const big = entryPatch({ rel: 'b.bin', mode: '100644', bytes }, 3);
    assert.equal(big.binary, true);
    assert.match(big.text, /^Binary files \/dev\/null and b\/b\.bin differ$/m);
    assert.doesNotMatch(big.text, /^\+A$/m);
    const small = entryPatch({ rel: 'b.bin', mode: '100644', bytes }, 4);
    assert.match(small.text, /^@@ -0,0 \+1,2 @@\n\+\x00\xff\n\+A\n$/m);
  });

  it('a symlink target is text even when it holds a NUL-free odd byte', () => {
    const p = entryPatch({ rel: 'l', mode: '120000', bytes: Buffer.from('../t') }, 1);
    assert.equal(p.binary, false);
    assert.match(p.text, /^\+\.\.\/t$/m);
  });

  it('the real scanner finds a secret on the right line of an entry patch', async () => {
    const s = createSecretScanner();
    const found = await s.scan(entryPatch({ rel: 'n.txt', mode: '100644', bytes: Buffer.from(`a\nb\n${PEM}\n`) }, 10).text, { part: 'patch' });
    assert.deepEqual(found, [{ rule: 'private-key-block', path: 'n.txt', line: 3 }]);
  });
});
