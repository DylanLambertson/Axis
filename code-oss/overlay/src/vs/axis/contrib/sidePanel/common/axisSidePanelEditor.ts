/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../nls.js';
import { cleanDisplayText } from '../../../services/workspaces/common/worktreeDiscovery.js';

/**
 * Spike PV-V0 (docs/design/pv-v0-editor-embed.md): the pure rules of the side-panel editor, kept free of the DOM so
 * that they are unit tested. The widget itself is `browser/axisSidePanelEditor.ts`.
 */

/** Context key bound on the side-panel editor's container: true for any key event whose target is inside it. */
export const AXIS_SIDE_PANEL_EDITOR_FOCUS = 'axisSidePanelEditorFocus';

/** The leave command, bound to Escape while that key is true. */
export const AXIS_SIDE_PANEL_LEAVE_COMMAND = 'axis.sidePanel.editor.leave';

/**
 * Escape's weight, compared with upstream `KeybindingWeight` (EditorCore 0, EditorContrib 100): below every editor
 * binding (find widget, suggest, hover, extra cursors, selection), so it fires only when none of them applies.
 */
export const AXIS_SIDE_PANEL_LEAVE_WEIGHT = -1;

/**
 * What a guarded workbench command does while a side-panel editor has focus (review S1). Upstream commands that act
 * on the editor part's active editor would act on the IDE editor hidden behind Agent view; Axis re-registers each
 * listed command id (the latest registration wins, `commands.ts:109`) with a guard that applies this action when the
 * focused code editor is a side-panel editor and the command got no explicit arguments, and runs the original
 * handler otherwise. Guarding the command, not a key, covers every key, chord, platform keymap, user keybinding and
 * the command's menus at once.
 *
 * - `save`, `saveWithoutFormatting`: save this file through the host (never the IDE's active editor);
 * - `close`: close the side-panel editor and return the focus;
 * - `openInIde`: hand off to IDE view at this file and selection, where the user runs the command;
 * - `block`: editor-group and tab commands, which mean nothing here; nothing happens and the host says so;
 * - `saveAllToo`: run the original (it saves only editors in groups) and also save every dirty side-panel file;
 * - `accept`: the command is right as it is (it acts on the focused code editor, or on no editor).
 */
export type AxisSidePanelAction = 'save' | 'saveWithoutFormatting' | 'close' | 'openInIde' | 'block' | 'saveAllToo' | 'accept';

const OPEN_IN_IDE = [
	'workbench.action.files.saveAs', 'workbench.action.files.revert', 'workbench.action.editor.changeLanguageMode',
	'workbench.files.action.compareWithSaved', 'workbench.files.action.compareWithClipboard',
	'copyFilePath', 'copyRelativeFilePath', 'workbench.action.files.copyPathOfActiveFile',
	'workbench.action.splitEditor', 'workbench.action.splitEditorDown', 'workbench.action.splitEditorLeft', 'workbench.action.splitEditorOrthogonal',
	'workbench.action.splitEditorRight', 'workbench.action.splitEditorUp', 'workbench.action.copyEditorToNewWindow',
	'editor.action.nextCommentThreadAction', 'editor.action.previousCommentThreadAction', 'editor.debug.action.toggleInlineBreakpoint',
	'testing.coverageAtCursor', 'testing.coverageCurrentFile', 'testing.debugAtCursor', 'testing.debugCurrentFile', 'testing.runAtCursor', 'testing.runCurrentFile',
];
const BLOCK = [
	'workbench.action.closeEditorsInGroup', 'workbench.action.closeUnmodifiedEditors', 'workbench.action.keepEditor', 'workbench.action.pinEditor',
	'workbench.action.focusAboveGroup', 'workbench.action.focusBelowGroup', 'workbench.action.focusLeftGroup', 'workbench.action.focusRightGroup', 'workbench.action.focusFirstEditorGroup',
	'workbench.action.lastEditorInGroup', 'workbench.action.nextEditor', 'workbench.action.previousEditor', 'workbench.action.nextEditorInGroup', 'workbench.action.previousEditorInGroup',
	'workbench.action.moveActiveEditorGroupDown', 'workbench.action.moveActiveEditorGroupLeft', 'workbench.action.moveActiveEditorGroupRight', 'workbench.action.moveActiveEditorGroupUp',
	'workbench.action.moveEditorLeftInGroup', 'workbench.action.moveEditorRightInGroup', 'workbench.action.moveEditorToFirstGroup', 'workbench.action.moveEditorToLastGroup',
	'workbench.action.moveEditorToNextGroup', 'workbench.action.moveEditorToPreviousGroup', 'workbench.action.toggleEditorGroupLayout',
	...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `workbench.action.openEditorAtIndex${n}`),
];
const ACCEPT = [
	'editor.action.selectAll', 'undo', 'redo', // read the focused code editor first: the side-panel editor
	'workbench.action.focusNextPart', 'workbench.action.focusPreviousPart', // replaced by the Axis part cycle (axis.action.focusNextPart)
	'breadcrumbs.toggleToOn', 'workbench.action.files.openFolderViaWorkspace', 'workbench.action.findInFiles', 'workbench.action.selectTheme',
];

