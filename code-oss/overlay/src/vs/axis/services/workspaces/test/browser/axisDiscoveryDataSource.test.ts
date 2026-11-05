/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities, FileType, IStat } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService, TestWorkspaceTrustManagementService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { AxisDiscoveryDataSource, workspaceKeyOf } from '../../common/axisDiscoveryDataSource.js';
import { AXIS_SAMPLE_RUNS_SETTING } from '../../common/axisSampleRuns.js';
import { MAX_DISCOVERED_WORKTREES } from '../../common/worktreeDiscovery.js';
import { AXIS_ID_PATTERN } from '../../common/axisWorkspaceData.js';
import { branchLabel, MAX_BRANCH_LABEL_LENGTH } from '../../common/axisWorkspaceModel.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * An in-memory provider that reports chosen paths as symbolic links (the in-memory provider has none):
 * `stat` and `readdir` flag them, and `realpath` of a path at or under one gives a different physical path.
 */
class SymlinkMarkingProvider extends InMemoryFileSystemProvider {
	readonly links = new Set<string>();
	/** Paths whose `stat` never finishes. */
	readonly hanging = new Set<string>();

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileRealpath;
	}

	async realpath(resource: URI): Promise<string> {
		await super.stat(resource); // a missing path fails, as on disk
		const linked = [...this.links].some(link => resource.path === link || resource.path.startsWith(`${link}/`));
		return linked ? `/physical${resource.path}` : resource.path;
	}

	override async stat(resource: URI): Promise<IStat> {
		if (this.hanging.has(resource.path)) {
			return new Promise<IStat>(() => { });
		}
		const stat = await super.stat(resource);
		return this.links.has(resource.path) ? { ...stat, type: stat.type | FileType.SymbolicLink } : stat;
	}

	override async readdir(resource: URI): Promise<[string, FileType][]> {
		const prefix = resource.path.endsWith('/') ? resource.path : `${resource.path}/`;
		return (await super.readdir(resource)).map(([name, type]) => [name, this.links.has(prefix + name) ? type | FileType.SymbolicLink : type]);
	}
}

