/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IAxisLayoutRequest } from '../common/axisView.js';

/** The IDE-view visibility of the parts that the Agent view hides. */
export interface IAxisIdePartsState {
	readonly activityBar: boolean;
	readonly sideBar: boolean;
}

export const DEFAULT_IDE_PARTS_STATE: IAxisIdePartsState = Object.freeze({ activityBar: true, sideBar: true });

/** Visibility of the parts that a layout swap changes. */
export interface IAxisPartVisibility {
	readonly agent: boolean;
	/** The agent part shows only its thin header (split mode, agent half collapsed). */
	readonly agentCollapsed: boolean;
	readonly editor: boolean;
	readonly activityBar: boolean;
	readonly sideBar: boolean;
}

/**
 * The visibility table of docs/design/axis-agent-shell.md section 3.1. The
 * panel and the auxiliary bar keep the user's visibility in every layout.
 *
 * - Agent view: only the agent part, which takes the editor's place.
 * - IDE view: the upstream layout, with the remembered activity and side bar.
 * - Split: both. A collapsed agent half keeps a thin header; a collapsed IDE
 *   half hides the IDE parts and the agent part shows the IDE header instead.
 */
export function axisPartVisibility(request: IAxisLayoutRequest, ide: IAxisIdePartsState): IAxisPartVisibility {
	switch (request.kind) {
		case 'agent':
			return { agent: true, agentCollapsed: false, editor: false, activityBar: false, sideBar: false };
		case 'ide':
			return { agent: false, agentCollapsed: false, editor: true, activityBar: ide.activityBar, sideBar: ide.sideBar };
		case 'split':
			if (request.collapsed === 'ide') {
				return { agent: true, agentCollapsed: false, editor: false, activityBar: false, sideBar: false };
			}
			return { agent: true, agentCollapsed: request.collapsed === 'agent', editor: true, activityBar: ide.activityBar, sideBar: ide.sideBar };
	}
}

/** Whether a layout shows the IDE parts, so that their visibility is the user's to remember. */
export function showsIdeParts(request: IAxisLayoutRequest): boolean {
	return request.kind === 'ide' || (request.kind === 'split' && request.collapsed !== 'ide');
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
