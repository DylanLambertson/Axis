/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The desktop renderer's daemon client (ticket PV-E0): `AxisReconnectingDaemonClient` over `connectAxisDaemon`, main's attested
// `vscode:axisConnect` port. Registered by the desktop entry (axis.desktop.main.ts) AFTER the shared entry, so it replaces the
// unavailable client there; web and browser builds keep `AxisUnavailableDaemonClient`.

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAxisDaemonClient } from '../common/axisDaemonClient.js';
import { AXIS_SHELL_CONTRACTS, AXIS_WELCOME_TIMEOUT_MS, AxisReconnectingDaemonClient } from '../common/axisDaemonReconnect.js';
import { connectAxisDaemon } from './axisDaemonConnection.js';

export class AxisRendererDaemonClient extends AxisReconnectingDaemonClient {
	constructor() {
		super({
			connect: onClose => connectAxisDaemon(AXIS_SHELL_CONTRACTS, onClose, AXIS_WELCOME_TIMEOUT_MS),
			timers: { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
			random: Math.random,
		});
	}
}

registerSingleton(IAxisDaemonClient, AxisRendererDaemonClient, InstantiationType.Delayed);
