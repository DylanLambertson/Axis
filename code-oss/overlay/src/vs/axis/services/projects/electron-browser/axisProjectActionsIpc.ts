/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The desktop renderer's project actions (S3): main's project action channel over the preload's ipcRenderer. The renderer sends
// only { nonce, action }; main checks the sender, takes the folder from the window and draws the dialog. Registered by the desktop
// entry after the shared one, so it replaces the unavailable service there.

import { generateUuid } from '../../../../base/common/uuid.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AxisProjectActionClient } from '../common/axisProjectActions.js';
import { AxisProjectActionsModel, IAxisProjectActionsService } from '../common/axisProjectActionsService.js';

export class AxisProjectActionsIpc extends AxisProjectActionsModel {
	constructor() {
		super(new AxisProjectActionClient({
			send: (channel, payload) => ipcRenderer.send(channel, payload),
			on: (channel, listener) => {
				const handler = (_event: unknown, payload: unknown) => listener(payload);
				ipcRenderer.on(channel, handler);
				return () => void ipcRenderer.removeListener(channel, handler);
			},
		}, generateUuid));
	}
}

registerSingleton(IAxisProjectActionsService, AxisProjectActionsIpc, InstantiationType.Delayed);
