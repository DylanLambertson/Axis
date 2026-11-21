/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { flatRows } from '../../common/axisChanges.js';
import { AxisChangesSource, AxisChangesStatus, AxisGitEntry, CLOSED_REPOSITORIES_KEY, GIT_REFRESH_COMMAND, STATUS_TIMEOUT_MS, gitEntryOf, hasClosedRepositories, isRepositoryRoot } from '../../common/axisChangesSource.js';
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
	/** Pending timeouts, fired by the test (no wall clock). */
	let timers: { run: () => void; ms: number; disposed: boolean }[];
	const timer = (run: () => void, ms: number) => {
		const t = { run, ms, disposed: false };
		timers.push(t);
		return { dispose: () => { t.disposed = true; } };
	};
	const fireTimers = () => timers.filter(t => !t.disposed).forEach(t => { t.disposed = true; t.run(); });
	/** Pending status confirmations (the git extension's Refresh), answered by the test. */
	let confirms: { root: string; answer: (ran: boolean | Error) => void }[];
	const confirmStatus = (root: URI) => new Promise<boolean>((resolve, reject) => confirms.push({ root: root.path, answer: ran => ran instanceof Error ? reject(ran) : resolve(ran) }));
	const confirmAll = async (ran: boolean | Error) => { confirms.splice(0).forEach(c => c.answer(ran)); await flush(); };
	let source: AxisChangesSource;
	let seen: AxisChangesStatus[];

	setup(() => {
		git = new FakeGitService();
		mounted = () => true;
		roots = new Set([ROOT.path, OTHER.path]);
		rootChecks = [];
		closed = false;
		timers = [];
		confirms = [];
		source = store.add(new AxisChangesSource(git, root => mounted(root), async root => {
			rootChecks.push(root.path);
			return roots.has(root.path);
		}, () => closed, timer, confirmStatus));
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
		await git.answer(new FakeRepository(OTHER, state({ untrackedChanges: [change.added('b.txt', OTHER)] })));
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'unavailable', 'a revisit does not reopen');
		assert.deepStrictEqual(git.opened, [ROOT.path, OTHER.path]);
		assert.deepStrictEqual(seen.filter(s => s === 'loading').length, 2, 'no "Reading…" flash on revisits');

		source.refresh();
		await flush();
		assert.deepStrictEqual(git.opened, [ROOT.path, OTHER.path, ROOT.path]);
		await git.answer(new FakeRepository(ROOT));
		await confirmAll(true); // an empty first state waits until Git has run a status
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
		const own = new AxisChangesSource(git, () => true, async () => true, () => false, timer, confirmStatus);
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
		await confirmAll(true); // an empty first state waits until Git has run a status
		assert.strictEqual(source.status, 'ready');
	});

	test('while Git has not said whether any repository is closed, a root waits; it opens once the count is 0', async () => {
		closed = undefined;
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'askFirst', 'unknown is treated as closed: never opened at startup');
		assert.strictEqual(source.waitingForGit, true, 'and the list says it waits for Git, not that repositories were closed');
		assert.deepStrictEqual(git.opened, []);
		closed = true;
		await source.reconsider();
		assert.strictEqual(source.status, 'askFirst');
		assert.strictEqual(source.waitingForGit, false, 'now known: repositories are closed');
		assert.deepStrictEqual(git.opened, []);
		closed = false;
		source.reconsider();
		await flush();
		assert.deepStrictEqual(git.opened, [ROOT.path], 'the key now says none is closed');
		await git.answer(new FakeRepository(ROOT));
		await confirmAll(true); // an empty first state waits until Git has run a status
		assert.strictEqual(source.status, 'ready');
		await source.reconsider();
		assert.deepStrictEqual(git.opened, [ROOT.path], 'reconsider does nothing outside askFirst');
		await confirmAll(true); // an empty first state waits until Git has run a status
		assert.strictEqual(source.status, 'ready', 'and keeps the followed repository');
	});

	test('with repositories closed in Git, a repository the service already has is still followed', async () => {
		closed = true;
		git.repositories.push(new FakeRepository(ROOT));
		await source.setRoot(ROOT);
		await confirmAll(true); // an empty first state waits until Git has run a status
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


	test('an empty first state is never "No changes" until Git has run a status for that root', async () => {
		const repo = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await flush();
		await git.answer(repo);
		assert.strictEqual(source.status, 'loading', 'maybe not scanned yet');
		assert.deepStrictEqual(confirms.map(c => c.root), [ROOT.path], 'one Refresh, for this root');
		assert.deepStrictEqual(timers.map(t => t.ms), [STATUS_TIMEOUT_MS]);
		await confirmAll(true);
		assert.strictEqual(source.status, 'ready', 'Git ran a status: the empty state is believed');
		assert.deepStrictEqual(names(), []);
		assert.ok(timers[0].disposed, 'the timeout is cancelled');
	});

	test('changes that arrive while confirming show at once; the confirmation then changes nothing', async () => {
		const repo = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await flush();
		await git.answer(repo);
		repo.set(state({ workingTreeChanges: [change.modified('a.ts')] }));
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual(names(), ['unstaged:a.ts']);
		const events = seen.length;
		fireTimers();
		assert.strictEqual(source.status, 'ready', 'a timeout after the changes showed does not hide them');
		assert.deepStrictEqual(names(), ['unstaged:a.ts']);
		assert.strictEqual(seen.length, events, 'and redraws nothing');
		await confirmAll(false);
		assert.deepStrictEqual([source.status, names()], ['ready', ['unstaged:a.ts']]);
	});

	test('a Refresh that answers after the changes showed redraws nothing', async () => {
		const repo = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await flush();
		await git.answer(repo);
		repo.set(state({ workingTreeChanges: [change.modified('a.ts')] }));
		const events = seen.length;
		await confirmAll(true);
		assert.strictEqual(seen.length, events);
	});

	test('several state events while confirming: the list follows each, and the confirmation keeps the last', async () => {
		const repo = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await flush();
		await git.answer(repo);
		repo.set(state({ workingTreeChanges: [change.modified('a.ts')] }));
		repo.set(state());
		assert.strictEqual(source.status, 'ready', 'a state event comes from a status run, even an empty one');
		repo.set(state({ untrackedChanges: [change.added('b.txt')] }));
		await confirmAll(true);
		assert.deepStrictEqual(names(), ['untracked:b.txt']);
	});

	test('a Refresh that fails or never answers ends in "unconfirmed", never "No changes"; Try again asks again', async () => {
		const repo = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await flush();
		await git.answer(repo);
		await confirmAll(new Error('command not found'));
		assert.strictEqual(source.status, 'unconfirmed');
		source.refresh();
		await flush();
		assert.strictEqual(source.status, 'loading', 'the known repository is followed again and confirmed again');
		assert.deepStrictEqual(confirms.map(c => c.root), [ROOT.path]);
		assert.deepStrictEqual(git.opened, [ROOT.path], 'no second open: the service already has it');
		fireTimers();
		assert.strictEqual(source.status, 'unconfirmed', 'a timeout is not a status');
		await confirmAll(true);
		assert.strictEqual(source.status, 'ready', 'a Refresh that answers after the timeout still settles it');
		assert.ok(STATUS_TIMEOUT_MS >= 5_000 && STATUS_TIMEOUT_MS <= 60_000);
	});

	test('a first state with only changes outside the worktree came from a status too', async () => {
		const other = URI.file('/w/ws-b/x.ts');
		source.setRoot(ROOT);
		await flush();
		await git.answer(new FakeRepository(ROOT, state({ workingTreeChanges: [change.raw(other, other, other)] })));
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual(confirms, []);
	});

	test('a repository that once showed changes is known to be scanned: emptied and revisited, it needs no Refresh', async () => {
		const repo = new FakeRepository(ROOT, state({ indexChanges: [change.modified('a.ts')] }));
		git.repositories.push(new FakeRepository(OTHER, state({ untrackedChanges: [change.added('b.txt', OTHER)] })));
		source.setRoot(ROOT);
		await flush();
		await git.answer(repo);
		repo.set(state());
		await source.setRoot(OTHER);
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual(confirms, []);
	});

	test('a first state with changes needs no confirmation', async () => {
		source.setRoot(ROOT);
		await flush();
		await git.answer(new FakeRepository(ROOT, state({ indexChanges: [change.modified('a.ts')] })));
		assert.strictEqual(source.status, 'ready');
		assert.deepStrictEqual([confirms, timers], [[], []]);
	});

	test('revisiting a repository Git has scanned shows its state at once, empty or not', async () => {
		const clean = new FakeRepository(ROOT);
		source.setRoot(ROOT);
		await flush();
		await git.answer(clean);
		await confirmAll(true);
		git.repositories.push(clean, new FakeRepository(OTHER, state({ untrackedChanges: [change.added('b.txt', OTHER)] })));
		await source.setRoot(OTHER);
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'ready', 'no "Reading…" again');
		assert.deepStrictEqual(names(), []);
		assert.deepStrictEqual(confirms, [], 'no second Refresh');
	});

	test('a known repository not yet confirmed is confirmed on its first empty state', async () => {
		git.repositories.push(new FakeRepository(ROOT));
		await source.setRoot(ROOT);
		assert.strictEqual(source.status, 'loading');
		assert.deepStrictEqual(git.opened, []);
		await confirmAll(true);
		assert.strictEqual(source.status, 'ready');
	});

	test('a confirmation for a worktree the user left never settles the next one', async () => {
		source.setRoot(ROOT);
		await flush();
		await git.answer(new FakeRepository(ROOT));
		const pending = confirms.splice(0);
		source.setRoot(OTHER);
		assert.ok(timers[0].disposed, 'leaving cancels the timeout');
		await flush();
		await git.answer(new FakeRepository(OTHER));
		pending.forEach(c => c.answer(true));
		await flush();
		assert.strictEqual(source.status, 'loading', 'OTHER still waits for its own confirmation');
		await confirmAll(true);
		assert.strictEqual(source.status, 'ready');
	});

	test('the confirmation is the git extension\'s Refresh command', () => {
		assert.strictEqual(GIT_REFRESH_COMMAND, 'git.refresh');
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
