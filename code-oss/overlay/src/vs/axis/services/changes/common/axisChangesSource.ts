/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitRepository, IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { IAxisChanges, readChanges } from './axisChanges.js';

/**
 * `idle`: no worktree. `notMounted`: the worktree is not in the window's folders.
 * `askFirst`: the user has closed repositories in the git extension, so this one may be one of
 * them; it is opened only when the user asks (`refresh`), because opening a closed repository
 * also forgets that the user closed it. `loading`: the repository is being looked up or
 * opened. `unavailable`: the folder is not a repository root, or the git extension gave no
 * repository rooted at it (off, untrusted, still starting). `ready`: `changes` is the
 * repository's state.
 */
export type AxisChangesStatus = 'idle' | 'notMounted' | 'askFirst' | 'loading' | 'unavailable' | 'ready';

/** What a folder's `.git` entry is, as far as the source needs to know. */
export type AxisGitEntry = 'file' | 'directory' | 'none';

/**
 * True when a folder is a repository root git will not walk up from: its `.git` is a file (a
 * linked worktree's pointer) or a directory holding `HEAD`. An empty or half-deleted `.git`
 * directory is not enough: git would resolve a parent repository instead.
 */
export async function isRepositoryRoot(root: URI, entry: (uri: URI) => Promise<AxisGitEntry>): Promise<boolean> {
	const git = joinPath(root, '.git');
	switch (await entry(git)) {
		case 'file': return true;
		case 'directory': return await entry(joinPath(git, 'HEAD')) === 'file';
		case 'none': return false;
	}
}

/** What the source needs from `IGitService`: it only reads. */
export type IAxisGitReader = Pick<IGitService, 'openRepository' | 'repositories'>;

const NO_CHANGES: IAxisChanges = { groups: [], total: 0, files: 0, outside: 0 };

/** Root comparison as upstream does it: case-insensitive where the file system usually is. */
const roots = extUriBiasedIgnorePathCase;

/**
 * The changes of one worktree, kept current from the observable `state` of its repository
 * in the workbench `IGitService` (the git extension). It never runs git and never writes.
 *
 * It opens as little as it can, because the git extension's public `openRepository` opens
 * a parent repository or one the user closed without asking (`openIfParent` and
 * `openIfClosed` on), and each call replaces the repository object other readers follow:
 *
 * 1. A repository the service already has for exactly this root is followed, not reopened.
 * 2. Otherwise it is opened only if the worktree is in the window's folders and its root holds
 *    `.git` (so the git extension never walks up to a parent repository), and at most once per
 *    root: a root found unavailable stays so until `refresh` (the window's folders changed, or
 *    the user asked), never on a workspace list update.
 * 3. If the user has closed repositories in the git extension (its `git.closedRepositoryCount`),
 *    a root it does not have is opened only when the user asks: the open would also clear the
 *    user's "Close Repository" for good.
 * 4. A repository rooted anywhere else is not shown.
 * 5. A followed repository that the service has since replaced (another reader opened it again)
 *    is looked up again on the next `setRoot` for the same root.
 *
 * A worktree switch while a lookup is pending drops the late result, so the list never shows
 * one workspace's changes under another's name.
 */
export class AxisChangesSource extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly listener = this._register(new MutableDisposable());
	private readonly tried = new Set<string>();
	private followed: IGitRepository | undefined;
	private generation = 0;
	private _root: URI | undefined;
	private _status: AxisChangesStatus = 'idle';
	private _changes: IAxisChanges = NO_CHANGES;

	/**
	 * @param isMounted whether a folder is inside the window's folders.
	 * @param isRoot whether a folder is a repository root (`isRepositoryRoot`).
	 * @param hasClosedRepositories whether the user has closed repositories in the git extension.
	 */
	constructor(
		private readonly git: IAxisGitReader,
		private readonly isMounted: (root: URI) => boolean,
		private readonly isRoot: (root: URI) => Promise<boolean>,
		private readonly hasClosedRepositories: () => boolean,
	) {
		super();
	}

	get root(): URI | undefined { return this._root; }
	get status(): AxisChangesStatus { return this._status; }
	get changes(): IAxisChanges { return this._changes; }

	/**
	 * Shows a worktree's changes; `undefined` clears. The same root again does nothing, unless the
	 * repository it follows is no longer the service's (then it is looked up again).
	 */
	setRoot(folder: URI | undefined): Promise<void> {
		const root = folder && roots.removeTrailingPathSeparator(folder);
		if (root && this._root && roots.isEqual(root, this._root) && !this.replaced()) {
			return Promise.resolve();
		}
		return this.open(root, false);
	}

	/** Looks the current worktree up again, opening it even if it was found unavailable or needed asking first. */
	refresh(): Promise<void> {
		return this.open(this._root, true);
	}

	private async open(root: URI | undefined, retry: boolean): Promise<void> {
		const generation = ++this.generation;
		this.listener.clear();
		this.followed = undefined;
		this._root = root;
		if (!root || !this.isMounted(root)) {
			this.set(root ? 'notMounted' : 'idle', NO_CHANGES);
			return;
		}
		const known = this.find(root);
		if (known) {
			this.follow(known, root);
			return;
		}
		const key = roots.getComparisonKey(root);
		if (this.tried.has(key) && !retry) {
			this.set('unavailable', NO_CHANGES);
			return;
		}
		if (this.hasClosedRepositories() && !retry) {
			this.set('askFirst', NO_CHANGES);
			return;
		}
		this.tried.add(key);
		this.set('loading', NO_CHANGES);
		let repository: IGitRepository | undefined;
		try {
			repository = await this.isRoot(root) ? await this.git.openRepository(root) : undefined;
		} catch {
			repository = undefined;
		}
		if (generation !== this.generation || this._store.isDisposed) {
			return;
		}
		if (!repository || !roots.isEqual(roots.removeTrailingPathSeparator(repository.rootUri), root)) {
			this.set('unavailable', NO_CHANGES);
			return;
		}
		this.follow(repository, root);
	}

	private find(root: URI): IGitRepository | undefined {
		for (const repository of this.git.repositories) {
			if (roots.isEqual(roots.removeTrailingPathSeparator(repository.rootUri), root)) {
				return repository;
			}
		}
		return undefined;
	}

	/** True when the followed repository is no longer one the service lists. */
	private replaced(): boolean {
		return this.followed !== undefined && !Array.from(this.git.repositories).includes(this.followed);
	}

	private follow(repository: IGitRepository, root: URI): void {
		this.followed = repository;
		this.listener.value = autorun(reader => this.set('ready', readChanges(repository.state.read(reader), root)));
	}

	private set(status: AxisChangesStatus, changes: IAxisChanges): void {
		this._status = status;
		this._changes = changes;
		this._onDidChange.fire();
	}
}
