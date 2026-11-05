/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService, TestWorkspaceTrustManagementService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { AxisDiscoveryDataSource } from '../../common/axisDiscoveryDataSource.js';

/** The disk provider, counting real-path requests (each one may never finish on a link loop). */
class CountingDiskProvider extends DiskFileSystemProvider {
	realpathCalls = 0;

	override realpath(resource: URI): Promise<string> {
		this.realpathCalls++;
		return super.realpath(resource);
	}
}

/** `git worktree add --relative-paths` needs git 2.48 or later; older hosts skip the suite. */
function gitHasRelativePaths(): boolean {
	try {
		const [major, minor] = execFileSync('git', ['--version'], { encoding: 'utf8' }).replace(/^git version /, '').split('.').map(Number);
		return major > 2 || (major === 2 && minor >= 48);
	} catch {
		return false;
	}
}

/**
 * Worktree discovery on the real disk provider, with repositories made by real
 * git and real symbolic links: the cases where a link higher up a path makes
 * a string comparison disagree with the physical path git follows.
 */
(isWindows || !gitHasRelativePaths() ? suite.skip : suite)('Axis worktree discovery on disk', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let fileService: FileService;
	let provider: CountingDiskProvider;
	let home: string;

	const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
		cwd,
		stdio: 'pipe',
		env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
	});

	setup(() => {
		disposables = store.add(new DisposableStore());
		fileService = disposables.add(new FileService(new NullLogService()));
		provider = disposables.add(new CountingDiskProvider(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, provider));
		home = realpathSync(mkdtempSync(join(tmpdir(), 'axis-discovery-')));
		// The victim: a repository with a worktree that uses relative paths.
		mkdirSync(join(home, 'src', 'proj'), { recursive: true });
		git(join(home, 'src', 'proj'), 'init', '-q');
		git(join(home, 'src', 'proj'), 'commit', '-q', '--allow-empty', '-m', 'init');
		git(join(home, 'src', 'proj'), 'worktree', 'add', '-q', '--relative-paths', '../proj-worktrees/feat', '-b', 'secret-feat');
		mkdirSync(join(home, 'Downloads'));
	});

	teardown(() => rmSync(home, { recursive: true, force: true }));

	/** Discovery must finish within this bound even when a link never resolves in a JS realpath (review finding S-2). */
	const BOUND_MS = 4000;

	async function paths(...folders: string[]): Promise<string[]> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`discovery did not finish within ${BOUND_MS} ms`)), BOUND_MS); });
		try {
			return await Promise.race([discover(folders), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	function createSource(folders: string[]): AxisDiscoveryDataSource {
		const context = new TestContextService(testWorkspace(...folders.map(folder => URI.file(folder))));
		const trust = disposables.add(new TestWorkspaceTrustManagementService());
		return disposables.add(new AxisDiscoveryDataSource(fileService, context, trust, new TestConfigurationService()));
	}

	async function discover(folders: string[], source = createSource(folders)): Promise<string[]> {
		const result: string[] = [];
		for (const project of await source.listProjects()) {
			result.push(...(await source.listWorktrees(project.id)).map(w => `${w.path.slice(home.length)}@${w.branch}`));
		}
		return result;
	}

	/**
	 * A link `x` in `dir` to a folder nine levels down, and the target text that reaches `fromHome` (a path
	 * relative to home) through it: `x/../../…`. The kernel follows `x` before each `..`; a lexical resolver
	 * collapses `x/..` and ends somewhere else, which is how a JS realpath was fooled.
	 */
	function deepLinkTarget(dir: string, fromHome: string): string {
		const levels = ['zz', '1', '2', '3', '4', '5', '6', '7', '8'];
		mkdirSync(join(dir, ...levels), { recursive: true });
		symlinkSync(levels.join('/'), join(dir, 'x'));
		const depth = dir.slice(home.length).split('/').filter(Boolean).length;
		return `x/${'../'.repeat(levels.length + depth)}${fromHome}`;
	}

	/** A link `loop` in `dir` whose target `x/../loop` the kernel resolves to `dir/d/loop`, and a JS realpath never finishes. */
	function loopLink(dir: string): string {
		mkdirSync(join(dir, 'd', 'e'), { recursive: true });
		mkdirSync(join(dir, 'd', 'loop'), { recursive: true });
		symlinkSync('d/e', join(dir, 'x'));
		symlinkSync('x/../loop', join(dir, 'loop'));
		return join(dir, 'd', 'loop');
	}

	function fakeRepoWithEntry(fake: string, gitdir: string): void {
		mkdirSync(join(fake, '.git', 'worktrees', 'feat'), { recursive: true });
		mkdirSync(join(fake, '.git', 'refs', 'heads'), { recursive: true });
		writeFileSync(join(fake, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(fake, '.git', 'worktrees', 'feat', 'gitdir'), gitdir);
		writeFileSync(join(fake, '.git', 'worktrees', 'feat', 'HEAD'), 'ref: refs/heads/innocent\n');
	}

	test('genuine relative-path worktrees are listed, also when the folder is opened through a link', async () => {
		symlinkSync('../src/proj', join(home, 'Downloads', 'proj-link'));
		const expected = ['/src/proj@main', '/src/proj-worktrees/feat@secret-feat'];
		assert.deepStrictEqual(await paths(join(home, 'src', 'proj')), expected);
		assert.deepStrictEqual(await paths(join(home, 'src', 'proj-worktrees', 'feat')), expected);
		assert.deepStrictEqual(await paths(join(home, 'Downloads', 'proj-link')), expected, 'physical paths');
	});

	test('a link higher up a worktree path does not list another repository\'s worktree', async () => {
		const fake = join(home, 'Downloads', 'proj');
		mkdirSync(join(fake, '.git', 'worktrees', 'feat'), { recursive: true });
		mkdirSync(join(fake, '.git', 'refs', 'heads'), { recursive: true });
		writeFileSync(join(fake, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(fake, '.git', 'worktrees', 'feat', 'gitdir'), '../../../../s/feat/.git\n');
		writeFileSync(join(fake, '.git', 'worktrees', 'feat', 'HEAD'), 'ref: refs/heads/innocent\n');
		symlinkSync('../src/proj-worktrees', join(home, 'Downloads', 's'));
		assert.deepStrictEqual(await paths(fake), ['/Downloads/proj@main']);
	});

	test('a worktree entry reached through a link whose target goes through a deeper link (x/..) is refused', async () => {
		const downloads = join(home, 'Downloads');
		symlinkSync(deepLinkTarget(downloads, 'src/proj-worktrees'), join(downloads, 's'));
		assert.ok(existsSync(join(downloads, 's', 'feat', '.git')), 'the kernel reaches the real worktree');
		fakeRepoWithEntry(join(downloads, 'proj'), '../../../../s/feat/.git\n');
		assert.deepStrictEqual(await paths(join(downloads, 'proj')), ['/Downloads/proj@main']);
	});

	test('a common dir and a submodule git dir reached through a deeper link (x/..) are not projects', async () => {
		const pw = join(home, 'Downloads', 'proj-worktrees');
		mkdirSync(join(pw, 'feat'), { recursive: true });
		symlinkSync(deepLinkTarget(pw, 'src/proj/.git'), join(pw, '.git'));
		writeFileSync(join(pw, 'feat', '.git'), 'gitdir: ../.git/worktrees/feat\n');
		assert.ok(existsSync(join(pw, '.git', 'worktrees', 'feat', 'gitdir')), 'the kernel reaches the real common dir');

		const modules = join(home, 'src', 'super', '.git', 'modules', 'sub');
		mkdirSync(modules, { recursive: true });
		writeFileSync(join(modules, 'HEAD'), 'ref: refs/heads/private-sub-branch\n');
		writeFileSync(join(modules, 'config'), '[core]\n\tworktree = ../../../sub\n');
		const sub = join(home, 'Downloads', 'sub');
		mkdirSync(join(sub, 'm'), { recursive: true });
		symlinkSync(deepLinkTarget(join(sub, 'm'), 'src/super/.git/modules/sub'), join(sub, 'm', 'lnk'));
		writeFileSync(join(sub, '.git'), 'gitdir: m/lnk\n');
		assert.ok(existsSync(join(sub, 'm', 'lnk', 'config')), 'the kernel reaches the real submodule git dir');

		assert.deepStrictEqual(await paths(join(pw, 'feat')), []);
		assert.deepStrictEqual(await paths(sub), []);
	});

	test('a folder opened through a deeper link (x/..), whose realpath comes back as written, is not a project', async () => {
		const downloads = join(home, 'Downloads');
		symlinkSync(deepLinkTarget(downloads, 'src/proj'), join(downloads, 'r'));
		assert.ok(existsSync(join(downloads, 'r', '.git', 'HEAD')), 'the kernel reaches the real repository');
		assert.deepStrictEqual(await paths(join(downloads, 'r')), []);
	});

	test('a looping link in a worktree entry or a submodule git dir neither hangs discovery nor hides the other entries', async () => {
		const downloads = join(home, 'Downloads');
		const real = loopLink(downloads);
		mkdirSync(join(real, 'feat'));
		writeFileSync(join(real, 'feat', '.git'), 'gitdir: ../../proj/.git/worktrees/feat\n');
		writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(real, 'config'), '[core]\n\tworktree = ../sub2\n');
		fakeRepoWithEntry(join(downloads, 'proj'), '../../../../loop/feat/.git\n');
		mkdirSync(join(downloads, 'sub2'));
		writeFileSync(join(downloads, 'sub2', '.git'), 'gitdir: ../loop\n');
		assert.deepStrictEqual(await paths(join(downloads, 'proj')), ['/Downloads/proj@main']);
		assert.deepStrictEqual(await paths(join(downloads, 'sub2'), join(home, 'src', 'proj')), ['/src/proj@main', '/src/proj-worktrees/feat@secret-feat']);
	});

	test('a looping opened folder is refused, and later discoveries reuse its one real-path request', async function () {
		this.timeout(10_000);
		loopLink(join(home, 'Downloads'));
		const loop = join(home, 'Downloads', 'loop');
		const source = createSource([loop]);
		const started = Date.now();
		assert.deepStrictEqual(await discover([loop], source), []);
		source.refresh();
		assert.deepStrictEqual(await discover([loop], source), []);
		source.refresh();
		assert.deepStrictEqual(await discover([loop], source), []);
		assert.strictEqual(provider.realpathCalls, 1, 'one request for the folder, however often discovery runs');
		assert.ok(Date.now() - started < 3000, 'only the first discovery waits for the request');
	});

	test('five looping opened folders do not hold up a real one', async () => {
		const folders: string[] = [];
		for (let i = 0; i < 5; i++) {
			const dir = join(home, 'Downloads', `l${i}`);
			mkdirSync(dir);
			loopLink(dir);
			folders.push(join(dir, 'loop'));
		}
		assert.deepStrictEqual(await paths(...folders, join(home, 'src', 'proj')), ['/src/proj@main', '/src/proj-worktrees/feat@secret-feat']);
		assert.strictEqual(provider.realpathCalls, 5, 'no request for a folder without a link');
	});

	test('only the first 50 opened folders are checked', async () => {
		mkdirSync(join(home, 'Downloads', 'target'));
		const folders: string[] = [];
		for (let i = 0; i < 60; i++) {
			const link = join(home, 'Downloads', `link${i}`);
			symlinkSync('target', link);
			folders.push(link);
		}
		assert.deepStrictEqual(await paths(...folders), []);
		assert.strictEqual(provider.realpathCalls, 50, 'the folders past the bound are not looked at');
	});

	test('Refresh follows a link that was retargeted, and a target that appears later', async () => {
		const other = join(home, 'src', 'other');
		mkdirSync(other, { recursive: true });
		git(other, 'init', '-q');
		git(other, 'commit', '-q', '--allow-empty', '-m', 'init');
		git(other, 'checkout', '-q', '-b', 'other-branch');
		const link = join(home, 'Downloads', 'p');
		symlinkSync(join(home, 'src', 'proj'), link);
		const source = createSource([link]);
		assert.deepStrictEqual((await discover([link], source))[0], '/src/proj@main');
		unlinkSync(link);
		symlinkSync(other, link);
		source.refresh();
		assert.deepStrictEqual(await discover([link], source), ['/src/other@other-branch']);

		const later = join(home, 'src', 'later');
		const late = join(home, 'Downloads', 'q');
		symlinkSync(later, late);
		const lateSource = createSource([late]);
		assert.deepStrictEqual(await discover([late], lateSource), []);
		mkdirSync(later);
		git(later, 'init', '-q');
		git(later, 'commit', '-q', '--allow-empty', '-m', 'init');
		lateSource.refresh();
		assert.deepStrictEqual(await discover([late], lateSource), ['/src/later@main']);
	});

	test('ten looping opened folders leave at most eight pending requests and do not hide a real one', async function () {
		this.timeout(15_000);
		const folders: string[] = [];
		for (let i = 0; i < 10; i++) {
			const dir = join(home, 'Downloads', `m${i}`);
			mkdirSync(dir);
			loopLink(dir);
			folders.push(join(dir, 'loop'));
		}
		assert.deepStrictEqual(await paths(...folders, join(home, 'src', 'proj')), ['/src/proj@main', '/src/proj-worktrees/feat@secret-feat']);
		assert.strictEqual(provider.realpathCalls, 8);
	});

	test('a worktree whose common dir is reached through a link is not a project', async () => {
		const pw = join(home, 'Downloads', 'proj-worktrees');
		mkdirSync(join(pw, 'feat'), { recursive: true });
		symlinkSync(join(home, 'src', 'proj', '.git'), join(pw, '.git'));
		writeFileSync(join(pw, 'feat', '.git'), 'gitdir: ../.git/worktrees/feat\n');
		assert.deepStrictEqual(await paths(join(pw, 'feat')), []);
	});

	test('a submodule whose git dir is reached through a link is not a project', async () => {
		const modules = join(home, 'src', 'super', '.git', 'modules', 'sub');
		mkdirSync(modules, { recursive: true });
		writeFileSync(join(modules, 'HEAD'), 'ref: refs/heads/private-sub-branch\n');
		writeFileSync(join(modules, 'config'), '[core]\n\tworktree = ../../../sub\n');
		const sub = join(home, 'Downloads', 'sub');
		mkdirSync(join(sub, 'x'), { recursive: true });
		symlinkSync(modules, join(sub, 'x', 'lnk'));
		writeFileSync(join(sub, '.git'), 'gitdir: x/lnk\n');
		assert.deepStrictEqual(await paths(sub), []);
	});
});
