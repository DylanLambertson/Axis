/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonApi } from '../../common/axisDaemonApi.js';
import { AxisDaemonCallError, sameStatus, sanitizeStatus, toCallErrorCode } from '../../common/axisDaemonClient.js';
import { MAX_CLI_RUNS, MAX_PROJECTS, readCliRuns, readPendingCount, readProjects, readWorktrees } from '../../common/axisDaemonReplies.js';
import { FakeDaemonClient, runWire, SHA, wire } from './axisDaemonFixtures.js';

function invalidReply(fn: () => unknown, message: string): void {
	assert.throws(fn, error => error instanceof AxisDaemonCallError && error.code === 'invalid_reply', message);
}

suite('Axis daemon replies', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects: the exact shape is read, anything else is dropped whole', () => {
		assert.deepStrictEqual(readProjects({ projects: [{ id: 'proj-1', name: 'Repo', trusted: true }] }), [{ id: 'proj-1', name: 'Repo', trusted: true }]);
		invalidReply(() => readProjects({ projects: [{ id: 'proj-1', name: 'Repo', trusted: true, path: '/x' }] }), 'an extra key');
		invalidReply(() => readProjects({ projects: [{ id: 'proj-1', name: 'Repo' }] }), 'a missing key');
		invalidReply(() => readProjects({ projects: [{ id: '-bad', name: 'Repo', trusted: true }] }), 'an id that can start an option');
		invalidReply(() => readProjects({ projects: [{ id: 'proj-1', name: 'Repo', trusted: 'yes' }] }), 'a string for a boolean');
		invalidReply(() => readProjects({ projects: [{ id: 'p', name: 'a', trusted: true }, { id: 'p', name: 'b', trusted: true }] }), 'a duplicate id');
		invalidReply(() => readProjects({ projects: Array.from({ length: MAX_PROJECTS + 1 }, (_, i) => ({ id: `p${i}`, name: 'n', trusted: true })) }), 'too many projects');
		invalidReply(() => readProjects({ projects: [], extra: 1 }), 'an extra key on the reply');
		invalidReply(() => readProjects(null), 'null');
		invalidReply(() => readProjects([]), 'an array');
		invalidReply(() => readProjects({ projects: [{ id: 'proj-1', name: 'n'.repeat(81), trusted: true }] }), 'a name over the contract bound');
	});

	test('projects: names from the daemon are cleaned for display', () => {
		const [project] = readProjects({ projects: [{ id: 'proj-1', name: 'a‮b\u0007c', trusted: false }] });
		assert.strictEqual(project.name, 'a�b�c', 'bidi override and control characters become visible U+FFFD');
	});

	test('a reply with an inherited or exotic prototype is refused', () => {
		class Evil { projects = []; }
		invalidReply(() => readProjects(new Evil()), 'a class instance');
		assert.deepStrictEqual(readProjects(Object.assign(Object.create(null), { projects: [] })), []);
	});

	test('worktrees: shape, optional fields and cleaning', () => {
		const [w] = readWorktrees({ worktrees: [wire({ id: 'ws-a', state: 'READY', dirty: { staged: 1, unstaged: 2, untracked: 3 }, ahead: 4, behind: 5, branch: 'x‮y' })] });
		assert.strictEqual(w.id, 'ws-a');
		assert.deepStrictEqual(w.dirty, { staged: 1, unstaged: 2, untracked: 3 });
		assert.strictEqual(w.ahead, 4);
		assert.strictEqual(w.branch, 'x�y');
		assert.strictEqual(readWorktrees({ worktrees: [wire({ branch: null, head: null })] })[0].head, null);
		invalidReply(() => readWorktrees({ worktrees: [wire({ origin: 'remote' })] }), 'an origin outside the set');
		invalidReply(() => readWorktrees({ worktrees: [wire({ head: 'abc' })] }), 'a short sha');
		invalidReply(() => readWorktrees({ worktrees: [wire({ dirty: { staged: -1, unstaged: 0, untracked: 0 } })] }), 'a negative count');
		invalidReply(() => readWorktrees({ worktrees: [wire({ dirty: { staged: 1, unstaged: 0, untracked: 0, extra: 0 } })] }), 'an extra dirty key');
		invalidReply(() => readWorktrees({ worktrees: [wire({ path: 'p'.repeat(4097) })] }), 'a path over the bound');
		invalidReply(() => readWorktrees({ worktrees: [wire({ ahead: 1.5 })] }), 'a fraction');
		invalidReply(() => readWorktrees({ worktrees: [wire(), wire(), wire()] }, 2), 'more worktrees than the caller allows');
		assert.strictEqual(readWorktrees({ worktrees: [wire({ baseSha: SHA })] })[0].baseSha, SHA);
	});

	test('runs: shape, enums and the terminal-state rules', () => {
		const [run] = readCliRuns({ runs: [runWire()] });
		assert.strictEqual(run.status, 'running');
		assert.strictEqual(run.agentId, 'claude');
		invalidReply(() => readCliRuns({ runs: [runWire({ status: 'exploded' })] }), 'a status outside the set');
		invalidReply(() => readCliRuns({ runs: [runWire({ reason: 'free text from a daemon' })] }), 'a reason that is not a code');
		invalidReply(() => readCliRuns({ runs: [runWire({ agentId: 'Bad Agent' })] }), 'an agent id outside the pattern');
		invalidReply(() => readCliRuns({ runs: [runWire({ endedAt: '2026-11-06T10:00:02.000Z' })] }), 'a running run with an end time');
		invalidReply(() => readCliRuns({ runs: [runWire({ state: 'FAILED', status: 'failed', endedAt: null })] }), 'a terminal run without an end time');
		invalidReply(() => readCliRuns({ runs: [runWire({ startedAt: null })] }), 'a running run that never started');
		invalidReply(() => readCliRuns({ runs: [runWire({ exitCode: 999 })] }), 'an exit code out of range');
		invalidReply(() => readCliRuns({ runs: [runWire(), runWire()] }), 'a duplicate run id');
		invalidReply(() => readCliRuns({ runs: Array.from({ length: MAX_CLI_RUNS + 1 }, (_, i) => runWire({ runId: `r${i}` })) }), 'too many runs');
		assert.strictEqual(readCliRuns({ runs: [runWire({ state: 'QUEUED', status: 'starting', startedAt: null, live: false })] })[0].state, 'QUEUED');
	});

	test('approvals: only the number of open challenges is read, and a bad list is refused', () => {
		assert.strictEqual(readPendingCount({ challenges: [{ challengeId: 'c1', targetSummary: 'secret text' }, { challengeId: 'c2' }] }), 2);
		assert.strictEqual(readPendingCount({ challenges: [] }), 0);
		invalidReply(() => readPendingCount({ challenges: [{ challengeId: 'c1' }, { challengeId: 'c1' }] }), 'a duplicate challenge');
		invalidReply(() => readPendingCount({ challenges: [{}] }), 'a challenge without an id');
		invalidReply(() => readPendingCount({ challenges: 3 }), 'not a list');
	});

	test('status and error codes are read from the closed sets only', () => {
		assert.deepStrictEqual(sanitizeStatus({ kind: 'failed', reason: 'crash_loop' }), { kind: 'failed', reason: 'crash_loop' });
		assert.deepStrictEqual(sanitizeStatus({ kind: 'failed', reason: '<img src=x>' }), { kind: 'down' });
		assert.deepStrictEqual(sanitizeStatus({ kind: 'failed' }), { kind: 'down' });
		assert.deepStrictEqual(sanitizeStatus({ kind: 'ready', reason: 'x', extra: 1 }), { kind: 'ready' }, 'extra fields are not carried');
		assert.deepStrictEqual(sanitizeStatus('ready'), { kind: 'down' });
		assert.deepStrictEqual(sanitizeStatus(undefined), { kind: 'down' });
		assert.ok(sameStatus({ kind: 'failed', reason: 'lock_held' }, { kind: 'failed', reason: 'lock_held' }));
		assert.ok(!sameStatus({ kind: 'failed', reason: 'lock_held' }, { kind: 'failed', reason: 'bad_config' }));
		assert.strictEqual(toCallErrorCode('E_TIMEOUT'), 'E_TIMEOUT');
		assert.strictEqual(toCallErrorCode('E_SECRET_LEAK /home/x'), 'E_INTERNAL');
		const error = new AxisDaemonCallError('/home/user/secret');
		assert.strictEqual(error.code, 'E_INTERNAL');
		assert.ok(!error.message.includes('/home'), 'an unknown code text never reaches the message');
	});
});

