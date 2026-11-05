/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, posix, win32 } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { AxisDataProvenance, IAxisCliRun, IAxisProjectInfo, IAxisWorkspaceDataSource, IAxisWorktreeInfo } from '../common/axisWorkspaceData.js';
import { AXIS_SAMPLE_RUNS_SETTING, sampleCliRuns } from '../common/axisSampleRuns.js';
import { branchOf, displayName, GitHead, isSafeRefName, MAX_DISCOVERED_WORKTREES, MAX_GIT_METADATA_BYTES, parseGitFile, parseHead, parseLooseRef, parsePackedRefs, resolveMetadataPath, stableId, worktreeDirFromGitdir } from '../common/worktreeDiscovery.js';

interface IDiscoveredProject {
	readonly info: IAxisProjectInfo;
	readonly commonDir: string;
	readonly localCheckout: string | undefined;
}

/** The workspace key the UI uses for a worktree: its journal id, else a stable hash of its path. */
export function workspaceKeyOf(worktree: IAxisWorktreeInfo): string {
	return worktree.id ?? stableId('w', hash(worktree.path));
}

/**
 * Phase 0 data source (docs/design/axis-agent-shell.md section 5.2): projects
 * are the git repositories of the window's folders, and their worktrees are
 * read from the metadata git writes on disk. It spawns no process and writes
 * nothing. CLI runs are empty unless `axis.preview.sampleRuns` asks for the
 * labelled sample set; there is no daemon in Phase 0.
 */
