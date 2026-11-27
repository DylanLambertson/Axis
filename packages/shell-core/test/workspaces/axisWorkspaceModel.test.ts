// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/workspaces/test/common/axisWorkspaceModel.test.ts) by OS-5.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { sampleCliRuns } from '../../src/workspaces/axisSampleRuns.js';
import { AXIS_ID_PATTERN, type IAxisWorktreeInfo } from '../../src/workspaces/axisWorkspaceData.js';
import { attentionOf, branchLabel, cycleIndex, type IAxisWorkspaceEntry, MAX_BRANCH_LABEL_LENGTH, opensTerminalOnFocus, orderEntries, rowStateOf } from '../../src/workspaces/axisWorkspaceModel.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function worktree(path: string, present = true): IAxisWorktreeInfo {
	return { origin: 'external', projectId: 'p-1', branch: 'main', head: SHA, path, locked: false, present };
}

function entry(key: string, label: string, options: Partial<IAxisWorkspaceEntry> = {}): IAxisWorkspaceEntry {
	const wt = options.worktree ?? worktree(`/w/${label}`);
	const runs = options.runs ?? [];
	return { key, label, project: { id: 'p-1', name: 'repo', trusted: true }, worktree: wt, isLocalCheckout: false, runs, attention: attentionOf(wt, runs), ...options };
}

suite('Axis dashboard model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a long branch label is cut to its maximum, on code points', () => {
		const huge = 'b'.repeat(64 * 1024);
		const label = branchLabel(entry('k', 'x', { worktree: { ...worktree('/w/x'), branch: huge } }));
		assert.strictEqual([...label].length, MAX_BRANCH_LABEL_LENGTH);
		assert.ok(label.endsWith('\u2026'));
		assert.strictEqual(branchLabel(entry('k', 'x', { worktree: { ...worktree('/w/x'), branch: 'main' } })), 'main');
	});

	test('a terminal opens by itself only in a trusted window, once, for a present worktree', () => {
		const trusted = entry('k', 'x');
		const untrustedProject = entry('k', 'x', { project: { id: 'p-1', name: 'repo', trusted: false } });
		const missing = entry('k', 'x', { worktree: worktree('/w/x', false) });
		assert.ok(opensTerminalOnFocus(trusted, true, false));
		assert.ok(!opensTerminalOnFocus(trusted, false, false), 'Restricted Mode');
		assert.ok(!opensTerminalOnFocus(untrustedProject, true, false), 'discovered while untrusted');
		assert.ok(!opensTerminalOnFocus(trusted, true, true), 'already opened once');
		assert.ok(!opensTerminalOnFocus(missing, true, false));
	});

	test('rows that need the user sort first, then the local checkout, then by name', () => {
		const runs = sampleCliRuns(['k-fail'], 0).map(r => ({ ...r, status: 'failed' as const, state: 'FAILED' as const }));
		const ordered = orderEntries([
			entry('k-b', 'b'),
			entry('k-local', 'repo', { isLocalCheckout: true }),
			entry('k-fail', 'z', { runs }),
			entry('k-a', 'a'),
			entry('k-gone', 'y', { worktree: worktree('/w/y', false) }),
		], ['p-1']);
		assert.deepStrictEqual(ordered.map(e => e.key), ['k-gone', 'k-fail', 'k-local', 'k-a', 'k-b']);
	});

	test('row states are text the user can read, from state Axis owns', () => {
		const [running, quiet, failed, finished] = sampleCliRuns(['a', 'b', 'c', 'd'], 1_000_000);
		assert.strictEqual(rowStateOf(entry('a', 'a', { runs: [running] })), 'running');
		assert.strictEqual(rowStateOf(entry('b', 'b', { runs: [quiet] })), 'quiet');
		assert.strictEqual(rowStateOf(entry('c', 'c', { runs: [failed] })), 'failed');
		assert.strictEqual(rowStateOf(entry('d', 'd', { runs: [finished] })), 'done');
		assert.strictEqual(rowStateOf(entry('e', 'e')), 'external');
		assert.strictEqual(rowStateOf(entry('f', 'f', { isLocalCheckout: true })), 'idle');
		assert.strictEqual(rowStateOf(entry('g', 'g', { worktree: worktree('/g', false) })), 'missing');
		assert.strictEqual(attentionOf(worktree('/q'), [quiet]), 'runQuiet');
	});

	test('sample runs are valid contract records, one per workspace, at most four', () => {
		const runs = sampleCliRuns(['a', 'b', 'c', 'd', 'e'], Date.UTC(2026, 10, 4));
		assert.strictEqual(runs.length, 4);
		for (const run of runs) {
			assert.match(run.runId, AXIS_ID_PATTERN);
			const terminal = run.state === 'COMPLETED' || run.state === 'FAILED' || run.state === 'CANCELLED';
			assert.strictEqual(run.endedAt !== null, terminal, `${run.runId}: endedAt is set exactly when terminal`);
			assert.strictEqual(run.live, !terminal);
		}
	});

	test('workspace cycling wraps in both directions', () => {
		assert.strictEqual(cycleIndex(undefined, 1, 3), 0);
		assert.strictEqual(cycleIndex(undefined, -1, 3), 2);
		assert.strictEqual(cycleIndex(2, 1, 3), 0);
		assert.strictEqual(cycleIndex(0, -1, 3), 2);
		assert.strictEqual(cycleIndex(0, 1, 0), undefined);
	});
});
