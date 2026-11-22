/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The renderer's daemon client core (ticket PV-E0, replacing X1b's unavailable registration). Pure: the connect step is injected
// (electron-browser/axisRendererDaemonClient.ts passes `connectAxisDaemon`, the only way to a port: main's attested
// `vscode:axisConnect`). It keeps one connection, reconnects with a bounded backoff after the port closes (a daemon restart, a new
// generation) or a connect fails, and shows the closed status set. The renderer holds no key, identity, attestation or path and
// stores nothing; every call is still decided by the daemon's own policy.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { AxisDaemonCallError, AxisDaemonStatus, AxisReadContract, IAxisDaemonClient, sameStatus } from './axisDaemonClient.js';

/** How long one connect may take before it counts as failed (main's broker, then `hello`/`welcome`). */
export const AXIS_WELCOME_TIMEOUT_MS = 10_000;
/**
 * The status turns `down` (the "not connected" notice) only after this many failed connects in a row AND at least
 * `AXIS_DOWN_AFTER_MS` since the first of them, so a normal supervisor restart (a few seconds) shows "Connecting". It keeps retrying.
 */
export const AXIS_DOWN_AFTER_FAILURES = 5;
export const AXIS_DOWN_AFTER_MS = 15_000;
/**
 * How long a connection must stay up before the failure count resets. A daemon that welcomes and then closes at once counts as a
 * failed connect (it backs off and can turn `down`) instead of being reconnected at once in a loop.
 */
export const AXIS_STABLE_AFTER_MS = 10_000;
export const AXIS_RECONNECT_BASE_MS = 250;
export const AXIS_RECONNECT_CAP_MS = 30_000;
export const AXIS_RECONNECT_JITTER = 0.2;
/** The contracts the shell asks for, version 1 each: what it already reads and writes, nothing more. */
export const AXIS_SHELL_CONTRACTS: ReadonlyArray<{ readonly id: AxisReadContract; readonly versions: readonly number[] }> = Object.freeze(
	(['axis.projects', 'axis.worktrees', 'axis.cli-runs', 'axis.approvals'] as const).map(id => Object.freeze({ id, versions: Object.freeze([1]) })),
);

/** The delay before reconnect attempt `failures` (1-based): 250 ms doubling to the 30 s cap, ±20 % jitter. */
export function reconnectDelay(failures: number, random: () => number): number {
	const base = Math.min(AXIS_RECONNECT_CAP_MS, AXIS_RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1));
	const jitter = 1 + (Math.min(1, Math.max(0, random())) * 2 - 1) * AXIS_RECONNECT_JITTER;
	return Math.round(Math.min(AXIS_RECONNECT_CAP_MS, base * jitter));
}

/** What one connection offers (an `AxisPortClient` in the product). */
export interface IAxisConnectedClient {
	call(contract: string, method: string, payload: unknown, options?: { readonly signal?: AbortSignal }): Promise<
		| { readonly ok: true; readonly result: unknown }
		| { readonly ok: false; readonly error: { readonly code: string } }
	>;
	close(): void;
}

export interface IAxisReconnectDeps {
	/** Open one connection; `onClose` is called once if it closes later. Rejects when main or the daemon refuses. */
	readonly connect: (onClose: () => void) => Promise<IAxisConnectedClient>;
	readonly timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
	readonly random: () => number;
}

