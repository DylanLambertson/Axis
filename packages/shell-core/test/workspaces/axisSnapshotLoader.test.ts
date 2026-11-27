// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/workspaces/test/common/axisSnapshotLoader.test.ts) by OS-5. The disk-reader
// cases are replaced by the daemon-only ones: no usable daemon, or no good read yet, is an empty snapshot.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { AxisDaemonApi } from '../../src/daemon/axisDaemonApi.js';
import { AxisDaemonCallError } from '../../src/daemon/axisDaemonClient.js';
import { MAX_POLLED_PROJECTS } from '../../src/workspaces/axisDaemonNotice.js';
import { AxisSnapshotLoader, emptySnapshot, sameSnapshot, workspaceKeyOf } from '../../src/workspaces/axisSnapshotLoader.js';
import { type IAxisWorktreeInfo } from '../../src/workspaces/axisWorkspaceData.js';
import { lastPathSegment } from '../../src/workspaces/displayText.js';
import { challengeWire, FakeDaemonClient, runWire, wire } from '../daemon/axisDaemonFixtures.js';

function row(extra: Record<string, unknown>): IAxisWorktreeInfo {
	return wire(extra) as unknown as IAxisWorktreeInfo;
}

function daemonWith(client: FakeDaemonClient): void {
	client.replies.set('axis.projects.list', { projects: [{ id: 'proj-1', name: 'Repo', trusted: true }] });
	client.replies.set('axis.worktrees.list', { worktrees: [wire({ path: '/work/main', origin: 'external' }), wire({ id: 'ws-a', path: '/work/wt-a' })] });
	client.replies.set('axis.worktrees.status', { worktrees: [wire({ id: 'ws-a', path: '/work/wt-a', dirty: { staged: 1, unstaged: 0, untracked: 0 }, ahead: 2, behind: 0 })] });
	client.replies.set('axis.cli-runs.list', { runs: [runWire({ workspaceId: 'ws-a', status: 'quiet' })] });
	client.replies.set('axis.approvals.pending', { challenges: [challengeWire()] });
}

