/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../nls.js';

/**
 * Spike PV-V0 (docs/design/pv-v0-editor-embed.md): the pure rules of the side-panel editor, kept free of the DOM so
 * that they are unit tested. The widget itself is `browser/axisSidePanelEditor.ts`.
 */

/** Context key bound on the side-panel editor's container: true for any key event whose target is inside it. */
export const AXIS_SIDE_PANEL_EDITOR_FOCUS = 'axisSidePanelEditorFocus';

/** Commands Axis binds while that key is true, so a workbench command never acts on the hidden IDE editor instead. */
export const AxisSidePanelCommand = {
	save: 'axis.sidePanel.editor.save',
	saveWithoutFormatting: 'axis.sidePanel.editor.saveWithoutFormatting',
	openInIde: 'axis.sidePanel.editor.openInIde',
	close: 'axis.sidePanel.editor.close',
	leave: 'axis.sidePanel.editor.leave',
} as const;
export type AxisSidePanelCommandId = typeof AxisSidePanelCommand[keyof typeof AxisSidePanelCommand];

/**
 * Weights, compared with upstream `KeybindingWeight` (EditorCore 0, EditorContrib 100, WorkbenchContrib 200).
 * A routed key must beat the workbench command it replaces (WorkbenchContrib, `when` undefined); Escape must lose to
 * every editor binding (find widget, suggest, hover, extra cursors, selection), so it only fires when none applies.
 */
export const AXIS_SIDE_PANEL_ROUTE_WEIGHT = 201;
export const AXIS_SIDE_PANEL_LEAVE_WEIGHT = -1;

/**
 * Keys that upstream binds, with `when` undefined, to a workbench command acting on the editor part's active editor
 * (file:line of the pinned source), and the Axis command that replaces each while focus is in the side-panel editor.
 */
export interface IAxisRoutedKey {
	readonly upstreamCommand: string;
	readonly upstreamSource: string;
	readonly route: AxisSidePanelCommandId;
	readonly primary: number;
	readonly win?: { readonly primary: number; readonly secondary?: number[] };
}

export const AXIS_SIDE_PANEL_ROUTED_KEYS: readonly IAxisRoutedKey[] = [
	{ upstreamCommand: 'workbench.action.files.save', upstreamSource: 'contrib/files/browser/fileCommands.ts:501', route: AxisSidePanelCommand.save, primary: KeyMod.CtrlCmd | KeyCode.KeyS },
	{
		upstreamCommand: 'workbench.action.files.saveWithoutFormatting', upstreamSource: 'contrib/files/browser/fileCommands.ts:511', route: AxisSidePanelCommand.saveWithoutFormatting,
		primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyS), win: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS) }
	},
	{ upstreamCommand: 'workbench.action.files.saveAs', upstreamSource: 'contrib/files/browser/fileCommands.ts:522', route: AxisSidePanelCommand.openInIde, primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS },
	{
		upstreamCommand: 'workbench.action.closeActiveEditor', upstreamSource: 'browser/parts/editor/editorCommands.ts:835', route: AxisSidePanelCommand.close,
		primary: KeyMod.CtrlCmd | KeyCode.KeyW, win: { primary: KeyMod.CtrlCmd | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyCode.KeyW] }
	},
	{ upstreamCommand: 'workbench.action.splitEditor', upstreamSource: 'browser/parts/editor/editorActions.ts:81', route: AxisSidePanelCommand.openInIde, primary: KeyMod.CtrlCmd | KeyCode.Backslash },
];

export interface IAxisSidePanelEditorInput {
	/** Whether the file's repository is trusted (ADR 0004 decision 12); untrusted means read-only. */
	readonly trusted: boolean;
	/** The file name shown to screen readers; cleaned by the caller. */
	readonly label: string;
}

/** Options Axis always sets, whatever the user's `editor.*` settings say. */
export function forcedSidePanelOptions(input: IAxisSidePanelEditorInput): IEditorOptions {
	return {
		readOnly: !input.trusted,
		domReadOnly: !input.trusted,
		readOnlyMessage: input.trusted ? undefined : { value: localize('axis.sidePanel.editor.restricted', "Restricted Mode: trust this repository in IDE view to edit.") },
		// The EditContext input (the Chromium default) sets no aria-readonly, so the label says it (spike finding F7).
		ariaLabel: input.trusted
			? localize('axis.sidePanel.editor.aria', "{0}, side panel editor", input.label)
			: localize('axis.sidePanel.editor.ariaReadOnly', "{0}, side panel editor, read-only (Restricted Mode)", input.label),
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
 * typed there must never reach a card even if a future layout nests an editor inside one.
 */
export function approvalShortcutAllowed(event: IAxisKeyGesture, scope: IAxisKeyScope, isMacintosh: boolean): boolean {
	return event.isTrusted === true
		&& event.repeat === false
		&& isApprovalChord(event, isMacintosh)
		&& scope.card.contains(event.target)
		&& scope.card.contains(scope.activeElement)
		&& !scope.isInComposer(scope.activeElement)
		&& !scope.isInEditor(scope.activeElement)
		&& !scope.isInEditor(event.target);
}
