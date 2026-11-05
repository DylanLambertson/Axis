/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, posix, win32 } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileType, IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { AxisDataProvenance, IAxisCliRun, IAxisProjectInfo, IAxisWorkspaceDataSource, IAxisWorktreeInfo } from './axisWorkspaceData.js';
import { AXIS_SAMPLE_RUNS_SETTING, sampleCliRuns } from './axisSampleRuns.js';
import { branchOf, displayName, GitHead, parseCoreWorktree, isSafeRefName, linksBack, MAX_DISCOVERED_WORKTREES, MAX_GIT_METADATA_BYTES, parseGitFile, parseHead, parseLooseRef, parsePackedRefs, resolveMetadataPath, stableId, worktreeDirFromGitdir } from './worktreeDiscovery.js';

interface IDiscoveredProject {
	readonly info: IAxisProjectInfo;
	readonly commonDir: string;
	readonly localCheckout: string | undefined;
	/** Whether `<common dir>/worktrees` may be listed: only for a `.git` directory in the folder or a verified linked worktree. */
	readonly listsWorktrees: boolean;
}

interface IFoundRepository {
	readonly commonDir: string;
	readonly localCheckout: string | undefined;
	readonly listsWorktrees: boolean;
}

/** Most components a checked path may have (a linked worktree's admin dir is its checkout's depth plus three); a longer path is refused. */
const MAX_PATH_COMPONENTS = 96;

/**
 * Time allowed to resolve the real path of an opened folder that contains a link; on timeout the folder
 * is not a project. A real path of a few links takes milliseconds.
 */
const OPENED_FOLDER_REALPATH_TIMEOUT_MS = 1000;

/** How long a settled real path of an opened folder (or its refusal) is reused before it is asked again. */
const OPENED_FOLDER_REALPATH_CACHE_MS = 5 * 60 * 1000;

/** Most opened folders checked per discovery, and how many are checked at once. */
const MAX_OPENED_FOLDERS = 50;
const OPENED_FOLDER_CONCURRENCY = 4;

/**
 * One real-path request for an opened folder. The upstream request cannot be cancelled and may never
 * finish (a link loop), so there is at most one per path: later discoveries reuse it instead of starting
 * another, and a request still pending after the timeout counts as a refusal.
 */
interface IRealpathRequest {
	readonly startedAt: number;
	readonly promise: Promise<string | undefined>;
	settledAt?: number;
	value?: string;
}

/** Time allowed to check one opened folder or one worktree entry; on timeout it is refused and the others go on. */
const ENTRY_TIMEOUT_MS = 5000;

/** The workspace key the UI uses for a worktree: its journal id, else a stable digest of its path. */
export function workspaceKeyOf(worktree: IAxisWorktreeInfo): string {
	return worktree.id ?? stableId('w', worktree.path);
}

/** A worktree listed by discovery: its folder's `.git` points back to the entry it was found from. */
interface IDiscoveredWorktrees {
	readonly worktrees: readonly IAxisWorktreeInfo[];
	/** Entries under `<common dir>/worktrees` that were not listed: missing, not linked back, or past the read limit. */
	readonly refused: number;
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
	private worktrees = new Map<string, Promise<IDiscoveredWorktrees>>();
	/** Real-path requests for opened folders, kept across discoveries (insertion order is age). */
	private readonly realpathRequests = new Map<string, IRealpathRequest>();

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

	async listWorktrees(projectId: string): Promise<readonly IAxisWorktreeInfo[]> {
		return (await this.discovered(projectId)).worktrees;
	}

	/** How many worktree entries of a project were refused (shown as a fixed message, never as rows). */
	async countRefusedWorktrees(projectId: string): Promise<number> {
		return (await this.discovered(projectId)).refused;
	}

