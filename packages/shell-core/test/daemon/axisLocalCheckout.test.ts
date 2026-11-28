// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-7 (docs/design/worktrees-local-checkout.md): the reader of `axis.worktrees/1.list` takes the "local" row only when the
// caller asked for it (`listWorktrees(id, { includeLocal: true })`), only first, and only without id, state, base, counts
// or lock. A plain list and every status reply still refuse "local" whole, as an unknown origin is refused.
// Mutants: "local" read without asking, "local" read in a status reply, a local row after another, a local row with an id
// or counts, a locked local row, includeLocal not sent.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { AxisDaemonApi } from '../../src/daemon/axisDaemonApi.js';
import { AxisDaemonCallError } from '../../src/daemon/axisDaemonClient.js';
import { readWorktrees } from '../../src/daemon/axisDaemonReplies.js';
import { FakeDaemonClient, SHA, wire } from './axisDaemonFixtures.js';

const local = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
	({ origin: 'local', projectId: 'proj-1', branch: 'main', head: SHA, path: '/home/u/repo', locked: false, present: true, ...extra });

function invalidReply(fn: () => unknown, message: string): void {
	assert.throws(fn, error => error instanceof AxisDaemonCallError && error.code === 'invalid_reply', message);
}

suite('Axis local checkout row', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('read only when asked, only first, and without workspace fields', () => {
		const [row, next] = readWorktrees({ worktrees: [local(), wire({ id: 'ws-a' })] }, undefined, { local: true });
		assert.deepStrictEqual(row, { origin: 'local', projectId: 'proj-1', branch: 'main', head: SHA, path: '/home/u/repo', locked: false, present: true });
		assert.strictEqual(next?.id, 'ws-a');
		assert.strictEqual(readWorktrees({ worktrees: [local({ branch: null, head: null, present: false })] }, undefined, { local: true })[0].head, null);
		invalidReply(() => readWorktrees({ worktrees: [local()] }), 'a local row nobody asked for');
		invalidReply(() => readWorktrees({ worktrees: [wire({ id: 'ws-a' }), local()] }, undefined, { local: true }), 'a local row after another');
		for (const [k, v] of [['id', 'ws-x'], ['state', 'READY'], ['baseRef', 'main'], ['baseSha', SHA], ['dirty', { staged: 0, unstaged: 0, untracked: 0 }], ['ahead', 0], ['behind', 0]] as const) {
			invalidReply(() => readWorktrees({ worktrees: [local({ [k]: v })] }, undefined, { local: true }), `a local row with ${k}`);
		}
		invalidReply(() => readWorktrees({ worktrees: [local({ locked: true })] }, undefined, { local: true }), 'a locked local row');
		invalidReply(() => readWorktrees({ worktrees: [local({ origin: 'remote' })] }, undefined, { local: true }), 'an unknown origin');
	});

	test('listWorktrees sends includeLocal only when asked, and statusOf never reads a local row', async () => {
		const client = new FakeDaemonClient();
		client.replies.set('axis.worktrees.list', (params: unknown) => ({ worktrees: (params as { includeLocal?: true }).includeLocal ? [local(), wire({ id: 'ws-a' })] : [wire({ id: 'ws-a' })] }));
		client.replies.set('axis.worktrees.status', { worktrees: [local()] });
		const api = new AxisDaemonApi(client);
		assert.deepStrictEqual((await api.listWorktrees('proj-1')).map(w => w.origin), ['axis']);
		assert.deepStrictEqual((await api.listWorktrees('proj-1', { includeLocal: true })).map(w => w.origin), ['local', 'axis']);
		assert.deepStrictEqual(client.calls.map(c => c.params), [{ projectId: 'proj-1' }, { projectId: 'proj-1', includeLocal: true }]);
		await assert.rejects(api.statusOf(['ws-a']), (e: AxisDaemonCallError) => e.code === 'invalid_reply');
		client.dispose();
	});
});
