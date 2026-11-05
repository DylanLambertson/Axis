/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { refineServiceDecorator } from '../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService } from '../../workbench/services/layout/browser/layoutService.js';
import { AxisViewKind } from '../common/axisView.js';

/**
 * Id of the Axis agent part. A string id, not a member of the upstream `Parts`
 * enum (docs/design/axis-agent-shell.md section 3.1).
 */
export const AXIS_AGENT_PART_ID = 'axis.parts.agent';


/**
 * The Axis workbench layout: the upstream layout service plus the agent part
 * and the Agent/IDE layout swap. `AxisWorkbench` is the only implementation.
 */
export interface IAxisWorkbenchLayoutService extends IWorkbenchLayoutService {

	/** Fires once, synchronously, when the agent part has been added to the grid. */
	readonly onDidCreateAgentPart: Event<void>;

	/** Fires after the layout has been swapped to a view. */
	readonly onDidApplyView: Event<AxisViewKind>;

	/**
	 * Fires while the Agent view is showing and an IDE-only part was revealed by
	 * something other than a view swap: an explicit editor open, an upstream
	 * layout command, or a command that opens a side bar view. The view service
	 * decides what to do (decision D-5).
	 */
	readonly onDidRequestIdeView: Event<void>;

	/** Whether the agent part exists yet (it is created with the workbench grid). */
	hasAgentPart(): boolean;

	/** The view the layout currently shows, or `undefined` before the first swap. */
	readonly appliedView: AxisViewKind | undefined;

	/**
	 * Swaps the layout to a view by changing part visibility. Parts are never
	 * recreated, the window is not reloaded and open editors stay open.
	 */
	applyView(view: AxisViewKind): void;

	isAgentPartVisible(): boolean;

	focusAgentPart(): void;
}

export const IAxisWorkbenchLayoutService = refineServiceDecorator<IWorkbenchLayoutService, IAxisWorkbenchLayoutService>(IWorkbenchLayoutService);
