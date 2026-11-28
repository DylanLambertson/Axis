// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/changes/test/common/axisChanges.test.ts, the active-row and focus cases) by
// OS-5, on plain rows instead of rows read from the git extension.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { focusAfterUpdate, nextActiveIndex } from '../../src/changes/axisListFocus.js';

const rows = (...ids: string[]) => ids.map(id => ({ id }));

suite('Axis list focus', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the active row follows its id across updates, else keeps its place, else none', () => {
		const after = rows('b', 'c', 'd');
		assert.strictEqual(nextActiveIndex(after, 'c', 2), 1, 'the same row, moved up');
		assert.strictEqual(nextActiveIndex(after, 'a', 0), 0, 'a removed row: the row now in its place');
		assert.strictEqual(nextActiveIndex(after, 'gone', 9), 2, 'clamped to the last row');
		assert.strictEqual(nextActiveIndex(after, 'gone', -4), 0, 'clamped to the first row');
		assert.strictEqual(nextActiveIndex(after, undefined, 1), 1);
		assert.strictEqual(nextActiveIndex(after, 'b', 2), 0, 'the id wins over the old position');
		assert.strictEqual(nextActiveIndex([], 'a', 3), -1, 'an empty list has no active row');
	});

	test('focus outside the view is never taken', () => {
		assert.deepStrictEqual([focusAfterUpdate('outside', false, true), focusAfterUpdate('outside', false, false)], ['stay', 'stay']);
	});

	test('focus on another control (Review all) stays there and never moves to a row', () => {
		assert.strictEqual(focusAfterUpdate('control', true, true), 'stay');
		assert.strictEqual(focusAfterUpdate('control', true, false), 'stay');
	});

	test('a control hidden or disabled under focus (Try again, Review all) hands focus to the heading, not the body', () => {
		assert.strictEqual(focusAfterUpdate('control', false, true), 'heading');
		assert.strictEqual(focusAfterUpdate('control', false, false), 'heading');
	});

	test('a focused row stays on a row, or goes to the heading when the list empties', () => {
		assert.strictEqual(focusAfterUpdate('row', true, true), 'row');
		assert.strictEqual(focusAfterUpdate('row', false, true), 'row', 'the focused row left: the row now in its place');
		assert.strictEqual(focusAfterUpdate('row', false, false), 'heading');
	});
});