/**
 * The policy for every default-keybinding command at the pin that can fire in the side-panel editor and reads the
 * active editor or delegates (prototypes/pv-v0-editor-embed/scan-keys.mjs), plus Save All (no Linux key). The scan
 * fails on a flagged command missing here, so an upstream sync cannot add an unguarded one silently.
 */
export const AXIS_SIDE_PANEL_COMMAND_POLICY: ReadonlyMap<string, AxisSidePanelAction> = new Map<string, AxisSidePanelAction>([
	['workbench.action.files.save', 'save'],
	['workbench.action.files.saveWithoutFormatting', 'saveWithoutFormatting'],
	['workbench.action.files.saveAll', 'saveAllToo'],
	['workbench.action.closeActiveEditor', 'close'],
	...OPEN_IN_IDE.map(id => [id, 'openInIde'] as const),
	...BLOCK.map(id => [id, 'block'] as const),
	...ACCEPT.map(id => [id, 'accept'] as const),
]);

/** Flagged commands the policy does not classify; the scan's gate. */
export function unclassifiedCommands(flagged: readonly string[]): string[] {
	return [...new Set(flagged)].filter(id => !AXIS_SIDE_PANEL_COMMAND_POLICY.has(id)).sort();
}

/**
 * What a guarded command does now: its action when the focused code editor is a side-panel editor and the command
 * was given no explicit arguments (a tab or Explorer context menu passes its own target), and `undefined` (run the
 * original handler) otherwise. `saveAllToo` applies whatever has the focus.
 */
export function guardDecision(action: AxisSidePanelAction, sidePanelFocused: boolean, argumentCount: number): AxisSidePanelAction | undefined {
	if (action === 'accept') {
		return undefined;
	}
	if (action === 'saveAllToo') {
		return action;
	}
	return sidePanelFocused && argumentCount === 0 ? action : undefined;
}

export interface IAxisSidePanelEditorInput {
	/** Whether the file's repository is trusted (ADR 0004 decision 12); untrusted means read-only. */
	readonly trusted: boolean;
	/** The file name; cleaned here (bidi, invisible and control characters) before it is spoken or shown. */
	readonly label: string;
}

/** Longest file label spoken, in code points. */
export const MAX_LABEL = 120;

