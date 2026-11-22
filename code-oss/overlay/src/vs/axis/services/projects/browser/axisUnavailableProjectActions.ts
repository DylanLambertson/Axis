/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// Web and browser builds: no main process to ask, so every project action is `unavailable`. The desktop entry replaces it.

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AxisProjectActionsModel, IAxisProjectActionsService } from '../common/axisProjectActionsService.js';

export class AxisUnavailableProjectActions extends AxisProjectActionsModel {
	constructor() {
		super(undefined);
	}
}

registerSingleton(IAxisProjectActionsService, AxisUnavailableProjectActions, InstantiationType.Delayed);
