// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-5 review B1, end to end through the exported API: after a good read, a failed read keeps the rows on screen but
// never presents their trust or approvals as current, and nothing can be resolved from them; a good read restores both.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { APPROVAL_GUARD_MS, AxisApprovalController, type IAxisGestureEvent, type IAxisGestureScope } from '../../src/approvals/axisApprovals.js';
import { AxisDaemonApi } from '../../src/daemon/axisDaemonApi.js';
import { AxisDaemonCallError } from '../../src/daemon/axisDaemonClient.js';
import { bannerContent, projectChip, trustSource } from '../../src/projects/axisProjectActions.js';
import { approvalsAvailability } from '../../src/workspaces/axisDaemonNotice.js';
import { AxisSnapshotLoader, type IAxisSnapshot } from '../../src/workspaces/axisSnapshotLoader.js';
import { challengeWire, FakeDaemonClient, runWire, wire } from '../daemon/axisDaemonFixtures.js';

const button = { name: 'approve' };
const scope: IAxisGestureScope = { card: { contains: n => n === button }, button, activeElement: button, isInComposer: () => false };
const click: IAxisGestureEvent = { isTrusted: true, type: 'click', target: button };

suite('Axis stale facts (review B1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('good read, failed read, recovery: trust and approvals are current only after a good read', async () => {
		const client = new FakeDaemonClient();
		client.replies.set('axis.projects.list', { projects: [{ id: 'proj-1', name: 'repo', trusted: true }] });
		client.replies.set('axis.worktrees.list', { worktrees: [wire({ id: 'ws-a' })] });
		client.replies.set('axis.worktrees.status', { worktrees: [] });
		client.replies.set('axis.cli-runs.list', { runs: [runWire()] });
		client.replies.set('axis.approvals.pending', { challenges: [challengeWire()] });
		client.replies.set('axis.approvals.resolve', (p: unknown) => ({ challengeId: (p as { challengeId: string }).challengeId, state: 'approved', nativeRequired: false }));
		const status = { kind: 'ready' } as const;
		const loader = new AxisSnapshotLoader(new AxisDaemonApi(client));
		let snapshot: IAxisSnapshot = await loader.load(status);
		let mono = 0;
		const controller = new AxisApprovalController(new AxisDaemonApi(client), () => snapshot.approvals, () => 1_000_000, () => mono, () => {});
		const resolves = () => client.calls.filter(c => c.method === 'resolve').length;

		// A good read: current trust and an answerable card.
		const [shown] = controller.layout();
		mono += APPROVAL_GUARD_MS + 1;
		assert.strictEqual(trustSource(status, snapshot), 'daemon');
		assert.match(projectChip(snapshot.projects[0]!, trustSource(status, snapshot)).label, /trusted to run/);
		assert.strictEqual(approvalsAvailability(status, snapshot).cards, true);

		// The next read times out while the client stays ready.
		client.replies.set('axis.cli-runs.list', () => { throw new AxisDaemonCallError('E_TIMEOUT'); });
		snapshot = await loader.load(status);
		assert.strictEqual(snapshot.staleError, 'E_TIMEOUT');
		assert.strictEqual(snapshot.entries.length, 1, 'the rows stay on screen, marked stale');
		assert.strictEqual(snapshot.approvals, undefined, 'the old listing is not kept');
		const source = trustSource(status, snapshot);
		assert.strictEqual(source, 'stale');
		assert.match(projectChip(snapshot.projects[0]!, source).label, /run trust unknown/);
		assert.doesNotMatch(projectChip(snapshot.projects[0]!, source).label, /trusted to run/);
		assert.strictEqual(bannerContent('trusted', source).action, undefined);
		assert.strictEqual(approvalsAvailability(status, snapshot).cards, false);
		assert.deepStrictEqual(controller.layout(), [], 'no card is drawn');
		mono += APPROVAL_GUARD_MS + 1;
		assert.deepStrictEqual(await controller.decide(shown!, 'approve', click, scope), { kind: 'stale' });
		assert.strictEqual(resolves(), 0, 'nothing is resolved from a stale card');

		// A good read again: current trust and the card is answerable after its guard time.
		client.replies.set('axis.cli-runs.list', { runs: [runWire()] });
		snapshot = await loader.load(status);
		assert.strictEqual(trustSource(status, snapshot), 'daemon');
		assert.strictEqual(approvalsAvailability(status, snapshot).cards, true);
		const [again] = controller.layout();
		mono += APPROVAL_GUARD_MS + 1;
		assert.deepStrictEqual(await controller.decide(again!, 'approve', click, scope), { kind: 'approved' });
		assert.strictEqual(resolves(), 1);
		client.dispose();
	});
});
