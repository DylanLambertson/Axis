/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { extUri as exactUri, extUriBiasedIgnorePathCase as extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { GitChange, GitRepositoryState } from '../../../../workbench/contrib/git/common/gitService.js';
import { IAxisRevealDiff, IAxisRevealMultiDiff } from '../../view/common/axisRevealInput.js';
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
	/** Changes across every group (a file staged and changed again counts twice). */
	readonly total: number;
	/** Distinct files across every group. */
	readonly files: number;
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
	return exactUri.isEqual(change.originalUri, change.modifiedUri) ? 'modified' : 'renamed'; // a case-only rename is a rename
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
	const files = new Set<string>();
	for (const id of CHANGE_GROUPS) {
		const list = state ? listOf(state, id) ?? [] : [];
		const kept = list.filter(change => inside(root, change.uri) && inside(root, change.originalUri) && inside(root, change.modifiedUri));
		outside += list.length - kept.length;
		if (!kept.length) {
			continue;
		}
		total += kept.length;
		kept.forEach(change => files.add(extUri.getComparisonKey(change.modifiedUri ?? change.uri)));
		const sorted = kept.map(change => ({ change, path: (change.modifiedUri ?? change.uri).path })).sort((a, b) => cmp(a.path, b.path));
		const rows = sorted.slice(0, MAX_CHANGE_ROWS).map(({ change }) => rowOf(root, id, change));
		groups.push({ id, rows, total: kept.length });
	}
	return { groups, total, files: files.size, outside };
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

/** The summary line above the list, e.g. "3 files: Staged 1, Not staged 2" (a file in two groups is one file). */
export function changesSummary(changes: IAxisChanges): string {
	if (!changes.total) {
		return localize('axis.changes.none', "No changes in this worktree.");
	}
	const parts = changes.groups.map(group => localize('axis.changes.count', "{0} {1}", changeGroupLabel(group.id), group.total));
	return changes.files === 1
		? localize('axis.changes.summaryOne', "1 file: {0}", parts.join(', '))
		: localize('axis.changes.summary', "{0} files: {1}", changes.files, parts.join(', '));
}

/** The editor tab title of a row's diff: the cleaned name and the fixed group text, never a raw path. */
export function diffLabelOf(row: IAxisChangeRow): string {
	return localize('axis.changes.diffLabel', "{0} ({1})", row.name, changeGroupLabel(row.group));
}

/** What a row opens: its own two sides, titled by `diffLabelOf`. */
export function diffTargetOf(row: IAxisChangeRow): IAxisRevealDiff {
	return { kind: 'diff', original: row.original, modified: row.modified, label: diffLabelOf(row) };
}

/** What "Review all" opens: every listed row's sides, each going to its worktree file. */
export function reviewAllTargetOf(rows: readonly IAxisChangeRow[], workspaceLabel: string): IAxisRevealMultiDiff {
	return {
		kind: 'multiDiff',
		label: localize('axis.changes.allLabel', "Changes in {0}", cleanDisplayText(workspaceLabel, MAX_CHANGE_NAME)),
		items: rows.map(row => ({ original: row.original, modified: row.modified, resource: row.resource })),
	};
}

/**
 * The row to keep active after the list changed: the same file (by id) if it is still listed,
 * otherwise the row now at the old position (clamped), or -1 for an empty list.
 */
export function nextActiveIndex(rows: readonly IAxisChangeRow[], activeId: string | undefined, activeIndex: number): number {
	const kept = activeId === undefined ? -1 : rows.findIndex(row => row.id === activeId);
	return kept >= 0 ? kept : Math.min(Math.max(activeIndex, 0), rows.length - 1);
}

/** Where keyboard focus was in the Changes view before it was redrawn. */
export type AxisChangesFocusBefore = 'row' | 'control' | 'outside';

/** What the view focuses after a redraw: nothing (focus stays), the active row, or the always-visible heading. */
export type AxisChangesFocusAfter = 'stay' | 'row' | 'heading';

/**
 * The focus rule of the Changes view after the list is redrawn by a git update:
 * - focus outside the view is never taken;
 * - focus on another control (Review all, Try again) stays there; it moves to the heading only
 *   if that control was hidden or removed by the update, never to a row;
 * - focus on a row stays on a row (the same file, else the one now in its place), or goes to
 *   the heading when the list emptied;
 * so focus is never stolen and never falls to the page body.
 */
export function focusAfterUpdate(before: AxisChangesFocusBefore, stillInside: boolean, hasRows: boolean): AxisChangesFocusAfter {
	switch (before) {
		case 'outside': return 'stay';
		case 'control': return stillInside ? 'stay' : 'heading';
		case 'row': return hasRows ? 'row' : 'heading';
	}
}
