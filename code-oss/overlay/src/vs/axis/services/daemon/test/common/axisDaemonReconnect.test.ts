/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonCallError, AxisDaemonStatus } from '../../common/axisDaemonClient.js';
import { AXIS_DOWN_AFTER_FAILURES, AXIS_DOWN_AFTER_MS, AXIS_RECONNECT_CAP_MS, AXIS_SHELL_CONTRACTS, AXIS_STABLE_AFTER_MS, AXIS_WELCOME_TIMEOUT_MS, AxisReconnectingDaemonClient, auditSaysDegraded, IAxisConnectedClient, reconnectDelay, stoppedReason } from '../../common/axisDaemonReconnect.js';

/** Manual timers: nothing runs until `run`; `due` lists the pending delays. */
function manualTimers() {
	let next = 1;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	return {
		set: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id; },
		clear: (h: unknown) => void timers.delete(h as number),
		due: () => [...timers.values()].map(t => t.ms),
		/** The pending retry timers: everything but the 15 s down window. */
		retries: () => [...timers.values()].map(t => t.ms).filter(ms => ms !== AXIS_DOWN_AFTER_MS),
		/** Run every pending timer of exactly `ms` (in creation order). */
		run: (ms: number) => { for (const [id, t] of [...timers]) { if (t.ms === ms) { timers.delete(id); t.fn(); } } },
	};
}

type Answer = { ok: true; result: unknown } | { ok: false; error: { code: string } };

