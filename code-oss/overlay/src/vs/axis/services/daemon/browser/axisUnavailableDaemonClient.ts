/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AxisDaemonCallError, AxisDaemonStatus, IAxisDaemonClient } from '../common/axisDaemonClient.js';

/**
 * The client registered until ticket X1b provides the real one: the daemon is
 * `down` and every call fails. X1b replaces this registration.
 */
export class AxisUnavailableDaemonClient implements IAxisDaemonClient {
	declare readonly _serviceBrand: undefined;
	readonly status: AxisDaemonStatus = { kind: 'down' };
	readonly onDidChangeStatus = Event.None;
	request(): Promise<unknown> {
		return Promise.reject(new AxisDaemonCallError('unavailable'));
	}
}

registerSingleton(IAxisDaemonClient, AxisUnavailableDaemonClient, InstantiationType.Delayed);
