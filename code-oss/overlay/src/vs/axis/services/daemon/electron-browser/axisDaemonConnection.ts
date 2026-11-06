/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The renderer's connection to the Axis daemon (ticket X1b, docs/design/main-answers.md section 2, ADR 0003 D1.2). Upstream
// `acquirePort` sends only a nonce on `vscode:axisConnect`; main checks the window and answers with one end of a channel whose
// other end it handed the daemon with a signed attestation. The renderer never sees a key or an identity: it says `hello` and
// gets `welcome` (or a rejection). The protocol logic is `AxisPortClient` from `@axis/protocol` (the only package a renderer may
// import, ADR 0005 D2.2); this file only adapts the DOM `MessagePort`. After a daemon restart the port closes and the caller
// connects again.
import { generateUuid } from '../../../../base/common/uuid.js';
import { acquirePort } from '../../../../base/parts/ipc/electron-browser/ipc.mp.js';
import { AxisPortClient, type ClientPort } from '../../../packages/protocol/client.js';

export type AxisContractRequest = ReadonlyArray<{ readonly id: string; readonly versions: readonly number[] }>;

function domPort(port: MessagePort): ClientPort {
	const wrapped: ClientPort = {
		postMessage: message => port.postMessage(message),
		onMessage: handler => {
			const listener = (e: MessageEvent) => handler(e.data);
			port.addEventListener('message', listener);
			return () => port.removeEventListener('message', listener);
		},
		onClose: handler => {
			port.addEventListener('close', handler);
			return () => port.removeEventListener('close', handler);
		},
		close: () => port.close(),
	};
	port.start();
	return wrapped;
}

/** Ask main for a port and open the client on it. Rejects when main refuses the window or the daemon rejects the connection. */
export async function connectAxisDaemon(contracts: AxisContractRequest): Promise<AxisPortClient> {
	const port = await acquirePort('vscode:axisConnect', 'vscode:axisConnectResult', generateUuid());
	return AxisPortClient.open(domPort(port), { contracts });
}
