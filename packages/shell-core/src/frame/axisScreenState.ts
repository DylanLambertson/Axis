// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The state every own-shell screen starts from (OS-6): which of the closed screen kinds to draw, whether writes are
// off, and the notices above it. It is decided here once, from the daemon status, the last snapshot and the secure
// storage state main reports, so no screen invents its own reading of "connected" or "trusted".

import { BRAND } from '@axis/ui';
import { localize } from '../base/nls.js';
import { isUsable, type AxisDaemonStatus } from '../daemon/axisDaemonClient.js';
import { daemonNotice, type IAxisNotice } from '../workspaces/axisDaemonNotice.js';
import { type IAxisSnapshot } from '../workspaces/axisSnapshotLoader.js';

/** What main reports about the OS keychain (OS-27): without it the daemon cannot keep secrets, so it is read only. */
export type AxisSecureStorage = 'available' | 'unavailable' | 'unknown';

/**
 * - `loading`: connecting, or connected with no read finished yet. Draw a skeleton, never sample rows.
 * - `disconnected`: the daemon is down. Nothing is shown as current.
 * - `failed`: the daemon stopped and will not restart by itself; the notice says what to do.
 * - `unreadable`: connected, but no read has worked yet (the notice gives the closed reason).
 * - `empty`: connected and read, with no registered project: the "add a project" state.
 * - `ready`: rows from the daemon (possibly marked stale by a notice).
 */
export type AxisScreenKind = 'loading' | 'disconnected' | 'failed' | 'unreadable' | 'empty' | 'ready';

export interface IAxisScreenState {
	readonly kind: AxisScreenKind;
	/** Adding, trusting, running and approving are off: a degraded daemon or no secure storage. */
	readonly readOnly: boolean;
	/** The notices above the screen, most severe first; never a plain "all is well" line. */
	readonly notices: readonly IAxisNotice[];
}

export interface IAxisScreenInput {
	readonly status: AxisDaemonStatus;
	/** The last snapshot the loader returned for this status, or undefined while the first load is running. */
	readonly snapshot: IAxisSnapshot | undefined;
	readonly secureStorage: AxisSecureStorage;
}

/** The notice for a missing OS keychain. */
export function storageNotice(): IAxisNotice {
	return { severity: 'warning', text: localize('axis.notice.noSecureStorage', "No secure storage: {0} is read only. Projects cannot be added or trusted, and runs cannot start, until the system keychain is available.", BRAND.productName) };
}

function kindOf(input: IAxisScreenInput): AxisScreenKind {
	const { status, snapshot } = input;
	switch (status.kind) {
		case 'connecting': return 'loading';
		case 'down': return 'disconnected';
		case 'failed': return 'failed';
	}
	if (snapshot === undefined) {
		return 'loading';
	}
	if (snapshot.origin !== 'daemon') {
		return snapshot.staleError === undefined ? 'loading' : 'unreadable';
	}
	return snapshot.notRegistered ? 'empty' : 'ready';
}

const RANK: Readonly<Record<IAxisNotice['severity'], number>> = { error: 0, warning: 1, info: 2 };

export function screenStateOf(input: IAxisScreenInput): IAxisScreenState {
	const kind = kindOf(input);
	const snapshot = input.snapshot;
	const fromDaemon = isUsable(input.status) && snapshot?.origin === 'daemon';
	const notice = daemonNotice({
		status: input.status,
		notRegistered: fromDaemon && snapshot.notRegistered,
		staleError: isUsable(input.status) ? snapshot?.staleError : undefined,
		truncatedProjects: fromDaemon && snapshot.truncatedProjects,
		hasRows: fromDaemon,
	});
	const notices: IAxisNotice[] = [];
	if (input.secureStorage === 'unavailable') {
		notices.push(storageNotice());
	}
	// A fresh read needs no line: "read from the service" is the normal state, not news.
	if (!(kind === 'ready' && notice.severity === 'info')) {
		notices.push(notice);
	}
	notices.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
	return { kind, readOnly: input.status.kind === 'degraded' || input.secureStorage === 'unavailable', notices };
}
