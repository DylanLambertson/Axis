// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-5 review B2 and S2 (and review 2 SF1) through the reconnecting client: nested status changes reach a listener in
// order, and a call that throws, or an error or answer whose fields throw, settles once with a closed code and leaves
// nothing pending; no getter, inherited field or `then` of what the connection returns is run.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { AxisDaemonCallError, sanitizeStatus, type AxisDaemonStatus } from '../../src/daemon/axisDaemonClient.js';
import { AXIS_STABLE_AFTER_MS, AxisReconnectingDaemonClient, type IAxisConnectedClient } from '../../src/daemon/axisDaemonReconnect.js';

const MARKER = 'PRIVATE_MARKER_FOR_REVIEW';
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function timers() {
	let next = 1;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	return {
		set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; },
		clear: (h: unknown) => void pending.delete(h as number),
		run: (ms: number) => { for (const [id, t] of [...pending]) { if (t.ms === ms) { pending.delete(id); t.fn(); } } },
	};
}

/** A client whose non-audit calls do what `call` says. */
function connected(call: () => unknown): IAxisConnectedClient {
	return {
		call: (contract) => (contract === 'axis.audit' ? Promise.resolve({ ok: true, result: { degraded: null } }) : call()) as ReturnType<IAxisConnectedClient['call']>,
		close: () => {},
	};
}

async function readyClient(c: IAxisConnectedClient) {
	const t = timers();
	const connects: Array<{ resolve: (c: IAxisConnectedClient) => void; onClose: () => void }> = [];
	const client = new AxisReconnectingDaemonClient({ connect: onClose => new Promise(resolve => void connects.push({ resolve, onClose })), timers: t, random: () => 0.5 });
	connects[0]!.resolve(c);
	await flush();
	assert.strictEqual(client.status.kind, 'ready');
	return { client, t, connects, pendingSize: () => (client as unknown as { pending: Set<unknown> }).pending.size };
}

async function closedCode(p: Promise<unknown>): Promise<string> {
	const e = await rejection(p);
	assert.ok(e instanceof AxisDaemonCallError, `a closed error, not ${String(e)}`);
	assert.ok(!String((e as Error).message).includes(MARKER) && (e as Error).cause === undefined);
	return (e as AxisDaemonCallError).code;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (e) {
		return e;
	}
	assert.fail('expected a rejection');
}

