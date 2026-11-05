/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { sampleCliRuns } from '../../common/axisSampleRuns.js';
import { AXIS_ID_PATTERN, IAxisWorktreeInfo } from '../../common/axisWorkspaceData.js';
import { attentionOf, branchLabel, cycleIndex, IAxisWorkspaceEntry, MAX_BRANCH_LABEL_LENGTH, opensTerminalOnFocus, orderEntries, rowStateOf } from '../../common/axisWorkspaceModel.js';
import { branchOf, clampText, displayName, isSafeRefName, linksBack, MAX_BRANCH_LENGTH, parseCoreWorktree, parseGitFile, parseHead, parseLooseRef, parsePackedRefs, resolveMetadataPath, stableId, worktreeDirFromGitdir } from '../../common/worktreeDiscovery.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function worktree(path: string, present = true): IAxisWorktreeInfo {
	return { origin: 'external', projectId: 'p-1', branch: 'main', head: SHA, path, locked: false, present };
}

function entry(key: string, label: string, options: Partial<IAxisWorkspaceEntry> = {}): IAxisWorkspaceEntry {
	const wt = options.worktree ?? worktree(`/w/${label}`);
	const runs = options.runs ?? [];
	return { key, label, project: { id: 'p-1', name: 'repo', trusted: true }, worktree: wt, isLocalCheckout: false, runs, attention: attentionOf(wt, runs), ...options };
}

