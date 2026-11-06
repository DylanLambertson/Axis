/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The Axis main seam: starts and supervises the daemon utility process (ADR 0003 D1 and D6, ticket X1,
// docs/design/daemon-host-entry.md), brokers renderer connections to it (ticket X1b) and answers its requests (ticket X1c,
// docs/design/main-answers.md). Started once from `CodeApplication.startup` (patch 0210).
//
// - The entry is FIXED: `vs/axis/daemon/node/axisDaemonMain.js` of this application. It is never launched through the
//   renderer-reachable utility process worker channel and no path, argument or environment comes from a renderer.
// - The process gets an explicit minimal environment (never main's own), no `execArgv`, no inspector, and its stdio piped so
//   nothing reaches a terminal; no listening socket is created.
// - The data directory and the attestation key come from here (the key is made per spawn and kept by the supervisor, which signs
//   every brokered connection with it).
// - `vscode:axisConnect`: the sender checks, the rate limit and the identity are `ConnectBroker`'s; the renderer gets one end of a
//   fresh `MessageChannelMain`, the daemon the other with a signed `connect`.
// - The answers (anchor, native confirmation, trust, settings) are `createMainAnswers`'; the anchor store is read BEFORE the first
//   spawn, so a keychain prompt cannot use up the daemon's 5 s anchor wait.
import { createHmac, randomBytes } from 'crypto';
import { homedir } from 'os';
import { app, utilityProcess, type MessagePortMain } from 'electron';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { FileAccess } from '../../../base/common/network.js';
import type { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { anchorFilePath, createAnchorFile } from '../../packages/daemon-host/main/anchor-file.js';
import { createAnchorStore } from '../../packages/daemon-host/main/anchor-store.js';
import { createMainAnswers } from '../../packages/daemon-host/main/answers.js';
import { ConnectBroker } from '../../packages/daemon-host/main/connect-broker.js';
import { DaemonSupervisor, axisDataRoots, daemonEnvironment, shouldStartDaemon, type DaemonChild, type SupervisedConfig } from '../../packages/daemon-host/supervisor.js';
import { connectSender, messageChannel, nativeDialog, resolveMainServices, safeStorageCipher, settingsSource, trustSource, windowTrusted, workbenchUrls } from './axisMainPorts.js';

const MAX_STDERR_LINE = 512;

interface IShutdownEvent { join(id: string, promise: Promise<void>): void }
interface ILifecycle { readonly onWillShutdown: (listener: (event: IShutdownEvent) => unknown) => unknown }
interface ILog { trace(message: string): void; warn(message: string): void; error(message: string): void }

export function startAxisMainSeam(lifecycle: ILifecycle, log: ILog, instantiation: IInstantiationService): DaemonSupervisor | undefined {
	// Until the real ports exist the daemon only refuses to start: spawn it in unpackaged builds only (supervisor.ts).
	if (!shouldStartDaemon(app.isPackaged)) {
		log.trace('axis daemon: not started in a packaged build');
		return undefined;
	}
	const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
	const config: SupervisedConfig = {
		// D-3, per platform and NOT Electron's userData (axisDataRoots). The daemon checks the root is not inside a registered repository.
		...axisDataRoots(platform, process.env, homedir()),
		platform,
		logLevel: 'info',
		devDiagnostics: !app.isPackaged,
	};
	const services = resolveMainServices(instantiation);

	let supervisor: DaemonSupervisor | undefined = undefined;
	const broker = new ConnectBroker<MessagePortMain>({
		supervisor: { connect: (identity, port) => supervisor?.connect(identity, port) ?? false },
		createChannel: messageChannel,
		closePort: port => port.close(),
		randomBytes: n => randomBytes(n),
		workbenchUrls: workbenchUrls(),
		windowTrusted: id => windowTrusted(services, id, platform),
		now: () => performance.now(),
		onEvent: (event, reason) => event === 'connect_refused' ? log.warn(`axis daemon: connect_refused reason=${reason}`) : log.trace(`axis daemon: ${event}`),
	});
	services.windows.onDidDestroyWindow(window => broker.windowClosed(window.id));

	const answers = createMainAnswers({
		// `<base>/anchor/audit-anchor.v1`, next to (never inside) the daemon's data directory, encrypted with safeStorage.
		anchors: createAnchorStore(safeStorageCipher(platform), createAnchorFile(anchorFilePath(config.dataDir))),
		dialog: nativeDialog(services),
		windows: broker,
		trust: trustSource(services),
		settings: settingsSource(services),
		platform,
		now: () => performance.now(),
		onEvent: e => log.warn(`axis daemon: ${e.event}${'reason' in e ? ` reason=${e.reason}` : ''}`),
	});

	supervisor = new DaemonSupervisor({
		config,
		randomBytes: n => randomBytes(n),
		hmacSha256: (key, text) => new Uint8Array(createHmac('sha256', key).update(text, 'utf8').digest()),
		now: () => performance.now(),
		timers: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
		onRequest: (message, reply) => answers.onRequest(message, reply),
		spawn: () => {
			const child = utilityProcess.fork(FileAccess.asFileUri('vs/axis/daemon/node/axisDaemonMain.js').fsPath, [], {
				serviceName: 'axis-daemon',
				env: daemonEnvironment(process.env),
				execArgv: [],
				stdio: 'pipe',
			});
			child.stdout?.on('data', () => { /* drained and dropped: an unread pipe would block the daemon */ });
			child.stderr?.on('data', (chunk: Buffer) => log.trace(`axis daemon: ${chunk.toString('utf8').trimEnd().slice(0, MAX_STDERR_LINE)}`));
			const handle: DaemonChild = {
				// A `connect` carries exactly one MessagePortMain (the broker's daemon end); every other message carries none.
				postMessage: (message, transfer) => transfer === undefined ? child.postMessage(message) : child.postMessage(message, transfer as MessagePortMain[]),
				kill: () => child.kill(),
				onMessage: handler => {
					const listener = (message: unknown) => handler(message);
					child.on('message', listener);
					return () => void child.off('message', listener);
				},
				onExit: handler => {
					const listener = (code: number) => handler(typeof code === 'number' ? code : null);
					child.on('exit', listener);
					return () => void child.off('exit', listener);
				},
			};
			return handle;
		},
		onEvent: (event, fields) => {
			const text = `axis daemon: ${event}${fields.code === undefined ? '' : ` code=${fields.code}`}${fields.reason === undefined ? '' : ` reason=${fields.reason}`}`;
			if (event === 'failed' || event === 'fatal_reported') {
				log.error(text);
			} else if (event === 'restart_scheduled' || event === 'degraded' || event === 'unanswered_request') {
				log.warn(text);
			} else {
				log.trace(text);
			}
		},
	});
	const started = supervisor;

	// The renderer handshake (ADR 0003 D1.2): upstream `acquirePort` sends the nonce; the answer carries the port, or upstream's
	// error shape with a closed code. An invalid nonce is not echoed, and a destroyed sender gets nothing.
	validatedIpcMain.on('vscode:axisConnect', (event, nonce: unknown) => {
		const outcome = broker.connect(connectSender(services, event), nonce);
		if (outcome.ok) {
			event.sender.postMessage('vscode:axisConnectResult', nonce, [outcome.port]);
		} else if (outcome.reason !== 'bad_nonce' && outcome.reason !== 'destroyed' && !event.sender.isDestroyed()) {
			event.sender.postMessage('vscode:axisConnectResult', { nonce, error: outcome.reason });
		}
	});

	// The shutdown message is the only graceful path on Windows, where a utility process is ended by TerminateProcess.
	lifecycle.onWillShutdown(event => event.join('axisDaemon', started.shutdown().finally(() => answers.dispose())));
	// Read the anchor store first (a keychain prompt must not use up the daemon's anchor wait), then spawn.
	void answers.prepare().finally(() => started.start());
	return started;
}
