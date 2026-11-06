/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IAxisTimers } from '../../workspaces/common/axisRefreshDriver.js';
import { AxisDaemonCallError, IAxisEventTransport } from './axisDaemonClient.js';
import { AxisEventBody, AxisServerFrame, EVENT_WINDOW, readServerFrame, readSubscribeReply, SHELL_EVENT_TOPICS } from './axisEventFrames.js';

/**
 * One `axis.events/1` subscription as the shell sees it (docs/design/axis-shell-a3.md). It owns the credit protocol:
 *
 * - every frame is validated whole; a frame of this subscription that is malformed, out of order (an event whose `seq` does not
 *   increase, a resync below the last `seq`) or that exceeds the granted window ends the subscription as a violation;
 * - frames are handed to the sink synchronously and then counted as consumed, so nothing is queued here beyond the frames that
 *   arrive before the `subscribe` reply is processed (at most one window);
 * - credit is returned with `ack` once enough frames were consumed (`ACK_BATCH`) or after `ACK_DELAY_MS`, and an ack never names
 *   a `seq` the daemon has not sent, so it can never grant more than was delivered.
 *
 * A gap in `seq` is not a loss (the daemon filters and coalesces); a loss is only ever a `resync` frame or a lost connection.
 */

export const ACK_BATCH = 8;
export const ACK_DELAY_MS = 50;
/** Other subscriptions' frames seen before the reply (the old one still being released, say) are held per id, for at most this many ids. */
const MAX_EARLY_SUBS = 8;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,43}$/;

export interface IAxisEventSink {
	/** A valid event: a hint that the named thing changed. Called synchronously; must not throw (a throw is swallowed). */
	onEvent(body: AxisEventBody): void;
	/** The daemon dropped events: everything shown must be read again. */
	onResync(): void;
	/** The subscription is over and will not deliver again: the daemon ended it, broke the protocol, or the connection closed. */
	onClosed(reason: 'end' | 'violation' | 'connection'): void;
}

export interface IAxisEventPosition {
	readonly epoch: string;
	readonly seq: number;
}

export interface IAxisOpenResult {
	readonly resumed: boolean;
}

export class AxisEventSubscription implements IDisposable {

	private id: string | undefined;
	private window: number = EVENT_WINDOW;
	private lastSeq = 0;
	private epoch: string | undefined;
	private unacked = 0;
	private ackTimer: unknown;
	private hasAckTimer = false;
	/** Frames that arrived before the reply, by the `sub` they name; each list holds at most one window. */
	private early = new Map<string, unknown[]>();
	private readonly earlyOverflow = new Set<string>();
	private opening = false;
	private disposed = false;
	private ended = false;
	private readonly offs: Array<() => void> = [];

	constructor(
		private readonly transport: IAxisEventTransport,
		private readonly timers: IAxisTimers,
		private readonly sink: IAxisEventSink,
	) { }

	/** The last `{ epoch, seq }` seen, for `resumeFrom` on the next subscription; `undefined` before the first reply. */
	get position(): IAxisEventPosition | undefined {
		return this.epoch === undefined ? undefined : { epoch: this.epoch, seq: this.lastSeq };
	}

	/** Frames held before the reply was processed (bounded: a few ids, one window each). */
	get bufferedEarly(): number {
		let n = 0;
		for (const list of this.early.values()) {
			n += list.length;
		}
		return n;
	}

	/** Frames received and not yet acknowledged (never more than the window). */
	get outstanding(): number {
		return this.unacked;
	}

	async open(resumeFrom?: IAxisEventPosition, token?: CancellationToken): Promise<IAxisOpenResult> {
		this.opening = true;
		const listener = this.transport.onFrame(raw => this.receive(raw));
		this.offs.push(() => listener.dispose());
		const params = { topics: [...SHELL_EVENT_TOPICS], ...(resumeFrom ? { resumeFrom: { epoch: resumeFrom.epoch, seq: resumeFrom.seq } } : {}) };
		let raw: unknown;
		try {
			raw = await this.transport.subscribe(params, token);
		} catch (error) {
			this.opening = false;
			this.dispose();
			throw error;
		}
		const reply = readSubscribeReply(raw);
		// `resumed: true` without a `resumeFrom` is a daemon that answers a question that was not asked.
		if (!reply || (reply.resumed && !resumeFrom)) {
			this.opening = false;
			this.dispose();
			throw new AxisDaemonCallError('invalid_reply');
		}
		if (this.disposed) {
			this.release(reply.subscriptionId);
			throw new AxisDaemonCallError('E_CANCELLED');
		}
		this.opening = false;
		this.id = reply.subscriptionId;
		this.epoch = reply.epoch;
		this.window = reply.window;
		// Replayed frames follow `resumeFrom.seq`; a fresh subscription's frames follow the head in the reply.
		this.lastSeq = reply.resumed && resumeFrom ? resumeFrom.seq : reply.seq;
		const early = this.early.get(reply.subscriptionId) ?? [];
		const overflow = this.earlyOverflow.has(reply.subscriptionId);
		this.early.clear();
		this.earlyOverflow.clear();
		if (overflow) {
			this.violation();
		} else {
			for (const frame of early) {
				this.receive(frame);
			}
		}
		return { resumed: reply.resumed };
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearAckTimer();
		for (const off of this.offs.splice(0)) {
			off();
		}
		this.early.clear();
		const id = this.id;
		this.id = undefined;
		if (id !== undefined && !this.ended) {
			this.release(id);
		}
	}

