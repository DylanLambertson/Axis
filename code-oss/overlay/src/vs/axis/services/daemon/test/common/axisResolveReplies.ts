/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/*
 * What the daemon answers to `axis.approvals/1.resolve`, per tier and decision: the reply `ChallengeManager.resolve`
 * returns (packages/challenge). test/packages/approval-reply-shape.test.mjs runs the real manager and checks every row,
 * so the fakes in the overlay tests cannot drift from the daemon. Keep this file free of imports: that test
 * transpiles it on its own.
 */

export interface IDaemonResolveReplyRow {
	readonly tier: number;
	readonly decision: 'approve' | 'deny';
	/** Answered after the challenge expired. */
	readonly late: boolean;
	readonly state: 'approved' | 'denied' | 'expired';
	readonly nativeRequired: boolean;
}

export const DAEMON_RESOLVE_REPLIES: readonly IDaemonResolveReplyRow[] = [
	{ tier: 3, decision: 'approve', late: false, state: 'approved', nativeRequired: false },
	{ tier: 3, decision: 'deny', late: false, state: 'denied', nativeRequired: false },
	{ tier: 3, decision: 'approve', late: true, state: 'expired', nativeRequired: false },
	{ tier: 4, decision: 'approve', late: false, state: 'approved', nativeRequired: true },
	{ tier: 4, decision: 'deny', late: false, state: 'denied', nativeRequired: true },
	{ tier: 4, decision: 'deny', late: true, state: 'expired', nativeRequired: true },
	{ tier: 5, decision: 'approve', late: false, state: 'approved', nativeRequired: true },
	{ tier: 5, decision: 'deny', late: false, state: 'denied', nativeRequired: true },
	{ tier: 5, decision: 'approve', late: true, state: 'expired', nativeRequired: true },
];
