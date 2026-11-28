// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The sentence a refusal screen shows for each closed refusal reason of the git and review contracts (OS-6; the
// vocabulary of the Demo 1 checklist). The tables are typed against the protocol's closed reason lists, so a reason
// added there does not compile here until it has a sentence. Nothing the daemon wrote is ever shown: an unknown
// reason gets one fixed sentence.

import type { GIT_COMMIT_REASONS, GIT_PUSH_REASONS, REVIEW_DIFF_REASONS } from '@axis/protocol';
import { localize } from '../base/nls.js';

export type AxisGitCommitReason = (typeof GIT_COMMIT_REASONS)[number];
export type AxisGitPushReason = (typeof GIT_PUSH_REASONS)[number];
export type AxisReviewDiffReason = (typeof REVIEW_DIFF_REASONS)[number];

const DRIFT = () => localize('axis.refusal.gitDrift', "The repository's git configuration changed since it was recorded. Acknowledge the change first.");
const UNTRUSTED = () => localize('axis.refusal.untrustedGit', "The project is not trusted for commits and pushes.");
const CANNOT_REVIEW = () => localize('axis.refusal.review.cannot', "The workspace cannot be reviewed in its current state.");

const COMMIT: Readonly<Record<AxisGitCommitReason, () => string>> = {
	head_moved: () => localize('axis.refusal.headMoved', "HEAD or the branch moved since the review. Review the changes again."),
	stale: () => localize('axis.refusal.stale', "The files changed since the review. Review the changes again."),
	index_changed: () => localize('axis.refusal.indexChanged', "The staged changes changed since the review. Review the changes again."),
	operation_in_progress: () => localize('axis.refusal.operation', "A merge, rebase or similar operation is in progress. Finish or abort it first."),
	ref_update_failed: () => localize('axis.refusal.refUpdate', "The branch is locked, so it was not moved. Nothing was committed; try again."),
	snapshot_failed: () => localize('axis.refusal.snapshot', "The workspace could not be read to check the review. Nothing was committed; try again."),
	git_drift: DRIFT,
	untrusted: UNTRUSTED,
	too_large: () => localize('axis.refusal.tooLarge', "The workspace has more changes than one review holds, so it cannot be committed from here."),
	not_found: () => localize('axis.refusal.notFound', "The commit the review was made against is gone. Review the changes again."),
	detached_head: () => localize('axis.refusal.detached', "HEAD is detached. Check out the workspace's branch to commit."),
	no_head: () => localize('axis.refusal.noHead', "The branch has no commit yet, so there is nothing to commit onto."),
};

const PUSH: Readonly<Record<AxisGitPushReason, () => string>> = {
	plan_changed: () => localize('axis.refusal.planChanged', "The branch or its scan changed after you confirmed. Review the new plan."),
	message_unscannable: () => localize('axis.refusal.messageUnscannable', "A commit message in the outgoing changes cannot be scanned, so it cannot be pushed."),
	secrets_found: () => localize('axis.refusal.secrets', "The outgoing changes match a secret pattern, so they cannot be pushed. Review the plan."),
	scan_incomplete: () => localize('axis.refusal.scanIncomplete', "The outgoing changes are too large to scan completely, so they cannot be pushed."),
	binary_unscanned: () => localize('axis.refusal.binary', "The outgoing changes include binary files that cannot be scanned. Review the plan."),
	git_drift: DRIFT,
	untrusted: UNTRUSTED,
};

const REVIEW: Readonly<Record<AxisReviewDiffReason, () => string>> = {
	too_large: () => localize('axis.refusal.review.tooLarge', "The workspace has more changed files than one review holds."),
	not_found: () => localize('axis.refusal.review.notFound', "The workspace's HEAD is gone, so it cannot be reviewed."),
	snapshot_failed: CANNOT_REVIEW,
	hunks_do_not_apply: CANNOT_REVIEW,
	index_refused: CANNOT_REVIEW,
	path_conflict: CANNOT_REVIEW,
	not_head: () => localize('axis.refusal.review.notHead', "HEAD moved while the review was read. Review the changes again."),
	no_head: () => localize('axis.refusal.review.noHead', "The branch has no commit yet, so there is nothing to review against."),
	unsafe_path: () => localize('axis.refusal.review.unsafePath', "A changed path cannot be used safely, so the review cannot be committed."),
	filtered_path: () => localize('axis.refusal.review.filtered', "A changed file is rewritten by a content filter, so the review cannot be committed."),
	nothing_accepted: () => localize('axis.refusal.review.nothing', "No change was accepted, so there is nothing to commit."),
	truncated_hunk: () => localize('axis.refusal.review.truncated', "A change has text the view cuts off. Acknowledge it before committing."),
};

const TABLES = { 'axis.git/1.commit': COMMIT, 'axis.git/1.push': PUSH, 'axis.review/1.diff': REVIEW } as const;
export type AxisRefusalSource = keyof typeof TABLES;

/** The fixed sentence for a refusal of one of the tabled methods. An unknown reason never echoes what was received. */
export function refusalText(source: AxisRefusalSource, reason: string | undefined): string {
	const table: Readonly<Record<string, () => string>> = TABLES[source];
	const sentence = reason !== undefined && Object.hasOwn(table, reason) ? table[reason] : undefined;
	return sentence ? sentence() : localize('axis.refusal.unknown', "That was refused. Nothing changed.");
}
