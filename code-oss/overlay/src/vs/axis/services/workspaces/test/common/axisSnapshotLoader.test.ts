/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonApi } from '../../../daemon/common/axisDaemonApi.js';
import { AxisDaemonCallError } from '../../../daemon/common/axisDaemonClient.js';
import { FakeDaemonClient, runWire, wire } from '../../../daemon/test/common/axisDaemonFixtures.js';
import { MAX_POLLED_PROJECTS } from '../../common/axisDaemonNotice.js';
import { AxisSnapshotLoader, sameSnapshot } from '../../common/axisSnapshotLoader.js';
import { AxisDataProvenance, IAxisCliRun, IAxisProjectInfo, IAxisWorkspaceLoadSource, IAxisWorktreeInfo } from '../../common/axisWorkspaceData.js';

const DISK_PROJECT: IAxisProjectInfo = { id: 'p-disk', name: 'disk-repo', trusted: true };
const DISK_WORKTREES: IAxisWorktreeInfo[] = [
	{ origin: 'external', projectId: 'p-disk', branch: 'main', head: null, path: '/work/main', locked: false, present: true },
	{ origin: 'external', projectId: 'p-disk', branch: 'feat', head: null, path: '/work/wt-a', locked: false, present: true },
];

class FakeDisk implements IAxisWorkspaceLoadSource {
	readonly onDidChange = Event.None;
	runsProvenance: AxisDataProvenance = 'discovery';
	projects: IAxisProjectInfo[] = [DISK_PROJECT];
	reads = 0;
	async listProjects() { this.reads++; return this.projects; }
	async listWorktrees() { return DISK_WORKTREES; }
	async listCliRuns(): Promise<readonly IAxisCliRun[]> { return []; }
	async getLocalCheckout() { return '/work/main'; }
	async countRefusedWorktrees() { return 2; }
}

function daemonWith(client: FakeDaemonClient): void {
	client.replies.set('axis.projects.list', { projects: [{ id: 'proj-1', name: 'Repo', trusted: true }] });
	client.replies.set('axis.worktrees.list', { worktrees: [wire({ path: '/work/main', origin: 'external' }), wire({ id: 'ws-a', path: '/work/wt-a' })] });
	client.replies.set('axis.worktrees.status', { worktrees: [wire({ id: 'ws-a', path: '/work/wt-a', dirty: { staged: 1, unstaged: 0, untracked: 0 }, ahead: 2, behind: 0 })] });
	client.replies.set('axis.cli-runs.list', { runs: [runWire({ workspaceId: 'ws-a', status: 'quiet' })] });
	client.replies.set('axis.approvals.pending', { challenges: [{ challengeId: 'c1' }] });
}

