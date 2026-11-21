/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ITextEditorOptions, ITextEditorSelection, ITextResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { IResourceDiffEditorInput, IResourceMultiDiffEditorInput, IUntitledTextResourceEditorInput } from '../../../../workbench/common/editor.js';

/** A file at a location (docs/design/axis-agent-shell.md section 3.4, `kind: file`). */
export interface IAxisRevealFile {
	readonly kind?: 'file';
	readonly resource: URI;
	readonly selection?: ITextEditorSelection;
}

/** Two sides of one change; a missing side is a file that does not exist there. */
export interface IAxisDiffSides {
	readonly original: URI | undefined;
	readonly modified: URI | undefined;
}

/** One file's diff, opened at its first change (`kind: diff`). */
export interface IAxisRevealDiff extends IAxisDiffSides {
	readonly kind: 'diff';
	readonly label: string;
}

export interface IAxisMultiDiffItem extends IAxisDiffSides {
	/** The worktree file the multi-diff's "open file" action goes to. */
	readonly resource: URI;
}

/** Several diffs in one multi-diff editor (`kind: multiDiff`, "Review all"). */
export interface IAxisRevealMultiDiff {
	readonly kind: 'multiDiff';
	readonly label: string;
	readonly items: readonly IAxisMultiDiffItem[];
}

/** A location to open in the IDE view. */
export type IAxisRevealTarget = IAxisRevealFile | IAxisRevealDiff | IAxisRevealMultiDiff;

type IAxisEditorInput = ITextResourceEditorInput | IResourceDiffEditorInput | IResourceMultiDiffEditorInput;

const FIRST_LINE: ITextEditorSelection = { startLineNumber: 1, startColumn: 1 };

/** Every reveal pins its editor and reuses one that is already open. */
function options(selection?: ITextEditorSelection): ITextEditorOptions {
	return selection ? { selection, revealIfOpened: true, pinned: true } : { revealIfOpened: true, pinned: true };
}

function side(resource: URI | undefined): Omit<ITextResourceEditorInput, 'options'> | Omit<IUntitledTextResourceEditorInput, 'options'> {
	return { resource };
}

/**
 * The untyped editor input `IEditorService.openEditor` gets for a reveal target, or
 * `undefined` when there is nothing to open.
 *
 * - A diff with both sides opens the diff editor without a selection, so it reveals the
 *   first change (`TextDiffEditor` calls `revealFirstDiff` when no option applies).
 * - A diff with one side (an added, untracked or deleted file) opens that side at line 1.
 * - A multi-diff lists every item that has a side and is transient (not restored on reload,
 *   since the change list it shows will be out of date).
 */
export function editorInputForReveal(target: IAxisRevealTarget): IAxisEditorInput | undefined {
	switch (target.kind) {
		case undefined:
		case 'file':
			return { resource: target.resource, options: options(target.selection) };
		case 'diff':
			if (target.original && target.modified) {
				return { original: { resource: target.original }, modified: { resource: target.modified }, label: target.label, options: options() };
			}
			if (target.original || target.modified) {
				return { resource: (target.modified ?? target.original)!, label: target.label, options: options(FIRST_LINE) };
			}
			return undefined;
		case 'multiDiff': {
			const resources = target.items
				.filter(item => item.original || item.modified)
				.map(item => ({ original: side(item.original), modified: side(item.modified), goToFileResource: item.resource }));
			return resources.length ? { resources, label: target.label, isTransient: true, options: options() } : undefined;
		}
	}
}
