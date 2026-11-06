/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AxisApprovalOutcome } from './axisApprovals.js';

/** Fixed text per outcome: nothing from the daemon or from an error is shown. */
export function outcomeText(outcome: AxisApprovalOutcome): string {
	switch (outcome.kind) {
		case 'approved': return localize('axis.approval.approved', "Approved.");
		case 'denied': return localize('axis.approval.denied', "Denied.");
		case 'awaiting-native': return localize('axis.approval.awaitingNative', "Approved. Waiting for the confirmation dialog.");
		case 'expired': return localize('axis.approval.expired', "This approval expired.");
		case 'stale': return localize('axis.approval.stale', "This approval changed. Review the current list.");
		case 'untrusted': return localize('axis.approval.untrusted', "Only a click or key press on the button counts as an answer.");
		case 'native-only': return localize('axis.approval.nativeOnly', "This approval is answered in the confirmation dialog.");
		case 'busy': return localize('axis.approval.busy', "An answer is already being sent.");
		case 'failed': return localize('axis.approval.failed', "The answer could not be sent. Try again.");
	}
}
