/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonCallError } from '../../../daemon/common/axisDaemonClient.js';
import { endFrame, EPOCH, EPOCH2, eventFrame, FakeEventTransport, flush, ManualTimers, reply, resyncFrame, SUB, SUB2 } from '../../../daemon/test/common/axisEventFixtures.js';
import { AxisAdaptiveRefreshDriver, AxisEventDriver, EVENT_DEBOUNCE_MS, RECONCILE_MAX_MS, RECONCILE_MIN_MS, STREAM_STABLE_MS } from '../../common/axisEventDriver.js';
import { POLL_MAX_BACKOFF_MS, POLL_MIN_MS } from '../../common/axisRefreshDriver.js';

class Harness {
	readonly transport = new FakeEventTransport();
	readonly timers = new ManualTimers();
	readonly live: boolean[] = [];
	refreshes = 0;
	running = 0;
	maxRunning = 0;
	result = true;
	gate: (() => Promise<void>) | undefined;
	transportPresent = true;
	readonly driver = new AxisEventDriver(() => this.transportPresent ? this.transport : undefined, l => this.live.push(l), this.timers, () => 0);

	readonly refresh = async (): Promise<boolean> => {
		this.refreshes++;
		this.running++;
		this.maxRunning = Math.max(this.maxRunning, this.running);
		await this.gate?.();
		this.running--;
		return this.result;
	};

	async started(): Promise<void> {
		this.driver.start(this.refresh);
		await this.timers.fire(); // connect
	}
}

