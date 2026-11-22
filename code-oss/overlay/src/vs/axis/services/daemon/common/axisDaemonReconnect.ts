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
/** Consecutive failed connects after which the status is `down` (it keeps retrying at the cap). */
export const AXIS_DOWN_AFTER_FAILURES = 5;
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
				this.setStatus({ kind: 'connecting' });
				this.schedule(0);
			}
		};
		const bound = this.deps.timers.set(() => finish(undefined), AXIS_WELCOME_TIMEOUT_MS);
		const finish = (client: IAxisConnectedClient | undefined) => {
			if (done) {
				client?.close(); // a connect that answers after its bound is not used
				return;
			}
			done = true;
			this.deps.timers.clear(bound);
			this.attempting = false;
			if (this.disposed) {
				client?.close();
				return;
			}
			if (client === undefined) {
				this.failures++;
				this.setStatus(this.failures >= AXIS_DOWN_AFTER_FAILURES ? { kind: 'down' } : { kind: 'connecting' });
				this.schedule(reconnectDelay(this.failures, this.deps.random));
				return;
			}
			opened = client;
			this.client = client;
			this.failures = 0;
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

	private schedule(ms: number): void {
		if (this.disposed || this.retry !== undefined) {
			return;
		}
		this.retry = this.deps.timers.set(() => this.attempt(), ms);
	}
}
