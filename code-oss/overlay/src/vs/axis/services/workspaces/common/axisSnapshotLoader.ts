/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import { AxisCallErrorCode, AxisDaemonCallError, AxisDaemonStatus, isUsable } from '../../daemon/common/axisDaemonClient.js';
import { AxisDaemonApi } from '../../daemon/common/axisDaemonApi.js';
import { IAxisApprovalCard } from '../../approvals/common/axisApprovals.js';
import { MAX_POLLED_PROJECTS } from './axisDaemonNotice.js';
import { AxisDataProvenance, IAxisCliRun, IAxisProjectInfo, IAxisWorkspaceLoadSource, IAxisWorktreeInfo } from './axisWorkspaceData.js';
import { attentionOf, IAxisWorkspaceEntry, orderEntries } from './axisWorkspaceModel.js';
import { workspaceKeyOf } from './axisDiscoveryDataSource.js';
import { displayName } from './worktreeDiscovery.js';

/** Where the rows of a snapshot come from. */
export type AxisDataOrigin = 'daemon' | 'discovery';

/** Everything the dashboard shows, read at one time. */
export interface IAxisSnapshot {
	readonly origin: AxisDataOrigin;
	readonly runsProvenance: AxisDataProvenance;
	readonly projects: readonly IAxisProjectInfo[];
	readonly entries: readonly IAxisWorkspaceEntry[];
	readonly refusedWorktrees: number;
	/** Open approval challenges, display data only; `undefined` when unknown. */
	readonly approvals: readonly IAxisApprovalCard[] | undefined;
	/** The daemon is usable but has no registered project, so the rows come from the disk reader. */
	readonly notRegistered: boolean;
	readonly truncatedProjects: boolean;
	/** Set when the last daemon read failed and the rows are the last good ones. */
	readonly staleError: AxisCallErrorCode | undefined;
}

/** Same data, ignoring object identity. Used so an unchanged poll does not redraw the dashboard. */
export function sameSnapshot(a: IAxisSnapshot | undefined, b: IAxisSnapshot): boolean {
	return !!a && JSON.stringify(a) === JSON.stringify(b);
}

function buildEntries(projects: readonly IAxisProjectInfo[], worktrees: ReadonlyMap<string, readonly IAxisWorktreeInfo[]>, runs: readonly IAxisCliRun[], isLocalCheckout: (projectId: string, worktree: IAxisWorktreeInfo) => boolean): IAxisWorkspaceEntry[] {
	const entries: IAxisWorkspaceEntry[] = [];
	for (const project of projects) {
		for (const worktree of worktrees.get(project.id) ?? []) {
			const key = workspaceKeyOf(worktree);
			const local = isLocalCheckout(project.id, worktree);
			const workspaceRuns = local ? [] : runs.filter(run => run.workspaceId === key);
			entries.push({
				key,
				project,
				worktree,
				isLocalCheckout: local,
				label: displayName(basename(worktree.path)),
				runs: workspaceRuns,
				attention: attentionOf(worktree, workspaceRuns),
			});
		}
	}
	return orderEntries(entries, projects.map(p => p.id));
}

/**
 * Turns the daemon status and the two sources into one snapshot
 * (docs/design/axis-shell-a2.md, "Data flow"). It holds no timer and no
 * listener: when to load is the refresh driver's decision.
 */
export class AxisSnapshotLoader {

	/** The last snapshot read from the daemon, kept while the daemon stays usable. */
	private lastDaemon: IAxisSnapshot | undefined;

	constructor(
		private readonly discovery: IAxisWorkspaceLoadSource,
		private readonly api: AxisDaemonApi,
	) { }

	async load(status: AxisDaemonStatus): Promise<IAxisSnapshot> {
		if (!isUsable(status)) {
			this.lastDaemon = undefined;
			return this.fromDiscovery({});
		}
		try {
			const snapshot = await this.fromDaemon();
			this.lastDaemon = snapshot.origin === 'daemon' ? snapshot : undefined;
			return snapshot;
		} catch (error) {
			const staleError = error instanceof AxisDaemonCallError ? error.code : 'E_INTERNAL';
			return this.lastDaemon ? { ...this.lastDaemon, staleError } : this.fromDiscovery({ staleError });
		}
	}

	private async fromDiscovery(extra: { staleError?: AxisCallErrorCode; notRegistered?: boolean }): Promise<IAxisSnapshot> {
		const projects = await this.discovery.listProjects();
		const runs = await this.discovery.listCliRuns();
		const worktrees = new Map<string, readonly IAxisWorktreeInfo[]>();
		const localCheckouts = new Map<string, string | undefined>();
		let refused = 0;
		for (const project of projects) {
			refused += await this.discovery.countRefusedWorktrees(project.id);
			localCheckouts.set(project.id, await this.discovery.getLocalCheckout(project.id));
			worktrees.set(project.id, await this.discovery.listWorktrees(project.id));
		}
		return {
			origin: 'discovery',
			runsProvenance: this.discovery.runsProvenance,
			projects,
			entries: buildEntries(projects, worktrees, runs, (projectId, worktree) => worktree.path === localCheckouts.get(projectId)),
			refusedWorktrees: refused,
			approvals: undefined,
			notRegistered: extra.notRegistered ?? false,
			truncatedProjects: false,
			staleError: extra.staleError,
		};
	}

	private async fromDaemon(): Promise<IAxisSnapshot> {
		const all = await this.api.listProjects();
		if (!all.length) {
			return this.fromDiscovery({ notRegistered: true });
		}
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
				return s ? { ...w, dirty: s.dirty, ahead: s.ahead, behind: s.behind } : w;
			}));
		}
		const runs = await this.api.listCliRuns();
		const approvals = await this.api.pendingApprovals().catch(() => undefined);

		// The local checkout is decided on this machine; a daemon path is only compared with it.
		const local = new Set<string>();
		try {
			for (const project of await this.discovery.listProjects()) {
				const path = await this.discovery.getLocalCheckout(project.id);
				if (path) {
					local.add(path);
				}
			}
		} catch {
			// no local data: no row is the local checkout
		}
		return {
			origin: 'daemon',
			runsProvenance: 'daemon',
			projects,
			entries: buildEntries(projects, worktrees, runs, (_projectId, worktree) => local.has(worktree.path)),
			refusedWorktrees: 0,
			approvals,
			notRegistered: false,
			truncatedProjects: all.length > projects.length,
			staleError: undefined,
		};
	}
}
