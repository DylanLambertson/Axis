/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonCallError } from '../../common/axisDaemonClient.js';
import { AxisEventBody } from '../../common/axisEventFrames.js';
import { ACK_BATCH, ACK_DELAY_MS, AxisEventSubscription, IAxisEventSink } from '../../common/axisEventSubscription.js';
import { endFrame, EPOCH, eventFrame, FakeEventTransport, flush, ManualTimers, reply, resyncFrame, SUB, SUB2 } from './axisEventFixtures.js';

class Sink implements IAxisEventSink {
	readonly events: AxisEventBody[] = [];
	resyncs = 0;
	readonly closed: string[] = [];
	throws = false;
	onEvent(body: AxisEventBody): void { this.events.push(body); if (this.throws) { throw new Error('boom'); } }
	onResync(): void { this.resyncs++; }
	onClosed(reason: string): void { this.closed.push(reason); }
}

async function opened(replyValue: Record<string, unknown> = reply(), resumeFrom?: { epoch: string; seq: number }) {
	const transport = new FakeEventTransport();
	transport.replies = [replyValue];
	const timers = new ManualTimers();
	const sink = new Sink();
	const sub = new AxisEventSubscription(transport, timers, sink);
	const result = await sub.open(resumeFrom);
	return { transport, timers, sink, sub, result };
}