export class AxisDiscoveryDataSource extends Disposable implements IAxisWorkspaceDataSource {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private projects: Promise<Map<string, IDiscoveredProject>> | undefined;
	private worktrees = new Map<string, Promise<readonly IAxisWorktreeInfo[]>>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const invalidate = () => {
			this.projects = undefined;
			this.worktrees.clear();
			this._onDidChange.fire();
		};
		this._register(this.contextService.onDidChangeWorkspaceFolders(invalidate));
		this._register(this.trustService.onDidChangeTrust(invalidate));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AXIS_SAMPLE_RUNS_SETTING)) {
				this._onDidChange.fire();
			}
		}));
	}

	get runsProvenance(): AxisDataProvenance {
		return this.configurationService.getValue<boolean>(AXIS_SAMPLE_RUNS_SETTING) === true ? 'sample' : 'discovery';
	}

	/** Forgets cached results and reads the disk again. */
	refresh(): void {
		this.projects = undefined;
		this.worktrees.clear();
		this._onDidChange.fire();
	}

	async listProjects(): Promise<readonly IAxisProjectInfo[]> {
		return [...(await this.discoverProjects()).values()].map(p => p.info);
	}

	async getLocalCheckout(projectId: string): Promise<string | undefined> {
		return (await this.discoverProjects()).get(projectId)?.localCheckout;
	}

	listWorktrees(projectId: string): Promise<readonly IAxisWorktreeInfo[]> {
		let result = this.worktrees.get(projectId);
		if (!result) {
			result = this.discoverWorktrees(projectId);
			this.worktrees.set(projectId, result);
		}
		return result;
	}

	async listCliRuns(workspaceId?: string): Promise<readonly IAxisCliRun[]> {
		if (this.runsProvenance !== 'sample') {
			return [];
		}
		const workspaceIds: string[] = [];
		for (const project of await this.listProjects()) {
			for (const worktree of await this.listWorktrees(project.id)) {
				if (worktree.path !== (await this.getLocalCheckout(project.id))) {
					workspaceIds.push(workspaceKeyOf(worktree));
				}
			}
		}
		const runs = sampleCliRuns(workspaceIds, Date.now());
		return workspaceId ? runs.filter(run => run.workspaceId === workspaceId) : runs;
	}

	private discoverProjects(): Promise<Map<string, IDiscoveredProject>> {
		if (!this.projects) {
			this.projects = (async () => {
				const projects = new Map<string, IDiscoveredProject>();
				const trusted = this.trustService.isWorkspaceTrusted();
				for (const folder of this.contextService.getWorkspace().folders) {
					if (folder.uri.scheme !== Schemas.file) {
						continue;
					}
					const repo = await this.findRepository(folder.uri.fsPath);
					if (!repo) {
						continue;
					}
					const id = stableId('p', hash(repo.commonDir));
					if (!projects.has(id)) {
						const name = displayName(basename(repo.localCheckout ?? folder.uri.fsPath));
						projects.set(id, { info: { id, name, trusted }, ...repo });
					}
				}
				return projects;
			})();
		}
		return this.projects;
	}

	/** Finds the common git dir and the local checkout of a folder, following a `.git` file once. */
	private async findRepository(root: string): Promise<{ commonDir: string; localCheckout: string | undefined } | undefined> {
		const path = isWindows ? win32 : posix;
		const dotGit = path.join(root, '.git');
		const stat = await this.statOrUndefined(dotGit);
		if (!stat) {
			return undefined;
		}
		if (stat.isDirectory) {
			return { commonDir: dotGit, localCheckout: root };
		}
		const gitDirLine = parseGitFile(await this.readText(dotGit) ?? '');
		if (!gitDirLine) {
			return undefined;
		}
		const gitDir = resolveMetadataPath(gitDirLine, root, isWindows);
		const commonDirLine = (await this.readText(path.join(gitDir, 'commondir')))?.split('\n')[0].trim();
		const commonDir = commonDirLine ? resolveMetadataPath(commonDirLine, gitDir, isWindows) : gitDir;
		// A linked worktree (or a submodule): the local checkout is the common dir's work tree when it is `<checkout>/.git`.
		const localCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : undefined;
		return { commonDir, localCheckout };
	}

	private async discoverWorktrees(projectId: string): Promise<readonly IAxisWorktreeInfo[]> {
		const project = (await this.discoverProjects()).get(projectId);
		if (!project) {
			return [];
		}
		const path = isWindows ? win32 : posix;
		const packed = parsePackedRefs(await this.readText(path.join(project.commonDir, 'packed-refs')) ?? '');
		const result: IAxisWorktreeInfo[] = [];

		if (project.localCheckout) {
			const head = parseHead(await this.readText(path.join(project.commonDir, 'HEAD')) ?? '');
			result.push(await this.toInfo(projectId, project.localCheckout, head, false, project.commonDir, packed));
		}

		const worktreesDir = path.join(project.commonDir, 'worktrees');
		const listing = await this.fileService.resolve(URI.file(worktreesDir)).catch(() => undefined);
		const entries = (listing?.children ?? []).filter(child => child.isDirectory).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_DISCOVERED_WORKTREES);
		for (const entry of entries) {
			const entryDir = entry.resource.fsPath;
			const worktreeDir = worktreeDirFromGitdir(await this.readText(path.join(entryDir, 'gitdir')) ?? '', entryDir, isWindows);
			if (!worktreeDir) {
				continue; // missing or malformed `gitdir`: not a worktree git can use either
			}
			const head = parseHead(await this.readText(path.join(entryDir, 'HEAD')) ?? '');
			const locked = !!(await this.statOrUndefined(path.join(entryDir, 'locked')));
			result.push(await this.toInfo(projectId, worktreeDir, head, locked, project.commonDir, packed));
		}
		return result;
	}

	private async toInfo(projectId: string, worktreeDir: string, head: GitHead | undefined, locked: boolean, commonDir: string, packed: Map<string, string>): Promise<IAxisWorktreeInfo> {
		const present = !!(await this.statOrUndefined(worktreeDir));
		return {
			origin: 'external', // Phase 0: Axis has created no worktree yet (design section 5.2)
			projectId,
			branch: branchOf(head),
			head: await this.resolveHead(head, commonDir, packed),
			path: worktreeDir,
			locked,
			present,
		};
	}

	private async resolveHead(head: GitHead | undefined, commonDir: string, packed: Map<string, string>): Promise<string | null> {
		if (!head) {
			return null;
		}
		if (head.kind === 'detached') {
			return head.sha;
		}
		if (!isSafeRefName(head.ref)) {
			return null;
		}
		const loose = parseLooseRef(await this.readText((isWindows ? win32 : posix).join(commonDir, ...head.ref.split('/'))) ?? '');
		return loose ?? packed.get(head.ref) ?? null; // null: an unborn branch
	}

	private async statOrUndefined(fsPath: string) {
		try {
			return await this.fileService.stat(URI.file(fsPath));
		} catch {
			return undefined;
		}
	}

	private async readText(fsPath: string): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(URI.file(fsPath), { limits: { size: MAX_GIT_METADATA_BYTES } });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}
}
