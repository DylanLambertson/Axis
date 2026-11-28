// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// What the shell says after a commit (OS-6 review SF3, review 2 F3/F4/N1; DC-0, ADR 0011 Decision 3). A commit is built
// from the reviewed tree, never from the person's staging, and afterwards the daemon tries one narrow refresh of their
// real index (`indexRefresh` in `axis.git/1.commit`'s reply). The commit stands either way.
//
// The reply proves little about the index, so the notice claims little. `{ refreshed: n }` counts the entries the refresh
// could safely advance; it never says the index matches the commit (an entry the person staged, a flagged entry or a
// case collision is left as it was, and n may be 0). A skip means nothing was changed, but not why each path looks as it
// does: an entry can be a stale copy of the old HEAD, the person's own staging, or another program's change. So the
// notice never prescribes a reset (that would replace the person's staging with the commit's version): it asks them to
// check `git status` and `git diff --cached` before committing in a terminal. The skip reasons are the protocol's closed
// list, each with a fixed sentence; nothing the daemon wrote is shown.

import type { GIT_INDEX_REFRESH_SKIPS } from '@axis/protocol';
import { localize } from '../base/nls.js';
import type { IAxisNotice } from '../workspaces/axisDaemonNotice.js';

export type AxisIndexRefreshSkip = (typeof GIT_INDEX_REFRESH_SKIPS)[number];

const SKIP: Readonly<Record<AxisIndexRefreshSkip, () => string>> = {
	locked: () => localize('axis.commit.skip.locked', "An index.lock file was in the way: another git program may still be running, or one left its lock behind. Let any running git program finish first."),
	head_moved: () => localize('axis.commit.skip.headMoved', "HEAD moved again right after the commit, so it may no longer point at the commit just made."),
	split_index: () => localize('axis.commit.skip.splitIndex', "The repository uses a split index, which is not updated from here."),
	sparse: () => localize('axis.commit.skip.sparse', "The repository uses a sparse index or sparse checkout, which is not updated from here."),
	unmerged: () => localize('axis.commit.skip.unmerged', "The index has unmerged files, with their conflict stages left as they are."),
	symlink: () => localize('axis.commit.skip.symlink', "The repository's index file is a symbolic link."),
	unreadable: () => localize('axis.commit.skip.unreadable', "The index could not be read."),
	lock_lost: () => localize('axis.commit.skip.lockLost', "The index lock was removed or replaced while the update was under way, so another git program may have changed the index."),
	rename_failed: () => localize('axis.commit.skip.renameFailed', "The updated index could not be put in place."),
	failed: () => localize('axis.commit.skip.failed', "The update did not finish."),
};

/** An own property's descriptor, or undefined: nothing on the value runs a getter or throws out (a Proxy trap may run). */
function descriptor(value: unknown, key: string): PropertyDescriptor | undefined {
	try {
		return typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key) : undefined;
	} catch {
		return undefined;
	}
}

/** An own data property's value, or undefined. */
function own(d: PropertyDescriptor | undefined): unknown {
	return d !== undefined && 'value' in d ? d.value : undefined;
}

const KEPT = () => localize('axis.commit.kept', "Staged changes you made yourself were kept.");
const CHECK = () => localize('axis.commit.check', "Before you commit in a terminal, check git status and git diff --cached: a staged change there may be an old copy that would undo part of this commit, or a change you staged yourself.");

/**
 * The notice after a successful commit, from the reply's `indexRefresh`: `{ refreshed: n }` (n a nonnegative safe
 * integer), `{ skipped: reason }`, or absent (a reply from before the refresh existed). A skip is a warning, never a
 * failed commit; an unknown reason gets a fixed sentence; an absent, malformed or contradictory result (both fields)
 * says the update was not reported.
 */
export function commitDone(indexRefresh: unknown): IAxisNotice {
	const refreshedField = descriptor(indexRefresh, 'refreshed');
	const skippedField = descriptor(indexRefresh, 'skipped');
	const refreshed = own(refreshedField);
	const skipped = own(skippedField);
	if (skippedField === undefined && typeof refreshed === 'number' && Number.isSafeInteger(refreshed) && refreshed >= 0) {
		return { severity: 'info', text: `${localize('axis.commit.done', "Committed.")} ${localize('axis.commit.refreshed', "Entries in git's index that could safely follow the commit were updated, and staged changes you made yourself were kept.")} ${localize('axis.commit.checkLight', "If you commit in a terminal, check git diff --cached first.")}` };
	}
	if (refreshedField === undefined && typeof skipped === 'string') {
		const reason = Object.hasOwn(SKIP, skipped) ? SKIP[skipped as AxisIndexRefreshSkip]() : localize('axis.commit.skip.unknown', "The update was skipped.");
		return { severity: 'warning', text: `${localize('axis.commit.skipped', "Committed, but git's index was not updated.")} ${reason} ${KEPT()} ${CHECK()}` };
	}
	return {
		severity: 'warning',
		text: `${localize('axis.commit.done', "Committed.")} ${localize('axis.commit.notReported', "The service did not say whether git's index was updated.")} ${KEPT()} ${CHECK()}`,
	};
}
