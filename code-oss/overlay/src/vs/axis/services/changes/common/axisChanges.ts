/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { GitChange, GitRepositoryState } from '../../../../workbench/contrib/git/common/gitService.js';
import { cleanDisplayText } from '../../workspaces/common/worktreeDiscovery.js';

/**
 * The Changes view model (docs/design/axis-agent-shell.md section 4.3, task A5): the
 * `IGitService` state of one worktree as display rows. Pure: no DOM, no service, no git
 * call. Everything a row shows is computed here as plain text, so the view only sets
 * `textContent`, and every name passes `cleanDisplayText`.
 */

/** The groups, in display order: what needs the user first. */
export const CHANGE_GROUPS = ['conflicts', 'staged', 'unstaged', 'untracked'] as const;
export type AxisChangeGroupId = typeof CHANGE_GROUPS[number];

export type AxisChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

/** Most rows built per group; the rest are counted (`IAxisChangeGroup.total`). */
export const MAX_CHANGE_ROWS = 500;
/** Longest file name shown, in code points. */
export const MAX_CHANGE_NAME = 120;
/** Longest folder or previous path shown, in code points. */
export const MAX_CHANGE_FOLDER = 240;

/** The git extension's content scheme: `git:<path>?{"path","ref"}`, read through its existing provider. */
export const GIT_SCHEME = 'git';
/** The `ref` the git extension reads for the index (stage 0). */
export const INDEX_REF = '~';
/** The `ref` the git extension reads for the staged blob of a file (the right side of a staged diff). */
export const STAGED_REF = '';

export interface IAxisChangeRow {
	/** Unique in one listing: the group and the file. */
	readonly id: string;
	readonly group: AxisChangeGroupId;
	readonly kind: AxisChangeKind;
	/** The file name, cleaned and clamped. */
	readonly name: string;
	/** The folder relative to the worktree root ('' at the root), cleaned and clamped. */
	readonly folder: string;
	/** For a rename, the previous path relative to the root, cleaned and clamped. */
	readonly previousPath: string | undefined;
	/** The file in the worktree. */
	readonly resource: URI;
	/** The left side of the diff, or `undefined` when the file did not exist there. */
	readonly original: URI | undefined;
	/** The right side of the diff, or `undefined` when the file is gone there. */
	readonly modified: URI | undefined;
}

export interface IAxisChangeGroup {
	readonly id: AxisChangeGroupId;
	/** At most `MAX_CHANGE_ROWS`, in path order. */
	readonly rows: readonly IAxisChangeRow[];
	/** Every change git reported in this group, also those not built. */
	readonly total: number;
}

export interface IAxisChanges {
	/** Only groups that have changes, in `CHANGE_GROUPS` order. */
	readonly groups: readonly IAxisChangeGroup[];
	/** Changes across every group. */
	readonly total: number;
	/** Changes dropped because a path was not inside the worktree root. */
	readonly outside: number;
}

/** The git extension's URI for `uri` at `ref` (`extensions/git/src/uri.ts` `toGitUri`). */
export function toGitUri(uri: URI, ref: string): URI {
	return uri.with({ scheme: GIT_SCHEME, path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) });
}

/** True when `uri` is absent, or a `file:` URI strictly inside `root` (`isEqualOrParent` normalizes `.` and `..`). */
function inside(root: URI, uri: URI | undefined): boolean {
	return uri === undefined || (uri.scheme === Schemas.file && extUri.isEqualOrParent(uri, root) && !extUri.isEqual(uri, root));
}

function kindOf(group: AxisChangeGroupId, change: GitChange): AxisChangeKind {
	if (group === 'conflicts') {
		return 'conflict';
	}
	if (group === 'untracked') {
		return 'untracked';
	}
	if (!change.originalUri) {
		return 'added';
	}
	if (!change.modifiedUri) {
		return 'deleted';
	}
	return extUri.isEqual(change.originalUri, change.modifiedUri) ? 'modified' : 'renamed';
}

/**
 * The two sides of a change, as the SCM view shows them (`extensions/git/src/repository.ts`
 * `getLeftResource`/`getRightResource`): staged is HEAD against the index, unstaged is the
 * index against the file, untracked and conflicts are the file alone.
 */
function sidesOf(group: AxisChangeGroupId, change: GitChange): { original: URI | undefined; modified: URI | undefined } {
	switch (group) {
		case 'staged':
			return {
				original: change.originalUri && toGitUri(change.originalUri, 'HEAD'),
				modified: change.modifiedUri && toGitUri(change.modifiedUri, STAGED_REF),
			};
		case 'unstaged':
			return {
				original: change.originalUri && toGitUri(change.originalUri, INDEX_REF),
				modified: change.modifiedUri,
			};
		default:
			return { original: undefined, modified: change.uri };
	}
}

function relative(root: URI, uri: URI): string {
	return extUri.relativePath(root, uri) ?? '';
}

