// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/workspaces/common/axisSnapshotLoader.ts) by OS-5, redesigned to read the
// daemon only: the own shell's renderer reads no files, so the legacy disk reader (discovery) and its fallback are gone.

import { AxisDaemonCallError, isUsable, type AxisCallErrorCode, type AxisDaemonStatus } from '../daemon/axisDaemonClient.js';
import { type AxisDaemonApi } from '../daemon/axisDaemonApi.js';
import { type IAxisApprovalCard } from '../approvals/axisApprovals.js';
import { MAX_POLLED_PROJECTS } from './axisDaemonNotice.js';
import { type IAxisCliRun, type IAxisProjectInfo, type IAxisWorktreeInfo } from './axisWorkspaceData.js';
import { attentionOf, orderEntries, type IAxisWorkspaceEntry } from './axisWorkspaceModel.js';
import { displayName, lastPathSegment } from './displayText.js';

/**
 * Where the rows of a snapshot come from: `daemon` (a read, possibly the last good one marked stale) or `none` (the
 * daemon is not usable, or no read has worked yet: the view shows its loading, disconnected or empty state).
 */
export type AxisDataOrigin = 'daemon' | 'none';

/** Everything the dashboard shows, read at one time. */
export interface IAxisSnapshot {
	readonly origin: AxisDataOrigin;
	readonly projects: readonly IAxisProjectInfo[];
	readonly entries: readonly IAxisWorkspaceEntry[];
	/** Open approval challenges, display data only; `undefined` when unknown. */
	readonly approvals: readonly IAxisApprovalCard[] | undefined;
	/** The daemon is usable and answered, but has no registered project: the "add a project" empty state. */
	readonly notRegistered: boolean;
	readonly truncatedProjects: boolean;
	/** Set when the last daemon read failed; the rows are the last good ones, or none. */
	readonly staleError: AxisCallErrorCode | undefined;
}

/** Same data, ignoring object identity. Used so an unchanged poll does not redraw the dashboard. */
export function sameSnapshot(a: IAxisSnapshot | undefined, b: IAxisSnapshot): boolean {
	return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The key of a row: the daemon's journal id, or, for a worktree Axis did not create (no id), one derived from its
 * project and path. A derived key never equals a journal id (the `:` is outside the id pattern), so no run attaches
 * to it.
 */
export function workspaceKeyOf(worktree: IAxisWorktreeInfo): string {
	return worktree.id ?? `external:${worktree.projectId}:${worktree.path}`;
}

/** A snapshot with no rows, for a daemon that is not usable or has not answered yet. */
export function emptySnapshot(staleError?: AxisCallErrorCode): IAxisSnapshot {
	return { origin: 'none', projects: [], entries: [], approvals: undefined, notRegistered: false, truncatedProjects: false, staleError };
}

/** The row with the status read's counts in place of its own: a count the status read does not carry is dropped. */
function withStatus(worktree: IAxisWorktreeInfo, status: IAxisWorktreeInfo): IAxisWorktreeInfo {
	const { dirty: _dirty, ahead: _ahead, behind: _behind, ...rest } = worktree;
	return {
		...rest,
		...(status.dirty === undefined ? {} : { dirty: status.dirty }),
		...(status.ahead === undefined ? {} : { ahead: status.ahead }),
		...(status.behind === undefined ? {} : { behind: status.behind }),
	};
}

function buildEntries(projects: readonly IAxisProjectInfo[], worktrees: ReadonlyMap<string, readonly IAxisWorktreeInfo[]>, runs: readonly IAxisCliRun[]): IAxisWorkspaceEntry[] {
	const entries: IAxisWorkspaceEntry[] = [];
	for (const project of projects) {
		for (const worktree of worktrees.get(project.id) ?? []) {
			const key = workspaceKeyOf(worktree);
			const workspaceRuns = runs.filter(run => run.workspaceId === key);
			entries.push({
				key,
				project,
				worktree,
				// The daemon lists no row for a project's main checkout (OS-5 note in the plan), so no row is one.
				isLocalCheckout: false,
				label: displayName(lastPathSegment(worktree.path)),
				runs: workspaceRuns,
				attention: attentionOf(worktree, workspaceRuns),
			});
		}
	}
	return orderEntries(entries, projects.map(p => p.id));
}

/**
 * Turns the daemon status and its replies into one snapshot. It holds no timer and no listener: when to load is the
 * refresh driver's decision.
 */
export class AxisSnapshotLoader {

	/** The last snapshot read from the daemon, kept while the daemon stays usable. */
	private lastDaemon: IAxisSnapshot | undefined;

	constructor(private readonly api: AxisDaemonApi) { }

	async load(status: AxisDaemonStatus): Promise<IAxisSnapshot> {
		if (!isUsable(status)) {
			this.lastDaemon = undefined;
			return emptySnapshot();
		}
		try {
			this.lastDaemon = await this.fromDaemon();
			return this.lastDaemon;
		} catch (error) {
			const staleError = error instanceof AxisDaemonCallError ? error.code : 'E_INTERNAL';
			// The last good rows stay on screen, marked stale; their approvals do not: a card from an old read must not be
			// answerable (OS-5 review B1), so `approvals` is unknown until a read works again.
			return this.lastDaemon ? { ...this.lastDaemon, approvals: undefined, staleError } : emptySnapshot(staleError);
		}
	}

	private async fromDaemon(): Promise<IAxisSnapshot> {
		const all = await this.api.listProjects();
		const projects = all.slice(0, MAX_POLLED_PROJECTS);
		const worktrees = new Map<string, readonly IAxisWorktreeInfo[]>();
		for (const project of projects) {
			worktrees.set(project.id, await this.api.listWorktrees(project.id));
		}
		const ids = [...worktrees.values()].flat().map(w => w.id).filter((id): id is string => id !== undefined);
		const status = new Map((ids.length ? await this.api.statusOf(ids) : []).map(w => [w.id, w]));
		for (const [projectId, list] of worktrees) {
			worktrees.set(projectId, list.map(w => {
				const s = w.id === undefined ? undefined : status.get(w.id);
				return s ? withStatus(w, s) : w;
			}));
		}
		const runs = projects.length ? await this.api.listCliRuns() : [];
		const approvals = await this.api.pendingApprovals().catch(() => undefined);
		return {
			origin: 'daemon',
			projects,
			entries: buildEntries(projects, worktrees, runs),
			approvals,
			notRegistered: all.length === 0,
			truncatedProjects: all.length > projects.length,
			staleError: undefined,
		};
	}
}