/** A connection. Its `axis.audit/1.status` answers at once with `audit` (not degraded by default) unless `audit` is 'hold'. */
function fakeClient(audit: Answer | 'hold' | 'throw' = { ok: true, result: { degraded: null } }) {
	const calls: Array<{ contract: string; method: string; settle: (a: Answer) => void; fail: (e: unknown) => void; signal?: AbortSignal }> = [];
	const audits: Array<{ settle: (a: Answer) => void; fail: (e: unknown) => void; signal?: AbortSignal }> = [];
	let closed = 0;
	const client: IAxisConnectedClient = {
		call: (contract, method, _payload, options) => {
			if (contract === 'axis.audit') {
				assert.strictEqual(method, 'status', 'the audit contract is read for status only');
				if (audit === 'throw') {
					return Promise.reject(new Error('bad_answer'));
				}
				return audit === 'hold' ? new Promise((resolve, reject) => void audits.push({ settle: resolve, fail: reject, signal: options?.signal })) : Promise.resolve(audit);
			}
			return new Promise((resolve, reject) => void calls.push({ contract, method, settle: resolve, fail: reject, signal: options?.signal }));
		},
		close: () => void closed++,
	};
	return { client, calls, audits, closed: () => closed };
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
		assert.strictEqual(AXIS_DOWN_AFTER_MS, 15_000);
		assert.strictEqual(AXIS_STABLE_AFTER_MS, 10_000);
		assert.deepStrictEqual([1, 2, 3, 4, 8, 20].map(n => reconnectDelay(n, () => 0.5)), [250, 500, 1000, 2000, AXIS_RECONNECT_CAP_MS, AXIS_RECONNECT_CAP_MS], 'the 8th would be 32 s: capped');
		assert.strictEqual(reconnectDelay(1, () => 0), 200);
		assert.strictEqual(reconnectDelay(1, () => 1), 300);
		assert.strictEqual(reconnectDelay(30, () => 1), AXIS_RECONNECT_CAP_MS, 'jitter never passes the cap');
		assert.deepStrictEqual(AXIS_SHELL_CONTRACTS.map(c => c.id), ['axis.projects', 'axis.worktrees', 'axis.cli-runs', 'axis.approvals', 'axis.audit'], 'only axis.audit added (F2), for its status read');
	});

	test('connecting, then ready on welcome; a close goes back to connecting and reconnects at once; one attempt at a time', async () => {
		const r = rig();
		assert.strictEqual(kindOf(r.client), 'connecting');
		assert.strictEqual(r.connects.length, 1);
		const one = fakeClient();
		r.connects[0].resolve(one.client);
		await flush();
		assert.strictEqual(kindOf(r.client), 'ready');
		r.timers.run(AXIS_STABLE_AFTER_MS);
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

	test('failed connects back off; down needs 5 in a row AND 15 s since the first; a connection that stays up resets both', async () => {
		const r = rig();
		for (let i = 1; i <= 6; i++) {
			r.connects[i - 1].reject(new Error('not_ready'));
			await flush();
			assert.strictEqual(kindOf(r.client), 'connecting', `after ${i}, inside 15 s: still connecting (a normal restart)`);
			const delay = reconnectDelay(i, () => 0.5);
			assert.deepStrictEqual(r.timers.retries(), [delay]);
			r.timers.run(delay);
		}
		r.timers.run(AXIS_DOWN_AFTER_MS);
		assert.strictEqual(kindOf(r.client), 'down', '6 failures and 15 s: down');
		r.connects[6].resolve(fakeClient().client);
		await flush();
		assert.strictEqual(kindOf(r.client), 'ready');
		r.timers.run(AXIS_STABLE_AFTER_MS);
		r.connects[6].onClose();
		assert.deepStrictEqual(r.timers.retries(), [0], 'the count was reset: the next attempt is immediate');
		r.timers.run(0);
		r.connects[7].reject(new Error('not_ready'));
		await flush();
		assert.strictEqual(kindOf(r.client), 'connecting', 'one failure after a welcome is not down');
		assert.deepStrictEqual(r.timers.retries(), [reconnectDelay(1, () => 0.5)], 'the backoff starts again from 250 ms');
		for (let i = 2; i <= AXIS_DOWN_AFTER_FAILURES; i++) {
			r.timers.run(reconnectDelay(i - 1, () => 0.5));
			r.connects[6 + i].reject(new Error('not_ready'));
			await flush();
		}
		assert.strictEqual(kindOf(r.client), 'connecting', 'the 15 s window restarted too: 5 quick failures are not down yet');
		r.timers.run(AXIS_DOWN_AFTER_MS);
		assert.strictEqual(kindOf(r.client), 'down');
		r.dispose();
	});

	test('15 s of failures is not enough without 5 of them: down comes with the 5th', async () => {
		const r = rig();
		r.connects[0].reject(new Error('not_ready'));
		await flush();
		r.timers.run(AXIS_DOWN_AFTER_MS);
		assert.strictEqual(kindOf(r.client), 'connecting', 'mutant: time alone');
		for (let i = 1; i < AXIS_DOWN_AFTER_FAILURES; i++) {
			r.timers.run(reconnectDelay(i, () => 0.5));
			r.connects[i].reject(new Error('not_ready'));
			await flush();
			assert.strictEqual(kindOf(r.client), i + 1 >= AXIS_DOWN_AFTER_FAILURES ? 'down' : 'connecting', `after ${i + 1}`);
		}
		r.dispose();
	});

	test('a daemon that welcomes and closes at once is a failed connect: it backs off and turns down, never a tight loop', async () => {
		const r = rig();
		for (let i = 1; i <= AXIS_DOWN_AFTER_FAILURES; i++) {
			r.connects[i - 1].resolve(fakeClient().client);
			await flush();
			assert.strictEqual(kindOf(r.client), 'ready');
			r.connects[i - 1].onClose();
			assert.strictEqual(kindOf(r.client), 'connecting', `after ${i}`);
			const delay = reconnectDelay(i, () => 0.5);
			assert.deepStrictEqual(r.timers.retries(), [delay], 'mutant: reconnected at once');
			if (i === AXIS_DOWN_AFTER_FAILURES) {
				r.timers.run(AXIS_DOWN_AFTER_MS);
				assert.strictEqual(kindOf(r.client), 'down');
			}
			r.timers.run(delay);
		}
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
		const pending = rig();
		pending.dispose();
		assert.deepStrictEqual(pending.timers.due(), [], 'dispose clears the welcome bound of the attempt in flight');
		cts.dispose();
		pre.dispose();
	});

	test('F2: main\'s stopped_<reason> is failed{reason} at once and it keeps retrying; any other refusal stays generic', async () => {
		assert.deepStrictEqual(['stopped_lock_held', 'stopped_bad_config', 'stopped_degraded', 'stopped_crash_loop'].map(m => stoppedReason(new Error(m))), ['lock_held', 'bad_config', 'degraded', 'crash_loop']);
		for (const other of [new Error('not_ready'), new Error('stopped_pty_required'), new Error('stopped_'), new Error('xstopped_crash_loop'), 'stopped_crash_loop', undefined, { message: 'stopped_crash_loop' }]) {
			assert.strictEqual(stoppedReason(other), undefined, String(other));
		}
		const r = rig();
		r.connects[0].reject(new Error('not_ready')); // a restart in progress: starts the 15 s window
		await flush();
		r.timers.run(reconnectDelay(1, () => 0.5));
		r.connects[1].reject(new Error('stopped_crash_loop')); // then the supervisor gives up
		await flush();
		assert.deepStrictEqual(r.client.status, { kind: 'failed', reason: 'crash_loop' }, 'mutant: generic connecting/down for a stopped supervisor');
		assert.deepStrictEqual(r.timers.retries(), [reconnectDelay(2, () => 0.5)], 'it keeps retrying on the backoff');
		r.timers.run(AXIS_DOWN_AFTER_MS);
		assert.strictEqual(kindOf(r.client), 'failed', 'the window started before never turns a stopped supervisor into connecting or down');
		r.timers.run(reconnectDelay(2, () => 0.5));
		r.connects[2].resolve(fakeClient().client);
		await flush();
		assert.strictEqual(kindOf(r.client), 'ready', 'a daemon that comes back is ready again');
		r.dispose();
	});

	test('F2: one audit status read per connection: degraded only from a present degraded object; a failed or slow read is ready', async () => {
		assert.strictEqual(auditSaysDegraded({ degraded: { reason: 'anchor_unreachable' } }), true);
		for (const v of [{ degraded: null }, {}, null, 'degraded', { degraded: 'yes' }]) {
			assert.strictEqual(auditSaysDegraded(v), false, JSON.stringify(v));
		}
		const degraded = rig();
		const d = fakeClient({ ok: true, result: { degraded: { reason: 'anchor_unreachable' } } });
		degraded.connects[0].resolve(d.client);
		await flush();
		assert.strictEqual(kindOf(degraded.client), 'degraded');
		const call = degraded.client.request('axis.projects', 'list', {});
		d.calls[0].settle({ ok: true, result: { projects: [] } });
		assert.deepStrictEqual(await call, { projects: [] }, 'a degraded host still serves reads');
		degraded.dispose();
		for (const audit of [{ ok: false, error: { code: 'E_POLICY_DENIED' } } as const, 'throw' as const, { ok: true, result: 'odd' } as const]) {
			const r = rig();
			r.connects[0].resolve(fakeClient(audit).client);
			await flush();
			assert.strictEqual(kindOf(r.client), 'ready', `${JSON.stringify(audit)}: no state is invented (mutant: degraded on a failed read)`);
			r.dispose();
		}
		const slow = rig();
		const s = fakeClient('hold');
		slow.connects[0].resolve(s.client);
		await flush();
		assert.strictEqual(kindOf(slow.client), 'connecting', 'calls wait for the audit answer');
		slow.timers.run(AXIS_WELCOME_TIMEOUT_MS);
		assert.strictEqual(kindOf(slow.client), 'ready', 'a read past the bound is ready');
		assert.strictEqual(s.audits[0].signal?.aborted, true, 'and it is cancelled');
		slow.timers.run(AXIS_STABLE_AFTER_MS);
		slow.timers.run(AXIS_STABLE_AFTER_MS);
		assert.strictEqual(s.audits.length, 1, 'never polled (mutant: a timer re-reads it)');
		slow.dispose();
	});
});
