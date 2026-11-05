/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../base/browser/dom.js';
import { Event } from '../../base/common/event.js';
import { refineServiceDecorator } from '../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService } from '../../workbench/services/layout/browser/layoutService.js';
import { AxisSplitCollapse, IAxisLayoutRequest } from '../common/axisView.js';

/**
 * Id of the Axis agent part. A string id, not a member of the upstream `Parts`
 * enum (docs/design/axis-agent-shell.md section 3.1).
 */
export const AXIS_AGENT_PART_ID = 'axis.parts.agent';

/**
 * Content hosted by the agent part. The part owns the grid leaf; the content
 * owns everything inside it (the dashboard and the workspace view).
 */
export interface IAxisAgentPartContent {
	readonly element: HTMLElement;
	layout(dimension: Dimension): void;
	/** Moves focus to the content's primary region (docs/UX.md focus rule 1). */
	focus(): void;
}

/** What the agent part needs to know to draw the split header. */
export interface IAxisSplitHeaderState {
	readonly split: boolean;
	readonly collapsed: AxisSplitCollapse;
}

export interface IAxisAgentPart {
	readonly element: HTMLElement;
	setContent(content: IAxisAgentPartContent): void;
	/** Whether the DOM focus is inside the agent part. */
	hasFocus(): boolean;
	focus(): void;
	/** Fires when the user asks the split header to collapse or expand a half. */
	readonly onDidRequestCollapse: Event<AxisSplitCollapse>;
}

/**
 * The Axis workbench layout: the upstream layout service plus the agent part
 * and the Agent/IDE/split layout swap. `AxisWorkbench` is the only implementation.
 */
export interface IAxisWorkbenchLayoutService extends IWorkbenchLayoutService {

	/** Fires once, synchronously, when the agent part has been added to the grid. */
	readonly onDidCreateAgentPart: Event<void>;

	/** Fires after the layout has been swapped. */
	readonly onDidApplyLayout: Event<IAxisLayoutRequest>;

	/**
	 * Fires while the Agent view is showing (not split) and an IDE-only part was
	 * revealed by something other than a layout swap: an explicit editor open,
	 * an upstream layout command, or a command that opens a side bar view. The
	 * view service decides what to do (decision D-5).
	 */
	readonly onDidRequestIdeView: Event<void>;

	/** Whether the agent part exists yet (it is created with the workbench grid). */
	hasAgentPart(): boolean;

	getAgentPart(): IAxisAgentPart | undefined;

	/** The layout shown now, or `undefined` before the first swap. */
	readonly appliedLayout: IAxisLayoutRequest | undefined;

	/**
	 * Swaps the layout by changing part visibility and sizes. Parts are never
	 * recreated, the window is not reloaded and open editors stay open.
	 */
	applyLayout(request: IAxisLayoutRequest): void;

	isAgentPartVisible(): boolean;

	focusAgentPart(): void;
}

export const IAxisWorkbenchLayoutService = refineServiceDecorator<IWorkbenchLayoutService, IAxisWorkbenchLayoutService>(IWorkbenchLayoutService);