suite('Axis reconnecting client boundaries (review B2, S2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('B2: a listener that closes the connection on ready leaves a later listener on the real status', async () => {
		const t = timers();
		const connects: Array<{ resolve: (c: IAxisConnectedClient) => void; onClose: () => void }> = [];
		const client = new AxisReconnectingDaemonClient({ connect: onClose => new Promise(resolve => void connects.push({ resolve, onClose })), timers: t, random: () => 0.5 });
		let closed = false;
		const a = client.onDidChangeStatus(s => { if (s.kind === 'ready' && !closed) { closed = true; connects[0]!.onClose(); } });
		const seen: AxisDaemonStatus['kind'][] = [];
		const b = client.onDidChangeStatus(s => seen.push(s.kind));
		connects[0]!.resolve(connected(() => new Promise<never>(() => {})));
		await flush();
		assert.strictEqual(closed, true);
		assert.strictEqual(seen[seen.length - 1], client.status.kind, `B ends on the client's status: ${JSON.stringify(seen)}`);
		assert.deepStrictEqual(seen.slice(0, 2), ['ready', client.status.kind], 'ready first, then the change made inside A');
		t.run(AXIS_STABLE_AFTER_MS);
		a.dispose();
		b.dispose();
		client.dispose();
	});

	test('S2: a call that throws synchronously rejects with a closed code and leaves nothing pending', async () => {
		const r = await readyClient(connected(() => { throw new Error(MARKER); }));
		const e = await rejection(r.client.request('axis.projects', 'list', {}));
		assert.ok(e instanceof AxisDaemonCallError, 'never the raw error');
		assert.strictEqual((e as AxisDaemonCallError).code, 'E_INTERNAL');
		assert.ok(!String((e as Error).message).includes(MARKER) && (e as Error).cause === undefined);
		assert.strictEqual(r.pendingSize(), 0);
		r.client.dispose();
	});

	test('S2: a rejection whose code getter throws settles once with E_INTERNAL, with no unhandled rejection', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const hostile = { get code(): string { throw new Error(MARKER); } };
			const r = await readyClient(connected(() => Promise.reject(hostile)));
			const e = await rejection(r.client.request('axis.projects', 'list', {}));
			assert.strictEqual((e as AxisDaemonCallError).code, 'E_INTERNAL');
			assert.ok(!String((e as Error).message).includes(MARKER));
			assert.strictEqual(r.pendingSize(), 0);
			const code = { code: 'E_TIMEOUT' };
			const r2 = await readyClient(connected(() => Promise.reject(code)));
			assert.strictEqual(((await rejection(r2.client.request('axis.projects', 'list', {}))) as AxisDaemonCallError).code, 'E_TIMEOUT', 'a plain code still counts');
			await flush();
			assert.deepStrictEqual(unhandled, []);
			r.client.dispose();
			r2.client.dispose();
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	test('S2: an answer whose fields throw is an invalid reply, settled once', async () => {
		const answer = { get ok(): boolean { throw new Error(MARKER); } };
		const r = await readyClient(connected(() => Promise.resolve(answer)));
		const e = await rejection(r.client.request('axis.projects', 'list', {}));
		assert.strictEqual((e as AxisDaemonCallError).code, 'invalid_reply');
		assert.strictEqual(r.pendingSize(), 0);
		r.client.dispose();
	});

	test('SF1: an answer read through accessors is an invalid reply, and no getter runs', async () => {
		let reads = 0;
		const accessor = { get ok(): boolean { reads++; return true; }, get result(): number { reads++; return 42; } };
		const r = await readyClient(connected(() => Promise.resolve(accessor)));
		assert.strictEqual(await closedCode(r.client.request('axis.projects', 'list', {})), 'invalid_reply');
		assert.strictEqual(reads, 0, 'neither getter ran');
		assert.strictEqual(r.pendingSize(), 0);
		r.client.dispose();
	});

	test('SF1: an inherited answer is an invalid reply', async () => {
		const r = await readyClient(connected(() => Promise.resolve(Object.create({ ok: true, result: 42 }))));
		assert.strictEqual(await closedCode(r.client.request('axis.projects', 'list', {})), 'invalid_reply');
		const r2 = await readyClient(connected(() => Promise.resolve({ ok: true, result: Object.create({ secret: 1 }) })));
		assert.strictEqual(await closedCode(r2.client.request('axis.projects', 'list', {})), 'invalid_reply', 'a result with a prototype is not wire data');
		assert.strictEqual(r.pendingSize() + r2.pendingSize(), 0);
		r.client.dispose();
		r2.client.dispose();
	});

	test('SF1: a result with a throwing then getter is a closed invalid reply, not the raw error', async () => {
		let reads = 0;
		const result = { get then(): never { reads++; throw new Error(MARKER); } };
		const r = await readyClient(connected(() => Promise.resolve({ ok: true, result })));
		assert.strictEqual(await closedCode(r.client.request('axis.projects', 'list', {})), 'invalid_reply');
		assert.strictEqual(reads, 0);
		assert.strictEqual(r.pendingSize(), 0);
		r.client.dispose();
	});

	test('SF1: a native promise with a throwing then getter settles with a closed code and leaves nothing pending', async () => {
		const hostile = () => Object.defineProperty(Promise.resolve({ ok: true, result: 42 }), 'then', { get() { throw new Error(MARKER); } });
		const r = await readyClient(connected(hostile));
		assert.strictEqual(await closedCode(r.client.request('axis.projects', 'list', {})), 'E_INTERNAL');
		assert.strictEqual(r.pendingSize(), 0, 'not held until disconnect');
		r.client.dispose();
	});

	test('SF1: an error code getter is never invoked', async () => {
		let reads = 0;
		const error = { get code(): string { reads++; return 'E_TIMEOUT'; } };
		const r = await readyClient(connected(() => Promise.reject(error)));
		assert.strictEqual(await closedCode(r.client.request('axis.projects', 'list', {})), 'E_INTERNAL');
		const r2 = await readyClient(connected(() => Promise.resolve({ ok: false, error })));
		assert.strictEqual(await closedCode(r2.client.request('axis.projects', 'list', {})), 'E_INTERNAL');
		assert.strictEqual(reads, 0);
		r.client.dispose();
		r2.client.dispose();
	});

	test('SF1: plain answers keep working, and the result handed out is a fresh copy', async () => {
		const result = { projects: [{ id: 'p1', tags: ['a'] }] };
		const r = await readyClient(connected(() => Promise.resolve({ ok: true, result })));
		const got = await r.client.request('axis.projects', 'list', {});
		assert.deepStrictEqual(got, result);
		assert.notStrictEqual(got, result, 'a copy, not the connection\'s object');
		const r2 = await readyClient(connected(() => Promise.resolve({ ok: false, error: { code: 'E_NOT_FOUND' } })));
		assert.strictEqual(await closedCode(r2.client.request('axis.projects', 'list', {})), 'E_NOT_FOUND');
		const r3 = await readyClient(connected(() => Promise.resolve({ result: 42 })));
		assert.strictEqual(await closedCode(r3.client.request('axis.projects', 'list', {})), 'invalid_reply', 'no ok at all');
		assert.strictEqual(r.pendingSize() + r2.pendingSize() + r3.pendingSize(), 0);
		r.client.dispose();
		r2.client.dispose();
		r3.client.dispose();
	});

	test('SF1: the audit read runs no getter on its answer and reads an accessor answer as not degraded', async () => {
		let reads = 0;
		const c: IAxisConnectedClient = {
			call: () => Promise.resolve({ get ok(): boolean { reads++; return true; }, result: { degraded: {} } }) as ReturnType<IAxisConnectedClient['call']>,
			close: () => {},
		};
		const r = await readyClient(c);
		assert.strictEqual(r.client.status.kind, 'ready');
		assert.strictEqual(reads, 0);
		r.client.dispose();
	});

	test('S2: sanitizeStatus never runs a getter and never throws', () => {
		assert.deepStrictEqual(sanitizeStatus({ get kind(): string { throw new Error(MARKER); } }), { kind: 'down' });
		assert.deepStrictEqual(sanitizeStatus({ get kind(): string { return 'ready'; } }), { kind: 'down' }, 'a getter is not read, even a benign one');
		const trap = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error(MARKER); } });
		assert.deepStrictEqual(sanitizeStatus(trap), { kind: 'down' });
		assert.deepStrictEqual(sanitizeStatus({ kind: 'failed', reason: 'crash_loop' }), { kind: 'failed', reason: 'crash_loop' });
		assert.deepStrictEqual(sanitizeStatus(Object.create({ kind: 'ready' })), { kind: 'down' }, 'an inherited kind is not own data');
	});
});
