/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IAxisCliRun, IAxisProjectInfo, IAxisWorktreeInfo } from './axisWorkspaceData.js';

/** One dashboard row: a worktree of a project, with its runs. */
export interface IAxisWorkspaceEntry {
	/** Stable UI key: the journal id, else a hash of the path. */
	readonly key: string;
	readonly project: IAxisProjectInfo;
	readonly worktree: IAxisWorktreeInfo;
	/** The user's own checkout: listed, opens in the IDE view, never runs agents (ADR 0004 decision 6). */
	readonly isLocalCheckout: boolean;
	/** Folder name of the worktree. */
	readonly label: string;
	readonly runs: readonly IAxisCliRun[];
	/** Why the row needs the user, in text (docs/UX.md: never colour alone); `undefined` if it does not. */
	readonly attention: AxisAttention | undefined;
}

export type AxisAttention = 'runFailed' | 'runQuiet' | 'missing';

/** Dashboard state of a row, from the states `docs/UX.md` lists that Phase 0 can know. */
export type AxisRowState = 'idle' | 'running' | 'quiet' | 'failed' | 'done' | 'external' | 'missing';

export function attentionOf(worktree: IAxisWorktreeInfo, runs: readonly IAxisCliRun[]): AxisAttention | undefined {
	if (!worktree.present) {
		return 'missing';
	}
	if (runs.some(run => run.status === 'failed' || run.status === 'killed' || run.status === 'interrupted')) {
		return 'runFailed';
	}
	if (runs.some(run => run.status === 'quiet')) {
		return 'runQuiet';
	}
	return undefined;
}

/** The single state shown in a row's State column. */
export function rowStateOf(entry: Pick<IAxisWorkspaceEntry, 'worktree' | 'runs' | 'isLocalCheckout'>): AxisRowState {
	if (!entry.worktree.present) {
		return 'missing';
	}
	const runs = entry.runs;
	if (runs.some(run => run.status === 'failed' || run.status === 'killed' || run.status === 'interrupted')) {
		return 'failed';
	}
	if (runs.some(run => run.status === 'quiet')) {
		return 'quiet';
	}
	if (runs.some(run => run.live)) {
		return 'running';
	}
	if (runs.length > 0) {
		return 'done';
	}
	return entry.worktree.origin === 'external' && !entry.isLocalCheckout ? 'external' : 'idle';
}

/**
 * Orders the rows (docs/UX.md, dashboard): grouped by project in project order;
 * within a project, rows that need the user first, then the local checkout,
 * then the other workspaces by name.
 */
export function orderEntries(entries: readonly IAxisWorkspaceEntry[], projectOrder: readonly string[]): IAxisWorkspaceEntry[] {
	const rank = (entry: IAxisWorkspaceEntry) => entry.attention ? 0 : entry.isLocalCheckout ? 1 : 2;
	const projectIndex = (entry: IAxisWorkspaceEntry) => {
		const index = projectOrder.indexOf(entry.project.id);
		return index === -1 ? projectOrder.length : index;
	};
	return [...entries].sort((a, b) =>
		projectIndex(a) - projectIndex(b)
		|| rank(a) - rank(b)
		|| a.label.localeCompare(b.label)
		|| a.key.localeCompare(b.key));
}

/** The index reached by moving `delta` rows from `current`, wrapping; `undefined` for an empty list. */
export function cycleIndex(current: number | undefined, delta: number, count: number): number | undefined {
	if (count === 0) {
		return undefined;
	}
	if (current === undefined) {
		return delta >= 0 ? 0 : count - 1;
	}
	return ((current + delta) % count + count) % count;
}
