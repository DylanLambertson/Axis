// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// What the shell says after a commit (OS-6 review SF3; DC-0, ADR 0011 Decision 3). A commit is built from the reviewed
// tree, never from the person's staging, and afterwards the daemon tries one narrow refresh of their real index
// (`indexRefresh` in `axis.git/1.commit`'s reply). The commit stands either way. When the refresh was skipped, the
// protocol requires the UI to say so: the committed paths then show in `git status` as staged changes that undo the
// commit, and a plain `git commit` in a terminal would undo it until they are reset. The skip reasons are the
// protocol's closed list, each with a fixed sentence; nothing the daemon wrote is shown.

import type { GIT_INDEX_REFRESH_SKIPS } from '@axis/protocol';
import { localize } from '../base/nls.js';
import type { IAxisNotice } from '../workspaces/axisDaemonNotice.js';

export type AxisIndexRefreshSkip = (typeof GIT_INDEX_REFRESH_SKIPS)[number];

const SKIP: Readonly<Record<AxisIndexRefreshSkip, () => string>> = {
	locked: () => localize('axis.commit.skip.locked', "Another git program was using the index."),
	head_moved: () => localize('axis.commit.skip.headMoved', "HEAD moved again right after the commit."),
	split_index: () => localize('axis.commit.skip.splitIndex', "The repository uses a split index, which is not updated from here."),
	sparse: () => localize('axis.commit.skip.sparse', "The repository uses a sparse index or sparse checkout, which is not updated from here."),
	unmerged: () => localize('axis.commit.skip.unmerged', "The index has unmerged files."),
	symlink: () => localize('axis.commit.skip.symlink', "The repository's index file is a symbolic link."),
	unreadable: () => localize('axis.commit.skip.unreadable', "The index could not be read."),
	lock_lost: () => localize('axis.commit.skip.lockLost', "The index lock was removed while the update was under way."),
	rename_failed: () => localize('axis.commit.skip.renameFailed', "The updated index could not be put in place."),
	failed: () => localize('axis.commit.skip.failed', "The update did not finish."),
};

/** An own data property, or undefined: a getter is never run, and nothing on the value throws out. */
function own(value: unknown, key: string): unknown {
	try {
		if (typeof value !== 'object' || value === null) {
			return undefined;
		}
		const d = Object.getOwnPropertyDescriptor(value, key);
		return d !== undefined && 'value' in d ? d.value : undefined;
	} catch {
		return undefined;
	}
}

const KEPT = () => localize('axis.commit.kept', "Staged changes you made yourself were kept.");
const CONSEQUENCE = () => localize('axis.commit.consequence', "Until the index is updated, git status shows the committed files as staged changes that undo the commit, and a plain git commit in a terminal would undo it. To fix this, run git reset -q -- followed by the committed paths.");

/**
 * The notice after a successful commit, from the reply's `indexRefresh`: `{ refreshed: n }`, `{ skipped: reason }`, or
 * absent (a reply from before the refresh existed). A skip is a warning, never a failed commit; an unknown reason gets a
 * fixed sentence; an absent or unreadable result says the update was not reported.
 */
export function commitDone(indexRefresh: unknown): IAxisNotice {
	if (typeof own(indexRefresh, 'refreshed') === 'number') {
		return { severity: 'info', text: `${localize('axis.commit.done', "Committed.")} ${KEPT()} ${localize('axis.commit.refreshed', "Git's index now matches the new commit.")}` };
	}
	const skipped = own(indexRefresh, 'skipped');
	if (typeof skipped === 'string') {
		const reason = Object.hasOwn(SKIP, skipped) ? SKIP[skipped as AxisIndexRefreshSkip]() : localize('axis.commit.skip.unknown', "The update was skipped.");
		return { severity: 'warning', text: `${localize('axis.commit.skipped', "Committed, but git's index was not updated.")} ${reason} ${KEPT()} ${CONSEQUENCE()}` };
	}
	return {
		severity: 'warning',
		text: `${localize('axis.commit.done', "Committed.")} ${KEPT()} ${localize('axis.commit.notReported', "The service did not say whether git's index was updated. If git status shows the committed files as staged changes, run git reset -q -- followed by those paths before committing in a terminal.")}`,
	};
}
