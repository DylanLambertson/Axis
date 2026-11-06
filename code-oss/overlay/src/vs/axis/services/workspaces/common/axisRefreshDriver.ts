/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Decides when the workspace data is read again (docs/design/axis-shell-a2.md,
 * "Polling"). The poll driver below is the Phase 1 implementation; the
 * event-driven one (ticket E1) calls `refresh` on daemon events and keeps a
 * slow reconcile timer. The service depends on this interface only.
 */
export interface IAxisRefreshDriver extends IDisposable {
	/** Starts calling `refresh`. It resolves `true` when the data was read and `false` when the read failed. Idempotent. */
	start(refresh: () => Promise<boolean>): void;
	/** Stops, cancelling any timer. A refresh already running is not interrupted, but nothing follows it. */
	stop(): void;
	/** Pauses (window hidden) or resumes. A paused driver holds no timer. */
	setPaused(paused: boolean): void;
}

export interface IAxisTimers {
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

const REAL_TIMERS: IAxisTimers = {
	set: (callback, delayMs) => setTimeout(callback, delayMs),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const POLL_MIN_MS = 1000;
export const POLL_MAX_MS = 2000;
export const POLL_MAX_BACKOFF_MS = 16_000;

/**
 * Polls with a delay of 1 to 2 s (uniform jitter) measured from the end of the
 * previous refresh, so two refreshes never overlap. After a failure the delay
 * doubles each time up to 16 s and returns to normal on the first success.
 */
export class AxisPollDriver implements IAxisRefreshDriver {

	private refresh: (() => Promise<boolean>) | undefined;
	private timer: unknown;
	private hasTimer = false;
	private generation = 0;
	private failures = 0;
	private paused = false;
	private disposed = false;

	constructor(
		private readonly timers: IAxisTimers = REAL_TIMERS,
		private readonly random: () => number = Math.random,
	) { }

	start(refresh: () => Promise<boolean>): void {
		if (this.disposed || this.refresh) {
			return;
		}
		this.refresh = refresh;
		this.failures = 0;
		this.schedule();
	}

	stop(): void {
		this.refresh = undefined;
		this.generation++;
		this.cancel();
	}

	setPaused(paused: boolean): void {
		if (paused === this.paused) {
			return;
		}
		this.paused = paused;
		if (paused) {
			this.cancel();
		} else if (this.refresh && !this.running) {
			this.schedule();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	private running = false;

	private delay(): number {
		const r = this.random();
		const jitter = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
		const base = POLL_MIN_MS + jitter * (POLL_MAX_MS - POLL_MIN_MS);
		return Math.min(POLL_MAX_BACKOFF_MS, base * 2 ** Math.min(this.failures, 8));
	}

	private schedule(): void {
		if (!this.refresh || this.paused || this.hasTimer || this.running) {
			return;
		}
		const generation = this.generation;
		this.hasTimer = true;
		this.timer = this.timers.set(() => {
			this.hasTimer = false;
			this.timer = undefined;
			void this.tick(generation);
		}, this.delay());
	}

	private async tick(generation: number): Promise<void> {
		const refresh = this.refresh;
		if (!refresh || generation !== this.generation || this.paused) {
			return;
		}
		this.running = true;
		let ok = false;
		try {
			ok = await refresh();
		} catch {
			ok = false;
		}
		this.running = false;
		if (generation === this.generation) {
			this.failures = ok ? 0 : this.failures + 1;
		}
		this.schedule(); // after a stop nothing is set; after a stop and a start this resumes the new run
	}

	private cancel(): void {
		if (this.hasTimer) {
			this.timers.clear(this.timer);
			this.hasTimer = false;
			this.timer = undefined;
		}
	}
}
