// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/workspaces/common/axisDaemonNotice.ts) by OS-5.

import { BRAND } from '@axis/ui';
import { localize } from '../base/nls.js';
import { type AxisCallErrorCode, type AxisDaemonStatus } from '../daemon/axisDaemonClient.js';
import { type IAxisSnapshot } from './axisSnapshotLoader.js';

export type AxisNoticeSeverity = 'info' | 'warning' | 'error';

export interface IAxisNotice {
	readonly severity: AxisNoticeSeverity;
	readonly text: string;
}

export interface IAxisNoticeInput {
	readonly status: AxisDaemonStatus;
	/** The daemon is usable and answered, but has no registered project: the "add a project" empty state. */
	readonly notRegistered: boolean;
	/** The last daemon read failed; the rows are the last good data, if `hasRows`. */
	readonly staleError: AxisCallErrorCode | undefined;
	/** A read of the daemon has worked since it became usable, so there are rows (possibly none) to show. */
	readonly hasRows: boolean;
	/** The daemon listed more projects than one refresh reads. */
	readonly truncatedProjects: boolean;
}

/** A fixed phrase per error code; nothing the daemon wrote is ever shown. */
export function errorPhrase(code: AxisCallErrorCode): string {
	switch (code) {
		case 'E_TIMEOUT': return localize('axis.err.timeout', "timed out");
		case 'E_UNAVAILABLE':
		case 'unavailable': return localize('axis.err.unavailable', "unavailable");
		case 'E_BACKPRESSURE': return localize('axis.err.busy', "busy");
		case 'E_POLICY_DENIED':
		case 'E_UNAUTHENTICATED': return localize('axis.err.refused', "refused");
		case 'invalid_reply': return localize('axis.err.invalidReply', "invalid reply");
		default: return localize('axis.err.unexpected', "unexpected error");
	}
}

/** The one line above the dashboard rows that says where the data comes from and what is wrong, in words. */
export function daemonNotice(input: IAxisNoticeInput): IAxisNotice {
	const { status } = input;
	switch (status.kind) {
		case 'connecting':
			return { severity: 'info', text: localize('axis.notice.connecting', "Connecting to the {0} service. Worktrees and agent runs appear once it answers.", BRAND.productName) };
		case 'down':
			return { severity: 'info', text: localize('axis.notice.down', "The {0} service is not connected. Worktrees, agent runs, run trust and approvals are not shown until it is.", BRAND.productName) };
		case 'failed':
			switch (status.reason) {
				case 'degraded': return { severity: 'error', text: localize('axis.notice.failedDegraded', "The {0} service stopped in degraded mode (its safety checks could not be set up) and will not restart by itself. Restart {0} to try again.", BRAND.productName) };
				case 'crash_loop': return { severity: 'error', text: localize('axis.notice.crashLoop', "The {0} service crashed repeatedly and was stopped. Restart {0} to try again.", BRAND.productName) };
				case 'lock_held': return { severity: 'error', text: localize('axis.notice.lockHeld', "Another {0} window or instance is using the same data. Close it and restart {0}.", BRAND.productName) };
				case 'bad_config': return { severity: 'error', text: localize('axis.notice.badConfig', "The {0} service could not start because its configuration was refused. Restart {0}; if this repeats, reinstall it.", BRAND.productName) };
				case 'pty_required': return { severity: 'warning', text: localize('axis.notice.ptyRequired', "The {0} service cannot start yet: the terminal host it needs is not part of this build.", BRAND.productName) };
			}
	}
	// The daemon is usable (ready or degraded).
	// Degraded outranks the data notes: it is why adding and trusting projects is off and a degraded host does not serve the worktree reads, so a stale marker would hide the real cause (PV-E0 F2 review SF2).
	if (status.kind === 'degraded') {
		return { severity: 'warning', text: localize('axis.notice.degraded', "The {0} service is running in degraded mode: only project and audit reads work. Workspaces, runs and approvals are unavailable.", BRAND.productName) };
	}
	if (input.staleError && !input.hasRows) {
		return { severity: 'warning', text: localize('axis.notice.noData', "The {1} service did not answer ({0}), and nothing has been read from it yet.", errorPhrase(input.staleError), BRAND.productName) };
	}
	if (input.staleError) {
		return { severity: 'warning', text: localize('axis.notice.stale', "The {1} service did not answer ({0}). Showing the last data it gave.", errorPhrase(input.staleError), BRAND.productName) };
	}
	if (input.notRegistered) {
		return { severity: 'info', text: localize('axis.notice.notRegistered', "No repository is registered with the {0} service yet. Add a project to see its worktrees and agent runs.", BRAND.productName) };
	}
	if (input.truncatedProjects) {
		return { severity: 'warning', text: localize('axis.notice.truncated', "The {1} service has more projects than the dashboard reads at once; only the first {0} are shown.", MAX_POLLED_PROJECTS, BRAND.productName) };
	}
	return { severity: 'info', text: localize('axis.notice.ready', "Workspaces and agent runs are read from the {0} service.", BRAND.productName) };
}

/** Most projects one refresh reads from the daemon. */
export const MAX_POLLED_PROJECTS = 50;

/**
 * Whether approval cards may be shown, and the line shown instead (PV-E0 F2 review SF2). Only a ready service with a
 * fresh read shows cards: a degraded host serves no approvals, so cards kept from an earlier connection would offer an
 * Approve that cannot work, and after a failed read the listing is not current (OS-5 review B1).
 */
export function approvalsAvailability(status: AxisDaemonStatus, rows: Pick<IAxisSnapshot, 'origin' | 'staleError'>): { readonly cards: boolean; readonly line: string } {
	switch (status.kind) {
		case 'ready':
			if (rows.origin !== 'daemon') {
				return { cards: false, line: localize('axis.approvals.notRead', "Approvals are not available yet: nothing has been read from the {0} service.", BRAND.productName) };
			}
			if (rows.staleError !== undefined) {
				return { cards: false, line: localize('axis.approvals.stale', "Approvals are not shown: the {0} service did not answer the last read. They return with the next good read.", BRAND.productName) };
			}
			return { cards: true, line: '' };
		case 'connecting': return { cards: false, line: localize('axis.approvals.connecting', "Approvals are not available yet: connecting to the {0} service.", BRAND.productName) };
		case 'degraded': return { cards: false, line: localize('axis.approvals.degraded', "Approvals are not available: the {0} service is in degraded mode.", BRAND.productName) };
		default: return { cards: false, line: localize('axis.approvals.offline', "Approvals need the {0} service. It is not connected, so none are shown.", BRAND.productName) };
	}
}
