/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonCallError, AxisDaemonStatus } from '../../common/axisDaemonClient.js';
import { AXIS_DOWN_AFTER_FAILURES, AXIS_RECONNECT_CAP_MS, AXIS_SHELL_CONTRACTS, AXIS_WELCOME_TIMEOUT_MS, AxisReconnectingDaemonClient, IAxisConnectedClient, reconnectDelay } from '../../common/axisDaemonReconnect.js';

/** Manual timers: nothing runs until `run`; `due` lists the pending delays. */
function manualTimers() {
	let next = 1;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	return {
		set: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id; },
		clear: (h: unknown) => void timers.delete(h as number),
		due: () => [...timers.values()].map(t => t.ms),
		/** Run every pending timer of exactly `ms` (in creation order). */
		run: (ms: number) => { for (const [id, t] of [...timers]) { if (t.ms === ms) { timers.delete(id); t.fn(); } } },
	};
}

type Answer = { ok: true; result: unknown } | { ok: false; error: { code: string } };

function fakeClient() {
	const calls: Array<{ contract: string; method: string; settle: (a: Answer) => void; fail: (e: unknown) => void; signal?: AbortSignal }> = [];
	let closed = 0;
	const client: IAxisConnectedClient = {
		call: (contract, method, _payload, options) => new Promise((resolve, reject) => void calls.push({ contract, method, settle: resolve, fail: reject, signal: options?.signal })),
		close: () => void closed++,
	};
	return { client, calls, closed: () => closed };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));
/** Read through a function so one assertion does not narrow the next. */
const kindOf = (c: { readonly status: AxisDaemonStatus }): string => c.status.kind;

function rig() {
	const timers = manualTimers();
	const connects: Array<{ resolve: (c: IAxisConnectedClient) => void; reject: (e: unknown) => void; onClose: () => void }> = [];
	const statuses: AxisDaemonStatus['kind'][] = [];
	const client = new AxisReconnectingDaemonClient({
		connect: onClose => new Promise((resolve, reject) => void connects.push({ resolve, reject, onClose })),
		timers,
		random: () => 0.5, // no jitter
	});
	const sub = client.onDidChangeStatus(s => statuses.push(s.kind));
	return { client, timers, connects, statuses, dispose: () => { sub.dispose(); client.dispose(); } };
}