suite('Axis event driver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('subscribes on start, reads everything once for a fresh stream, then waits for events', async () => {
		const h = await (async () => { const x = new Harness(); await x.started(); return x; })();
		assert.strictEqual(h.transport.subscribes.length, 1);
		assert.deepStrictEqual(h.live, [true]);
		assert.strictEqual(h.refreshes, 0);
		await h.timers.fire(d => d === 0); // the urgent first read
		assert.strictEqual(h.refreshes, 1);
		assert.deepStrictEqual(h.timers.delays.filter(d => d !== STREAM_STABLE_MS).map(d => d >= RECONCILE_MIN_MS && d <= RECONCILE_MAX_MS), [true], 'only the slow reconcile is left');
		h.driver.dispose();
	});

	test('an event causes one read after the debounce; several events in the window cause one', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		h.transport.push(eventFrame(11, { topic: 'runs', runId: 'run-1' }));
		h.transport.push(eventFrame(12, { topic: 'workspaces', workspaceId: 'ws-a' }));
		h.transport.push(eventFrame(13, { topic: 'approvals' }));
		assert.ok(h.timers.delays.includes(EVENT_DEBOUNCE_MS));
		assert.ok(!h.timers.delays.some(d => d >= RECONCILE_MIN_MS), 'the reconcile timer does not hold the read back');
		await h.timers.fire(d => d === EVENT_DEBOUNCE_MS);
		assert.strictEqual(h.refreshes, 2);
		assert.strictEqual(h.timers.delays.filter(d => d === EVENT_DEBOUNCE_MS).length, 0);
		h.driver.dispose();
	});

	test('reads never overlap; an event during a read is read again afterwards', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		let release!: () => void;
		h.gate = () => new Promise<void>(resolve => { release = resolve; });
		h.transport.push(eventFrame(11));
		const firing = h.timers.fire(d => d === EVENT_DEBOUNCE_MS);
		await flush();
		assert.strictEqual(h.running, 1);
		h.transport.push(eventFrame(12));
		assert.strictEqual(h.timers.delays.filter(d => d === EVENT_DEBOUNCE_MS).length, 0, 'no second read is scheduled while one runs');
		h.gate = undefined;
		release();
		await firing;
		await flush();
		assert.ok(h.timers.delays.includes(EVENT_DEBOUNCE_MS), 'the event that came during the read is read after it');
		await h.timers.fire(d => d === EVENT_DEBOUNCE_MS);
		assert.strictEqual(h.refreshes, 3);
		assert.strictEqual(h.maxRunning, 1);
		h.driver.dispose();
	});

	test('a resync reads at once, without the debounce', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		h.transport.push(resyncFrame(11));
		assert.ok(h.timers.delays.includes(0));
		assert.ok(!h.timers.delays.includes(EVENT_DEBOUNCE_MS));
		const before = h.refreshes;
		await h.timers.fire(d => d === 0);
		assert.strictEqual(h.refreshes, before + 1);
		h.driver.dispose();
	});

	test('credit is returned while events are only marked, even when no read is due (paused)', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		h.driver.setPaused(true);
		assert.strictEqual(h.timers.pending.size, 0, 'a paused driver holds no timer');
		for (let i = 1; i <= 9; i++) {
			h.transport.push(eventFrame(10 + i));
		}
		assert.ok(h.transport.acks.length >= 1, 'a batch was acknowledged although the window is hidden');
		assert.strictEqual(h.refreshes, 1, 'no read while paused');
		assert.ok(!h.timers.delays.includes(EVENT_DEBOUNCE_MS), 'and none is scheduled');
		h.driver.setPaused(false);
		assert.ok(h.timers.delays.includes(EVENT_DEBOUNCE_MS), 'the missed events are read on resume');
		await h.timers.fire(d => d === EVENT_DEBOUNCE_MS);
		assert.strictEqual(h.refreshes, 2);
		h.driver.dispose();
	});

	test('with no event the data is still read again by the slow reconcile', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		await h.timers.fire(d => d >= RECONCILE_MIN_MS);
		assert.strictEqual(h.refreshes, 2);
		h.driver.dispose();
	});

	test('a failed read is retried with growing backoff and the data stays marked as changed', async () => {
		const h = new Harness();
		h.result = false;
		await h.started();
		const delays: number[] = [];
		for (let i = 0; i < 6; i++) {
			const d = h.timers.delays.filter(x => x !== 50 && x !== STREAM_STABLE_MS);
			assert.strictEqual(d.length, 1);
			delays.push(d[0]);
			await h.timers.fire(x => x === d[0]);
		}
		assert.strictEqual(delays[0], 0);
		for (let i = 2; i < delays.length; i++) {
			assert.ok(delays[i] >= delays[i - 1], `${delays}`);
		}
		assert.ok(delays[delays.length - 1] > delays[1]);
		assert.ok(delays.every(d => d <= POLL_MAX_BACKOFF_MS));
		h.result = true;
		for (let i = 0; i < 20 && h.timers.pending.size > 0; i++) {
			const d = h.timers.delays[0];
			await h.timers.fire(x => x === d);
			if (d >= RECONCILE_MIN_MS) { break; }
		}
		h.driver.dispose();
	});

	test('the daemon ending the stream goes not-live, reconnects with backoff and resumes from the last position', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		h.transport.push(eventFrame(25));
		h.transport.replies = [reply({ resumed: true, seq: 30 })];
		h.transport.push(endFrame());
		assert.deepStrictEqual(h.live, [true, false]);
		const delay = h.timers.delays.find(d => d > 0 && d <= POLL_MAX_BACKOFF_MS);
		assert.ok(delay !== undefined && delay >= 1000);
		await h.timers.fire(d => d === delay);
		assert.deepStrictEqual(h.transport.subscribes[1], { topics: ['workspaces', 'runs', 'approvals'], resumeFrom: { epoch: EPOCH, seq: 25 } });
		assert.deepStrictEqual(h.live, [true, false, true]);
		h.driver.dispose();
	});

	test('a resumed subscription needs no full read, a not-resumed one does', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		h.transport.replies = [reply({ resumed: true, seq: 30 })];
		h.transport.close();
		const before = h.refreshes;
		await h.timers.fire(d => d >= 1000 && d < RECONCILE_MIN_MS);
		assert.ok(!h.timers.delays.some(d => d < RECONCILE_MIN_MS && d !== STREAM_STABLE_MS), 'resumed: nothing to read');
		h.transport.replies = [reply({ resumed: false, epoch: EPOCH2, subscriptionId: SUB2, seq: 3 })];
		h.transport.close();
		await h.timers.fire(d => d >= 1000 && d < RECONCILE_MIN_MS);
		await h.timers.fire(d => d < RECONCILE_MIN_MS);
		assert.strictEqual(h.refreshes, before + 1);
		h.driver.dispose();
	});

	test('a closed connection goes not-live; a protocol violation does too', async () => {
		const h = new Harness();
		await h.started();
		h.transport.close();
		assert.deepStrictEqual(h.live, [true, false]);
		await h.timers.fire(d => d >= 1000 && d < RECONCILE_MIN_MS);
		assert.deepStrictEqual(h.live, [true, false, true]);
		h.transport.push({ ...eventFrame(20), extra: 1 });
		assert.deepStrictEqual(h.live, [true, false, true, false]);
		h.driver.dispose();
	});

	test('a stream that breaks the protocol as soon as it opens backs off with growing delays and restarts from a fresh baseline', async () => {
		const timers = new ManualTimers();
		const transport = new FakeEventTransport();
		transport.replies = [() => {
			transport.push(eventFrame(10)); // not above the head in the reply: a violation, and the daemon would replay it
			return reply({ resumed: false });
		}];
		const driver = new AxisEventDriver(() => transport, () => { }, timers, () => 0.5);
		driver.start(async () => true);
		const delays: number[] = [];
		for (let i = 0; i < 8; i++) {
			const d = timers.delays.filter(x => x !== 50 && x < RECONCILE_MIN_MS && x !== EVENT_DEBOUNCE_MS && x !== STREAM_STABLE_MS);
			assert.strictEqual(d.length, 1, JSON.stringify(timers.delays));
			delays.push(d[0]);
			await timers.fire(x => x === d[0]);
		}
		assert.strictEqual(delays[0], 0);
		for (let i = 2; i < 5; i++) {
			assert.ok(delays[i] > delays[i - 1], `strictly growing at first: ${delays}`);
		}
		assert.ok(delays[1] >= 1000);
		assert.strictEqual(delays[delays.length - 1], POLL_MAX_BACKOFF_MS);
		assert.ok(transport.subscribes.every(p => !('resumeFrom' in p)), 'no resume after a violation');
		driver.dispose();
	});

	test('a stream that stays up for the stable time starts the backoff over; an additive body never breaks it', async () => {
		const timers = new ManualTimers();
		const transport = new FakeEventTransport();
		const driver = new AxisEventDriver(() => transport, () => { }, timers, () => 0);
		driver.start(async () => true);
		await timers.fire();
		transport.push(eventFrame(11, { topic: 'runs', runId: 'run-1', newField: 1 }));
		assert.strictEqual(driver.live, true, 'a body this shell does not know is a hint, not a violation');
		transport.close(); // not stable yet: a first failure
		await timers.fire(d => d === 1000);
		transport.close(); // not stable either: a second failure
		assert.ok(timers.delays.includes(2000));
		await timers.fire(d => d === 2000);
		await timers.fire(d => d === STREAM_STABLE_MS);
		transport.close();
		assert.ok(timers.delays.includes(1000), 'the stream was stable, so this loss is a first failure again');
		assert.ok(!timers.delays.includes(4000));
		driver.dispose();
	});

	test('a hidden window holds no stability timer, and showing it again starts the wait over', async () => {
		const timers = new ManualTimers();
		const transport = new FakeEventTransport();
		const driver = new AxisEventDriver(() => transport, () => { }, timers, () => 0);
		driver.start(async () => true);
		await timers.fire();
		transport.close(); // a first failure
		await timers.fire(d => d === 1000);
		driver.setPaused(true);
		assert.ok(!timers.delays.includes(STREAM_STABLE_MS));
		driver.setPaused(false);
		assert.ok(timers.delays.includes(STREAM_STABLE_MS));
		await timers.fire(d => d === STREAM_STABLE_MS);
		transport.close();
		assert.ok(timers.delays.includes(1000) && !timers.delays.includes(2000));
		driver.dispose();
	});

	test('a valid frame alone does not make a stream healthy: losing it soon after keeps the backoff growing', async () => {
		const timers = new ManualTimers();
		const transport = new FakeEventTransport();
		const driver = new AxisEventDriver(() => transport, () => { }, timers, () => 0);
		driver.start(async () => true);
		await timers.fire();
		transport.push(eventFrame(11));
		transport.close();
		await timers.fire(d => d === 1000);
		transport.push(eventFrame(12));
		transport.close();
		assert.ok(timers.delays.includes(2000), `${timers.delays}`);
		driver.dispose();
	});

	test('a stream that breaks the protocol shortly after it opened keeps backing off, however many times it reconnects', async () => {
		const timers = new ManualTimers();
		const transport = new FakeEventTransport();
		const driver = new AxisEventDriver(() => transport, () => { }, timers, () => 0);
		driver.start(async () => true);
		const delays: number[] = [];
		for (let i = 0; i < 8; i++) {
			const d = timers.delays.filter(x => x !== 50 && x !== EVENT_DEBOUNCE_MS && x !== STREAM_STABLE_MS && x < RECONCILE_MIN_MS && x !== 0 || (i === 0 && x === 0));
			assert.strictEqual(d.length, 1, JSON.stringify(timers.delays));
			delays.push(d[0]);
			await timers.fire(x => x === d[0]); // connect succeeds, then the fresh-stream read is scheduled
			const refresh = timers.delays.includes(0);
			if (refresh) {
				await timers.fire(x => x === 0);
			}
			transport.push({ ...eventFrame(1000 + i), extra: 1 }); // broken envelope, after the stream opened
		}
		assert.deepStrictEqual(delays.slice(0, 4), [0, 1000, 2000, 4000]);
		assert.strictEqual(delays[delays.length - 1], POLL_MAX_BACKOFF_MS);
		assert.ok(transport.subscribes.every(p => !('resumeFrom' in p)));
		driver.dispose();
	});

	test('a restart after a failed session starts the connection backoff at zero', async () => {
		const timers = new ManualTimers();
		const transport = new FakeEventTransport();
		transport.replies = [new AxisDaemonCallError('E_UNAVAILABLE')];
		const driver = new AxisEventDriver(() => transport, () => { }, timers, () => 0);
		driver.start(async () => true);
		await timers.fire(); // fails once, backoff armed
		await timers.fire(d => d === 1000); // fails twice
		driver.stop();
		transport.replies = [reply()];
		driver.start(async () => true);
		assert.deepStrictEqual(timers.delays, [0]);
		driver.dispose();
	});

	test('a refused subscribe retries with backoff capped at 16 s and reports not-live', async () => {
		const h = new Harness();
		h.transport.replies = [new AxisDaemonCallError('E_METHOD_NOT_FOUND')];
		h.driver.start(h.refresh);
		const seen: number[] = [];
		for (let i = 0; i < 12; i++) {
			const d = h.timers.delays[0];
			seen.push(d);
			await h.timers.fire(x => x === d);
		}
		assert.strictEqual(seen[0], 0);
		assert.ok(seen.slice(1).every(d => d >= 1000 && d <= POLL_MAX_BACKOFF_MS), `${seen}`);
		assert.strictEqual(seen[seen.length - 1], POLL_MAX_BACKOFF_MS);
		assert.ok(h.live.every(l => !l));
		assert.strictEqual(h.refreshes, 0);
		h.driver.dispose();
	});

	test('with no event transport it is not live and keeps retrying', async () => {
		const h = new Harness();
		h.transportPresent = false;
		h.driver.start(h.refresh);
		await h.timers.fire();
		assert.deepStrictEqual(h.live, [false]);
		assert.strictEqual(h.timers.pending.size, 1);
		h.driver.dispose();
		assert.strictEqual(h.timers.pending.size, 0);
	});

	test('stop unsubscribes, drops listeners and timers, and nothing runs after it', async () => {
		const h = new Harness();
		await h.started();
		await h.timers.fire(d => d === 0);
		h.transport.push(eventFrame(11));
		h.driver.stop();
		await flush();
		assert.strictEqual(h.timers.pending.size, 0);
		assert.deepStrictEqual(h.transport.unsubscribes, [SUB]);
		assert.strictEqual(h.transport.listeners, false);
		h.transport.push(eventFrame(12));
		assert.strictEqual(h.refreshes, 1);
		h.driver.dispose();
	});

	test('start after stop subscribes again, resuming from where the stopped one ended', async () => {
		const h = new Harness();
		await h.started();
		h.transport.push(eventFrame(21));
		h.driver.stop();
		h.transport.replies = [reply({ resumed: true, seq: 40 })];
		await h.started();
		assert.deepStrictEqual(h.transport.subscribes[1], { topics: ['workspaces', 'runs', 'approvals'], resumeFrom: { epoch: EPOCH, seq: 21 } });
		h.driver.dispose();
	});

	test('stop while the subscribe is pending leaves nothing behind', async () => {
		const h = new Harness();
		h.driver.start(h.refresh);
		const firing = h.timers.fire();
		h.driver.stop();
		await firing;
		await flush();
		assert.strictEqual(h.timers.pending.size, 0);
		assert.strictEqual(h.transport.listeners, false);
		assert.deepStrictEqual(h.transport.unsubscribes, [SUB]);
		h.driver.dispose();
	});
});