suite('Axis snapshot loader', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const client = new FakeDaemonClient();
		const disk = new FakeDisk();
		daemonWith(client);
		return { client, disk, loader: new AxisSnapshotLoader(disk, new AxisDaemonApi(client)) };
	}

	test('a usable daemon is the source: rows, status fields, runs, approvals', async () => {
		const { client, loader } = setup();
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'daemon');
		assert.strictEqual(snapshot.runsProvenance, 'daemon');
		assert.strictEqual(snapshot.pendingApprovals, 1);
		assert.strictEqual(snapshot.staleError, undefined);
		const wt = snapshot.entries.find(e => e.key === 'ws-a')!;
		assert.deepStrictEqual(wt.worktree.dirty, { staged: 1, unstaged: 0, untracked: 0 });
		assert.strictEqual(wt.worktree.ahead, 2);
		assert.strictEqual(wt.runs.length, 1);
		assert.strictEqual(wt.attention, 'runQuiet');
		client.dispose();
	});

	test('the local checkout is decided from the disk reader, and gets no runs', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.worktrees.list', { worktrees: [wire({ id: 'ws-main', path: '/work/main' }), wire({ id: 'ws-a', path: '/work/wt-a' })] });
		client.replies.set('axis.cli-runs.list', { runs: [runWire({ workspaceId: 'ws-a' }), runWire({ runId: 'run-2', workspaceId: 'ws-main' })] });
		const snapshot = await loader.load({ kind: 'degraded' });
		const local = snapshot.entries.filter(e => e.isLocalCheckout);
		assert.deepStrictEqual(local.map(e => e.worktree.path), ['/work/main']);
		assert.strictEqual(local[0].runs.length, 0, 'a run recorded for the local checkout is not shown');
		assert.strictEqual(snapshot.entries.find(e => e.key === 'ws-a')!.runs.length, 1);
		client.dispose();
	});

	test('a daemon path equal to no local checkout is not a local checkout, even if its name looks like one', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.worktrees.list', { worktrees: [wire({ id: 'ws-a', path: '/elsewhere/main' })] });
		client.replies.set('axis.worktrees.status', { worktrees: [] });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.ok(snapshot.entries.every(e => !e.isLocalCheckout));
		client.dispose();
	});

	test('every status that is not ready or degraded reads the disk and asks the daemon nothing', async () => {
		for (const status of [{ kind: 'connecting' }, { kind: 'down' }, { kind: 'failed', reason: 'crash_loop' }, { kind: 'failed', reason: 'pty_required' }] as const) {
			const { client, loader } = setup();
			const snapshot = await loader.load(status);
			assert.strictEqual(snapshot.origin, 'discovery', status.kind);
			assert.strictEqual(snapshot.runsProvenance, 'discovery');
			assert.strictEqual(snapshot.refusedWorktrees, 2);
			assert.strictEqual(snapshot.pendingApprovals, undefined);
			assert.strictEqual(client.calls.length, 0, 'no call to a daemon that is not usable');
			client.dispose();
		}
	});

	test('no registered project: the disk rows are shown and the state says so', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.projects.list', { projects: [] });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'discovery');
		assert.strictEqual(snapshot.notRegistered, true);
		assert.strictEqual(snapshot.entries.length, 2);
		client.dispose();
	});

	test('a failed read keeps the last daemon rows and marks them stale with the closed code', async () => {
		const { client, loader } = setup();
		const good = await loader.load({ kind: 'ready' });
		client.replies.set('axis.cli-runs.list', () => { throw new AxisDaemonCallError('E_TIMEOUT'); });
		const stale = await loader.load({ kind: 'ready' });
		assert.strictEqual(stale.origin, 'daemon');
		assert.strictEqual(stale.staleError, 'E_TIMEOUT');
		assert.deepStrictEqual(stale.entries, good.entries);
		client.replies.set('axis.cli-runs.list', () => { throw new Error('/home/user/.secret leaked in a message'); });
		assert.strictEqual((await loader.load({ kind: 'ready' })).staleError, 'E_INTERNAL', 'a foreign error is reduced to a code');
		client.dispose();
	});

	test('a failed first read falls back to the disk rows with the error marked', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.projects.list', { projects: [{ id: 'proj-1', name: 'Repo', trusted: true, extra: 1 }] });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'discovery');
		assert.strictEqual(snapshot.staleError, 'invalid_reply');
		client.dispose();
	});

	test('a daemon that goes down drops its old rows: coming back reads fresh data, not the old snapshot', async () => {
		const { client, loader } = setup();
		await loader.load({ kind: 'ready' });
		await loader.load({ kind: 'down' });
		client.replies.set('axis.projects.list', () => { throw new AxisDaemonCallError('E_UNAVAILABLE'); });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'discovery', 'the old daemon rows are not shown after the daemon went down');
		client.dispose();
	});

	test('an approvals failure does not fail the read', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.approvals.pending', () => { throw new AxisDaemonCallError('E_UNAVAILABLE'); });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'daemon');
		assert.strictEqual(snapshot.pendingApprovals, undefined);
		assert.strictEqual(snapshot.staleError, undefined);
		client.dispose();
	});

	test('a failed status read fails the whole read; partial data is not merged', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.worktrees.status', () => { throw new AxisDaemonCallError('E_BACKPRESSURE'); });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'discovery');
		assert.strictEqual(snapshot.staleError, 'E_BACKPRESSURE');
		client.dispose();
	});

	test('only the first 50 projects are read, and the snapshot says so', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.projects.list', { projects: Array.from({ length: MAX_POLLED_PROJECTS + 5 }, (_, i) => ({ id: `proj-${i}`, name: `r${i}`, trusted: true })) });
		client.replies.set('axis.worktrees.list', (params: unknown) => ({ worktrees: [wire({ projectId: (params as { projectId: string }).projectId, path: '/w/x' })] }));
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.projects.length, MAX_POLLED_PROJECTS);
		assert.strictEqual(snapshot.truncatedProjects, true);
		assert.strictEqual(client.calls.filter(c => c.method === 'list' && c.contract === 'axis.worktrees').length, MAX_POLLED_PROJECTS);
		client.dispose();
	});

	test('an unchanged read is the same snapshot, a changed one is not', async () => {
		const { client, loader } = setup();
		const first = await loader.load({ kind: 'ready' });
		assert.ok(sameSnapshot(first, await loader.load({ kind: 'ready' })));
		client.replies.set('axis.cli-runs.list', { runs: [runWire({ workspaceId: 'ws-a', status: 'failed', state: 'FAILED', endedAt: '2026-11-06T11:00:00.000Z', exitCode: 1, live: false })] });
		assert.ok(!sameSnapshot(first, await loader.load({ kind: 'ready' })));
		assert.ok(!sameSnapshot(undefined, first));
		client.dispose();
	});
});