export class AxisReconnectingDaemonClient extends Disposable implements IAxisDaemonClient {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<AxisDaemonStatus>());
	readonly onDidChangeStatus: Event<AxisDaemonStatus> = this._onDidChangeStatus.event;

	private _status: AxisDaemonStatus = { kind: 'connecting' };
	private client: IAxisConnectedClient | undefined;
	private failures = 0;
	private attempting = false;
	private retry: unknown;
	/** Set while a fresh connection has not yet stayed up for `AXIS_STABLE_AFTER_MS`. */
	private stable: unknown;
	/** The welcome bound of the attempt in flight. */
	private bound: unknown;
	/** Runs from the first failure of a run of failures; `down` needs it to have fired. */
	private downWindow: unknown;
	private downWindowPassed = false;
	private disposed = false;
	/** Every call in flight: each is settled exactly once, by its answer or by the connection leaving `ready`. */
	private readonly pending = new Set<(error: AxisDaemonCallError) => void>();

	constructor(private readonly deps: IAxisReconnectDeps) {
		super();
		this.attempt();
	}

	get status(): AxisDaemonStatus {
		return this._status;
	}

	request(contract: AxisReadContract, method: string, params: object, token?: CancellationToken): Promise<unknown> {
		const client = this.client;
		if (client === undefined || this._status.kind !== 'ready') {
			return Promise.reject(new AxisDaemonCallError('unavailable'));
		}
		if (token?.isCancellationRequested) {
			return Promise.reject(new AxisDaemonCallError('E_CANCELLED'));
		}
		return new Promise((resolve, reject) => {
			const abort = new AbortController();
			const sub = token?.onCancellationRequested(() => abort.abort());
			let settled = false;
			const fail = (error: AxisDaemonCallError) => finish(() => reject(error));
			const finish = (f: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				this.pending.delete(fail);
				sub?.dispose();
				f();
			};
			this.pending.add(fail);
			client.call(contract, method, params, { signal: abort.signal }).then(
				r => finish(() => r.ok ? resolve(r.result) : reject(new AxisDaemonCallError(r.error.code))),
				// A malformed reply (`bad_answer`), a timeout, a cancel, a closed port: a closed code, the connection stays as it is.
				e => finish(() => reject(new AxisDaemonCallError((e as { code?: unknown } | null)?.code))),
			);
		});
	}

	override dispose(): void {
		this.disposed = true;
		if (this.retry !== undefined) {
			this.deps.timers.clear(this.retry);
		}
		this.clearStable();
		this.clearDownWindow();
		if (this.bound !== undefined) {
			this.deps.timers.clear(this.bound);
			this.bound = undefined;
		}
		this.failPending();
		this.client?.close();
		this.client = undefined;
		super.dispose();
	}

	private setStatus(status: AxisDaemonStatus): void {
		if (sameStatus(this._status, status)) {
			return;
		}
		this._status = status;
		if (status.kind !== 'ready') {
			this.failPending();
		}
		this._onDidChangeStatus.fire(status);
	}

	private failPending(): void {
		for (const fail of [...this.pending]) {
			fail(new AxisDaemonCallError('unavailable'));
		}
	}

	private attempt(): void {
		if (this.disposed || this.attempting) {
			return;
		}
		this.attempting = true;
		this.retry = undefined;
		let done = false;
		let opened: IAxisConnectedClient | undefined;
		const onClose = () => {
			if (this.client === opened && opened !== undefined) {
				this.client = undefined;
				if (this.stable === undefined) {
					this.setStatus({ kind: 'connecting' });
					this.schedule(0); // it stayed up: reconnect at once
				} else {
					this.clearStable();
					this.failed(); // closed right after its welcome: a failed connect
				}
			}
		};
		const bound = this.deps.timers.set(() => finish(undefined), AXIS_WELCOME_TIMEOUT_MS);
		this.bound = bound;
		const finish = (client: IAxisConnectedClient | undefined) => {
			if (done) {
				client?.close(); // a connect that answers after its bound is not used
				return;
			}
			done = true;
			this.deps.timers.clear(bound);
			if (this.bound === bound) {
				this.bound = undefined;
			}
			this.attempting = false;
			if (this.disposed) {
				client?.close();
				return;
			}
			if (client === undefined) {
				this.failed();
				return;
			}
			opened = client;
			this.client = client;
			this.stable = this.deps.timers.set(() => {
				this.stable = undefined;
				this.failures = 0;
				this.clearDownWindow();
			}, AXIS_STABLE_AFTER_MS);
			this.setStatus({ kind: 'ready' });
		};
		let connecting: Promise<IAxisConnectedClient>;
		try {
			connecting = this.deps.connect(onClose);
		} catch {
			connecting = Promise.reject(new Error('connect threw'));
		}
		connecting.then(client => finish(client), () => finish(undefined));
	}

	private failed(): void {
		this.failures++;
		if (this.downWindow === undefined && !this.downWindowPassed) {
			this.downWindow = this.deps.timers.set(() => {
				this.downWindow = undefined;
				this.downWindowPassed = true;
				if (this.client === undefined && !this.disposed) {
					this.setStatus(this.downStatus());
				}
			}, AXIS_DOWN_AFTER_MS);
		}
		this.setStatus(this.downStatus());
		this.schedule(reconnectDelay(this.failures, this.deps.random));
	}

	private downStatus(): AxisDaemonStatus {
		return this.failures >= AXIS_DOWN_AFTER_FAILURES && this.downWindowPassed ? { kind: 'down' } : { kind: 'connecting' };
	}

	private clearDownWindow(): void {
		if (this.downWindow !== undefined) {
			this.deps.timers.clear(this.downWindow);
			this.downWindow = undefined;
		}
		this.downWindowPassed = false;
	}

	private clearStable(): void {
		if (this.stable !== undefined) {
			this.deps.timers.clear(this.stable);
			this.stable = undefined;
		}
	}

	private schedule(ms: number): void {
		if (this.disposed || this.retry !== undefined) {
			return;
		}
		this.retry = this.deps.timers.set(() => this.attempt(), ms);
	}
}
