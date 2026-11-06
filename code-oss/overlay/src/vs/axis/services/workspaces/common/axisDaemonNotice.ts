/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AxisCallErrorCode, AxisDaemonStatus } from '../../daemon/common/axisDaemonClient.js';

export type AxisNoticeSeverity = 'info' | 'warning' | 'error';

export interface IAxisNotice {
	readonly severity: AxisNoticeSeverity;
	readonly text: string;
}

export interface IAxisNoticeInput {
	readonly status: AxisDaemonStatus;
	/** The daemon is usable but has no registered project, so the rows come from the disk reader. */
	readonly notRegistered: boolean;
	/** The last daemon read failed; the rows are the last good data. */
	readonly staleError: AxisCallErrorCode | undefined;
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
			return { severity: 'info', text: localize('axis.notice.connecting', "Connecting to the Axis service. Worktrees are read from disk meanwhile.") };
		case 'down':
			return { severity: 'info', text: localize('axis.notice.down', "Read from the worktrees on disk. The Axis service is not running, so no agent runs are shown.") };
		case 'failed':
			switch (status.reason) {
				case 'degraded': return { severity: 'error', text: localize('axis.notice.failedDegraded', "The Axis service stopped in degraded mode (its safety checks could not be set up) and will not restart by itself. Restart Axis to try again. Worktrees are read from disk.") };
				case 'crash_loop': return { severity: 'error', text: localize('axis.notice.crashLoop', "The Axis service crashed repeatedly and was stopped. Restart Axis to try again. Worktrees are read from disk.") };
				case 'lock_held': return { severity: 'error', text: localize('axis.notice.lockHeld', "Another Axis window or instance is using the same data. Close it and restart Axis. Worktrees are read from disk.") };
				case 'bad_config': return { severity: 'error', text: localize('axis.notice.badConfig', "The Axis service could not start because its configuration was refused. Restart Axis; if this repeats, reinstall it. Worktrees are read from disk.") };
				case 'pty_required': return { severity: 'warning', text: localize('axis.notice.ptyRequired', "The Axis service cannot start yet: the terminal host it needs is not part of this build. Worktrees are read from disk.") };
			}
	}
	// The daemon is usable (ready or degraded).
	if (input.staleError) {
		return { severity: 'warning', text: localize('axis.notice.stale', "The Axis service did not answer ({0}). Showing the last data it gave.", errorPhrase(input.staleError)) };
	}
	if (input.notRegistered) {
		return { severity: 'info', text: localize('axis.notice.notRegistered', "No repository is registered with the Axis service yet. Worktrees are read from disk and no agent runs are shown.") };
	}
	if (input.truncatedProjects) {
		return { severity: 'warning', text: localize('axis.notice.truncated', "The Axis service has more projects than the dashboard reads at once; only the first {0} are shown.", MAX_POLLED_PROJECTS) };
	}
	if (status.kind === 'degraded') {
		return { severity: 'warning', text: localize('axis.notice.degraded', "The Axis service is running in degraded mode. Reading works; starting runs and approving may be refused.") };
	}
	return { severity: 'info', text: localize('axis.notice.ready', "Workspaces and agent runs are read from the Axis service.") };
}

/** Most projects one refresh reads from the daemon. */
export const MAX_POLLED_PROJECTS = 50;