function rowOf(root: URI, group: AxisChangeGroupId, change: GitChange): IAxisChangeRow {
	const kind = kindOf(group, change);
	const resource = change.modifiedUri ?? change.uri;
	const path = relative(root, resource);
	const slash = path.lastIndexOf('/');
	const { original, modified } = sidesOf(group, change);
	return {
		id: `${group}:${resource.toString()}`,
		group,
		kind,
		name: cleanDisplayText(path.slice(slash + 1), MAX_CHANGE_NAME),
		folder: cleanDisplayText(slash < 0 ? '' : path.slice(0, slash), MAX_CHANGE_FOLDER),
		previousPath: kind === 'renamed' && change.originalUri ? cleanDisplayText(relative(root, change.originalUri), MAX_CHANGE_FOLDER) : undefined,
		resource,
		original,
		modified,
	};
}

function listOf(state: GitRepositoryState, group: AxisChangeGroupId): readonly GitChange[] {
	switch (group) {
		case 'conflicts': return state.mergeChanges;
		case 'staged': return state.indexChanges;
		case 'unstaged': return state.workingTreeChanges;
		case 'untracked': return state.untrackedChanges;
	}
}

/**
 * The rows for one worktree. A change with any path outside `root`, or not a `file:` URI,
 * is dropped and counted in `outside`: the view never builds a diff for a file it was not
 * asked about.
 */
export function readChanges(state: GitRepositoryState | undefined, root: URI): IAxisChanges {
	const groups: IAxisChangeGroup[] = [];
	let total = 0;
	let outside = 0;
	for (const id of CHANGE_GROUPS) {
		const list = state ? listOf(state, id) ?? [] : [];
		const kept = list.filter(change => inside(root, change.uri) && inside(root, change.originalUri) && inside(root, change.modifiedUri));
		outside += list.length - kept.length;
		if (!kept.length) {
			continue;
		}
		total += kept.length;
		const sorted = kept.map(change => ({ change, path: (change.modifiedUri ?? change.uri).path })).sort((a, b) => cmp(a.path, b.path));
		const rows = sorted.slice(0, MAX_CHANGE_ROWS).map(({ change }) => rowOf(root, id, change));
		groups.push({ id, rows, total: kept.length });
	}
	return { groups, total, outside };
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Every row in display order, the order keyboard navigation follows. */
export function flatRows(changes: IAxisChanges): IAxisChangeRow[] {
	return changes.groups.flatMap(group => group.rows);
}

/** The short state word shown on a row, before its name. Never derived from a file name. */
export function changeKindLabel(kind: AxisChangeKind): string {
	switch (kind) {
		case 'modified': return localize('axis.changes.kind.modified', "Modified");
		case 'added': return localize('axis.changes.kind.added', "Added");
		case 'deleted': return localize('axis.changes.kind.deleted', "Deleted");
		case 'renamed': return localize('axis.changes.kind.renamed', "Renamed");
		case 'untracked': return localize('axis.changes.kind.untracked', "Untracked");
		case 'conflict': return localize('axis.changes.kind.conflict', "Conflict");
	}
}

/** The one-letter glyph shown with the state word (the SCM view's letters). */
export function changeKindGlyph(kind: AxisChangeKind): string {
	switch (kind) {
		case 'modified': return 'M';
		case 'added': return 'A';
		case 'deleted': return 'D';
		case 'renamed': return 'R';
		case 'untracked': return 'U';
		case 'conflict': return '!';
	}
}

export function changeGroupLabel(group: AxisChangeGroupId): string {
	switch (group) {
		case 'conflicts': return localize('axis.changes.group.conflicts', "Conflicts");
		case 'staged': return localize('axis.changes.group.staged', "Staged");
		case 'unstaged': return localize('axis.changes.group.unstaged', "Not staged");
		case 'untracked': return localize('axis.changes.group.untracked', "Untracked");
	}
}

/**
 * The accessible name of a row. The state and group come first and are fixed text, so a
 * file name, which comes last, cannot pose as another state.
 */
export function changeRowLabel(row: IAxisChangeRow): string {
	const where = row.folder
		? localize('axis.changes.row.in', "in {0}", row.folder)
		: localize('axis.changes.row.root', "at the worktree root");
	const from = row.previousPath ? localize('axis.changes.row.from', ", renamed from {0}", row.previousPath) : '';
	return localize('axis.changes.row', "{0}, {1}: {2}, {3}{4}", changeKindLabel(row.kind), changeGroupLabel(row.group), row.name, where, from);
}

/** The summary line above the list, e.g. "3 files: Staged 1, Not staged 2". */
export function changesSummary(changes: IAxisChanges): string {
	if (!changes.total) {
		return localize('axis.changes.none', "No changes in this worktree.");
	}
	const parts = changes.groups.map(group => localize('axis.changes.count', "{0} {1}", changeGroupLabel(group.id), group.total));
	return changes.total === 1
		? localize('axis.changes.summaryOne', "1 file: {0}", parts.join(', '))
		: localize('axis.changes.summary', "{0} files: {1}", changes.total, parts.join(', '));
}