	private discovered(projectId: string): Promise<IDiscoveredWorktrees> {
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
				const folders = this.contextService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).slice(0, MAX_OPENED_FOLDERS);
				const repos = await mapWithConcurrency(folders, OPENED_FOLDER_CONCURRENCY, folder => raceTimeout(this.findRepository(folder.uri.fsPath), ENTRY_TIMEOUT_MS));
				folders.forEach((folder, index) => {
					const repo = repos[index];
					if (!repo) {
						return;
					}
					const id = stableId('p', repo.commonDir);
					if (!projects.has(id)) {
						const name = displayName(basename(repo.localCheckout ?? folder.uri.fsPath));
						projects.set(id, { info: { id, name, trusted }, ...repo });
					}
				});
				return projects;
			})();
		}
		return this.projects;
	}

	/**
	 * Finds the common git dir and the local checkout of a folder, following a
	 * `.git` file once. A `.git` file is only a claim made by the folder, so it
	 * is believed only when the git dir it names points back at this folder:
	 * a linked worktree's admin dir (`<common dir>/worktrees/<name>/gitdir`), or
	 * a submodule's `core.worktree`. Only a `.git` directory in the folder, or a
	 * verified linked worktree, lists the repository's other worktrees.
	 */
	private async findRepository(openedRoot: string): Promise<IFoundRepository | undefined> {
		const path = isWindows ? win32 : posix;
		// Work in physical paths, as git does: the folder the user opened may itself be reached through a link.
		const root = await this.physicalOpenedFolder(openedRoot);
		if (!root) {
			return undefined;
		}
		const dotGit = path.join(root, '.git');
		const stat = await this.statOrUndefined(dotGit);
		if (!stat || stat.isSymbolicLink) {
			return undefined;
		}
		if (stat.isDirectory) {
			return { commonDir: dotGit, localCheckout: root, listsWorktrees: true };
		}
		const gitDirLine = parseGitFile(await this.readText(dotGit) ?? '');
		if (!gitDirLine) {
			return undefined;
		}
		const gitDir = resolveMetadataPath(gitDirLine, root, isWindows);
		if (!gitDir) {
			return undefined;
		}
		const commonDirLine = (await this.readText(path.join(gitDir, 'commondir')))?.split('\n')[0].trim();
		if (!commonDirLine) {
			// A submodule: its git dir's `core.worktree` must name this folder. It is one checkout; its
			// git dir's `worktrees/` is not listed. (A `--separate-git-dir` repository has no such
			// back-pointer and is not a project in Phase 0.)
			if (!(await this.isPhysical(gitDir))) {
				return undefined;
			}
			const coreWorktree = parseCoreWorktree(await this.readText(path.join(gitDir, 'config')) ?? '');
			const coreWorktreeDir = coreWorktree ? resolveMetadataPath(coreWorktree, gitDir, isWindows) : undefined;
			if (!coreWorktreeDir || !samePath(coreWorktreeDir, root)) {
				return undefined;
			}
			return { commonDir: gitDir, localCheckout: root, listsWorktrees: false };
		}
		// A linked worktree: git keeps its admin dir at `<common dir>/worktrees/<name>`, whose `gitdir` names this folder's `.git`.
		const commonDir = resolveMetadataPath(commonDirLine, gitDir, isWindows);
		const gitdirBack = resolveMetadataPath((await this.readText(path.join(gitDir, 'gitdir')))?.split('\n')[0].trim() || '.', gitDir, isWindows);
		if (!commonDir || !gitdirBack) {
			return undefined;
		}
		const adminParent = path.join(commonDir, 'worktrees');
		// The common dir is the git dir's grandparent here, so a physical git dir means a physical common dir too.
		if (!samePath(path.dirname(gitDir), adminParent) || !samePath(gitdirBack, dotGit) || !(await this.isPhysical(gitDir))) {
			return undefined;
		}
		const localCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : undefined;
		return { commonDir, localCheckout, listsWorktrees: true };
	}

	private async discoverWorktrees(projectId: string): Promise<IDiscoveredWorktrees> {
		const project = (await this.discoverProjects()).get(projectId);
		if (!project) {
			return { worktrees: [], refused: 0 };
		}
		const path = isWindows ? win32 : posix;
		const packed = parsePackedRefs(await this.readText(path.join(project.commonDir, 'packed-refs')) ?? '');
		const result: IAxisWorktreeInfo[] = [];

		if (project.localCheckout) {
			const head = parseHead(await this.readText(path.join(project.commonDir, 'HEAD')) ?? '');
			result.push(await this.toInfo(projectId, project.localCheckout, head, false, project.commonDir, packed));
		}

		if (!project.listsWorktrees) {
			return { worktrees: result, refused: 0 };
		}
		const worktreesDir = path.join(project.commonDir, 'worktrees');
		if (!(await this.isPhysical(worktreesDir))) {
			return { worktrees: result, refused: 0 }; // a linked or missing `worktrees` folder: nothing to list
		}
		// Names and types only (no stat per child), so a huge directory costs one read; then a bounded slice.
		const names = (await this.listDirectories(worktreesDir)).sort((a, b) => a.localeCompare(b));
		const entries = names.slice(0, MAX_DISCOVERED_WORKTREES);
		let refused = names.length - entries.length;
		for (const name of entries) {
			const entryDir = path.join(worktreesDir, name);
			const worktreeDir = await raceTimeout(this.verifiedWorktreeDir(entryDir), ENTRY_TIMEOUT_MS);
			if (!worktreeDir) {
				refused++; // missing, malformed, naming a folder that is not this worktree, or too slow: never listed or opened
				continue;
			}
			const head = parseHead(await this.readText(path.join(entryDir, 'HEAD')) ?? '');
			const locked = !!(await this.statOrUndefined(path.join(entryDir, 'locked')));
			result.push(await this.toInfo(projectId, worktreeDir, head, locked, project.commonDir, packed));
		}
		return { worktrees: result, refused };
	}

	/** Names of the real (not symbolically linked) directories in a folder, from one `readdir`. */
	private async listDirectories(fsPath: string): Promise<string[]> {
		const provider = this.fileService.getProvider(Schemas.file);
		try {
			const children = provider ? await provider.readdir(URI.file(fsPath)) : [];
			return children.filter(([, type]) => (type & FileType.Directory) !== 0 && (type & FileType.SymbolicLink) === 0).map(([name]) => name);
		} catch {
			return [];
		}
	}

	/** The worktree folder of a `<common dir>/worktrees/<name>` entry, if it links back; else `undefined`. */
	private async verifiedWorktreeDir(entryDir: string): Promise<string | undefined> {
		const worktreeDir = worktreeDirFromGitdir(await this.readText((isWindows ? win32 : posix).join(entryDir, 'gitdir')) ?? '', entryDir, isWindows);
		return worktreeDir && (await this.isLinkedBack(worktreeDir, entryDir)) ? worktreeDir : undefined;
	}

	/**
	 * The worktree folder is a real directory, its `.git` is not a symbolic link,
	 * and the `.git` file names `adminDir`. A `.git` directory or a missing `.git`
	 * fails the read, so it is refused there.
	 */
	private async isLinkedBack(worktreeDir: string, adminDir: string): Promise<boolean> {
		const dotGit = (isWindows ? win32 : posix).join(worktreeDir, '.git');
		const [dirStat, fileStat] = await Promise.all([this.statOrUndefined(worktreeDir), this.statOrUndefined(dotGit)]);
		if (!dirStat?.isDirectory || fileStat?.isSymbolicLink || !(await this.isPhysical(worktreeDir))) {
			return false;
		}
		return linksBack(await this.readText(dotGit) ?? '', worktreeDir, adminDir, isWindows);
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

	/**
	 * The physical path of a folder the user opened, or `undefined`. A path with no link in it is used as it
	 * is, without asking for a real path. Otherwise the real path is asked for once per path (see
	 * `IRealpathRequest`) and the answer is walked as well.
	 */
	private async physicalOpenedFolder(openedRoot: string): Promise<string | undefined> {
		const normalized = (isWindows ? win32 : posix).normalize(openedRoot);
		if (await this.isPhysical(normalized)) {
			return normalized;
		}
		const real = await this.realPathOnce(normalized);
		return real && (await this.isPhysical(real)) ? real : undefined;
	}

	private async realPathOnce(fsPath: string): Promise<string | undefined> {
		const now = Date.now();
		let request = this.realpathRequests.get(fsPath);
		if (request?.settledAt !== undefined && now - request.settledAt > OPENED_FOLDER_REALPATH_CACHE_MS) {
			request = undefined;
		}
		if (!request) {
			const started: IRealpathRequest = {
				startedAt: now,
				promise: this.realPath(fsPath).then(value => {
					started.settledAt = Date.now();
					started.value = value;
					return value;
				}),
			};
			this.realpathRequests.delete(fsPath);
			this.realpathRequests.set(fsPath, started);
			while (this.realpathRequests.size > MAX_OPENED_FOLDERS * 2) {
				const oldest = this.realpathRequests.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				this.realpathRequests.delete(oldest);
			}
			request = started;
		}
		if (request.settledAt !== undefined) {
			return request.value;
		}
		const remaining = OPENED_FOLDER_REALPATH_TIMEOUT_MS - (now - request.startedAt);
		return remaining > 0 ? raceTimeout(request.promise, remaining) : undefined;
	}

	/**
	 * The physical form of a path (every symbolic link resolved), or `undefined` when it cannot be resolved.
	 * Used only for the folder the user opened, and its answer is checked by `isPhysical`: the upstream
	 * realpath may return a path as written when its own resolution fails, and may not finish on some loops.
	 */
	private async realPath(fsPath: string): Promise<string | undefined> {
		try {
			return (await this.fileService.realpath(URI.file(fsPath)))?.fsPath;
		} catch {
			return undefined;
		}
	}

	/**
	 * True when every component of an absolute path exists and none is a symbolic link, checked one prefix
	 * at a time (the file service's `stat` reports a link at the last component, as `lstat` does). Then the
	 * path as written is the path the kernel follows. Fails closed: a missing or unreadable component, a
	 * relative path or more than `MAX_PATH_COMPONENTS` components gives `false`.
	 */
	private async isPhysical(fsPath: string): Promise<boolean> {
		const path = isWindows ? win32 : posix;
		if (!path.isAbsolute(fsPath)) {
			return false;
		}
		const normalized = path.normalize(fsPath);
		const root = path.parse(normalized).root;
		const parts = normalized.slice(root.length).split(path.sep).filter(Boolean);
		if (parts.length > MAX_PATH_COMPONENTS) {
			return false;
		}
		let current = root;
		for (const part of parts) {
			current = path.join(current, part);
			const stat = await this.statOrUndefined(current);
			if (!stat || stat.isSymbolicLink) {
				return false;
			}
		}
		return true;
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

function samePath(a: string, b: string): boolean {
	return isWindows ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : posix.normalize(a) === posix.normalize(b);
}

/** Maps items with at most `limit` calls in flight, keeping the order of the results. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
