/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitRepository, IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { IAxisChanges, readChanges } from './axisChanges.js';

/**
 * `idle`: no worktree. `notMounted`: the worktree is not in the window's folders.
 * `loading`: the repository is being looked up or opened. `unavailable`: the folder is not a
 * repository root, or the git extension gave no repository rooted at it (off, untrusted,
 * still starting). `ready`: `changes` is the repository's state.
 */
export type AxisChangesStatus = 'idle' | 'notMounted' | 'loading' | 'unavailable' | 'ready';

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
 * 3. A repository rooted anywhere else is not shown.
 *
 * A worktree switch while a lookup is pending drops the late result, so the list never shows
 * one workspace's changes under another's name.
 */
export class AxisChangesSource extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly listener = this._register(new MutableDisposable());
	private readonly tried = new Set<string>();
	private generation = 0;
	private _root: URI | undefined;
	private _status: AxisChangesStatus = 'idle';
	private _changes: IAxisChanges = NO_CHANGES;

	/**
	 * @param isMounted whether a folder is inside the window's folders.
	 * @param isRepositoryRoot whether a folder holds `.git` (a file for a linked worktree).
	 */
	constructor(
		private readonly git: IAxisGitReader,
		private readonly isMounted: (root: URI) => boolean,
		private readonly isRepositoryRoot: (root: URI) => Promise<boolean>,
	) {
		super();
	}

	get root(): URI | undefined { return this._root; }
	get status(): AxisChangesStatus { return this._status; }
	get changes(): IAxisChanges { return this._changes; }

	/** Shows a worktree's changes; `undefined` clears. The same root again does nothing. */
	setRoot(folder: URI | undefined): Promise<void> {
		const root = folder && roots.removeTrailingPathSeparator(folder);
		if (root && this._root && roots.isEqual(root, this._root)) {
			return Promise.resolve();
		}
		return this.open(root, false);
	}

	/** Looks the current worktree up again, opening it even if it was found unavailable before. */
	refresh(): Promise<void> {
		return this.open(this._root, true);
	}

	private async open(root: URI | undefined, retry: boolean): Promise<void> {
		const generation = ++this.generation;
		this.listener.clear();
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
		this.tried.add(key);
		this.set('loading', NO_CHANGES);
		let repository: IGitRepository | undefined;
		try {
			repository = await this.isRepositoryRoot(root) ? await this.git.openRepository(root) : undefined;
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

	private follow(repository: IGitRepository, root: URI): void {
		this.listener.value = autorun(reader => this.set('ready', readChanges(repository.state.read(reader), root)));
	}

	private set(status: AxisChangesStatus, changes: IAxisChanges): void {
		this._status = status;
		this._changes = changes;
		this._onDidChange.fire();
	}
}