suite('Axis daemon api', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('requests carry fixed names and ids only, never a path', async () => {
		const client = new FakeDaemonClient();
		client.replies.set('axis.worktrees.list', { worktrees: [wire({ id: 'ws-a' })] });
		client.replies.set('axis.worktrees.status', { worktrees: [wire({ id: 'ws-a', dirty: { staged: 0, unstaged: 0, untracked: 0 } })] });
		client.replies.set('axis.cli-runs.list', { runs: [] });
		client.replies.set('axis.approvals.pending', { challenges: [] });
		client.replies.set('axis.projects.list', { projects: [] });
		const api = new AxisDaemonApi(client);
		await api.listProjects();
		await api.listWorktrees('proj-1');
		await api.statusOf(['ws-a']);
		await api.listCliRuns();
		await api.pendingApprovals();
		assert.deepStrictEqual(client.calls.map(c => `${c.contract}.${c.method}`), ['axis.projects.list', 'axis.worktrees.list', 'axis.worktrees.status', 'axis.cli-runs.list', 'axis.approvals.pending']);
		assert.deepStrictEqual(client.calls[1].params, { projectId: 'proj-1' });
		assert.deepStrictEqual(client.calls[2].params, { ids: ['ws-a'] });
		assert.ok(!JSON.stringify(client.calls).includes('/work'), 'no path is sent');
		client.dispose();
	});

	test('an id outside the journal pattern is refused before any request', async () => {
		const client = new FakeDaemonClient();
		const api = new AxisDaemonApi(client);
		await assert.rejects(api.listWorktrees('--upload-pack=x'), (e: AxisDaemonCallError) => e.code === 'E_INVALID_ARGUMENT');
		await assert.rejects(api.statusOf(['ok-1', '../x']), (e: AxisDaemonCallError) => e.code === 'E_INVALID_ARGUMENT');
		assert.strictEqual(client.calls.length, 0);
		client.dispose();
	});

	test('status is asked 100 ids at a time and a reply about an id nobody asked for is dropped', async () => {
		const client = new FakeDaemonClient();
		const ids = Array.from({ length: 250 }, (_, i) => `ws-${i}`);
		client.replies.set('axis.worktrees.status', (params: unknown) => ({ worktrees: (params as { ids: string[] }).ids.slice(0, 1).map(id => wire({ id })).concat([wire({ id: 'intruder' })]) }));
		const got = await new AxisDaemonApi(client).statusOf(ids);
		assert.deepStrictEqual(client.calls.map(c => (c.params as { ids: string[] }).ids.length), [100, 100, 50]);
		assert.deepStrictEqual(got.map(w => w.id), ['ws-0', 'ws-100', 'ws-200']);
		client.dispose();
	});

	test('a worktree of another project in a list reply is not a row of this project', async () => {
		const client = new FakeDaemonClient();
		client.replies.set('axis.worktrees.list', { worktrees: [wire({ id: 'a' }), wire({ id: 'b', projectId: 'proj-2' })] });
		assert.deepStrictEqual((await new AxisDaemonApi(client).listWorktrees('proj-1')).map(w => w.id), ['a']);
		client.dispose();
	});
});
