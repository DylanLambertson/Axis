/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { AxisDaemonCallError, IAxisEventTransport } from '../../common/axisDaemonClient.js';
import { IAxisTimers } from '../../../workspaces/common/axisRefreshDriver.js';

export const SUB = 'sub-AAAAAAAAAAAAAAAAAAAAAA';
export const SUB2 = 'sub-BBBBBBBBBBBBBBBBBBBBBB';
export const EPOCH = 'epoch-AAAAAAAAAAAAAAAAAAAA';
export const EPOCH2 = 'epoch-BBBBBBBBBBBBBBBBBBBB';

/** Timers the test fires by hand; nothing here waits for wall-clock time. */
export class ManualTimers implements IAxisTimers {
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
	get delays(): number[] {
		return [...this.pending.values()].map(t => t.delayMs);
	}
	/** Fires the oldest pending timer whose delay matches, then lets promises settle. */
	async fire(match: (delayMs: number) => boolean = () => true): Promise<void> {
		const found = [...this.pending.entries()].find(([, t]) => match(t.delayMs));
		if (!found) {
			throw new Error(`no pending timer matches; pending delays: ${JSON.stringify(this.delays)}`);
		}
		this.pending.delete(found[0]);
		found[1].callback();
		await flush();
	}
}

/** Lets promise continuations run (no timers involved). */
export async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

export function reply(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { subscriptionId: SUB, epoch: EPOCH, seq: 10, resumed: false, window: 32, ...extra };
}

export function eventFrame(seq: number, event: Record<string, unknown> = { topic: 'approvals' }, sub = SUB): Record<string, unknown> {
	return { v: 1, sub, seq, event };
}

export function resyncFrame(seq: number, sub = SUB): Record<string, unknown> {
	return { v: 1, sub, seq, resync: { reason: 'overflow' } };
}

export function endFrame(sub = SUB): Record<string, unknown> {
	return { v: 1, sub, end: { reason: 'shutdown' } };
}

/** A scripted event side of the connection: records calls, lets the test push frames and close the connection. */
export class FakeEventTransport implements IAxisEventTransport {
	readonly subscribes: object[] = [];
	readonly unsubscribes: string[] = [];
	readonly acks: Array<{ id: string; seq: number }> = [];
	/** Replies, consumed in order; the last one repeats. A function runs at call time (it may push frames or throw). */
	replies: Array<unknown | (() => unknown)> = [reply()];
	ackThrows = false;
	private calls = 0;
	private readonly frames = new Emitter<unknown>();
	private readonly closes = new Emitter<void>();
	readonly onFrame = this.frames.event;
	readonly onDidClose = this.closes.event;

	async subscribe(params: object): Promise<unknown> {
		this.subscribes.push(params);
		const next = this.replies[Math.min(this.calls++, this.replies.length - 1)];
		const value = typeof next === 'function' ? (next as () => unknown)() : next;
		if (value instanceof AxisDaemonCallError) {
			throw value;
		}
		return value;
	}

	async unsubscribe(subscriptionId: string): Promise<unknown> {
		this.unsubscribes.push(subscriptionId);
		return { subscriptionId };
	}

	ack(subscriptionId: string, seq: number): void {
		if (this.ackThrows) {
			throw new Error('closed');
		}
		this.acks.push({ id: subscriptionId, seq });
	}

	push(frame: unknown): void {
		this.frames.fire(frame);
	}

	close(): void {
		this.closes.fire();
	}

	get listeners(): boolean {
		return this.frames.hasListeners() || this.closes.hasListeners();
	}
}
