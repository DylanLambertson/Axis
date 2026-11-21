/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { flatRows } from '../../common/axisChanges.js';
import { AxisChangesSource, AxisChangesStatus, AxisGitEntry, CLOSED_REPOSITORIES_KEY, gitEntryOf, hasClosedRepositories, isRepositoryRoot } from '../../common/axisChangesSource.js';
import { change, FakeGitService, FakeRepository, file, flush, ROOT, state } from './axisChangesFixtures.js';

const OTHER = URI.file('/w/ws-b');

suite('Axis Changes source (fake IGitService)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let git: FakeGitService;
	let mounted: (root: URI) => boolean;
	/** Folders that hold `.git`. */
	let roots: Set<string>;
	let rootChecks: string[];
	let closed: boolean | undefined;
	let source: AxisChangesSource;
	let seen: AxisChangesStatus[];

	setup(() => {
		git = new FakeGitService();
		mounted = () => true;
		roots = new Set([ROOT.path, OTHER.path]);
		rootChecks = [];
		closed = false;
		source = store.add(new AxisChangesSource(git, root => mounted(root), async root => {
			rootChecks.push(root.path);
			return roots.has(root.path);
		}, () => closed));
		seen = [];
		store.add(source.onDidChange(() => seen.push(source.status)));
	});

	const names = () => flatRows(source.changes).map(r => `${r.group}:${r.name}`);

	test('opens a repository root, lists its state and follows every state change', async () => {
		const repo = new FakeRepository(ROOT, state({ workingTreeChanges: [change.modified('a.ts')] }));
		const opening = source.setRoot(ROOT);
		assert.strictEqual(source.status, 'loading');
		await flush();
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

	test('a repository the service already has is followed, never reopened (so no other reader loses it)', async () => {
		const known = new FakeRepository(URI.file('/w/ws-a/'), state({ untrackedChanges: [change.added('k.txt')] }));
		git.repositories.push(new FakeRepository(URI.file('/w/elsewhere')), known);
		await source.setRoot(ROOT);
		assert.deepStrictEqual(git.opened, []);
		assert.deepStrictEqual(rootChecks, []);
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual(names(), ['untracked:k.txt']);
		known.set(state());
		assert.deepStrictEqual(names(), []);
	});

	test('a folder that is not a repository root is never opened (the git extension would open a parent)', async () => {
		roots.delete(ROOT.path);
		await source.setRoot(ROOT);
		await flush();
		assert.deepStrictEqual(rootChecks, [ROOT.path]);
		assert.deepStrictEqual(git.opened, [], 'no openRepository call');
		assert.strictEqual(source.status, 'unavailable');
	});

	test('a root found unavailable is not tried again on a list update or a revisit, only on refresh', async () => {
		source.setRoot(ROOT);
		await flush();
		await git.answer(undefined);
		assert.strictEqual(source.status, 'unavailable');
		source.setRoot(ROOT);
		source.setRoot(URI.file('/w/ws-a/'));
		source.setRoot(OTHER);
		await flush();
		await git.answer(new FakeRepository(OTHER));
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'unavailable', 'a revisit does not reopen');
		assert.deepStrictEqual(git.opened, [ROOT.path, OTHER.path]);
		assert.deepStrictEqual(seen.filter(s => s === 'loading').length, 2, 'no "Reading…" flash on revisits');

		source.refresh();
		await flush();
		assert.deepStrictEqual(git.opened, [ROOT.path, OTHER.path, ROOT.path]);
		await git.answer(new FakeRepository(ROOT));
		assert.strictEqual(source.status, 'ready');
	});

	test('the same root again does not reopen', async () => {
		source.setRoot(ROOT);
		await flush();
		await git.answer(new FakeRepository(ROOT));
		source.setRoot(URI.file('/w/ws-a/'));
		source.setRoot(ROOT);
		await flush();
		assert.deepStrictEqual(git.opened, [ROOT.path]);
	});

	test('a late answer for the previous worktree is dropped (no changes shown under another name)', async () => {
		const a = new FakeRepository(ROOT, state({ untrackedChanges: [change.added('from-a.txt')] }));
		const b = new FakeRepository(OTHER, state({ untrackedChanges: [change.added('from-b.txt', OTHER)] }));
		source.setRoot(ROOT);
		await flush();
		source.setRoot(OTHER);
		await flush();
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
		await flush();
		source.setRoot(OTHER);
		await flush();
		await git.answer(b, true);
		await git.answer(a);
		b.set(state({ untrackedChanges: [change.added('still-b.txt', OTHER)] }));
		assert.deepStrictEqual(names(), ['untracked:still-b.txt'], 'ws-b is still followed');
		a.set(state({ untrackedChanges: [change.added('from-a.txt')] }));
		assert.deepStrictEqual(names(), ['untracked:still-b.txt']);
	});

	test('switching worktrees stops listening to the old repository at once', async () => {
		const a = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await flush();
		await git.answer(a);
		source.setRoot(OTHER);
		a.set(state({ untrackedChanges: [change.added('while-loading.txt')] }));
		assert.strictEqual(source.status, 'loading', 'ws-a stops being followed as soon as ws-b is asked for');
		assert.deepStrictEqual(names(), []);
		await flush();
		await git.answer(new FakeRepository(OTHER));
		const before = seen.length;
		a.set(state({ untrackedChanges: [change.added('x.txt')] }));
		assert.strictEqual(seen.length, before);
		source.setRoot(undefined);
		assert.strictEqual(source.status, 'idle');
		assert.strictEqual(source.root, undefined);
	});

	test('no repository, one rooted elsewhere, or a failed open is unavailable', async () => {
		source.setRoot(ROOT);
		await flush();
		await git.answer(new FakeRepository(URI.file('/w'), state({ untrackedChanges: [change.added('ws-a/x.txt', URI.file('/w'))] })));
		assert.strictEqual(source.status, 'unavailable', 'a parent repository is not this worktree');
		assert.deepStrictEqual(names(), []);

		source.refresh();
		await flush();
		await git.answer(new Error('delegate failed'));
		assert.strictEqual(source.status, 'unavailable');
	});

	test('a worktree outside the window\'s folders is never looked at', async () => {
		mounted = root => root.path === ROOT.path;
		await source.setRoot(OTHER);
		assert.strictEqual(source.status, 'notMounted');
		assert.deepStrictEqual([git.opened, rootChecks], [[], []]);
		mounted = () => true;
		source.refresh();
		await flush();
		assert.deepStrictEqual(git.opened, [OTHER.path]);
		await git.answer(undefined);
	});

	test('nothing is shown or listened to after dispose', async () => {
		const own = new AxisChangesSource(git, () => true, async () => true, () => false);
		const repo = new FakeRepository(ROOT);
		own.setRoot(ROOT);
		await flush();
		own.dispose();
		await git.answer(repo);
		assert.strictEqual(own.status, 'loading');
		repo.set(state({ untrackedChanges: [change.added('x')] }));
		assert.deepStrictEqual(flatRows(own.changes), []);
	});

	test('rows carry the real file for the editor', async () => {
		source.setRoot(ROOT);
		await flush();
		await git.answer(new FakeRepository(ROOT, state({ workingTreeChanges: [change.modified('src/x.ts')] })));
		assert.strictEqual(flatRows(source.changes)[0].resource.toString(), file('src/x.ts').toString());
	});

	test('with repositories closed in Git, a root it does not have is opened only when the user asks', async () => {
		closed = true;
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'askFirst');
		assert.deepStrictEqual([git.opened, rootChecks], [[], []], 'no open: it would forget the user closed it');
		await source.setRoot(OTHER);
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'askFirst', 'a revisit still asks');
		source.refresh();
		await flush();
		assert.deepStrictEqual(git.opened, [ROOT.path], 'Show changes opens it');
		await git.answer(new FakeRepository(ROOT));
		assert.strictEqual(source.status, 'ready');
	});

	test('while Git has not said whether any repository is closed, a root waits; it opens once the count is 0', async () => {
		closed = undefined;
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'askFirst', 'unknown is treated as closed: never opened at startup');
		assert.deepStrictEqual(git.opened, []);
		closed = true;
		await source.reconsider();
		assert.strictEqual(source.status, 'askFirst');
		assert.deepStrictEqual(git.opened, []);
		closed = false;
		source.reconsider();
		await flush();
		assert.deepStrictEqual(git.opened, [ROOT.path], 'the key now says none is closed');
		await git.answer(new FakeRepository(ROOT));
		assert.strictEqual(source.status, 'ready');
		await source.reconsider();
		assert.deepStrictEqual(git.opened, [ROOT.path], 'reconsider does nothing outside askFirst');
		assert.strictEqual(source.status, 'ready', 'and keeps the followed repository');
	});

	test('with repositories closed in Git, a repository the service already has is still followed', async () => {
		closed = true;
		git.repositories.push(new FakeRepository(ROOT));
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual(git.opened, []);
	});

	test('a followed repository the service replaced is looked up again on the next setRoot', async () => {
		const first = new FakeRepository(ROOT, state({ untrackedChanges: [change.added('old.txt')] }));
		git.repositories.push(first);
		await source.setRoot(ROOT);
		assert.deepStrictEqual(names(), ['untracked:old.txt']);
		const second = new FakeRepository(ROOT, state({ untrackedChanges: [change.added('new.txt')] }));
		git.repositories.splice(0, 1, second);
		await source.setRoot(ROOT);
		assert.deepStrictEqual(names(), ['untracked:new.txt'], 'follows the new object');
		first.set(state());
		assert.deepStrictEqual(names(), ['untracked:new.txt'], 'and no longer the old one');
		assert.deepStrictEqual(git.opened, []);
	});
});

