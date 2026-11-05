/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { AXIS_AGENT_PART_ID, IAxisWorkbenchLayoutService } from './axisLayoutService.js';

export type AxisNavigablePart = typeof AXIS_AGENT_PART_ID | Parts.EDITOR_PART | Parts.PANEL_PART | Parts.AUXILIARYBAR_PART | Parts.STATUSBAR_PART | Parts.ACTIVITYBAR_PART | Parts.SIDEBAR_PART;

/**
 * The F6 cycle: the upstream order (`navigationActions.ts`, editor, panel,
 * auxiliary bar, status bar, activity bar, side bar) with the agent part after
 * the editor, which is where it sits in the grid.
 */
export const AXIS_PART_CYCLE: readonly AxisNavigablePart[] = [
	Parts.EDITOR_PART,
	AXIS_AGENT_PART_ID,
	Parts.PANEL_PART,
	Parts.AUXILIARYBAR_PART,
	Parts.STATUSBAR_PART,
	Parts.ACTIVITYBAR_PART,
	Parts.SIDEBAR_PART,
];

/** The next visible part in the cycle, or `undefined` if none other is visible. */
export function nextVisiblePart(current: AxisNavigablePart | undefined, next: boolean, isVisible: (part: AxisNavigablePart) => boolean): AxisNavigablePart | undefined {
	const count = AXIS_PART_CYCLE.length;
	const start = current ? AXIS_PART_CYCLE.indexOf(current) : (next ? -1 : 0);
	for (let step = 1; step <= count; step++) {
		const index = ((start + (next ? step : -step)) % count + count) % count;
		const candidate = AXIS_PART_CYCLE[index];
		if (candidate !== current && isVisible(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export function focusNeighbourPart(accessor: ServicesAccessor, next: boolean): void {
	const layoutService = accessor.get(IWorkbenchLayoutService) as IAxisWorkbenchLayoutService;
	const editorService = accessor.get(IEditorService);

	const isVisible = (part: AxisNavigablePart): boolean => part === AXIS_AGENT_PART_ID
		? layoutService.isAgentPartVisible()
		: layoutService.isVisible(part, mainWindow);

	let current: AxisNavigablePart | undefined;
	if (layoutService.getAgentPart()?.hasFocus()) {
		current = AXIS_AGENT_PART_ID;
	} else if (editorService.activeEditorPane?.hasFocus() || layoutService.hasFocus(Parts.EDITOR_PART)) {
		current = Parts.EDITOR_PART;
	} else {
		current = ([Parts.ACTIVITYBAR_PART, Parts.STATUSBAR_PART, Parts.SIDEBAR_PART, Parts.AUXILIARYBAR_PART, Parts.PANEL_PART] as const).find(part => layoutService.hasFocus(part));
	}

	const target = nextVisiblePart(current, next, isVisible);
	if (!target) {
		return;
	}
	if (target === AXIS_AGENT_PART_ID) {
		layoutService.focusAgentPart();
	} else {
		layoutService.focusPart(target, mainWindow);
	}
}