suite('Axis adaptive refresh driver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function make(withEvents: boolean) {
		const transport = new FakeEventTransport();
		const timers = new ManualTimers();
		const driver = new AxisAdaptiveRefreshDriver(withEvents ? { events: transport } : {}, timers, () => 0);
		let refreshes = 0;
		const refresh = async () => { refreshes++; return true; };
		return { transport, timers, driver, refresh, count: () => refreshes };
	}

	test('without the events capability it polls, as before', async () => {
		const { timers, driver, refresh, count } = make(false);
		driver.start(refresh);
		assert.ok(timers.delays.includes(POLL_MIN_MS));
		await timers.fire(d => d === POLL_MIN_MS);
		assert.strictEqual(count(), 1);
		assert.strictEqual(driver.eventsLive, false);
		driver.dispose();
		assert.strictEqual(timers.pending.size, 0);
	});

	test('once subscribed it stops polling; when the stream is lost it polls again; when it is back it stops', async () => {
		const { transport, timers, driver, refresh } = make(true);
		driver.start(refresh);
		assert.ok(timers.delays.includes(POLL_MIN_MS), 'polls until the subscription is up');
		await timers.fire(d => d === 0); // connect
		assert.strictEqual(driver.eventsLive, true);
		assert.ok(!timers.delays.includes(POLL_MIN_MS), 'the poll timer is gone');
		transport.close();
		assert.strictEqual(timers.pending.size, 2, 'polling (one timer) while the reconnect waits (the other)');
		for (let i = 0; i < 4 && !driver.eventsLive; i++) {
			await timers.fire(d => d === POLL_MIN_MS); // the poll and the reconnect both wait 1 s here
		}
		assert.strictEqual(driver.eventsLive, true);
		assert.ok(!timers.delays.includes(POLL_MIN_MS));
		driver.dispose();
		assert.strictEqual(timers.pending.size, 0);
	});

	test('a daemon that refuses the subscription (no events in degraded mode) is polled', async () => {
		const { transport, timers, driver, refresh, count } = make(true);
		transport.replies = [new AxisDaemonCallError('E_METHOD_NOT_FOUND')];
		driver.start(refresh);
		await timers.fire(d => d === 0);
		assert.strictEqual(driver.eventsLive, false);
		await timers.fire(d => d === POLL_MIN_MS);
		assert.strictEqual(count(), 1);
		driver.dispose();
	});

	test('stop and dispose leave no timer or listener; pause reaches both drivers', async () => {
		const { transport, timers, driver, refresh } = make(true);
		driver.start(refresh);
		await timers.fire(d => d === 0);
		driver.setPaused(true);
		assert.strictEqual(timers.pending.size, 0);
		driver.setPaused(false);
		driver.stop();
		assert.strictEqual(timers.pending.size, 0);
		assert.strictEqual(transport.listeners, false);
		driver.start(refresh);
		driver.dispose();
		assert.strictEqual(timers.pending.size, 0);
		assert.strictEqual(transport.listeners, false);
		driver.start(refresh);
		assert.strictEqual(timers.pending.size, 0, 'a disposed driver does not start');
	});
});
