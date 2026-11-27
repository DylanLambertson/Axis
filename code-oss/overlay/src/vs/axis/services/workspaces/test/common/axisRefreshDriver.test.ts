/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisPollDriver, IAxisTimers, POLL_MAX_BACKOFF_MS, POLL_MAX_MS, POLL_MIN_MS } from '../../common/axisRefreshDriver.js';

/** Timers the test fires by hand; nothing here waits for wall-clock time. */
class ManualTimers implements IAxisTimers {
	private nextHandle = 1;
	readonly pending = new Map<number, { callback: () => void; delayMs: number }>();
	set(callback: () => void, delayMs: number): unknown {
		const handle = this.nextHandle++;
		this.pending.set(handle, { callback, delayMs });
		return handle;
	}
	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}
	/** The delay of the only pending timer. */
	get delay(): number {
		assert.strictEqual(this.pending.size, 1, 'exactly one timer is pending');
		return [...this.pending.values()][0].delayMs;
	}
	async fire(): Promise<void> {
		assert.strictEqual(this.pending.size, 1, 'exactly one timer is pending');
		const [handle, timer] = [...this.pending.entries()][0];
		this.pending.delete(handle);
		timer.callback();
		await flush();
	}
}

/** Lets promise continuations run (no timers involved). */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

suite('Axis poll driver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('waits 1 to 2 s after start, with the jitter taken from the random source', async () => {
		for (const [random, expected] of [[0, POLL_MIN_MS], [0.5, 1500], [1, POLL_MAX_MS]] as const) {
			const timers = new ManualTimers();
			const driver = new AxisPollDriver(timers, () => random);
			driver.start(async () => true);
			assert.strictEqual(timers.delay, expected);
			driver.dispose();
		}
	});

	test('a random source outside 0..1 cannot push the delay out of range', () => {
		for (const random of [-5, 7, NaN]) {
			const timers = new ManualTimers();
			const driver = new AxisPollDriver(timers, () => random);
			driver.start(async () => true);
			assert.ok(timers.delay >= POLL_MIN_MS && timers.delay <= POLL_MAX_MS, `delay ${timers.delay} for ${random}`);
			driver.dispose();
		}
	});

	test('never runs two refreshes at once and schedules the next one only when the first ends', async () => {
		const timers = new ManualTimers();
		const driver = new AxisPollDriver(timers, () => 0);
		let release!: (ok: boolean) => void;
		let started = 0;
		driver.start(() => { started++; return new Promise<boolean>(resolve => { release = resolve; }); });
		await timers.fire();
		assert.strictEqual(started, 1);
		assert.strictEqual(timers.pending.size, 0, 'no timer while a refresh is running');
		driver.setPaused(true);
		driver.setPaused(false);
		assert.strictEqual(timers.pending.size, 0, 'resuming does not start a second refresh');
		release(true);
		await flush();
		assert.strictEqual(timers.pending.size, 1);
		driver.dispose();
	});

	test('backs off on failure, up to 16 s, and returns to normal on the first success', async () => {
		const timers = new ManualTimers();
		const driver = new AxisPollDriver(timers, () => 0);
		let ok = false;
		driver.start(async () => ok);
		const delays: number[] = [timers.delay];
		for (let i = 0; i < 6; i++) {
			await timers.fire();
			delays.push(timers.delay);
		}
		assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16_000, 16_000, 16_000]);
		assert.strictEqual(Math.max(...delays), POLL_MAX_BACKOFF_MS);
		ok = true;
		await timers.fire();
		assert.strictEqual(timers.delay, POLL_MIN_MS);
		driver.dispose();
	});

	test('a refresh that throws counts as a failure and the polling goes on', async () => {
		const timers = new ManualTimers();
		const driver = new AxisPollDriver(timers, () => 0);
		driver.start(async () => { throw new Error('boom'); });
		await timers.fire();
		assert.strictEqual(timers.delay, 2000);
		driver.dispose();
	});

	test('stop and dispose leave no timer behind, and a refresh finishing after stop schedules nothing', async () => {
		const timers = new ManualTimers();
		const driver = new AxisPollDriver(timers, () => 0);
		let release!: (ok: boolean) => void;
		driver.start(() => new Promise<boolean>(resolve => { release = resolve; }));
		await timers.fire();
		driver.stop();
		release(true);
		await flush();
		assert.strictEqual(timers.pending.size, 0, 'nothing follows a stopped driver');

		driver.start(async () => true);
		assert.strictEqual(timers.pending.size, 1);
		driver.dispose();
		assert.strictEqual(timers.pending.size, 0);
		driver.start(async () => true);
		assert.strictEqual(timers.pending.size, 0, 'a disposed driver does not start');
	});

	test('a stop and a start while a refresh runs: the old refresh ends and the new run is scheduled, its backoff untouched', async () => {
		const timers = new ManualTimers();
		const driver = new AxisPollDriver(timers, () => 0);
		let release!: (ok: boolean) => void;
		driver.start(() => new Promise<boolean>(resolve => { release = resolve; }));
		await timers.fire();
		driver.stop();
		driver.start(async () => true);
		assert.strictEqual(timers.pending.size, 0, 'no second refresh while the old one still runs');
		release(false); // the old run failed, which says nothing about the new one
		await flush();
		assert.strictEqual(timers.pending.size, 1, 'the new run is scheduled when the old refresh ends');
		assert.strictEqual(timers.delay, POLL_MIN_MS, 'no backoff from the old run');
		driver.dispose();
	});

	test('pausing holds no timer and resuming schedules one', async () => {
		const timers = new ManualTimers();
		const driver = new AxisPollDriver(timers, () => 0);
		driver.start(async () => true);
		driver.setPaused(true);
		assert.strictEqual(timers.pending.size, 0);
		driver.setPaused(true);
		driver.setPaused(false);
		assert.strictEqual(timers.pending.size, 1);
		driver.dispose();
	});

	test('start is idempotent: a second start does not add a timer or replace the refresh', async () => {
		const timers = new ManualTimers();
		const driver = new AxisPollDriver(timers, () => 0);
		const calls: string[] = [];
		driver.start(async () => { calls.push('first'); return true; });
		driver.start(async () => { calls.push('second'); return true; });
		assert.strictEqual(timers.pending.size, 1);
		await timers.fire();
		assert.deepStrictEqual(calls, ['first']);
		driver.dispose();
	});
});