suite('Axis renderer daemon client (PV-E0)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the named bounds: a 10 s welcome bound, down after 5 failures, 250 ms doubling to a 30 s cap with ±20 % jitter', () => {
		assert.strictEqual(AXIS_WELCOME_TIMEOUT_MS, 10_000);
		assert.strictEqual(AXIS_DOWN_AFTER_FAILURES, 5);
		assert.deepStrictEqual([1, 2, 3, 4, 8, 20].map(n => reconnectDelay(n, () => 0.5)), [250, 500, 1000, 2000, AXIS_RECONNECT_CAP_MS, AXIS_RECONNECT_CAP_MS], 'the 8th would be 32 s: capped');
		assert.strictEqual(reconnectDelay(1, () => 0), 200);
		assert.strictEqual(reconnectDelay(1, () => 1), 300);
		assert.strictEqual(reconnectDelay(30, () => 1), AXIS_RECONNECT_CAP_MS, 'jitter never passes the cap');
		assert.deepStrictEqual(AXIS_SHELL_CONTRACTS.map(c => c.id), ['axis.projects', 'axis.worktrees', 'axis.cli-runs', 'axis.approvals'], 'no new capability');
	});

	test('connecting, then ready on welcome; a close goes back to connecting and reconnects at once; one attempt at a time', async () => {
		const r = rig();
		assert.strictEqual(kindOf(r.client), 'connecting');
		assert.strictEqual(r.connects.length, 1);
		const one = fakeClient();
		r.connects[0].resolve(one.client);
		await flush();
		assert.strictEqual(kindOf(r.client), 'ready');
		r.connects[0].onClose();
		assert.strictEqual(kindOf(r.client), 'connecting');
		assert.deepStrictEqual(r.timers.due(), [0]);
		r.timers.run(0);
		assert.strictEqual(r.connects.length, 2);
		r.timers.run(0);
		assert.strictEqual(r.connects.length, 2, 'never two attempts in flight');
		r.connects[1].resolve(fakeClient().client);
		await flush();
		assert.deepStrictEqual(r.statuses, ['ready', 'connecting', 'ready']);
		r.dispose();
	});

	test('failed connects back off and turn down after 5 in a row, still retrying; a welcome resets the count', async () => {
		const r = rig();
		for (let i = 1; i <= 6; i++) {
			r.connects[i - 1].reject(new Error('not_ready'));
			await flush();
			assert.strictEqual(kindOf(r.client), i >= AXIS_DOWN_AFTER_FAILURES ? 'down' : 'connecting', `after ${i}`);
			const delay = reconnectDelay(i, () => 0.5);
			assert.deepStrictEqual(r.timers.due(), [delay]);
			r.timers.run(delay);
		}
		r.connects[6].resolve(fakeClient().client);
		await flush();
		assert.strictEqual(kindOf(r.client), 'ready');
		r.connects[6].onClose();
		assert.deepStrictEqual(r.timers.due(), [0], 'the count was reset: the next attempt is immediate');
		r.dispose();
	});

	test('a connect that does not answer within the welcome bound fails; if it answers later its client is closed, not used', async () => {
		const r = rig();
		r.timers.run(AXIS_WELCOME_TIMEOUT_MS);
		await flush();
		assert.strictEqual(kindOf(r.client), 'connecting');
		const late = fakeClient();
		r.connects[0].resolve(late.client);
		await flush();
		assert.strictEqual(late.closed(), 1);
		assert.strictEqual(kindOf(r.client), 'connecting');
		r.dispose();
	});

	test('requests: refused while not ready; answered or rejected with a closed code; a malformed reply keeps the connection', async () => {
		const r = rig();
		await assert.rejects(r.client.request('axis.projects', 'list', {}), (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'unavailable');
		const one = fakeClient();
		r.connects[0].resolve(one.client);
		await flush();
		const ok = r.client.request('axis.projects', 'list', {});
		one.calls[0].settle({ ok: true, result: { projects: [] } });
		assert.deepStrictEqual(await ok, { projects: [] });
		const denied = r.client.request('axis.worktrees', 'create', {});
		one.calls[1].settle({ ok: false, error: { code: 'E_POLICY_DENIED' } });
		await assert.rejects(denied, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'E_POLICY_DENIED');
		const bad = r.client.request('axis.projects', 'list', {});
		one.calls[2].fail(Object.assign(new Error('bad_answer'), { code: 'E_INTERNAL' }));
		await assert.rejects(bad, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'E_INTERNAL');
		assert.strictEqual(kindOf(r.client), 'ready', 'a malformed reply does not tear the connection down');
		assert.strictEqual(one.closed(), 0);
		const weird = r.client.request('axis.projects', 'list', {});
		one.calls[3].fail(new Error('anything'));
		await assert.rejects(weird, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'E_INTERNAL');
		r.dispose();
	});

	test('leaving ready rejects every pending call unavailable exactly once; a late answer after the reconnect settles nothing twice', async () => {
		const r = rig();
		const one = fakeClient();
		r.connects[0].resolve(one.client);
		await flush();
		const a = r.client.request('axis.projects', 'list', {});
		const b = r.client.request('axis.cli-runs', 'list', {});
		let settled = 0;
		a.catch(() => settled++); b.catch(() => settled++);
		r.connects[0].onClose();
		await assert.rejects(a, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'unavailable');
		await assert.rejects(b, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'unavailable');
		one.calls[0].settle({ ok: true, result: 'late' });
		one.calls[1].fail(new Error('closed'));
		await flush();
		assert.strictEqual(settled, 2, 'mutant: a double settle');
		r.dispose();
	});

	test('a cancelled token aborts the call (E_CANCELLED); dispose stops retrying, rejects pending and closes the connection', async () => {
		const r = rig();
		const one = fakeClient();
		r.connects[0].resolve(one.client);
		await flush();
		const cts = new CancellationTokenSource();
		const p = r.client.request('axis.approvals', 'list', {}, cts.token);
		cts.cancel();
		assert.strictEqual(one.calls[0].signal?.aborted, true);
		one.calls[0].fail(Object.assign(new Error('aborted'), { code: 'E_CANCELLED' }));
		await assert.rejects(p, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'E_CANCELLED');
		const pre = new CancellationTokenSource();
		pre.cancel();
		await assert.rejects(r.client.request('axis.projects', 'list', {}, pre.token), (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'E_CANCELLED');
		const waiting = r.client.request('axis.projects', 'list', {});
		r.dispose();
		await assert.rejects(waiting, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'unavailable');
		assert.strictEqual(one.closed(), 1);
		assert.deepStrictEqual(r.timers.due(), []);
		cts.dispose();
		pre.dispose();
	});
});
