/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { GitChange, GitRepositoryState, IGitRepository } from '../../../../../workbench/contrib/git/common/gitService.js';
import { IAxisGitReader } from '../../common/axisChangesSource.js';

export const ROOT = URI.file('/w/ws-a');

export function file(path: string, root = ROOT): URI {
	return URI.joinPath(root, path);
}

/** A change as the git extension delegate reports it (`extHostGitExtensionService.ts` `toGitChangeDto`). */
export const change = {
	modified: (path: string): GitChange => ({ uri: file(path), originalUri: file(path), modifiedUri: file(path) }),
	added: (path: string, root = ROOT): GitChange => ({ uri: file(path, root), originalUri: undefined, modifiedUri: file(path, root) }),
	deleted: (path: string): GitChange => ({ uri: file(path), originalUri: file(path), modifiedUri: undefined }),
	renamed: (from: string, to: string): GitChange => ({ uri: file(from), originalUri: file(from), modifiedUri: file(to) }),
	raw: (uri: URI, originalUri: URI | undefined, modifiedUri: URI | undefined): GitChange => ({ uri, originalUri, modifiedUri }),
};

export function state(parts: Partial<GitRepositoryState> = {}): GitRepositoryState {
	return { remotes: [], mergeChanges: [], indexChanges: [], workingTreeChanges: [], untrackedChanges: [], ...parts };
}

/** A repository whose state the test sets. Any method that is not a read records a call. */
export class FakeRepository implements IGitRepository {
	readonly state: ISettableObservable<GitRepositoryState>;
	readonly writes: string[] = [];

	constructor(readonly rootUri: URI, initial: GitRepositoryState = state()) {
		this.state = observableValue('fakeGitState', initial);
	}

	updateState(next: GitRepositoryState): void { this.writes.push('updateState'); this.state.set(next, undefined); }
	set(next: GitRepositoryState): void { this.state.set(next, undefined); }
	getRefs(): Promise<never> { this.writes.push('getRefs'); return Promise.reject(new Error('not a Changes view call')); }
	diffBetweenWithStats(): Promise<never> { this.writes.push('diffBetweenWithStats'); return Promise.reject(new Error('not a Changes view call')); }
	diffBetweenWithStats2(): Promise<never> { this.writes.push('diffBetweenWithStats2'); return Promise.reject(new Error('not a Changes view call')); }
	commitFiles(): Promise<never> { this.writes.push('commitFiles'); return Promise.reject(new Error('not a Changes view call')); }
}

/** A fake `IGitService` whose `openRepository` answers are settled by the test. */
export class FakeGitService implements IAxisGitReader {
	readonly opened: string[] = [];
	private readonly pending: { uri: URI; resolve: (repo: IGitRepository | undefined) => void; reject: (err: Error) => void }[] = [];

	openRepository(uri: URI): Promise<IGitRepository | undefined> {
		this.opened.push(uri.path);
		return new Promise((resolve, reject) => this.pending.push({ uri, resolve, reject }));
	}

	/** Settles the oldest pending open, or the newest with `newest`. */
	answer(repo: IGitRepository | undefined | Error, newest = false): Promise<void> {
		const next = newest ? this.pending.pop() : this.pending.shift();
		if (!next) {
			throw new Error('no pending openRepository');
		}
		if (repo instanceof Error) {
			next.reject(repo);
		} else {
			next.resolve(repo);
		}
		return flush();
	}
}

/** Lets awaited promises run. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}
