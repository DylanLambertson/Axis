// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-5 review 2 (SF1): replies are read through own data only, and a result is a fresh copy of JSON-shaped data.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { AXIS_WIRE_DEPTH_LIMIT, codeOf, readReply, whenSettled, wireDataCopy } from '../../src/daemon/axisWireData.js';

const MARKER = 'PRIVATE_MARKER_FOR_REVIEW';
const INVALID = { ok: false, code: 'invalid_reply' };

function nested(depth: number): unknown {
	let v: unknown = 'leaf';
	for (let i = 0; i < depth; i++) {
		v = { v };
	}
	return v;
}

suite('Axis wire data (review 2 SF1)', () => {

	test('copies JSON-shaped data into fresh objects and arrays', () => {
		const value = { a: 1, b: 'x', c: true, d: null, e: [1, [2, { f: 3 }]], g: { h: -0.5 } };
		const out = wireDataCopy(value) as typeof value;
		assert.deepStrictEqual(out, value);
		assert.notStrictEqual(out, value);
		assert.notStrictEqual(out.e, value.e);
		assert.notStrictEqual(out.g, value.g);
		const bare = Object.assign(Object.create(null), { k: 1 }) as object;
		assert.deepStrictEqual(wireDataCopy(bare), { k: 1 }, 'a null-prototype object is plain data');
		assert.strictEqual(wireDataCopy(7), 7);
		assert.strictEqual(wireDataCopy(undefined), undefined);
	});

	test('keeps a __proto__ key as a plain field', () => {
		const value = JSON.parse('{"__proto__":{"polluted":true},"x":1}') as object;
		const out = wireDataCopy(value) as Record<string, unknown>;
		assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
		assert.deepStrictEqual(Object.getOwnPropertyDescriptor(out, '__proto__')?.value, { polluted: true });
		assert.strictEqual((out as { polluted?: unknown }).polluted, undefined);
	});

	test('refuses accessors at any depth without running them', () => {
		let reads = 0;
		const getter = { get v(): number { reads++; return 1; } };
		assert.throws(() => wireDataCopy(getter));
		assert.throws(() => wireDataCopy({ a: [getter] }));
		const arr = [1, 2];
		Object.defineProperty(arr, 1, { get() { reads++; return 2; }, enumerable: true });
		assert.throws(() => wireDataCopy(arr));
		assert.strictEqual(reads, 0);
	});

	test('refuses what is not JSON data: functions, symbols, bigints, class instances, cycles and deep nesting', () => {
		for (const bad of [() => 1, Symbol('s'), 1n, new Date(0), new Map(), { f: () => 1 }]) {
			assert.throws(() => wireDataCopy(bad), `${String(typeof bad)} refused`);
		}
		const cycle: Record<string, unknown> = {};
		cycle['self'] = cycle;
		assert.throws(() => wireDataCopy(cycle), 'a cycle runs into the depth limit');
		class Sub extends Array {}
		assert.throws(() => wireDataCopy(new Sub()), 'an array with another prototype');
		assert.doesNotThrow(() => wireDataCopy(nested(AXIS_WIRE_DEPTH_LIMIT)), 'up to the limit of nested containers');
		assert.throws(() => wireDataCopy(nested(AXIS_WIRE_DEPTH_LIMIT + 1)));
		const shared = { s: 1 };
		assert.deepStrictEqual(wireDataCopy([shared, shared]), [{ s: 1 }, { s: 1 }], 'a repeated (not cyclic) object is fine');
	});

	test('readReply reads own data only and never throws', () => {
		assert.deepStrictEqual(readReply({ ok: true, result: { x: 1 } }), { ok: true, result: { x: 1 } });
		assert.deepStrictEqual(readReply({ ok: true, result: undefined }), { ok: true, result: undefined }, 'an own result, even undefined');
		assert.deepStrictEqual(readReply({ ok: true }), INVALID, 'ok without a result');
		const inherited = Object.assign(Object.create({ result: 42 }) as object, { ok: true });
		assert.deepStrictEqual(readReply(inherited), INVALID, 'an own ok with an inherited result');
		assert.deepStrictEqual(readReply({ ok: false, error: { code: 'E_TIMEOUT' } }), { ok: false, code: 'E_TIMEOUT' });
		assert.deepStrictEqual(readReply({ ok: false }), { ok: false, code: undefined });
		for (const bad of [undefined, null, 5, 'ok', { ok: 'true' }, { result: 1 }, Object.create({ ok: true, result: 1 })]) {
			assert.deepStrictEqual(readReply(bad), INVALID);
		}
		assert.deepStrictEqual(readReply({ ok: false, get error(): unknown { throw new Error(MARKER); } }), INVALID);
		assert.deepStrictEqual(readReply({ ok: true, result: { get then(): unknown { throw new Error(MARKER); } } }), INVALID);
		const trap = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error(MARKER); } });
		assert.deepStrictEqual(readReply(trap), INVALID);
		const fieldTrap = new Proxy({ a: 1 }, { getOwnPropertyDescriptor: () => { throw new Error(MARKER); } });
		assert.deepStrictEqual(readReply({ ok: true, result: fieldTrap }), INVALID);
		const keysTrap = new Proxy({}, { ownKeys: () => { throw new Error(MARKER); } });
		assert.deepStrictEqual(readReply({ ok: true, result: keysTrap }), INVALID);
		const proto = new Proxy({}, { getPrototypeOf: () => { throw new Error(MARKER); } });
		assert.deepStrictEqual(readReply({ ok: true, result: proto }), INVALID);
	});

	test('codeOf reads an own data code only', () => {
		let reads = 0;
		assert.strictEqual(codeOf({ code: 'E_TIMEOUT' }), 'E_TIMEOUT');
		assert.strictEqual(codeOf({ get code(): string { reads++; return 'E_TIMEOUT'; } }), undefined);
		assert.strictEqual(codeOf(Object.create({ code: 'E_TIMEOUT' })), undefined);
		assert.strictEqual(codeOf(new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error(MARKER); } })), undefined);
		assert.strictEqual(codeOf('E_TIMEOUT'), undefined);
		assert.strictEqual(reads, 0);
	});

	test('whenSettled turns a throwing then getter into a rejection, and passes plain values through', async () => {
		const hostile = Object.defineProperty(Promise.resolve(1), 'then', { get() { throw new Error(MARKER); } });
		const seen = await new Promise<string>(done => whenSettled(hostile, () => done('value'), e => done(`error:${(e as Error).message}`)));
		assert.strictEqual(seen, `error:${MARKER}`, 'the caller decides how to close it');
		assert.strictEqual(await new Promise(done => whenSettled(Promise.resolve(2), done, done)), 2);
		assert.strictEqual(await new Promise(done => whenSettled(3, done, done)), 3);
		assert.doesNotThrow(() => whenSettled(hostile, () => {}, () => {}), 'never throws in the caller');
	});
});