/** Fixture repositories on an in-memory `file:` provider (design task A2: 0, 1 and 3 worktrees, detached HEAD, missing gitdir). */
(isWindows ? suite.skip : suite)('Axis worktree discovery', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let fileService: FileService;
	let configuration: TestConfigurationService;
	let provider: SymlinkMarkingProvider;

	setup(() => {
		disposables = store.add(new DisposableStore());
		fileService = disposables.add(new FileService(new NullLogService()));
		provider = disposables.add(new SymlinkMarkingProvider());
		disposables.add(fileService.registerProvider(Schemas.file, provider));
		configuration = new TestConfigurationService();
	});

	async function write(path: string, content: string): Promise<void> {
		await fileService.writeFile(URI.file(path), VSBuffer.fromString(content));
	}

	async function mainRepo(root: string, head = 'ref: refs/heads/main\n'): Promise<void> {
		await write(`${root}/.git/HEAD`, head);
		await write(`${root}/.git/refs/heads/main`, `${SHA_A}\n`);
		await write(`${root}/README.md`, 'hello\n');
	}

	async function linkedWorktree(root: string, name: string, dir: string, head: string): Promise<void> {
		await write(`${root}/.git/worktrees/${name}/gitdir`, `${dir}/.git\n`);
		await write(`${root}/.git/worktrees/${name}/HEAD`, head);
		await write(`${root}/.git/worktrees/${name}/commondir`, '../..\n');
		await write(`${dir}/.git`, `gitdir: ${root}/.git/worktrees/${name}\n`);
	}

	function createSource(...folders: string[]): AxisDiscoveryDataSource {
		const context = new TestContextService(testWorkspace(...folders.map(f => URI.file(f))));
		const trust = disposables.add(new TestWorkspaceTrustManagementService());
		return disposables.add(new AxisDiscoveryDataSource(fileService, context, trust, configuration));
	}

	test('a folder that is not a repository yields no project', async () => {
		await write('/plain/file.txt', 'x');
		assert.deepStrictEqual(await createSource('/plain').listProjects(), []);
	});

	test('a repository with no linked worktree lists only the local checkout', async () => {
		await mainRepo('/repo');
		const source = createSource('/repo');
		const [project] = await source.listProjects();
		assert.match(project.id, AXIS_ID_PATTERN);
		assert.strictEqual(project.name, 'repo');
		assert.strictEqual(await source.getLocalCheckout(project.id), '/repo');
		const worktrees = await source.listWorktrees(project.id);
		assert.deepStrictEqual(worktrees, [{ origin: 'external', projectId: project.id, branch: 'main', head: SHA_A, path: '/repo', locked: false, present: true }]);
	});

	test('three linked worktrees: branches, packed refs, a detached HEAD and a lock; a missing folder is refused', async () => {
		await mainRepo('/repo');
		await write('/repo/.git/packed-refs', `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/heads/feature\n^${SHA_A}\n`);
		await linkedWorktree('/repo', 'feature', '/wt/feature', 'ref: refs/heads/feature\n');
		await linkedWorktree('/repo', 'detached', '/wt/detached', `${SHA_B}\n`);
		await linkedWorktree('/repo', 'gone', '/wt/gone', 'ref: refs/heads/gone\n');
		await write('/repo/.git/worktrees/feature/locked', 'axis:ws\n');
		await fileService.del(URI.file('/wt/gone'), { recursive: true });

		const source = createSource('/repo');
		const [project] = await source.listProjects();
		const byPath = new Map((await source.listWorktrees(project.id)).map(w => [w.path, w]));
		assert.deepStrictEqual([...byPath.keys()], ['/repo', '/wt/detached', '/wt/feature']);
		assert.deepStrictEqual(byPath.get('/wt/feature'), { origin: 'external', projectId: project.id, branch: 'feature', head: SHA_B, path: '/wt/feature', locked: true, present: true });
		assert.strictEqual(byPath.get('/wt/detached')?.branch, null);
		assert.strictEqual(byPath.get('/wt/detached')?.head, SHA_B);
		assert.strictEqual(await source.countRefusedWorktrees(project.id), 1, 'the missing folder cannot be checked, so it is not listed');
	});

	test('an entry with a missing or malformed gitdir is skipped', async () => {
		await mainRepo('/repo');
		await write('/repo/.git/worktrees/broken/HEAD', 'ref: refs/heads/x\n');
		await write('/repo/.git/worktrees/odd/gitdir', '/somewhere/not-a-dot-git\n');
		const source = createSource('/repo');
		const [project] = await source.listProjects();
		assert.deepStrictEqual((await source.listWorktrees(project.id)).map(w => w.path), ['/repo']);
		assert.strictEqual(await source.countRefusedWorktrees(project.id), 2);
	});

	test('a gitdir naming a folder that does not point back is refused, whatever is there', async () => {
		await mainRepo('/repo');
		await mainRepo('/home/user'); // an unrelated repository: its .git is a directory
		await write('/repo/.git/worktrees/home/gitdir', '/home/user/.git\n');
		await write('/repo/.git/worktrees/home/HEAD', 'ref: refs/heads/main\n');
		await write('/elsewhere/.git', 'gitdir: /other/.git/worktrees/x\n'); // a .git file, but for another repository
		await write('/repo/.git/worktrees/other/gitdir', '/elsewhere/.git\n');
		await write('/repo/.git/worktrees/rel/gitdir', '../../../../home/user/.git\n'); // `..` out of the repository
		const source = createSource('/repo');
		const [project] = await source.listProjects();
		assert.deepStrictEqual((await source.listWorktrees(project.id)).map(w => w.path), ['/repo']);
		assert.strictEqual(await source.countRefusedWorktrees(project.id), 3);
	});

	test('an opened folder whose .git file claims an unrelated common dir is not a project', async () => {
		await mainRepo('/home/user');
		await write('/clone/.git', 'gitdir: meta/a\n');
		await write('/clone/meta/a/commondir', '/home/user/.git\n');
		await write('/clone/meta/a/gitdir', '/clone/.git\n'); // points back, but the admin dir is not under the common dir
		assert.deepStrictEqual(await createSource('/clone').listProjects(), []);
	});

	async function paths(folder: string): Promise<string[]> {
		const source = createSource(folder);
		const result: string[] = [];
		for (const project of await source.listProjects()) {
			result.push(...(await source.listWorktrees(project.id)).map(w => w.path));
		}
		return result;
	}

	async function victim(): Promise<void> {
		await mainRepo('/home/user/victim');
		await linkedWorktree('/home/user/victim', 'secretwt', '/home/user/victim-wt', 'ref: refs/heads/private-branch\n');
	}

	test('a .git file naming another repository\'s git dir does not make a project or list its worktrees', async () => {
		await victim();
		await write('/clone/.git', 'gitdir: /home/user/victim/.git\n');
		await write('/clone2/.git', 'gitdir: ../home/user/victim/.git\n'); // relative
		await write('/clone3/.git', 'gitdir: /home/user/victim/.git/worktrees/secretwt\n'); // its genuine admin dir, which names victim-wt
		for (const folder of ['/clone', '/clone2', '/clone3']) {
			assert.deepStrictEqual(await paths(folder), [], folder);
		}
	});

	test('a genuine submodule is one checkout, verified by core.worktree, and lists no worktrees', async () => {
		await mainRepo('/super');
		await write('/super/sub/.git', 'gitdir: ../.git/modules/sub\n');
		await write('/super/.git/modules/sub/HEAD', 'ref: refs/heads/main\n');
		await write('/super/.git/modules/sub/config', '[core]\n\tbare = false\n\tworktree = ../../../sub\n');
		await write('/super/.git/modules/sub/worktrees/extra/gitdir', '/wt/sub-extra/.git\n'); // a real worktree of the submodule: not listed
		await write('/wt/sub-extra/.git', 'gitdir: /super/.git/modules/sub/worktrees/extra\n');
		assert.deepStrictEqual(await paths('/super/sub'), ['/super/sub']);
	});

	test('a submodule-style .git file whose core.worktree names another folder, or that has none, is not a project', async () => {
		await write('/fake/.git', 'gitdir: /store/fake.git\n');
		await write('/store/fake.git/HEAD', 'ref: refs/heads/main\n');
		await write('/store/fake.git/config', '[core]\n\tworktree = /elsewhere\n');
		await write('/sep/.git', 'gitdir: /store/sep.git\n'); // a --separate-git-dir repository: no back-pointer
		await write('/store/sep.git/HEAD', 'ref: refs/heads/main\n');
		assert.deepStrictEqual(await paths('/fake'), []);
		assert.deepStrictEqual(await paths('/sep'), []);
	});

	test('a symbolically linked worktree folder is refused, even when its relative .git resolves back', async () => {
		// The reviewer's case: /a/wt links to another repository's worktree whose relative .git, read from /a/wt, names /a's entry.
		await mainRepo('/a/victim');
		await write('/a/victim/.git/worktrees/x/gitdir', '/a/wt/.git\n');
		await write('/a/wt/.git', 'gitdir: ../victim/.git/worktrees/x\n');
		assert.deepStrictEqual(await paths('/a/victim'), ['/a/victim', '/a/wt'], 'control: accepted while /a/wt is a real folder');
		provider.links.add('/a/wt');
		assert.deepStrictEqual(await paths('/a/victim'), ['/a/victim']);
	});

	test('a worktree whose .git is a symbolic link or a directory is refused', async () => {
		await mainRepo('/repo');
		await linkedWorktree('/repo', 'linked', '/wt/linked', 'ref: refs/heads/main\n');
		await write('/repo/.git/worktrees/dir/gitdir', '/wt/dir/.git\n');
		await write('/wt/dir/.git/HEAD', 'ref: refs/heads/main\n'); // .git is a directory here
		assert.deepStrictEqual(await paths('/repo'), ['/repo', '/wt/linked'], 'control');
		provider.links.add('/wt/linked/.git');
		assert.deepStrictEqual(await paths('/repo'), ['/repo']);
	});

	test('symbolically linked entries and an opened folder whose .git is a link are not followed', async () => {
		await mainRepo('/repo');
		await linkedWorktree('/repo', 'entry', '/wt/entry', 'ref: refs/heads/main\n');
		await mainRepo('/linked');
		provider.links.add('/repo/.git/worktrees/entry');
		provider.links.add('/linked/.git');
		assert.deepStrictEqual(await paths('/repo'), ['/repo']);
		assert.deepStrictEqual(await paths('/linked'), []);
	});

	test('a symbolic link higher up a worktree path is refused (the folder and its .git are real)', async () => {
		// The reviewer's case: /d/s links to the victim's worktrees folder; feat and feat/.git are real, the relative link reads back.
		await mainRepo('/d/proj');
		await write('/d/proj/.git/worktrees/feat/gitdir', '../../../../s/feat/.git\n');
		await write('/d/s/feat/.git', 'gitdir: ../../proj/.git/worktrees/feat\n');
		assert.deepStrictEqual(await paths('/d/proj'), ['/d/proj', '/d/s/feat'], 'control: accepted while /d/s is a real folder');
		provider.links.add('/d/s');
		assert.deepStrictEqual(await paths('/d/proj'), ['/d/proj']);
	});

	test('a linked worktree whose common dir, or a submodule whose git dir, is reached through a link is not a project', async () => {
		await mainRepo('/d/pw');
		await linkedWorktree('/d/pw', 'feat', '/d/pw/feat', 'ref: refs/heads/main\n');
		await write('/d/pw/feat/.git', 'gitdir: ../.git/worktrees/feat\n');
		await write('/d/pw/.git/worktrees/feat/gitdir', '/d/pw/feat/.git\n');
		await write('/d/sub/.git', 'gitdir: x/lnk\n');
		await write('/d/sub/x/lnk/HEAD', 'ref: refs/heads/main\n');
		await write('/d/sub/x/lnk/config', '[core]\n\tworktree = ../../../sub\n');
		assert.deepStrictEqual(await paths('/d/pw/feat'), ['/d/pw', '/d/pw/feat'], 'control: the linked worktree lists the main checkout and itself');
		assert.deepStrictEqual(await paths('/d/sub'), ['/d/sub'], 'control: the submodule');
		provider.links.add('/d/pw/.git');
		provider.links.add('/d/sub/x/lnk');
		assert.deepStrictEqual(await paths('/d/pw/feat'), []);
		assert.deepStrictEqual(await paths('/d/sub'), []);
	});

	test('an opened worktree whose admin dir entry is a link is not a project', async () => {
		await mainRepo('/repo');
		await linkedWorktree('/repo', 'feat', '/wt/feat', 'ref: refs/heads/main\n');
		assert.deepStrictEqual(await paths('/wt/feat'), ['/repo', '/wt/feat'], 'control');
		provider.links.add('/repo/.git/worktrees/feat');
		assert.deepStrictEqual(await paths('/wt/feat'), []);
	});

	test('entries under a worktrees folder that is a link are not listed', async () => {
		await mainRepo('/repo');
		await linkedWorktree('/repo', 'e', '/wt/e', 'ref: refs/heads/main\n');
		assert.deepStrictEqual(await paths('/repo'), ['/repo', '/wt/e'], 'control');
		provider.links.add('/repo/.git/worktrees');
		assert.deepStrictEqual(await paths('/repo'), ['/repo']);
	});

	test('a repository deep in the tree still lists its worktrees from the worktree side', async () => {
		const deep = '/' + Array.from({ length: 90 }, (_, i) => `d${i}`).join('/');
		await mainRepo(`${deep}/repo`);
		await linkedWorktree(`${deep}/repo`, 'feat', `${deep}/wt`, 'ref: refs/heads/main\n');
		assert.deepStrictEqual(await paths(`${deep}/wt`), [`${deep}/repo`, `${deep}/wt`]);
	});

	test('a path over the component limit is refused and one at the limit is not', async () => {
		const at = (count: number) => '/' + [...Array.from({ length: count - 1 }, (_, i) => `d${i}`), 'repo'].join('/');
		await mainRepo(at(96));
		await mainRepo(at(97));
		assert.deepStrictEqual(await paths(at(96)), [at(96)]);
		assert.deepStrictEqual(await paths(at(97)), []);
	});

	test('a folder whose check never finishes is refused after the entry limit and the others still list', () => runWithFakedTimers({}, async () => {
		await mainRepo('/repo');
		await write('/slow/file.txt', 'x');
		provider.hanging.add('/slow');
		const source = createSource('/slow', '/repo');
		assert.deepStrictEqual((await source.listProjects()).map(p => p.name), ['repo']);
	}));

	test('at most MAX_DISCOVERED_WORKTREES entries are read; the rest are counted as not listed', async () => {
		await mainRepo('/repo');
		for (let i = 0; i < MAX_DISCOVERED_WORKTREES; i++) {
			await write(`/repo/.git/worktrees/e${String(i).padStart(4, '0')}/gitdir`, '/nowhere/.git\n');
		}
		await linkedWorktree('/repo', 'zz-past-the-limit', '/wt/zz', 'ref: refs/heads/main\n');
		const source = createSource('/repo');
		const [project] = await source.listProjects();
		assert.deepStrictEqual((await source.listWorktrees(project.id)).map(w => w.path), ['/repo']);
		assert.strictEqual(await source.countRefusedWorktrees(project.id), MAX_DISCOVERED_WORKTREES + 1);
	});

	test('opening a linked worktree finds the same project and its local checkout', async () => {
		await mainRepo('/repo');
		await linkedWorktree('/repo', 'feature', '/wt/feature', 'ref: refs/heads/main\n');
		await linkedWorktree('/repo', 'other', '/wt/other', 'ref: refs/heads/main\n');
		const fromMain = await createSource('/repo').listProjects();
		const source = createSource('/wt/feature');
		const fromWorktree = await source.listProjects();
		assert.strictEqual(fromWorktree[0].id, fromMain[0].id);
		assert.strictEqual(await source.getLocalCheckout(fromWorktree[0].id), '/repo');
		assert.deepStrictEqual((await source.listWorktrees(fromWorktree[0].id)).map(w => w.path), ['/repo', '/wt/feature', '/wt/other'], 'a verified linked worktree lists its siblings');
	});

	test('a hostile branch name reaches the dashboard cleaned and bounded', async () => {
		await mainRepo('/repo', `ref: refs/heads/main\u202E${'b'.repeat(60 * 1024)}\n`);
		const source = createSource('/repo');
		const [project] = await source.listProjects();
		const [worktree] = await source.listWorktrees(project.id);
		assert.ok(worktree.branch!.startsWith('main\uFFFDbbb'));
		assert.strictEqual([...worktree.branch!].length, 256, 'the contract limit');
		const label = branchLabel({ key: 'k', label: 'repo', project, worktree, isLocalCheckout: true, runs: [], attention: undefined });
		assert.strictEqual([...label].length, MAX_BRANCH_LABEL_LENGTH);
	});

	test('a ref name that would leave the git directory is not read', async () => {
		await mainRepo('/repo', 'ref: refs/heads/../../../etc/x\n');
		// /repo/.git + refs/heads/../../../etc/x: what an unguarded join of that ref would read.
		await write('/repo/etc/x', `${SHA_B}\n`);
		const source = createSource('/repo');
		const [project] = await source.listProjects();
		const [checkout] = await source.listWorktrees(project.id);
		assert.strictEqual(checkout.head, null);
	});

	test('runs are empty without the sample setting, and labelled sample with it', async () => {
		await mainRepo('/repo');
		await linkedWorktree('/repo', 'feature', '/wt/feature', 'ref: refs/heads/main\n');
		const source = createSource('/repo');
		assert.deepStrictEqual(await source.listCliRuns(), []);
		assert.strictEqual(source.runsProvenance, 'discovery');

		configuration.setUserConfiguration(AXIS_SAMPLE_RUNS_SETTING, true);
		const runs = await source.listCliRuns();
		const [project] = await source.listProjects();
		const feature = (await source.listWorktrees(project.id)).find(w => w.path === '/wt/feature')!;
		assert.strictEqual(source.runsProvenance, 'sample');
		assert.deepStrictEqual(runs.map(r => r.workspaceId), [workspaceKeyOf(feature)], 'never a run in the local checkout');
	});
});
