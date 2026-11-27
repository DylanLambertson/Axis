// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (contrib/sidePanel/common/axisSidePanelEditor.ts, the approval-shortcut gate) by OS-5,
// with the keycaps and spoken name the decision card's shortcut badge shows (OS-11).

import { localize } from '../base/nls.js';

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
	/** True for a node inside the composer or any other input an agent's text reaches. */
	isInComposer(node: unknown): boolean;
	/** True for a node inside any code editor widget, embedded or not. */
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
 * composer and never from a code editor: an editor binds `Mod+Enter` to its own command, and a key typed there must
 * never reach a card even if a layout nests an editor inside one. IME composition is refused.
 *
 * This is the DOM gate only and is NOT sufficient on its own: a key that passes it must go through the same answer
 * path as a click (the shown digest, the guard time counted from when the card last changed or the focus entered it,
 * expiry, in flight and settled). `isInEditor` and `isInComposer` must walk `event.composedPath()`, because
 * `closest()` stops at a shadow root.
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

/** The keycaps of the shortcut badge, in order: the platform's modifier, then Enter. */
export function approvalShortcutKeys(isMacintosh: boolean): readonly string[] {
	return isMacintosh ? ['⌘', '↩'] : ['Ctrl', 'Enter'];
}

/** The badge's accessible name (`aria-keyshortcuts` takes `approvalShortcutAria`): the keys spelled out. */
export function approvalShortcutLabel(isMacintosh: boolean): string {
	return isMacintosh
		? localize('axis.approval.shortcut.mac', "Command+Return")
		: localize('axis.approval.shortcut', "Control+Enter");
}

/** The `aria-keyshortcuts` value of the card's default answer. */
export function approvalShortcutAria(isMacintosh: boolean): string {
	return isMacintosh ? 'Meta+Enter' : 'Control+Enter';
}