suite('Axis Changes repository root check', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	async function check(entries: Record<string, AxisGitEntry>): Promise<[boolean, string[]]> {
		const asked: string[] = [];
		const result = await isRepositoryRoot(ROOT, async uri => {
			asked.push(uri.path.slice(ROOT.path.length));
			return entries[uri.path.slice(ROOT.path.length)] ?? 'none';
		});
		return [result, asked];
	}

	const GITDIR: Record<string, AxisGitEntry> = { '/.git': 'directory', '/.git/HEAD': 'file', '/.git/objects': 'directory', '/.git/refs': 'directory' };

	test('a .git file (linked worktree) or a .git directory with HEAD, objects and refs is a root', async () => {
		assert.deepStrictEqual(await check({ '/.git': 'file' }), [true, ['/.git']]);
		assert.deepStrictEqual((await check(GITDIR))[0], true);
	});

	test('no .git, an empty or half-deleted .git directory is not a root (git would walk up to a parent)', async () => {
		assert.strictEqual((await check({}))[0], false);
		assert.strictEqual((await check({ '/.git': 'directory' }))[0], false);
		assert.strictEqual((await check({ '/.git': 'directory', '/.git/HEAD': 'file' }))[0], false, 'HEAD alone: git walks up');
		for (const [part, wrong] of [['/.git/HEAD', 'directory'], ['/.git/HEAD', 'none'], ['/.git/objects', 'none'], ['/.git/objects', 'file'], ['/.git/refs', 'none'], ['/.git/refs', 'file']] as const) {
			assert.strictEqual((await check({ ...GITDIR, [part]: wrong }))[0], false, `${part} ${wrong}`);
		}
	});

	test('a stat result maps to an entry; a missing path is none', () => {
		assert.strictEqual(gitEntryOf({ isFile: true, isDirectory: false }), 'file');
		assert.strictEqual(gitEntryOf({ isFile: false, isDirectory: true }), 'directory');
		assert.strictEqual(gitEntryOf({ isFile: false, isDirectory: false }), 'none');
		assert.strictEqual(gitEntryOf(undefined), 'none');
	});

	test('the closed-repository count: the git extension\'s key, unknown until it is a number', () => {
		assert.strictEqual(CLOSED_REPOSITORIES_KEY, 'git.closedRepositoryCount');
		assert.deepStrictEqual([0, 1, 3, undefined, null, '1', true].map(hasClosedRepositories), [false, true, true, undefined, undefined, undefined, undefined]);
	});
});
