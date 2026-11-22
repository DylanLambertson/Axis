/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisProjectAction, AxisProjectOutcome, IAxisProjectAnswer } from '../../common/axisProjectActions.js';
import { AxisProjectActionsModel } from '../../common/axisProjectActionsService.js';

function fakeClient() {
	const calls: Array<{ action: AxisProjectAction | 'status'; answer: DeferredPromise<AxisProjectOutcome | IAxisProjectAnswer> }> = [];
	const ask = (action: AxisProjectAction | 'status') => { const answer = new DeferredPromise<AxisProjectOutcome | IAxisProjectAnswer>(); calls.push({ action, answer }); return answer.p; };
	let disposed = 0;
	return {
		calls,
		disposed: () => disposed,
		client: {
			run: (action: AxisProjectAction | 'status') => ask(action).then(a => typeof a === 'string' ? a : a.outcome),
			status: () => ask('status').then(a => typeof a === 'string' ? { outcome: a } : a),
			dispose: () => void disposed++,
		},
	};
}

suite('Axis project actions service (S3)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('one action at a time: a second while one waits is busy without asking main; the outcome is kept for the banner', async () => {
		const f = fakeClient();
		const model = store.add(new AxisProjectActionsModel(f.client));
		let changes = 0;
		store.add(model.onDidChange(() => changes++));
		const first = model.run('trust');
		assert.strictEqual(model.waiting, 'trust');
		assert.strictEqual(await model.run('add'), 'busy');
		const acts = () => f.calls.filter(c => c.action !== 'status');
		assert.strictEqual(acts().length, 1, 'mutant: a second request sent');
		acts()[0].answer.complete('trusted');
		assert.strictEqual(await first, 'trusted');
		assert.strictEqual(model.waiting, undefined);
		assert.strictEqual(model.lastOutcome, 'trusted');
		assert.ok(changes >= 2);
		const next = model.run('untrust');
		assert.strictEqual(model.lastOutcome, undefined, 'a new action clears the last outcome');
		acts()[1].answer.error(new Error('ipc closed'));
		assert.strictEqual(await next, 'unavailable', 'a throwing client is unavailable');
	});

	test('without a client (web, browser) every action is unavailable; dispose disposes the client', async () => {
		const none = store.add(new AxisProjectActionsModel(undefined));
		assert.strictEqual(await none.run('add'), 'unavailable');
		assert.strictEqual(none.lastOutcome, 'unavailable');
		const f = fakeClient();
		const model = new AxisProjectActionsModel(f.client);
		model.dispose();
		assert.strictEqual(f.disposed(), 1);
	});

	test('status: asked once, calls meanwhile coalesce into one more; the answer is kept; an action asks again after it ends', async () => {
		const f = fakeClient();
		const model = store.add(new AxisProjectActionsModel(f.client));
		let changes = 0;
		store.add(model.onDidChange(() => changes++));
		assert.strictEqual(model.windowTrust, 'unknown');
		model.refreshStatus();
		model.refreshStatus();
		model.refreshStatus();
		assert.deepStrictEqual(f.calls.map(c => c.action), ['status'], 'one in flight (mutant: one request per call)');
		f.calls[0].answer.complete('status_read_only');
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		assert.strictEqual(model.windowTrust, 'read_only');
		assert.deepStrictEqual(f.calls.map(c => c.action), ['status', 'status'], 'the coalesced calls became exactly one more');
		f.calls[1].answer.complete('status_read_only');
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		assert.strictEqual(changes, 1, 'an unchanged answer does not re-render');
		const trust = model.run('trust');
		f.calls[2].answer.complete('trusted');
		await trust;
		assert.strictEqual(f.calls[3]?.action, 'status', 'the action asks for status again when it ends');
		model.refreshStatus();
		f.calls[3].answer.complete('busy');
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		assert.strictEqual(model.windowTrust, 'read_only', 'busy keeps the last answer (review N2)');
		f.calls[4].answer.complete('unavailable');
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		assert.strictEqual(model.windowTrust, 'unknown', 'main could not tell: unknown, never the last good answer');
	});

	test('without a client, status stays unknown and nothing is sent', () => {
		const none = store.add(new AxisProjectActionsModel(undefined));
		none.refreshStatus();
		assert.strictEqual(none.windowTrust, 'unknown');
	});

	test('PV-D1-0: the window project id comes with a registered status answer only, and goes with any other answer', async () => {
		const f = fakeClient();
		const model = store.add(new AxisProjectActionsModel(f.client));
		const settle = async (a: AxisProjectOutcome | IAxisProjectAnswer) => {
			model.refreshStatus();
			f.calls[f.calls.length - 1].answer.complete(a);
			await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		};
		await settle({ outcome: 'status_read_only', projectId: 'p-7' });
		assert.strictEqual(model.windowProjectId, 'p-7');
		await settle('busy');
		assert.strictEqual(model.windowProjectId, 'p-7', 'busy keeps it');
		await settle({ outcome: 'status_trusted', projectId: 'p-7' });
		assert.strictEqual(model.windowTrust, 'trusted');
		await settle('status_not_registered');
		assert.strictEqual(model.windowProjectId, undefined, 'not registered clears it (mutant: kept)');
		await settle({ outcome: 'status_read_only', projectId: 'p-8' });
		await settle('unavailable');
		assert.strictEqual(model.windowProjectId, undefined, 'unknown clears it: never a stale project home');
	});
});
