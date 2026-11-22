/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisProjectAction, AxisProjectOutcome, windowLocalCheckoutIds } from '../../common/axisProjectActions.js';
import { AxisProjectActionsModel } from '../../common/axisProjectActionsService.js';

function fakeClient() {
	const calls: Array<{ action: AxisProjectAction; answer: DeferredPromise<AxisProjectOutcome> }> = [];
	let disposed = 0;
	return {
		calls,
		disposed: () => disposed,
		client: {
			run: (action: AxisProjectAction) => { const answer = new DeferredPromise<AxisProjectOutcome>(); calls.push({ action, answer }); return answer.p; },
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
		assert.strictEqual(f.calls.length, 1, 'mutant: a second request sent');
		f.calls[0].answer.complete('trusted');
		assert.strictEqual(await first, 'trusted');
		assert.strictEqual(model.waiting, undefined);
		assert.strictEqual(model.lastOutcome, 'trusted');
		assert.ok(changes >= 2);
		const next = model.run('untrust');
		assert.strictEqual(model.lastOutcome, undefined, 'a new action clears the last outcome');
		f.calls[1].answer.error(new Error('ipc closed'));
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

	test('the window project is the local checkout row at the one open folder', () => {
		const entries = [
			{ isLocalCheckout: true, project: { id: 'p1' }, worktree: { path: '/r/one' } },
			{ isLocalCheckout: false, project: { id: 'p1' }, worktree: { path: '/r/one-wt' } },
			{ isLocalCheckout: true, project: { id: 'p2' }, worktree: { path: '/r/two' } },
		];
		assert.deepStrictEqual(windowLocalCheckoutIds(entries, ['/r/one']), ['p1']);
		assert.deepStrictEqual(windowLocalCheckoutIds(entries, ['/r/one-wt']), [], 'a worktree folder is not the local checkout');
		assert.deepStrictEqual(windowLocalCheckoutIds(entries, ['/r/one', '/r/two']), [], 'a multi-root window has no single project');
		assert.deepStrictEqual(windowLocalCheckoutIds(entries, []), []);
	});
});
