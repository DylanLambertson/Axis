/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AxisViewKind } from '../common/axisView.js';

/** The IDE-view visibility of the parts that the Agent view hides. */
export interface IAxisIdePartsState {
	readonly activityBar: boolean;
	readonly sideBar: boolean;
}

export const DEFAULT_IDE_PARTS_STATE: IAxisIdePartsState = Object.freeze({ activityBar: true, sideBar: true });

/** Visibility of the parts that a view swap changes. */
export interface IAxisPartVisibility {
	readonly agent: boolean;
	readonly editor: boolean;
	readonly activityBar: boolean;
	readonly sideBar: boolean;
}

/**
 * The visibility table of docs/design/axis-agent-shell.md section 3.1 for the
 * Agent and IDE views. The panel and the auxiliary bar keep the user's
 * visibility in both views; their per-view containers come with tasks A4 and A5.
 */
export function axisPartVisibility(view: AxisViewKind, ide: IAxisIdePartsState): IAxisPartVisibility {
	if (view === 'agent') {
		return { agent: true, editor: false, activityBar: false, sideBar: false };
	}
	return { agent: false, editor: true, activityBar: ide.activityBar, sideBar: ide.sideBar };
}

/** Parses the stored IDE parts state, falling back to the defaults for anything malformed. */
export function parseIdePartsState(raw: string | undefined): IAxisIdePartsState {
	if (!raw) {
		return DEFAULT_IDE_PARTS_STATE;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === 'object') {
			const candidate = value as Partial<Record<keyof IAxisIdePartsState, unknown>>;
			return {
				activityBar: typeof candidate.activityBar === 'boolean' ? candidate.activityBar : DEFAULT_IDE_PARTS_STATE.activityBar,
				sideBar: typeof candidate.sideBar === 'boolean' ? candidate.sideBar : DEFAULT_IDE_PARTS_STATE.sideBar,
			};
		}
	} catch {
		// fall through
	}
	return DEFAULT_IDE_PARTS_STATE;
}