/** Options Axis always sets, whatever the user's `editor.*` settings say. */
export function forcedSidePanelOptions(input: IAxisSidePanelEditorInput): IEditorOptions {
	return {
		readOnly: !input.trusted,
		domReadOnly: !input.trusted,
		readOnlyMessage: input.trusted ? undefined : { value: localize('axis.sidePanel.editor.restricted', "Restricted Mode: trust this repository in IDE view to edit.") },
		// The EditContext input (the Chromium default) sets no aria-readonly, so the label says it (spike finding F7).
		ariaLabel: input.trusted
			? localize('axis.sidePanel.editor.aria', "{0}, side panel editor", cleanDisplayText(input.label, MAX_LABEL))
			: localize('axis.sidePanel.editor.ariaReadOnly', "{0}, side panel editor, read-only (Restricted Mode)", cleanDisplayText(input.label, MAX_LABEL)),
		// Agent-written text is untrusted even in a trusted repository: always show hidden and confusable characters.
		unicodeHighlight: { invisibleCharacters: true, ambiguousCharacters: true },
		renderControlCharacters: true,
		// Quick edits only (product-vision-v2 §3.5 rule 4): no minimap, no glyph margin (no debugger), no sticky scroll.
		minimap: { enabled: false },
		glyphMargin: false,
		stickyScroll: { enabled: false },
		dropIntoEditor: { enabled: false },
		scrollBeyondLastLine: false,
	};
}

/**
 * The options for the widget: the user's resolved `editor.*` configuration for the resource first (a raw
 * `CodeEditorWidget` does not read it), then the forced options, which always win. Nested option objects are merged
 * one level deep so that a forced `unicodeHighlight` field does not drop the user's other `unicodeHighlight` fields.
 */
export function sidePanelEditorOptions(user: Readonly<Record<string, unknown>> | undefined, input: IAxisSidePanelEditorInput): IEditorOptions {
	const forced = forcedSidePanelOptions(input) as Record<string, unknown>;
	const result: Record<string, unknown> = { ...(user ?? {}) };
	for (const [key, value] of Object.entries(forced)) {
		const mine = result[key];
		result[key] = isPlainObject(value) && isPlainObject(mine) ? { ...mine, ...value } : value;
	}
	return result as IEditorOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The part of a DOM `KeyboardEvent` the approval-shortcut gate reads. */
export interface IAxisKeyGesture {
	readonly isTrusted: boolean;
	readonly type: string;
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly repeat: boolean;
	readonly isComposing: boolean;
	readonly target: unknown;
}

/** Where the key event happened, read by the card at the time of the event. */
export interface IAxisKeyScope {
	readonly card: { contains(other: unknown): boolean };
	readonly activeElement: unknown;
	/** True for a node inside the composer or any other agent-facing input. */
	isInComposer(node: unknown): boolean;
	/** True for a node inside any code editor widget (`.monaco-editor`), embedded or not. */
	isInEditor(node: unknown): boolean;
}

/** `Mod+Enter`: Cmd on macOS, Ctrl elsewhere; no other modifier. */
export function isApprovalChord(event: IAxisKeyGesture, isMacintosh: boolean): boolean {
	const mod = isMacintosh ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	return event.type === 'keydown' && event.key === 'Enter' && mod && !event.altKey && !event.shiftKey;
}

/**
 * Whether a key event may answer an approval card (docs/design/ui/directions.md rule 9). It must be a real key press
 * (not script-dispatched, not auto-repeat), on the card itself with the focus inside the card, never from the
 * composer and never from a code editor: the side-panel editor binds `Mod+Enter` to Insert Line Below, and a key
 * typed there must never reach a card even if a future layout nests an editor inside one. IME composition is refused.
 *
 * This is the DOM gate only and is NOT sufficient on its own (review S3): a key that passes it must go through the
 * same `AxisApprovalController` answer path as a click (the shown digest, the guard time counted from when the card
 * last changed or the focus entered it, expiry, in flight and settled). `isInEditor` and `isInComposer` must walk
 * `event.composedPath()`, because `closest()` stops at a shadow root.
 */
export function approvalShortcutAllowed(event: IAxisKeyGesture, scope: IAxisKeyScope, isMacintosh: boolean): boolean {
	return event.isTrusted === true
		&& event.repeat === false
		&& event.isComposing !== true
		&& isApprovalChord(event, isMacintosh)
		&& scope.card.contains(event.target)
		&& scope.card.contains(scope.activeElement)
		&& !scope.isInComposer(scope.activeElement)
		&& !scope.isInEditor(scope.activeElement)
		&& !scope.isInEditor(event.target);
}