suite('Axis worktree discovery parsers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('git files, HEAD and refs', () => {
		assert.strictEqual(parseGitFile('gitdir: /r/.git/worktrees/a\n'), '/r/.git/worktrees/a');
		assert.strictEqual(parseGitFile('gitdir: ../.git/worktrees/a\r\n'), '../.git/worktrees/a');
		assert.strictEqual(parseGitFile('nonsense'), undefined);
		assert.deepStrictEqual(parseHead('ref: refs/heads/main\n'), { kind: 'ref', ref: 'refs/heads/main' });
		assert.deepStrictEqual(parseHead(`${SHA}\n`), { kind: 'detached', sha: SHA });
		assert.strictEqual(parseHead('ref: HEAD'), undefined);
		assert.strictEqual(parseHead(''), undefined);
		assert.strictEqual(parseLooseRef(`${SHA}\n`), SHA);
		assert.strictEqual(parseLooseRef('xyz'), undefined);
		assert.deepStrictEqual([...parsePackedRefs(`# header\n${SHA} refs/heads/a\n^${SHA}\nbad line\n${SHA} HEAD\n`)], [['refs/heads/a', SHA]]);
		assert.strictEqual(branchOf({ kind: 'ref', ref: 'refs/heads/feat/x' }), 'feat/x');
		assert.strictEqual(branchOf({ kind: 'ref', ref: 'refs/remotes/o/x' }), null);
		assert.strictEqual(branchOf({ kind: 'detached', sha: SHA }), null);
	});

	test('branch names from HEAD are cleaned and bounded', () => {
		const ref = (name: string) => ({ kind: 'ref' as const, ref: `refs/heads/${name}` });
		assert.strictEqual(branchOf(ref('main\u202Eniam')), 'main\uFFFDniam', 'a bidi override is replaced, visibly');
		assert.strictEqual(branchOf(ref('a\u200Bb\u0007c\u2028d')), 'a\uFFFDb\uFFFDc\uFFFDd');
		assert.strictEqual(parseHead(`ref: refs/heads/x\u202Ey`)?.kind, 'ref', 'parsing keeps the ref; cleaning is for display');
		const huge = branchOf(ref('b'.repeat(64 * 1024)))!;
		assert.strictEqual([...huge].length, MAX_BRANCH_LENGTH);
		assert.ok(huge.endsWith('\u2026'));
		assert.strictEqual([...branchLabel(entry('k', 'x', { worktree: { ...worktree('/w/x'), branch: huge } }))].length, MAX_BRANCH_LABEL_LENGTH);
		assert.strictEqual(branchOf(ref('a\u0301\u0302\u0303\u0304b')), 'a\u0301\u0302b', 'at most two combining marks in a row');
		assert.strictEqual(branchOf(ref('x\uE000y\u{10FFFF}')), 'x\uFFFDy\uFFFD', 'private-use and unassigned code points');
		assert.strictEqual(displayName('n\u0300\u0300\u0300\u0300'), 'n\u0300\u0300');
		assert.strictEqual(clampText('\u{1F600}'.repeat(5), 3), '\u{1F600}\u{1F600}\u2026', 'cut on code points, never inside a pair');
	});

	test('a worktree is accepted only when its .git file points back to the entry', () => {
		assert.ok(linksBack('gitdir: /r/.git/worktrees/a\n', '/wt/a', '/r/.git/worktrees/a', false));
		assert.ok(linksBack('gitdir: ../../r/.git/worktrees/a\n', '/wt/a', '/r/.git/worktrees/a', false), 'relative links (worktree.useRelativePaths)');
		assert.ok(!linksBack('gitdir: /r/.git/worktrees/b\n', '/wt/a', '/r/.git/worktrees/a', false));
		assert.ok(!linksBack('', '/home/user', '/r/.git/worktrees/a', false));
		assert.ok(linksBack('gitdir: C:\\R\\.git\\worktrees\\a', 'D:\\wt\\a', 'c:\\r\\.git\\worktrees\\a', true));
	});

	test('metadata paths: leading .. only; a . or .. after a name, or in an absolute path, is refused', () => {
		assert.strictEqual(resolveMetadataPath('../../../wt/a/.git', '/r/.git/worktrees/a', false), '/r/wt/a/.git');
		assert.strictEqual(resolveMetadataPath('/wt/a/.git', '/r', false), '/wt/a/.git');
		for (const bad of ['x/../../wt/.git', '../s/../wt/.git', 'a/./b', '/wt/../a/.git', '/wt/./a', '/../wt/a', '/./wt/a']) {
			assert.strictEqual(resolveMetadataPath(bad, '/r/.git/worktrees/a', false), undefined, bad);
		}
		assert.strictEqual(resolveMetadataPath('C:\\wt\\..\\a', 'C:\\r', true), undefined);
		assert.strictEqual(worktreeDirFromGitdir('/wt/x/../a/.git\n', '/r/.git/worktrees/a', false), undefined);
		assert.ok(!linksBack('gitdir: ../x/../r/.git/worktrees/a', '/wt/a', '/r/.git/worktrees/a', false));
	});

	test('core.worktree of a git config', () => {
		assert.strictEqual(parseCoreWorktree('[core]\n\trepositoryformatversion = 0\n\tworktree = ../../../sub\n'), '../../../sub');
		assert.strictEqual(parseCoreWorktree('[core]\n\tworktree = "/a b/c"\n'), '/a b/c');
		assert.strictEqual(parseCoreWorktree('[core]\n\tWorkTree = /x ; comment\n'), '/x');
		assert.strictEqual(parseCoreWorktree('[remote "origin"]\n\tworktree = /x\n'), undefined, 'another section');
		assert.strictEqual(parseCoreWorktree('[core "x"]\n\tworktree = /x\n'), undefined, 'a core subsection is not core');
		assert.strictEqual(parseCoreWorktree('[core]\n\tbare = false\n'), undefined);
		assert.strictEqual(parseCoreWorktree(''), undefined);
	});

	test('ref names that would escape the git directory are refused', () => {
		assert.ok(isSafeRefName('refs/heads/feat/x-1'));
		for (const bad of ['refs/heads/../../x', 'refs/heads//x', 'refs/heads/x.lock', 'HEAD', 'refs/heads/a b', 'refs/./x']) {
			assert.ok(!isSafeRefName(bad), bad);
		}
	});

	test('metadata paths resolve absolute and relative entries', () => {
		assert.strictEqual(resolveMetadataPath('/a//c', '/x', false), '/a/c');
		assert.strictEqual(resolveMetadataPath('../../../wt/.git', '/r/.git/worktrees/a', false), '/r/wt/.git');
		assert.strictEqual(resolveMetadataPath('C:\\r\\wt\\.git', 'C:\\x', true), 'C:\\r\\wt\\.git');
		assert.strictEqual(worktreeDirFromGitdir('/wt/a/.git\n', '/r/.git/worktrees/a', false), '/wt/a');
		assert.strictEqual(worktreeDirFromGitdir('/wt/a/not-git\n', '/r', false), undefined);
		assert.strictEqual(worktreeDirFromGitdir('', '/r', false), undefined);
	});

	test('names and ids fit the contract rules', () => {
		assert.strictEqual(displayName('  fix\u200b-login\u0007 '), 'fix-login');
		assert.strictEqual(displayName(''), 'unnamed');
		assert.strictEqual(displayName('x'.repeat(200)).length, 80);
		for (const value of ['', '/w/a', 'x'.repeat(5000), '\u202E']) {
			assert.match(stableId('w', value), AXIS_ID_PATTERN);
		}
		assert.notStrictEqual(stableId('w', '/w/a'), stableId('w', '/w/b'));
		assert.strictEqual(stableId('w', '/w/a').length, 2 + 32, '128 bits of digest');
	});
});

suite('Axis dashboard model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

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
