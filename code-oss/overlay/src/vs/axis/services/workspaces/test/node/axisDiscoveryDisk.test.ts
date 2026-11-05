/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
	let home: string;

	const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
		cwd,
		stdio: 'pipe',
		env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
	});

	setup(() => {
		disposables = store.add(new DisposableStore());
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		home = realpathSync(mkdtempSync(join(tmpdir(), 'axis-discovery-')));
		// The victim: a repository with a worktree that uses relative paths.
		mkdirSync(join(home, 'src', 'proj'), { recursive: true });
		git(join(home, 'src', 'proj'), 'init', '-q');
		git(join(home, 'src', 'proj'), 'commit', '-q', '--allow-empty', '-m', 'init');
		git(join(home, 'src', 'proj'), 'worktree', 'add', '-q', '--relative-paths', '../proj-worktrees/feat', '-b', 'secret-feat');
		mkdirSync(join(home, 'Downloads'));
	});

	teardown(() => rmSync(home, { recursive: true, force: true }));

	async function paths(folder: string): Promise<string[]> {
		const context = new TestContextService(testWorkspace(URI.file(folder)));
		const trust = disposables.add(new TestWorkspaceTrustManagementService());
		const source = disposables.add(new AxisDiscoveryDataSource(fileService, context, trust, new TestConfigurationService()));
		const result: string[] = [];
		for (const project of await source.listProjects()) {
			result.push(...(await source.listWorktrees(project.id)).map(w => `${w.path.slice(home.length)}@${w.branch}`));
		}
		return result;
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
