/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IAxisDaemonClient, IAxisEventTransport } from '../../daemon/common/axisDaemonClient.js';
import { AxisEventSubscription, IAxisEventPosition } from '../../daemon/common/axisEventSubscription.js';
import { AxisPollDriver, IAxisRefreshDriver, IAxisTimers, POLL_MAX_BACKOFF_MS } from './axisRefreshDriver.js';

/*
 * The event-driven refresh (docs/design/axis-shell-a3.md). An event is only a hint that something changed, so the driver
 * answers it the way the poll driver answers a timer: it calls `refresh`, which reads the daemon through `AxisDaemonApi`
 * (validated, bounded) and replaces the snapshot. Nothing from a frame reaches the models.
 */

const REAL_TIMERS: IAxisTimers = {
	set: (callback, delayMs) => setTimeout(callback, delayMs),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Events arriving within this time of each other cause one refresh. */
export const EVENT_DEBOUNCE_MS = 150;
/** Without any event, the data is read again after 30 to 60 s, in case a hint was lost. */
export const RECONCILE_MIN_MS = 30_000;
export const RECONCILE_MAX_MS = 60_000;
const RETRY_BASE_MS = 1000;

type TimerKind = 'connect' | 'refresh' | 'reconcile';

export class AxisEventDriver implements IAxisRefreshDriver {

	private refresh: (() => Promise<boolean>) | undefined;
	private subscription: AxisEventSubscription | undefined;
	private position: IAxisEventPosition | undefined;
	private cancellation: CancellationTokenSource | undefined;
	private timer: unknown;
	private timerKind: TimerKind | undefined;
	private connecting = false;
	private refreshing = false;
	private dirty = false;
	private urgent = false;
	/** Failed reads in a row. */
	private failures = 0;
	/** Failed or lost subscriptions in a row; reset only when a stream delivers a valid frame, so a stream that breaks at once keeps backing off. */
	private connectFailures = 0;
	private watchHandle: { dispose(): void } | undefined;
	private paused = false;
	private disposed = false;
	private generation = 0;

	/**
	 * @param transport the connection's event side, read on every connect (it may appear or go away with the connection)
	 * @param onLive called with `true` once subscribed and `false` whenever the subscription is lost or cannot be made
	 */
	constructor(
		private readonly transport: () => IAxisEventTransport | undefined,
		private readonly onLive: (live: boolean) => void = () => { },
		private readonly timers: IAxisTimers = REAL_TIMERS,
		private readonly random: () => number = Math.random,
	) { }

	get live(): boolean {
		return this.subscription !== undefined && !this.connecting;
	}

	start(refresh: () => Promise<boolean>): void {
		if (this.disposed || this.refresh) {
			return;
		}
		this.refresh = refresh;
		this.failures = 0;
		this.connectFailures = 0;
		this.dirty = false;
		this.urgent = false;
		this.generation++;
		this.arm();
	}

	stop(): void {
		this.refresh = undefined;
		this.generation++;
		this.cancelTimer();
		this.teardown();
		this.connecting = false;
		this.refreshing = false;
	}

	setPaused(paused: boolean): void {
		if (paused === this.paused) {
			return;
		}
		this.paused = paused;
		if (paused) {
			this.cancelTimer(); // frames are still consumed and acknowledged; they only mark the data as changed
		} else {
			this.arm();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	private arm(): void {
		if (this.timerKind === 'reconcile' && this.dirty) {
			this.cancelTimer(); // a hint arrived: the slow reconcile must not hold the read back
		}
		if (!this.refresh || this.paused || this.connecting || this.refreshing || this.timerKind !== undefined) {
			return;
		}
		let kind: TimerKind;
		let delay: number;
		if (!this.subscription) {
			kind = 'connect';
			delay = this.connectFailures === 0 ? 0 : this.backoff(this.connectFailures);
		} else if (this.dirty) {
			kind = 'refresh';
			delay = this.failures > 0 ? this.backoff(this.failures) : this.urgent ? 0 : EVENT_DEBOUNCE_MS;
		} else {
			kind = 'reconcile';
			delay = RECONCILE_MIN_MS + this.unit() * (RECONCILE_MAX_MS - RECONCILE_MIN_MS);
		}
		const generation = this.generation;
		this.timerKind = kind;
		this.timer = this.timers.set(() => {
			this.timerKind = undefined;
			this.timer = undefined;
			if (generation === this.generation) {
				void (kind === 'connect' ? this.connect(generation) : this.read(generation));
			}
		}, delay);
	}

	private cancelTimer(): void {
		if (this.timerKind !== undefined) {
			this.timers.clear(this.timer);
			this.timerKind = undefined;
			this.timer = undefined;
		}
	}

	private unit(): number {
		const r = this.random();
		return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
	}

	private backoff(failures: number): number {
		return Math.min(POLL_MAX_BACKOFF_MS, RETRY_BASE_MS * (1 + this.unit()) * 2 ** Math.min(failures - 1, 8));
	}

	private teardown(): void {
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		this.cancellation = undefined;
		this.watchHandle?.dispose();
		this.watchHandle = undefined;
		const sub = this.subscription;
		this.subscription = undefined;
		this.position = sub?.position ?? this.position; // the next subscription asks to resume from here
		sub?.dispose();
	}

	private async connect(generation: number): Promise<void> {
		const transport = this.transport();
		if (!transport) {
			return this.lost(generation);
		}
		this.connecting = true;
		this.cancellation = new CancellationTokenSource();
		const subscription = new AxisEventSubscription(transport, this.timers, {
			onEvent: () => this.hint(false),
			onResync: () => this.hint(true),
			onClosed: reason => this.dropped(subscription, reason),
		});
		this.watchHandle?.dispose();
		this.watchHandle = transport.onDidClose(() => subscription.connectionClosed());
		this.subscription = subscription;
		try {
			const { resumed } = await subscription.open(this.position, this.cancellation.token);
			if (generation !== this.generation || this.subscription !== subscription) {
				return; // stopped, or the subscription was already lost while opening
			}
			this.connecting = false;
			this.position = subscription.position;
			if (!resumed) {
				this.hint(true); // a fresh stream says nothing about the past: read everything
			}
			this.onLive(true);
			this.arm();
		} catch {
			if (generation === this.generation && this.subscription === subscription) {
				this.teardown();
				this.lost(generation);
			}
		}
	}

	/** A valid frame was consumed: the stream works, so connection backoff starts over. */
	private hint(urgent: boolean): void {
		this.connectFailures = 0;
		this.dirty = true;
		this.urgent = this.urgent || urgent;
		this.arm();
	}

	/** The subscription ended (the daemon said so, broke the protocol, or the connection closed): reconnect with backoff. */
	private dropped(subscription: AxisEventSubscription, reason: 'end' | 'violation' | 'connection'): void {
		if (this.subscription !== subscription) {
			return;
		}
		// After a protocol violation the old position is not trusted: no resume, so the next stream starts from a fresh baseline.
		this.position = reason === 'violation' ? undefined : subscription.position ?? this.position;
		this.watchHandle?.dispose();
		this.watchHandle = undefined;
		this.subscription = undefined;
		this.connecting = false;
		this.cancelTimer();
		this.lost(this.generation);
	}

	private lost(generation: number): void {
		if (generation !== this.generation) {
			return;
		}
		this.connecting = false;
		this.connectFailures++;
		this.onLive(false); // events may be missed from here on: the next subscription reads everything unless it resumes

		this.arm();
	}

	private async read(generation: number): Promise<void> {
		const refresh = this.refresh;
		if (!refresh) {
			return;
		}
		this.refreshing = true;
		this.dirty = false;
		this.urgent = false;
		let ok = false;
		try {
			ok = await refresh();
		} catch {
			ok = false;
		}
		if (generation !== this.generation) {
			return;
		}
		this.refreshing = false;
		if (ok) {
			this.failures = 0;
		} else {
			this.failures++;
			this.dirty = true;
		}
		this.arm();
	}
}

/**
 * The driver the shell uses: events when the connection offers `axis.events/1` and the subscription holds, the poll driver
 * otherwise (no capability, the daemon refuses the subscription, or while it is being re-established). It never leaves the
 * window without one of the two.
 */
export class AxisAdaptiveRefreshDriver implements IAxisRefreshDriver {

	private readonly events: AxisEventDriver;
	private readonly poll: AxisPollDriver;
	private refresh: (() => Promise<boolean>) | undefined;
	private disposed = false;

	constructor(client: Pick<IAxisDaemonClient, 'events'>, timers: IAxisTimers = REAL_TIMERS, random: () => number = Math.random) {
		this.poll = new AxisPollDriver(timers, random);
		this.events = new AxisEventDriver(() => client.events, live => this.mode(live), timers, random);
	}

	/** Whether the events subscription is what currently drives refreshes. */
	get eventsLive(): boolean {
		return this.events.live;
	}

	start(refresh: () => Promise<boolean>): void {
		if (this.disposed || this.refresh) {
			return;
		}
		this.refresh = refresh;
		this.poll.start(refresh); // polls until the subscription is up
		this.events.start(refresh);
	}

	stop(): void {
		this.refresh = undefined;
		this.events.stop();
		this.poll.stop();
	}

	setPaused(paused: boolean): void {
		this.events.setPaused(paused);
		this.poll.setPaused(paused);
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.events.dispose();
		this.poll.dispose();
	}

	private mode(live: boolean): void {
		const refresh = this.refresh;
		if (!refresh) {
			return;
		}
		if (live) {
			this.poll.stop();
		} else {
			this.poll.start(refresh);
		}
	}
}
