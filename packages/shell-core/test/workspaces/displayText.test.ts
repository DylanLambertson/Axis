// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The display-text rules (from the legacy overlay's worktreeDiscovery tests, "names and ids fit the contract rules").
import assert from 'node:assert';
import { suite, test } from 'node:test';
import { clampText, cleanDisplayText, displayName } from '../../src/workspaces/displayText.js';

suite('Axis display text', () => {

	test('names fit the contract rules', () => {
		assert.strictEqual(displayName('  fix\u200B-login\u0007 '), 'fix-login');
		assert.strictEqual(displayName(''), 'unnamed');
		assert.strictEqual(displayName('\u202E'), 'unnamed');
		assert.strictEqual(displayName('x'.repeat(200)).length, 80);
		assert.strictEqual(displayName('a\uE000'), 'a\uFFFD');
	});

	test('clamping counts code points and ends with an ellipsis', () => {
		assert.strictEqual(clampText('abc', 3), 'abc');
		assert.strictEqual(clampText('abcd', 3), 'ab\u2026');
		assert.strictEqual(clampText('\u{1F600}\u{1F600}\u{1F600}', 3), '\u{1F600}\u{1F600}\u{1F600}');
		assert.strictEqual(clampText('\u{1F600}'.repeat(4), 3), '\u{1F600}\u{1F600}\u2026');
	});

	test('display text shows unsafe characters as U+FFFD and cuts mark runs to two', () => {
		assert.strictEqual(cleanDisplayText('a\u202Eb\u0007c', 10), 'a\uFFFDb\uFFFDc');
		assert.strictEqual(cleanDisplayText('\u3164\u2800', 10), '\uFFFD\uFFFD');
		assert.strictEqual(cleanDisplayText('e\u0301\u0302\u0303\u0304', 10), 'e\u0301\u0302');
		assert.strictEqual(cleanDisplayText('abcdef', 4), 'abc\u2026');
	});
});