suite('Axis event subscription', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('subscribes to the three shell topics, with resumeFrom only when given', async () => {
		const a = await opened();
		assert.deepStrictEqual(a.transport.subscribes, [{ topics: ['workspaces', 'runs', 'approvals'] }]);
		a.sub.dispose();
		const b = await opened(reply({ resumed: true }), { epoch: EPOCH, seq: 4 });
		assert.deepStrictEqual(b.transport.subscribes, [{ topics: ['workspaces', 'runs', 'approvals'], resumeFrom: { epoch: EPOCH, seq: 4 } }]);
		assert.strictEqual(b.result.resumed, true);
		b.sub.dispose();
	});

	test('an event reaches the sink and is acknowledged after a delay with the last seq', async () => {
		const { transport, timers, sink, sub } = await opened();
		transport.push(eventFrame(11, { topic: 'workspaces', workspaceId: 'ws-a' }));
		transport.push(eventFrame(15, { topic: 'runs', runId: 'run-1', state: 'FAILED' }));
		assert.deepStrictEqual(sink.events, [{ topic: 'workspaces', workspaceId: 'ws-a' }, { topic: 'runs', runId: 'run-1', state: 'FAILED' }]);
		assert.deepStrictEqual(transport.acks, [], 'credit is not returned before the delay');
		assert.deepStrictEqual(timers.delays, [ACK_DELAY_MS]);
		await timers.fire();
		assert.deepStrictEqual(transport.acks, [{ id: SUB, seq: 15 }]);
		assert.strictEqual(sub.outstanding, 0);
		assert.strictEqual(timers.pending.size, 0);
		sub.dispose();
	});

	test('a full batch is acknowledged at once, covering exactly the frames received', async () => {
		const { transport, timers, sub } = await opened();
		for (let i = 1; i < ACK_BATCH; i++) {
			transport.push(eventFrame(10 + i));
		}
		assert.deepStrictEqual(transport.acks, []);
		transport.push(eventFrame(10 + ACK_BATCH));
		assert.deepStrictEqual(transport.acks, [{ id: SUB, seq: 10 + ACK_BATCH }]);
		assert.strictEqual(timers.pending.size, 0, 'the delayed ack was cancelled by the batch ack');
		assert.strictEqual(sub.outstanding, 0);
		sub.dispose();
	});

	test('an ack never names a seq above the last frame received', async () => {
		const { transport, timers, sub } = await opened();
		for (let round = 0; round < 5; round++) {
			for (let i = 0; i < 20; i++) {
				const seq = 11 + round * 100 + i * 3; // gaps are not losses
				transport.push(eventFrame(seq));
				for (const ack of transport.acks) {
					assert.ok(ack.seq <= seq);
				}
			}
			if (timers.pending.size > 0) {
				await timers.fire();
			}
		}
		assert.strictEqual(transport.acks[transport.acks.length - 1].seq, 11 + 4 * 100 + 19 * 3);
		sub.dispose();
	});

	test('more unacknowledged frames than the granted window ends the subscription', async () => {
		const { transport, sink } = await opened(reply({ window: 3 }));
		transport.ackThrows = true; // credit cannot be returned
		transport.push(eventFrame(11));
		transport.push(eventFrame(12));
		transport.push(eventFrame(13));
		assert.deepStrictEqual(sink.closed, []);
		transport.push(eventFrame(14));
		assert.deepStrictEqual(sink.closed, ['violation']);
		assert.strictEqual(sink.events.length, 3, 'the frame beyond the window is not applied');
	});

	test('the default window of 32 is enforced the same way', async () => {
		const { transport, sink } = await opened();
		transport.ackThrows = true;
		for (let i = 1; i <= 32; i++) {
			transport.push(eventFrame(10 + i));
		}
		assert.deepStrictEqual(sink.closed, []);
		transport.push(eventFrame(43));
		assert.deepStrictEqual(sink.closed, ['violation']);
	});

	test('an event whose seq does not increase is a violation; a gap is not', async () => {
		const a = await opened();
		a.transport.push(eventFrame(20));
		a.transport.push(eventFrame(95));
		assert.deepStrictEqual(a.sink.closed, []);
		a.transport.push(eventFrame(95));
		assert.deepStrictEqual(a.sink.closed, ['violation']);
		const b = await opened();
		b.transport.push(eventFrame(10)); // the head in the reply: only later events may follow
		assert.deepStrictEqual(b.sink.closed, ['violation']);
		const c = await opened();
		c.transport.push(eventFrame(30));
		c.transport.push(eventFrame(29));
		assert.deepStrictEqual(c.sink.closed, ['violation']);
	});

	test('a resync may carry the seq of the last event but not a lower one, and counts against the window', async () => {
		const a = await opened();
		a.transport.push(eventFrame(20));
		a.transport.push(resyncFrame(20));
		assert.strictEqual(a.sink.resyncs, 1);
		assert.deepStrictEqual(a.sink.closed, []);
		a.transport.push(resyncFrame(19));
		assert.deepStrictEqual(a.sink.closed, ['violation']);
		const b = await opened(reply({ window: 2 }));
		b.transport.ackThrows = true;
		b.transport.push(resyncFrame(10));
		b.transport.push(eventFrame(11));
		b.transport.push(resyncFrame(12));
		assert.deepStrictEqual(b.sink.closed, ['violation']);
	});

	test('a malformed frame of this subscription ends it; a frame of another subscription is ignored and not acknowledged', async () => {
		const a = await opened();
		a.transport.push({ ...eventFrame(20), extra: 1 });
		assert.deepStrictEqual(a.sink.closed, ['violation']);
		assert.deepStrictEqual(a.sink.events, []);
		const b = await opened();
		b.transport.push(eventFrame(20, { topic: 'approvals' }, SUB2));
		b.transport.push({ garbage: true });
		b.transport.push(null);
		assert.deepStrictEqual(b.sink.closed, []);
		assert.deepStrictEqual(b.sink.events, []);
		assert.strictEqual(b.timers.pending.size, 0);
		b.sub.dispose();
	});

	test('an event with an unknown body is a hint: the body is dropped, everything is read again, credit is returned, the stream goes on', async () => {
		const { transport, sink } = await opened();
		transport.push(eventFrame(11, { topic: 'runs', runId: 'run-1', newField: 1 }));
		transport.push(eventFrame(12, { topic: 'newtopic' }));
		transport.push(eventFrame(12, { topic: 'newtopic' })); // a repeated seq is still a violation, as for any event
		assert.deepStrictEqual(sink.events, []);
		assert.strictEqual(sink.resyncs, 2);
		assert.deepStrictEqual(sink.closed, ['violation']);
		const b = await opened();
		b.transport.push(eventFrame(11, { topic: 'newtopic' }));
		await b.timers.fire();
		assert.deepStrictEqual(b.transport.acks, [{ id: SUB, seq: 11 }]);
		assert.deepStrictEqual(b.sink.closed, []);
		b.sub.dispose();
	});

	test('a flood of frames of another subscription before the reply does not end this one, and cannot crowd its frames out', async () => {
		const transport = new FakeEventTransport();
		transport.replies = [() => {
			for (let i = 0; i < 100; i++) {
				transport.push(eventFrame(100 + i, { topic: 'approvals' }, SUB2));
			}
			transport.push(eventFrame(11, { topic: 'runs', runId: 'run-1' }));
			for (let i = 0; i < 100; i++) {
				transport.push(eventFrame(300 + i, { topic: 'approvals' }, SUB2));
			}
			transport.push(eventFrame(12, { topic: 'approvals' }));
			return reply();
		}];
		const sink = new Sink();
		const sub = new AxisEventSubscription(transport, new ManualTimers(), sink);
		await sub.open();
		assert.deepStrictEqual(sink.closed, []);
		assert.deepStrictEqual(sink.events, [{ topic: 'runs', runId: 'run-1' }, { topic: 'approvals' }]);
		assert.deepStrictEqual(transport.acks, [], 'foreign frames are never acknowledged');
		sub.dispose();
	});

	test('what is held before the reply stays bounded however many subscriptions flood', async () => {
		const transport = new FakeEventTransport();
		let held = -1;
		let subscription: AxisEventSubscription | undefined;
		transport.replies = [() => {
			for (let i = 0; i < 100; i++) {
				for (let j = 0; j < 40; j++) {
					transport.push(eventFrame(100 + j, { topic: 'approvals' }, `sub-${String(i).padStart(22, 'X')}`));
				}
			}
			held = subscription!.bufferedEarly;
			return reply();
		}];
		subscription = new AxisEventSubscription(transport, new ManualTimers(), new Sink());
		await subscription.open();
		assert.ok(held > 0 && held <= 8 * 32, `held ${held}`);
		subscription.dispose();
	});

	test('frames with no usable sub before the reply are dropped, and several foreign subscriptions flooding at once do not hide the real one', async () => {
		const transport = new FakeEventTransport();
		transport.replies = [() => {
			transport.push({ seq: 1 });
			transport.push(null);
			transport.push({ sub: 5 });
			for (let i = 0; i < 7; i++) { // the ids that can really be around: this connection's earlier subscriptions (at most 4)
				for (let j = 0; j < 40; j++) {
					transport.push(eventFrame(100 + j, { topic: 'approvals' }, `sub-${String(i).padStart(22, 'X')}`));
				}
			}
			transport.push(eventFrame(11, { topic: 'runs', runId: 'run-1' }));
			return reply();
		}];
		const sink = new Sink();
		const sub = new AxisEventSubscription(transport, new ManualTimers(), sink);
		await sub.open();
		assert.deepStrictEqual(sink.closed, []);
		assert.deepStrictEqual(sink.events, [{ topic: 'runs', runId: 'run-1' }]);
		sub.dispose();
	});

	test('frames that arrive before the reply is processed are applied afterwards, in order', async () => {
		const transport = new FakeEventTransport();
		transport.replies = [() => {
			transport.push(eventFrame(11, { topic: 'runs', runId: 'run-1' }));
			transport.push(eventFrame(12, { topic: 'approvals' }));
			transport.push(eventFrame(13, { topic: 'runs', runId: 'run-2' }, SUB2));
			return reply();
		}];
		const sink = new Sink();
		const sub = new AxisEventSubscription(transport, new ManualTimers(), sink);
		await sub.open();
		assert.deepStrictEqual(sink.events, [{ topic: 'runs', runId: 'run-1' }, { topic: 'approvals' }]);
		assert.deepStrictEqual(sink.closed, []);
		sub.dispose();
	});

	test('more than one window of early frames is a violation, and nothing of them is applied', async () => {
		const transport = new FakeEventTransport();
		transport.replies = [() => {
			for (let i = 0; i < 33; i++) {
				transport.push(eventFrame(11 + i));
			}
			return reply();
		}];
		const sink = new Sink();
		const sub = new AxisEventSubscription(transport, new ManualTimers(), sink);
		await sub.open();
		assert.deepStrictEqual(sink.closed, ['violation']);
		assert.deepStrictEqual(sink.events, []);
		assert.deepStrictEqual(transport.unsubscribes, [SUB]);
	});

	test('an invalid reply fails the open as invalid_reply and leaves no listener', async () => {
		for (const bad of [reply({ window: 64 }), reply({ extra: 1 }), 'x', reply({ resumed: true })]) {
			const transport = new FakeEventTransport();
			transport.replies = [bad];
			const sub = new AxisEventSubscription(transport, new ManualTimers(), new Sink());
			await assert.rejects(sub.open(), (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'invalid_reply');
			assert.strictEqual(transport.listeners, false);
		}
	});

	test('a refused subscribe rejects with the call error and leaves no listener', async () => {
		const transport = new FakeEventTransport();
		transport.replies = [new AxisDaemonCallError('E_METHOD_NOT_FOUND')];
		const sub = new AxisEventSubscription(transport, new ManualTimers(), new Sink());
		await assert.rejects(sub.open(), (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'E_METHOD_NOT_FOUND');
		assert.strictEqual(transport.listeners, false);
	});

	test('a resumed subscription continues after resumeFrom.seq, a fresh one after the reply seq', async () => {
		const resumed = await opened(reply({ resumed: true, seq: 50 }), { epoch: EPOCH, seq: 30 });
		resumed.transport.push(eventFrame(31)); // a replayed event, older than the reply seq
		assert.deepStrictEqual(resumed.sink.closed, []);
		assert.strictEqual(resumed.sink.events.length, 1);
		resumed.transport.push(eventFrame(30));
		assert.deepStrictEqual(resumed.sink.closed, ['violation']);
		const fresh = await opened(reply({ resumed: false, seq: 50 }), { epoch: EPOCH, seq: 30 });
		fresh.transport.push(eventFrame(40));
		assert.deepStrictEqual(fresh.sink.closed, ['violation'], 'not resumed: the stream starts after the reply seq');
	});

	test('position follows the last frame, for the next resumeFrom', async () => {
		const { transport, sub } = await opened();
		assert.deepStrictEqual(sub.position, { epoch: EPOCH, seq: 10 });
		transport.push(eventFrame(25));
		assert.deepStrictEqual(sub.position, { epoch: EPOCH, seq: 25 });
		sub.dispose();
	});

	test('the daemon ending the subscription reports end and does not unsubscribe', async () => {
		const { transport, sink, sub } = await opened();
		transport.push(endFrame());
		assert.deepStrictEqual(sink.closed, ['end']);
		sub.dispose();
		assert.deepStrictEqual(transport.unsubscribes, []);
		assert.strictEqual(transport.listeners, false);
	});

	test('a closed connection reports connection and does not unsubscribe', async () => {
		const { transport, sink, sub } = await opened();
		sub.connectionClosed();
		assert.deepStrictEqual(sink.closed, ['connection']);
		assert.deepStrictEqual(transport.unsubscribes, []);
		sub.dispose();
	});

	test('dispose unsubscribes once, stops frames and acks, and clears its timer', async () => {
		const { transport, timers, sink, sub } = await opened();
		transport.push(eventFrame(11));
		assert.strictEqual(timers.pending.size, 1);
		sub.dispose();
		sub.dispose();
		await flush();
		assert.strictEqual(timers.pending.size, 0);
		assert.deepStrictEqual(transport.unsubscribes, [SUB]);
		transport.push(eventFrame(12));
		assert.strictEqual(sink.events.length, 1);
		assert.deepStrictEqual(transport.acks, []);
		assert.strictEqual(transport.listeners, false);
	});

	test('a dispose while the subscribe is pending releases the new subscription', async () => {
		const transport = new FakeEventTransport();
		const sink = new Sink();
		const sub = new AxisEventSubscription(transport, new ManualTimers(), sink);
		const opening = sub.open();
		sub.dispose();
		await assert.rejects(opening, (e: unknown) => e instanceof AxisDaemonCallError && e.code === 'E_CANCELLED');
		assert.deepStrictEqual(transport.unsubscribes, [SUB]);
	});

	test('a sink that throws still has the frame counted and acknowledged', async () => {
		const { transport, timers, sink, sub } = await opened();
		sink.throws = true;
		transport.push(eventFrame(11));
		assert.strictEqual(sub.outstanding, 1);
		await timers.fire();
		assert.deepStrictEqual(transport.acks, [{ id: SUB, seq: 11 }]);
		assert.deepStrictEqual(sink.closed, []);
		sub.dispose();
	});

	test('a failed ack leaves the credit outstanding, ends nothing by itself, and is retried', async () => {
		const { transport, timers, sink, sub } = await opened();
		transport.ackThrows = true;
		transport.push(eventFrame(11));
		await timers.fire();
		assert.strictEqual(sub.outstanding, 1);
		assert.deepStrictEqual(sink.closed, []);
		assert.deepStrictEqual(timers.delays, [ACK_DELAY_MS], 'a retry is scheduled');
		transport.ackThrows = false;
		await timers.fire();
		assert.deepStrictEqual(transport.acks, [{ id: SUB, seq: 11 }]);
		assert.strictEqual(sub.outstanding, 0);
		assert.strictEqual(timers.pending.size, 0);
		sub.dispose();
	});
});
