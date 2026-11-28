// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-5 review B2: the emitter's delivery matches the pinned Code OSS emitter (2c33b50b) under disposal and reentrancy.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { Emitter, setUnexpectedErrorHandler } from '../../src/base/event.js';
import { type IDisposable } from '../../src/base/lifecycle.js';

suite('Axis emitter delivery (review B2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a listener removed by an earlier listener during delivery is not called', () => {
		const emitter = new Emitter<string>();
		const seen: string[] = [];
		let b: IDisposable | undefined;
		const a = emitter.event(() => b?.dispose());
		b = emitter.event(e => seen.push(`b:${e}`));
		emitter.fire('after-dispose');
		assert.deepStrictEqual(seen, [], 'Code OSS calls B zero times');
		emitter.fire('again');
		assert.deepStrictEqual(seen, []);
		a.dispose();
		emitter.dispose();
	});

	test('a listener that disposes itself is not called again, and later listeners still are', () => {
		const emitter = new Emitter<number>();
		const seen: string[] = [];
		const self: IDisposable = emitter.event(e => { seen.push(`a${e}`); self.dispose(); });
		const other = emitter.event(e => seen.push(`b${e}`));
		emitter.fire(1);
		emitter.fire(2);
		assert.deepStrictEqual(seen, ['a1', 'b1', 'b2']);
		other.dispose();
		emitter.dispose();
	});

	test('disposing the emitter during delivery stops the rest of it, and later fires deliver nothing', () => {
		const emitter = new Emitter<string>();
		const seen: string[] = [];
		const a = emitter.event(() => emitter.dispose());
		const b = emitter.event(e => seen.push(e));
		emitter.fire('x');
		emitter.fire('y');
		assert.deepStrictEqual(seen, []);
		assert.strictEqual(emitter.hasListeners(), false);
		a.dispose();
		b.dispose();
	});

	test('a fire from inside a listener first finishes the delivery in progress: every listener sees the events in order', () => {
		const emitter = new Emitter<string>();
		const a: string[] = [];
		const b: string[] = [];
		const subA = emitter.event(e => { a.push(e); if (e === 'ready') emitter.fire('connecting'); });
		const subB = emitter.event(e => b.push(e));
		emitter.fire('ready');
		assert.deepStrictEqual(b, ['ready', 'connecting'], 'Code OSS order; the old emitter gave [connecting, ready]');
		assert.deepStrictEqual(a, ['ready', 'connecting']);
		subA.dispose();
		subB.dispose();
		emitter.dispose();
	});

	test('a listener added during delivery waits for the next fire', () => {
		const emitter = new Emitter<number>();
		const seen: number[] = [];
		let late: IDisposable | undefined;
		const a = emitter.event(() => { late ??= emitter.event(e => seen.push(e)); });
		emitter.fire(1);
		emitter.fire(2);
		assert.deepStrictEqual(seen, [2]);
		a.dispose();
		late?.dispose();
		emitter.dispose();
	});

	test('a throwing listener is reported once and does not stop the others, also in a nested fire', () => {
		const errors: unknown[] = [];
		const previous = setUnexpectedErrorHandler(e => errors.push(e));
		try {
			const emitter = new Emitter<string>();
			const seen: string[] = [];
			const a = emitter.event(e => { if (e === 'one') { emitter.fire('two'); throw new Error('boom'); } });
			const b = emitter.event(e => seen.push(e));
			emitter.fire('one');
			assert.deepStrictEqual(seen, ['one', 'two']);
			assert.strictEqual(errors.length, 1);
			a.dispose();
			b.dispose();
			emitter.dispose();
		} finally {
			setUnexpectedErrorHandler(previous);
		}
	});
});
