// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/changes/common/axisChanges.ts: nextActiveIndex, focusAfterUpdate) by OS-5.
// The rest of that model reads the Code OSS git extension's staged and unstaged groups; the own shell's Changes view
// reads `axis.review/1` instead (one list against HEAD), so only the rules that hold for any redrawn list are here.

/**
 * The row to keep active after the list changed: the same row (by id) if it is still listed, otherwise the row now at
 * the old position (clamped), or -1 for an empty list.
 */
export function nextActiveIndex(rows: readonly { readonly id: string }[], activeId: string | undefined, activeIndex: number): number {
	const kept = activeId === undefined ? -1 : rows.findIndex(row => row.id === activeId);
	return kept >= 0 ? kept : Math.min(Math.max(activeIndex, 0), rows.length - 1);
}

/** Where keyboard focus was in a list view before it was redrawn. */
export type AxisListFocusBefore = 'row' | 'control' | 'outside';

/** What the view focuses after a redraw: nothing (focus stays), the active row, or the always-visible heading. */
export type AxisListFocusAfter = 'stay' | 'row' | 'heading';

/**
 * The focus rule of a list view after an update redraws it:
 * - focus outside the view is never taken;
 * - focus on another control (Review all, Try again) stays there; it moves to the heading only if that control was
 *   hidden or removed by the update, never to a row;
 * - focus on a row stays on a row (the same one, else the one now in its place), or goes to the heading when the list
 *   emptied;
 * so focus is never stolen and never falls to the page body.
 */
export function focusAfterUpdate(before: AxisListFocusBefore, stillInside: boolean, hasRows: boolean): AxisListFocusAfter {
	switch (before) {
		case 'outside': return 'stay';
		case 'control': return stillInside ? 'stay' : 'heading';
		case 'row': return hasRows ? 'row' : 'heading';
	}
}
