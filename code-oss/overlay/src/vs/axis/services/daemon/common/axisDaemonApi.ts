/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { AXIS_ID_PATTERN, IAxisCliRun, IAxisProjectInfo, IAxisWorktreeInfo } from '../../workspaces/common/axisWorkspaceData.js';
import { AxisDaemonCallError, IAxisDaemonClient } from './axisDaemonClient.js';
import { MAX_STATUS_IDS, readCliRuns, readPendingCount, readProjects, readWorktrees } from './axisDaemonReplies.js';

/**
 * The read calls the dashboard makes (docs/design/axis-shell-a2.md). The only
 * code that uses the client: fixed contract and method names, ids that match
 * the journal-id pattern and nothing else in the requests (never a path), and
 * every reply validated and cleaned before it is returned.
 */
export class AxisDaemonApi {

	constructor(private readonly client: IAxisDaemonClient, private readonly token?: CancellationToken) { }

	async listProjects(): Promise<IAxisProjectInfo[]> {
		return readProjects(await this.client.request('axis.projects', 'list', {}, this.token));
	}

	async listWorktrees(projectId: string): Promise<IAxisWorktreeInfo[]> {
		const reply = readWorktrees(await this.client.request('axis.worktrees', 'list', { projectId: checkedId(projectId) }, this.token));
		return reply.filter(w => w.projectId === projectId); // another project's worktree is not this project's row
	}

	/** `status` of the given worktree ids, 100 per call; a reply for an id that was not asked for is dropped. */
	async statusOf(ids: readonly string[]): Promise<IAxisWorktreeInfo[]> {
		const out: IAxisWorktreeInfo[] = [];
		for (let i = 0; i < ids.length; i += MAX_STATUS_IDS) {
			const chunk = ids.slice(i, i + MAX_STATUS_IDS).map(checkedId);
			const reply = readWorktrees(await this.client.request('axis.worktrees', 'status', { ids: chunk }, this.token), MAX_STATUS_IDS);
			out.push(...reply.filter(w => w.id !== undefined && chunk.includes(w.id)));
		}
		return out;
	}

	async listCliRuns(): Promise<IAxisCliRun[]> {
		return readCliRuns(await this.client.request('axis.cli-runs', 'list', { limit: 200 }, this.token));
	}

	/** The number of open challenges in this window. */
	async pendingApprovals(): Promise<number> {
		return readPendingCount(await this.client.request('axis.approvals', 'pending', {}, this.token));
	}
}

function checkedId(value: string): string {
	if (!AXIS_ID_PATTERN.test(value)) {
		throw new AxisDaemonCallError('E_INVALID_ARGUMENT');
	}
	return value;
}