suite('Axis snapshot loader', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const client = new FakeDaemonClient();
		daemonWith(client);
		return { client, loader: new AxisSnapshotLoader(new AxisDaemonApi(client)) };
	}

	test('a usable daemon is the source: rows, status fields, runs, approvals', async () => {
		const { client, loader } = setup();
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'daemon');
		assert.strictEqual(snapshot.approvals?.length, 1);
		assert.strictEqual(snapshot.approvals?.[0]?.targetSummary, 'Remove the worktree feat-x');
		assert.strictEqual(snapshot.staleError, undefined);
		assert.strictEqual(snapshot.notRegistered, false);
		const wt = snapshot.entries.find(e => e.key === 'ws-a')!;
		assert.deepStrictEqual(wt.worktree.dirty, { staged: 1, unstaged: 0, untracked: 0 });
		assert.strictEqual(wt.worktree.ahead, 2);
		assert.strictEqual(wt.runs.length, 1);
		assert.strictEqual(wt.attention, 'runQuiet');
		assert.strictEqual(wt.label, 'wt-a');
		client.dispose();
	});

	test('the status read replaces the counts of a row, and a count it does not carry is dropped', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.worktrees.list', { worktrees: [wire({ id: 'ws-a', path: '/work/wt-a', dirty: { staged: 9, unstaged: 9, untracked: 9 }, ahead: 9, behind: 9 })] });
		client.replies.set('axis.worktrees.status', { worktrees: [wire({ id: 'ws-a', path: '/work/wt-a', ahead: 1 })] });
		const row = (await loader.load({ kind: 'ready' })).entries[0]!.worktree;
		assert.strictEqual(row.ahead, 1);
		assert.ok(!('dirty' in row) && !('behind' in row), 'no stale count from the list survives a status read');
		client.dispose();
	});

	test('no row is a local checkout: the daemon lists none, and a row named like one gets its runs', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.worktrees.list', { worktrees: [wire({ id: 'ws-main', path: '/work/main' })] });
		client.replies.set('axis.worktrees.status', { worktrees: [] });
		client.replies.set('axis.cli-runs.list', { runs: [runWire({ workspaceId: 'ws-main' })] });
		const snapshot = await loader.load({ kind: 'degraded' });
		assert.ok(snapshot.entries.every(e => !e.isLocalCheckout));
		assert.strictEqual(snapshot.entries[0]?.runs.length, 1);
		client.dispose();
	});

	test('a worktree without a journal id gets a key no run can claim', async () => {
		const { client, loader } = setup();
		const snapshot = await loader.load({ kind: 'ready' });
		const external = snapshot.entries.find(e => e.worktree.id === undefined)!;
		assert.strictEqual(external.key, 'external:proj-1:/work/main');
		assert.strictEqual(external.runs.length, 0);
		assert.strictEqual(workspaceKeyOf(row({ id: 'ws-a' })), 'ws-a', 'a journal id is the key');
		assert.notStrictEqual(workspaceKeyOf(row({ path: '/a', projectId: 'p1' })), workspaceKeyOf(row({ path: '/a', projectId: 'p2' })), 'the project is part of the key');
		client.replies.set('axis.cli-runs.list', { runs: [runWire({ workspaceId: external.key })] });
		assert.deepStrictEqual(await loader.load({ kind: 'ready' }), { ...snapshot, approvals: undefined, staleError: 'invalid_reply' }, 'a run naming a derived key is refused by the reply reader, never attached');
		client.dispose();
	});

	test('every status that is not ready or degraded is an empty snapshot and asks the daemon nothing', async () => {
		for (const status of [{ kind: 'connecting' }, { kind: 'down' }, { kind: 'failed', reason: 'crash_loop' }, { kind: 'failed', reason: 'pty_required' }] as const) {
			const { client, loader } = setup();
			const snapshot = await loader.load(status);
			assert.deepStrictEqual(snapshot, emptySnapshot(), status.kind);
			assert.strictEqual(snapshot.origin, 'none');
			assert.strictEqual(client.calls.length, 0, 'no call to a daemon that is not usable');
			client.dispose();
		}
	});

	test('no registered project: daemon origin, no rows, and the state says so', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.projects.list', { projects: [] });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'daemon');
		assert.strictEqual(snapshot.notRegistered, true);
		assert.strictEqual(snapshot.entries.length, 0);
		assert.ok(!client.calls.some(c => c.contract === 'axis.cli-runs'), 'no runs are read for no project');
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
		assert.strictEqual(good.approvals?.length, 1);
		assert.strictEqual(stale.approvals, undefined, 'review B1: the rows stay, the approvals of the old read do not (mutant: approvals kept)');
		client.replies.set('axis.cli-runs.list', () => { throw new Error('/home/user/.secret leaked in a message'); });
		assert.strictEqual((await loader.load({ kind: 'ready' })).staleError, 'E_INTERNAL', 'a foreign error is reduced to a code');
		client.dispose();
	});

	test('a stale read does not replace the last good rows: the next good read is fresh again', async () => {
		const { client, loader } = setup();
		await loader.load({ kind: 'ready' });
		client.replies.set('axis.cli-runs.list', () => { throw new AxisDaemonCallError('E_TIMEOUT'); });
		await loader.load({ kind: 'ready' });
		client.replies.set('axis.cli-runs.list', { runs: [] });
		const fresh = await loader.load({ kind: 'ready' });
		assert.strictEqual(fresh.staleError, undefined);
		assert.strictEqual(fresh.entries.find(e => e.key === 'ws-a')!.runs.length, 0);
		client.dispose();
	});

	test('a failed first read is an empty snapshot with the error marked', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.projects.list', { projects: [{ id: 'proj-1', name: 'Repo', trusted: true, extra: 1 }] });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.deepStrictEqual(snapshot, emptySnapshot('invalid_reply'));
		client.dispose();
	});

	test('a daemon that goes down drops its old rows: coming back reads fresh data, not the old snapshot', async () => {
		const { client, loader } = setup();
		await loader.load({ kind: 'ready' });
		await loader.load({ kind: 'down' });
		client.replies.set('axis.projects.list', () => { throw new AxisDaemonCallError('E_UNAVAILABLE'); });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'none', 'the old daemon rows are not shown after the daemon went down');
		assert.strictEqual(snapshot.staleError, 'E_UNAVAILABLE');
		client.dispose();
	});

	test('an approvals failure does not fail the read', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.approvals.pending', () => { throw new AxisDaemonCallError('E_UNAVAILABLE'); });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.strictEqual(snapshot.origin, 'daemon');
		assert.strictEqual(snapshot.approvals, undefined);
		assert.strictEqual(snapshot.staleError, undefined);
		client.dispose();
	});

	test('a failed status read fails the whole read; partial data is not merged', async () => {
		const { client, loader } = setup();
		client.replies.set('axis.worktrees.status', () => { throw new AxisDaemonCallError('E_BACKPRESSURE'); });
		const snapshot = await loader.load({ kind: 'ready' });
		assert.deepStrictEqual(snapshot, emptySnapshot('E_BACKPRESSURE'));
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

	test('a row label is the last path segment, either separator, trailing ones dropped', () => {
		assert.strictEqual(lastPathSegment('/work/wt-a'), 'wt-a');
		assert.strictEqual(lastPathSegment('/work/wt-a//'), 'wt-a');
		assert.strictEqual(lastPathSegment('C:\\work\\wt-b\\'), 'wt-b');
		assert.strictEqual(lastPathSegment('mixed/dir\\leaf'), 'leaf');
		assert.strictEqual(lastPathSegment('plain'), 'plain');
		assert.strictEqual(lastPathSegment('///'), '');
	});
});
