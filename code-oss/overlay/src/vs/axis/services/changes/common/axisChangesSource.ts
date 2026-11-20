/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { IAxisChanges, readChanges } from './axisChanges.js';

/**
 * `idle`: no worktree. `notMounted`: the worktree is not in the window's folders, so the git
 * extension would not open it without asking (Phase 0: the window's folder does not follow
 * the focused workspace yet). `loading`: the repository is being opened. `unavailable`: the
 * git extension has no repository rooted at the worktree (off, untrusted, still starting, or
 * the folder is not its own worktree). `ready`: `changes` is the repository's state.
 */
export type AxisChangesStatus = 'idle' | 'notMounted' | 'loading' | 'unavailable' | 'ready';

/** What the source needs from `IGitService`: it only reads, and only through this call. */
export type IAxisGitReader = Pick<IGitService, 'openRepository'>;

const NO_CHANGES: IAxisChanges = { groups: [], total: 0, outside: 0 };

/**
 * The changes of one worktree, kept current from the observable `state` of the repository
 * that the workbench `IGitService` (the git extension) opens for it. It never runs git and
 * never writes: no git process, index or file is touched from here.
 *
 * A worktree switch while an open is pending drops the late result, so the list never shows
 * one workspace's changes under another's name.
 */
export class AxisChangesSource extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly listener = this._register(new MutableDisposable());
	private generation = 0;
	private _root: URI | undefined;
	private _status: AxisChangesStatus = 'idle';
	private _changes: IAxisChanges = NO_CHANGES;

	/**
	 * @param isMounted whether a folder is inside the window's folders; only those are opened,
	 * so viewing a workspace never makes the git extension prompt about a parent repository.
	 */
	constructor(private readonly git: IAxisGitReader, private readonly isMounted: (root: URI) => boolean) {
		super();
	}

	get root(): URI | undefined { return this._root; }
	get status(): AxisChangesStatus { return this._status; }
	get changes(): IAxisChanges { return this._changes; }

	/** Shows a worktree's changes; `undefined` clears. The same root again does nothing. */
	setRoot(folder: URI | undefined): Promise<void> {
		const root = folder && extUri.removeTrailingPathSeparator(folder);
		if (root && this._root && extUri.isEqual(root, this._root) && (this._status === 'loading' || this._status === 'ready')) {
			return Promise.resolve();
		}
		return this.open(root);
	}

	/** Opens the current worktree again (after `unavailable` or `notMounted`). */
	refresh(): Promise<void> {
		return this.open(this._root);
	}

	private async open(root: URI | undefined): Promise<void> {
		const generation = ++this.generation;
		this.listener.clear();
		this._root = root;
		if (!root || !this.isMounted(root)) {
			this.set(root ? 'notMounted' : 'idle', NO_CHANGES);
			return;
		}
		this.set('loading', NO_CHANGES);
		let repository;
		try {
			repository = await this.git.openRepository(root);
		} catch {
			repository = undefined;
		}
		if (generation !== this.generation || this._store.isDisposed) {
			return;
		}
		if (!repository || !extUri.isEqual(repository.rootUri, root)) {
			this.set('unavailable', NO_CHANGES);
			return;
		}
		this.listener.value = autorun(reader => this.set('ready', readChanges(repository.state.read(reader), root)));
	}

	private set(status: AxisChangesStatus, changes: IAxisChanges): void {
		this._status = status;
		this._changes = changes;
		this._onDidChange.fire();
	}
}
