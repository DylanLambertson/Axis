/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { AxisDaemonCallError, AxisDaemonStatus, AxisReadContract, IAxisDaemonClient } from '../../common/axisDaemonClient.js';

export const SHA = '0123456789abcdef0123456789abcdef01234567';

export interface IRecordedCall {
	readonly contract: string;
	readonly method: string;
	readonly params: unknown;
}

/** A scripted client: `replies` maps `<contract>.<method>` to a reply, or a function returning one (or throwing). */
export class FakeDaemonClient implements IAxisDaemonClient {
	declare readonly _serviceBrand: undefined;
	readonly calls: IRecordedCall[] = [];
	readonly replies = new Map<string, unknown | ((params: unknown) => unknown)>();
	private readonly emitter = new Emitter<AxisDaemonStatus>();
	readonly onDidChangeStatus = this.emitter.event;
	status: AxisDaemonStatus = { kind: 'ready' };

	setStatus(status: AxisDaemonStatus): void {
		this.status = status;
		this.emitter.fire(status);
	}

	async request(contract: AxisReadContract, method: string, params: object): Promise<unknown> {
		this.calls.push({ contract, method, params });
		const reply = this.replies.get(`${contract}.${method}`);
		if (reply === undefined) {
			throw new AxisDaemonCallError('E_METHOD_NOT_FOUND');
		}
		return typeof reply === 'function' ? (reply as (p: unknown) => unknown)(params) : reply;
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

export function wire(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { origin: 'axis', projectId: 'proj-1', branch: 'feat/x', head: SHA, path: '/work/wt-a', locked: false, present: true, ...extra };
}

export function runWire(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		runId: 'run-1', workspaceId: 'ws-a', agentId: 'claude', state: 'RUNNING', status: 'running', reason: null, exitCode: null,
		createdAt: '2026-11-06T10:00:00.000Z', startedAt: '2026-11-06T10:00:01.000Z', endedAt: null, live: true,
		lastOutputAt: 1_000, outputChars: 10, droppedChars: 0, snapshotAfter: 'pending', ...extra,
	};
}

export const CHALLENGE_ID = 'chal_AAAAAAAAAAAAAAAAAAAAAA';
export const DIGEST = 'ab'.repeat(32);

export function challengeWire(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		challengeId: CHALLENGE_ID, digest: DIGEST, contract: 'axis.worktrees', method: 'remove', tier: 3,
		targetSummary: 'Remove the worktree feat-x', nativeConfirmationRequired: false, expiresAt: 2_000_000, ...extra,
	};
}
