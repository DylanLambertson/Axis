/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AXIS_ID_PATTERN } from '../../workspaces/common/axisWorkspaceData.js';

/*
 * Validators for `axis.events/1` (docs/design/events.md, docs/design/axis-shell-a3.md). Like the A2 reply validators they accept
 * exactly the contract shape and return `undefined` for anything else: the frame is dropped whole, nothing is merged and no
 * text of it is kept. The renderer copies of the limits below follow `packages/protocol/src/events.ts`.
 */

export const EVENTS_CONTRACT = 'axis.events';
/** Unacknowledged frames one subscription may have outstanding (the daemon's `EVENT_WINDOW`). */
export const EVENT_WINDOW = 32;
/** The topics the shell subscribes to: the ones that change what the dashboard shows. */
export const SHELL_EVENT_TOPICS = ['workspaces', 'runs', 'approvals'] as const;

const TOKEN = /^[A-Za-z0-9_-]{22,43}$/;
const RUN_STATES: ReadonlySet<string> = new Set(['QUEUED', 'RUNNING', 'REVIEWING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']);

export type AxisEventBody =
	| { readonly topic: 'workspaces'; readonly workspaceId: string }
	| { readonly topic: 'runs'; readonly runId: string; readonly state?: string }
	| { readonly topic: 'approvals' }
	| { readonly topic: 'anchor'; readonly stalled: boolean }
	| { readonly topic: 'audit'; readonly headSeq: number };

export interface IAxisSubscribeReply {
	readonly subscriptionId: string;
	readonly epoch: string;
	readonly seq: number;
	readonly resumed: boolean;
	readonly window: number;
}

export type AxisServerFrame =
	| { readonly kind: 'event'; readonly sub: string; readonly seq: number; readonly event: AxisEventBody }
	/** A frame whose envelope is sound (version, sub, seq, exactly one `event` key) but whose body is not one this shell knows (a newer daemon's additive field or topic). Only ever a hint: the body is discarded. */
	| { readonly kind: 'opaque'; readonly sub: string; readonly seq: number }
	| { readonly kind: 'resync'; readonly sub: string; readonly seq: number }
	| { readonly kind: 'end'; readonly sub: string };

function plain(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null ? value as Record<string, unknown> : undefined;
}

/** True when the object has exactly these own keys (a missing or an extra key is a bad shape). */
function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(record);
	return required.every(k => Object.prototype.hasOwnProperty.call(record, k)) && keys.every(k => required.includes(k) || optional.includes(k));
}

function token(value: unknown): value is string {
	return typeof value === 'string' && TOKEN.test(value);
}

function seqOf(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function id(value: unknown): value is string {
	return typeof value === 'string' && AXIS_ID_PATTERN.test(value);
}

export function readSubscribeReply(value: unknown): IAxisSubscribeReply | undefined {
	const r = plain(value);
	if (!r || !exactKeys(r, ['subscriptionId', 'epoch', 'seq', 'resumed', 'window'])) {
		return undefined;
	}
	const { subscriptionId, epoch, seq, resumed, window } = r;
	if (!token(subscriptionId) || !token(epoch) || !seqOf(seq) || typeof resumed !== 'boolean') {
		return undefined;
	}
	// A window we did not agree to would let the daemon send more than this client buffers.
	if (typeof window !== 'number' || !Number.isInteger(window) || window < 1 || window > EVENT_WINDOW) {
		return undefined;
	}
	return { subscriptionId, epoch, seq, resumed, window };
}

export function readEventBody(value: unknown): AxisEventBody | undefined {
	const b = plain(value);
	if (!b) {
		return undefined;
	}
	switch (b.topic) {
		case 'workspaces': return exactKeys(b, ['topic', 'workspaceId']) && id(b.workspaceId) ? { topic: 'workspaces', workspaceId: b.workspaceId } : undefined;
		case 'runs':
			if (!exactKeys(b, ['topic', 'runId'], ['state']) || !id(b.runId)) {
				return undefined;
			}
			if (b.state === undefined) {
				return Object.prototype.hasOwnProperty.call(b, 'state') ? undefined : { topic: 'runs', runId: b.runId };
			}
			return typeof b.state === 'string' && RUN_STATES.has(b.state) ? { topic: 'runs', runId: b.runId, state: b.state } : undefined;
		case 'approvals': return exactKeys(b, ['topic']) ? { topic: 'approvals' } : undefined;
		case 'anchor': return exactKeys(b, ['topic', 'stalled']) && typeof b.stalled === 'boolean' ? { topic: 'anchor', stalled: b.stalled } : undefined;
		case 'audit': return exactKeys(b, ['topic', 'headSeq']) && seqOf(b.headSeq) ? { topic: 'audit', headSeq: b.headSeq } : undefined;
		default: return undefined;
	}
}

/** One frame of `event`, `resync` or `end` shape; protocol version 1 only. */
export function readServerFrame(value: unknown): AxisServerFrame | undefined {
	const f = plain(value);
	if (!f || f.v !== 1 || !token(f.sub)) {
		return undefined;
	}
	if ('event' in f) {
		if (!exactKeys(f, ['v', 'sub', 'seq', 'event']) || !seqOf(f.seq)) {
			return undefined;
		}
		const event = readEventBody(f.event);
		return event ? { kind: 'event', sub: f.sub, seq: f.seq, event } : { kind: 'opaque', sub: f.sub, seq: f.seq };
	}
	if ('resync' in f) {
		const r = plain(f.resync);
		return exactKeys(f, ['v', 'sub', 'seq', 'resync']) && seqOf(f.seq) && r && exactKeys(r, ['reason']) && r.reason === 'overflow' ? { kind: 'resync', sub: f.sub, seq: f.seq } : undefined;
	}
	if ('end' in f) {
		const e = plain(f.end);
		return exactKeys(f, ['v', 'sub', 'end']) && e && exactKeys(e, ['reason']) && e.reason === 'shutdown' ? { kind: 'end', sub: f.sub } : undefined;
	}
	return undefined;
}