	private receive(raw: unknown): void {
		if (this.disposed) {
			return;
		}
		const sub = subOf(raw);
		if (this.id === undefined) {
			// Before the reply is processed the id is unknown: keep at most one window of frames, judge them once it is.
			if (this.opening && typeof sub === 'string' && TOKEN_SHAPE.test(sub)) {
				const list = this.early.get(sub);
				if (list) {
					list.length < EVENT_WINDOW ? list.push(raw) : this.earlyOverflow.add(sub);
				} else if (this.early.size < MAX_EARLY_SUBS) {
					this.early.set(sub, [raw]);
				}
			}
			return;
		}
		if (sub !== this.id) {
			return; // another subscription's frame (an old one that was just dropped): not ours to judge or acknowledge
		}
		const frame = readServerFrame(raw);
		if (!frame) {
			return this.violation();
		}
		this.accept(frame);
	}

	private accept(frame: AxisServerFrame): void {
		if (frame.kind === 'end') {
			this.ended = true;
			this.finish('end');
			return;
		}
		const increases = frame.kind !== 'resync' ? frame.seq > this.lastSeq : frame.seq >= this.lastSeq;
		if (!increases || this.unacked + 1 > this.window) {
			return this.violation();
		}
		this.lastSeq = frame.seq;
		this.unacked++;
		try {
			if (frame.kind === 'event') {
				this.sink.onEvent(frame.event);
			} else if (frame.kind === 'opaque') {
				this.sink.onResync(); // an unknown hint: its body is discarded and everything shown is read again
			} else {
				this.sink.onResync();
			}
		} catch {
			// a hint that could not be applied is covered by the read the driver makes next
		}
		if (this.disposed) {
			return; // the sink ended the subscription while handling the frame
		}
		this.consumed();
	}

	/** Credit goes back after consumption: at once for a batch, otherwise after a short delay. */
	private consumed(): void {
		if (this.unacked >= Math.min(ACK_BATCH, this.window)) {
			this.flushAck();
		} else {
			this.scheduleAck();
		}
	}

	private scheduleAck(): void {
		if (this.hasAckTimer || this.disposed) {
			return;
		}
		this.hasAckTimer = true;
		this.ackTimer = this.timers.set(() => {
			this.hasAckTimer = false;
			this.ackTimer = undefined;
			this.flushAck();
		}, ACK_DELAY_MS);
	}

	private flushAck(): void {
		this.clearAckTimer();
		if (this.id === undefined || this.unacked === 0) {
			return;
		}
		try {
			this.transport.ack(this.id, this.lastSeq);
			this.unacked = 0;
		} catch {
			// the connection is closed (`onDidClose` ends this subscription) or the send failed: try again shortly, credit must not stay lost
			this.scheduleAck();
		}
	}

	private clearAckTimer(): void {
		if (this.hasAckTimer) {
			this.timers.clear(this.ackTimer);
			this.hasAckTimer = false;
			this.ackTimer = undefined;
		}
	}

	private violation(): void {
		this.finish('violation');
	}

	/** Called by the owner when the connection closed. */
	connectionClosed(): void {
		this.ended = true; // nothing to unsubscribe on a closed connection
		this.finish('connection');
	}

	private finish(reason: 'end' | 'violation' | 'connection'): void {
		if (this.disposed) {
			return;
		}
		this.dispose();
		try {
			this.sink.onClosed(reason);
		} catch {
			// the owner reconnects on its own schedule
		}
	}

	private release(id: string): void {
		this.transport.unsubscribe(id).catch(() => { /* best effort: the subscription dies with the connection anyway */ });
	}
}

function subOf(raw: unknown): unknown {
	return typeof raw === 'object' && raw !== null ? (raw as { sub?: unknown }).sub : undefined;
}
