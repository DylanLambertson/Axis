/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService, TestWorkspaceTrustManagementService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { AxisDiscoveryDataSource, workspaceKeyOf } from '../../browser/axisDiscoveryDataSource.js';
import { AXIS_SAMPLE_RUNS_SETTING } from '../../common/axisSampleRuns.js';
import { AXIS_ID_PATTERN } from '../../common/axisWorkspaceData.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** Fixture repositories on an in-memory `file:` provider (design task A2: 0, 1 and 3 worktrees, detached HEAD, missing gitdir). */
(isWindows ? suite.skip : suite)('Axis worktree discovery', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let fileService: FileService;
	let configuration: TestConfigurationService;

	setup(() => {
		disposables = store.add(new DisposableStore());
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
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

	test('three linked worktrees: branches, packed refs, a detached HEAD, a lock and a missing folder', async () => {
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
		assert.deepStrictEqual([...byPath.keys()], ['/repo', '/wt/detached', '/wt/feature', '/wt/gone']);
		assert.deepStrictEqual(byPath.get('/wt/feature'), { origin: 'external', projectId: project.id, branch: 'feature', head: SHA_B, path: '/wt/feature', locked: true, present: true });
		assert.strictEqual(byPath.get('/wt/detached')?.branch, null);
		assert.strictEqual(byPath.get('/wt/detached')?.head, SHA_B);
		assert.strictEqual(byPath.get('/wt/gone')?.present, false);
		assert.strictEqual(byPath.get('/wt/gone')?.head, null, 'an unknown branch has no head');
	});

	test('an entry with a missing or malformed gitdir is skipped', async () => {
		await mainRepo('/repo');
		await write('/repo/.git/worktrees/broken/HEAD', 'ref: refs/heads/x\n');
		await write('/repo/.git/worktrees/odd/gitdir', '/somewhere/not-a-dot-git\n');
		const source = createSource('/repo');
		const [project] = await source.listProjects();
		assert.deepStrictEqual((await source.listWorktrees(project.id)).map(w => w.path), ['/repo']);
	});

	test('opening a linked worktree finds the same project and its local checkout', async () => {
		await mainRepo('/repo');
		await linkedWorktree('/repo', 'feature', '/wt/feature', 'ref: refs/heads/main\n');
		const fromMain = await createSource('/repo').listProjects();
		const source = createSource('/wt/feature');
		const fromWorktree = await source.listProjects();
		assert.strictEqual(fromWorktree[0].id, fromMain[0].id);
		assert.strictEqual(await source.getLocalCheckout(fromWorktree[0].id), '/repo');
	});

	test('a ref name that would leave the git directory is not read', async () => {
		await mainRepo('/repo', 'ref: refs/heads/../../../etc/x\n');
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
