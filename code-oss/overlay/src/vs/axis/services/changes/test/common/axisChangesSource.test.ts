/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { flatRows } from '../../common/axisChanges.js';
import { AxisChangesSource, AxisChangesStatus } from '../../common/axisChangesSource.js';
import { change, FakeGitService, FakeRepository, file, flush, ROOT, state } from './axisChangesFixtures.js';

const OTHER = URI.file('/w/ws-b');

suite('Axis Changes source (fake IGitService)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let git: FakeGitService;
	let mounted: (root: URI) => boolean;
	let source: AxisChangesSource;
	let seen: AxisChangesStatus[];

	setup(() => {
		git = new FakeGitService();
		mounted = () => true;
		source = store.add(new AxisChangesSource(git, root => mounted(root)));
		seen = [];
		store.add(source.onDidChange(() => seen.push(source.status)));
	});

	const names = () => flatRows(source.changes).map(r => `${r.group}:${r.name}`);

	test('opens the worktree, lists its state and follows every state change', async () => {
		const repo = new FakeRepository(ROOT, state({ workingTreeChanges: [change.modified('a.ts')] }));
		const opening = source.setRoot(ROOT);
		assert.strictEqual(source.status, 'loading');
		await git.answer(repo);
		await opening;
		assert.deepStrictEqual(git.opened, [ROOT.path]);
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual(names(), ['unstaged:a.ts']);

		repo.set(state({ indexChanges: [change.modified('a.ts')], untrackedChanges: [change.added('b.txt')] }));
		assert.deepStrictEqual(names(), ['staged:a.ts', 'untracked:b.txt']);
		repo.set(state());
		assert.deepStrictEqual(names(), []);
		assert.deepStrictEqual(seen, ['loading', 'ready', 'ready', 'ready']);
		assert.deepStrictEqual(repo.writes, [], 'the source only reads `state`');
	});

	test('the same root again does not reopen; refresh does', async () => {
		source.setRoot(ROOT);
		await git.answer(new FakeRepository(ROOT));
		source.setRoot(URI.file('/w/ws-a/'));
		source.setRoot(ROOT);
		assert.deepStrictEqual(git.opened, [ROOT.path]);
		source.refresh();
		assert.deepStrictEqual(git.opened, [ROOT.path, ROOT.path]);
		await git.answer(undefined);
	});

	test('a late answer for the previous worktree is dropped (no changes shown under another name)', async () => {
		const a = new FakeRepository(ROOT, state({ untrackedChanges: [change.added('from-a.txt')] }));
		const b = new FakeRepository(OTHER, state({ untrackedChanges: [change.added('from-b.txt', OTHER)] }));
		source.setRoot(ROOT);
		source.setRoot(OTHER);
		await git.answer(a);
		assert.strictEqual(source.status, 'loading', 'the answer for ws-a does not settle ws-b');
		assert.deepStrictEqual(names(), []);
		a.set(state({ untrackedChanges: [change.added('later.txt')] }));
		assert.deepStrictEqual(names(), [], 'and ws-a is not listened to');
		await git.answer(b);
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual(names(), ['untracked:from-b.txt']);
	});

	test('a late answer for the previous worktree does not replace the current one', async () => {
		const a = new FakeRepository(ROOT);
		const b = new FakeRepository(OTHER);
		source.setRoot(ROOT);
		source.setRoot(OTHER);
		await git.answer(b, true);
		await git.answer(a);
		b.set(state({ untrackedChanges: [change.added('still-b.txt', OTHER)] }));
		assert.deepStrictEqual(names(), ['untracked:still-b.txt'], 'ws-b is still followed');
		a.set(state({ untrackedChanges: [change.added('from-a.txt')] }));
		assert.deepStrictEqual(names(), ['untracked:still-b.txt']);
	});

	test('switching worktrees stops listening to the old repository', async () => {
		const a = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await git.answer(a);
		source.setRoot(OTHER);
		a.set(state({ untrackedChanges: [change.added('while-loading.txt')] }));
		assert.strictEqual(source.status, 'loading', 'ws-a stops being followed as soon as ws-b is asked for');
		assert.deepStrictEqual(names(), []);
		await git.answer(new FakeRepository(OTHER));
		const before = seen.length;
		a.set(state({ untrackedChanges: [change.added('x.txt')] }));
		assert.strictEqual(seen.length, before);
		assert.deepStrictEqual(names(), []);
		source.setRoot(undefined);
		assert.strictEqual(source.status, 'idle');
		assert.strictEqual(source.root, undefined);
	});

	test('no repository, a repository rooted elsewhere, or a failed open is unavailable', async () => {
		source.setRoot(ROOT);
		await git.answer(undefined);
		assert.strictEqual(source.status, 'unavailable');

		source.refresh();
		await git.answer(new FakeRepository(URI.file('/w'), state({ untrackedChanges: [change.added('ws-a/x.txt', URI.file('/w'))] })));
		assert.strictEqual(source.status, 'unavailable', 'a parent repository is not this worktree');
		assert.deepStrictEqual(names(), []);

		source.refresh();
		await git.answer(new Error('delegate failed'));
		assert.strictEqual(source.status, 'unavailable');

		source.setRoot(ROOT);
		assert.strictEqual(source.status, 'loading', 'after unavailable, the same root is tried again');
		await git.answer(new FakeRepository(ROOT));
		assert.strictEqual(source.status, 'ready');
	});

	test('a worktree outside the window\'s folders is never opened', async () => {
		mounted = root => root.path === ROOT.path;
		await source.setRoot(OTHER);
		assert.strictEqual(source.status, 'notMounted');
		assert.deepStrictEqual(git.opened, [], 'no openRepository call, so the git extension never prompts');
		mounted = () => true;
		source.refresh();
		assert.deepStrictEqual(git.opened, [OTHER.path]);
		await git.answer(undefined);
	});

	test('nothing is shown or listened to after dispose', async () => {
		const own = new AxisChangesSource(git, () => true);
		const repo = new FakeRepository(ROOT);
		own.setRoot(ROOT);
		own.dispose();
		await git.answer(repo);
		assert.strictEqual(own.status, 'loading');
		repo.set(state({ untrackedChanges: [change.added('x')] }));
		assert.deepStrictEqual(flatRows(own.changes), []);
		await flush();
	});

	test('rows carry the real file for the editor', async () => {
		source.setRoot(ROOT);
		await git.answer(new FakeRepository(ROOT, state({ workingTreeChanges: [change.modified('src/x.ts')] })));
		assert.strictEqual(flatRows(source.changes)[0].resource.toString(), file('src/x.ts').toString());
	});
});
