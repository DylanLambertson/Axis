/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { fileRowText, MAX_TREE_NAME, MAX_TREE_TITLE } from '../../common/axisFileTreeText.js';

/** Characters that must never reach the screen from a file name: controls (newline included), format and bidi controls, separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

suite('Axis Files tree row text', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a plain name is shown as is; a folder says so in its accessible name', () => {
		assert.deepStrictEqual(fileRowText('login.ts', false), { name: 'login.ts', label: 'login.ts', title: 'login.ts' });
		assert.deepStrictEqual(fileRowText('src', true), { name: 'src', label: 'src, folder', title: 'src' });
	});

	test('a right-to-left override cannot reverse a name ("invoiceexe.pdf")', () => {
		const text = fileRowText('invoice\u202Efdp.exe', false);
		assert.deepStrictEqual(text, { name: 'invoice\uFFFDfdp.exe', label: 'invoice\uFFFDfdp.exe', title: 'invoice\uFFFDfdp.exe' });
	});

	const HOSTILE: [string, string][] = [
		['newline', 'line\nbreak.txt'],
		['carriage return and tab', 'x\r\t.ts'],
		['NUL and escape', 'n\u0000\u001b[31mred.ts'],
		['C1 control', 'c1\u0085next.ts'],
		['bidi isolates and marks', '\u2066a\u2069\u200F\u200E.ts'],
		['zero-width and BOM', 'z\u200B\u200C\u200D\uFEFF.ts'],
		['line and paragraph separators', 'l\u2028p\u2029.ts'],
		['letters that draw nothing', '\u3164\u115F\u2800.ts'],
		['private use', 'p\uE000.ts'],
	];

	for (const [what, name] of HOSTILE) {
		test(`${what}: no unsafe character in the text, label or title, and a visible replacement`, () => {
			for (const isDirectory of [false, true]) {
				const text = fileRowText(name, isDirectory);
				for (const value of [text.name, text.label, text.title]) {
					assert.ok(!UNSAFE.test(value), `${JSON.stringify(value)} is shown as is`);
					assert.ok(value.includes('\uFFFD'), 'a replaced character stays visible');
				}
				assert.ok(text.label.startsWith(text.name), 'the accessible name starts with the cleaned name');
			}
		});
	}

	test('cleaning is lossy on purpose: invisible differences show the same visible marker', () => {
		// A deliberate decision (Files tree review 1): each hidden character leaves a visible U+FFFD, so two names that
		// differ only in which invisible character they hide look alike, and neither hides a different file.
		const zwsp = fileRowText('a\u200Bb', false).name;
		assert.strictEqual(zwsp, fileRowText('a\u200Cb', false).name);
		assert.strictEqual(zwsp, fileRowText('a\u00ADb', false).name);
		assert.strictEqual(zwsp, 'a\uFFFDb');
	});

	test('very long names are clamped on code points, the title a little longer', () => {
		const long = 'n'.repeat(10_000);
		const text = fileRowText(long, false);
		assert.strictEqual([...text.name].length, MAX_TREE_NAME);
		assert.ok(text.name.endsWith('\u2026'));
		assert.strictEqual([...text.title].length, MAX_TREE_TITLE);
		assert.strictEqual(fileRowText('n'.repeat(MAX_TREE_NAME), false).name, 'n'.repeat(MAX_TREE_NAME), 'a name that fits is not cut');
		const astral = fileRowText('\u{1F600}'.repeat(500), false);
		assert.strictEqual([...astral.name].length, MAX_TREE_NAME, 'cut on code points, never inside a surrogate pair');
	});
});
