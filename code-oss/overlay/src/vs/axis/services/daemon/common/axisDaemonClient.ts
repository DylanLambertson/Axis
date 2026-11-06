/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/*
 * The renderer side of the daemon connection (docs/design/axis-shell-a2.md).
 * Ticket X1b implements `IAxisDaemonClient` over the MessagePort main brokers;
 * the shell codes against this interface only.
 */

/** Why the supervisor will not restart the daemon (`FailureReason` of `@axis/daemon-host`, plus the `pty_required` refusal). */
export type AxisDaemonFailureReason = 'lock_held' | 'bad_config' | 'pty_required' | 'degraded' | 'crash_loop';

/** The closed daemon state the shell shows. */
export type AxisDaemonStatus =
	| { readonly kind: 'connecting' }
	| { readonly kind: 'ready' }
	| { readonly kind: 'degraded' }
	| { readonly kind: 'failed'; readonly reason: AxisDaemonFailureReason }
	| { readonly kind: 'down' };

const FAILURE_REASONS: ReadonlySet<string> = new Set<AxisDaemonFailureReason>(['lock_held', 'bad_config', 'pty_required', 'degraded', 'crash_loop']);

/** Reads any value as a status of the closed set; anything else is `down`. Never throws, never returns a caller-owned object. */
export function sanitizeStatus(value: unknown): AxisDaemonStatus {
	if (typeof value !== 'object' || value === null) {
		return { kind: 'down' };
	}
	const { kind, reason } = value as { kind?: unknown; reason?: unknown };
	switch (kind) {
		case 'connecting': return { kind: 'connecting' };
		case 'ready': return { kind: 'ready' };
		case 'degraded': return { kind: 'degraded' };
		case 'failed': return typeof reason === 'string' && FAILURE_REASONS.has(reason) ? { kind: 'failed', reason: reason as AxisDaemonFailureReason } : { kind: 'down' };
		default: return { kind: 'down' };
	}
}

/** Whether the daemon answers reads in this status. */
export function isUsable(status: AxisDaemonStatus): boolean {
	return status.kind === 'ready' || status.kind === 'degraded';
}

export function sameStatus(a: AxisDaemonStatus, b: AxisDaemonStatus): boolean {
	return a.kind === b.kind && (a.kind !== 'failed' || (b.kind === 'failed' && a.reason === b.reason));
}

/** The codes of ADR 0003 D3, plus the two the client side adds. */
export const AXIS_ERROR_CODES = [
	'E_INVALID_ARGUMENT', 'E_UNAUTHENTICATED', 'E_POLICY_DENIED', 'E_APPROVAL_REQUIRED', 'E_NOT_FOUND', 'E_CONFLICT',
	'E_IDEMPOTENCY_CONFLICT', 'E_TIMEOUT', 'E_CANCELLED', 'E_BACKPRESSURE', 'E_UNAVAILABLE', 'E_METHOD_NOT_FOUND',
	'E_VERSION_UNSUPPORTED', 'E_INTERNAL', 'unavailable', 'invalid_reply',
] as const;
export type AxisCallErrorCode = typeof AXIS_ERROR_CODES[number];

/** Maps any value to a code of the closed set (`E_INTERNAL` for anything else). */
export function toCallErrorCode(value: unknown): AxisCallErrorCode {
	return typeof value === 'string' && (AXIS_ERROR_CODES as readonly string[]).includes(value) ? value as AxisCallErrorCode : 'E_INTERNAL';
}

/** A failed call. Only the code survives: daemon messages, details and correlation ids are not kept. */
export class AxisDaemonCallError extends Error {
	readonly code: AxisCallErrorCode;
	constructor(code: unknown) {
		const known = toCallErrorCode(code);
		super(`axis daemon call failed: ${known}`);
		this.name = 'AxisDaemonCallError';
		this.code = known;
	}
}

/** The contracts the shell reads. */
export type AxisReadContract = 'axis.projects' | 'axis.worktrees' | 'axis.cli-runs' | 'axis.approvals';

/**
 * The server-pushed side of the connection (`axis.events/1`, docs/design/axis-shell-a3.md). Everything crossing it is raw:
 * the shell validates replies and frames itself. An implementation that cannot offer events leaves `events` undefined.
 */
export interface IAxisEventTransport {
	/** Calls `axis.events/1.subscribe` with plain JSON params and resolves with the raw `result`. Rejects with `AxisDaemonCallError`. */
	subscribe(params: object, token?: CancellationToken): Promise<unknown>;
	/** Calls `axis.events/1.unsubscribe`. */
	unsubscribe(subscriptionId: string, token?: CancellationToken): Promise<unknown>;
	/** Sends the credit message `{ v: 1, ack, seq }` (no reply). Throws if the connection is closed. */
	ack(subscriptionId: string, seq: number): void;
	/** Every raw frame the daemon pushes on this connection, in arrival order. */
	readonly onFrame: Event<unknown>;
	/** The connection closed (a daemon restart, a port error): every subscription on it is over. */
	readonly onDidClose: Event<void>;
}

export const IAxisDaemonClient = createDecorator<IAxisDaemonClient>('axisDaemonClient');

export interface IAxisDaemonClient {
	readonly _serviceBrand: undefined;

	readonly status: AxisDaemonStatus;
	readonly onDidChangeStatus: Event<AxisDaemonStatus>;
	/** Present only when the connection can carry `axis.events/1`; the shell polls without it. */
	readonly events?: IAxisEventTransport;

	/**
	 * Calls `<contract>/1.<method>` with plain JSON params and resolves with the reply `result`. Rejects with
	 * `AxisDaemonCallError`. The implementation enforces the contract's `timeoutMs` (reject `E_TIMEOUT`) and cancels
	 * the call when `token` is cancelled (reject `E_CANCELLED`).
	 */
	request(contract: AxisReadContract, method: string, params: object, token?: CancellationToken): Promise<unknown>;
}
