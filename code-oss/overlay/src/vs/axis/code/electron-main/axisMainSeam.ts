/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The Axis main seam: starts and supervises the daemon utility process (ADR 0003 D1 and D6, ticket X1,
// docs/design/daemon-host-entry.md). Started once from `CodeApplication.startup` (patch 0210).
//
// - The entry is FIXED: `vs/axis/daemon/node/axisDaemonMain.js` of this application. It is never launched through the
//   renderer-reachable utility process worker channel and no path, argument or environment comes from a renderer.
// - The process gets an explicit minimal environment (never main's own), no `execArgv`, no inspector, and its stdio piped so
//   nothing reaches a terminal; no listening socket is created.
// - The data directory and the attestation key come from here (the key is made per spawn by the supervisor).
// - Restart policy, exit-code handling and the shutdown message are `DaemonSupervisor`'s (packages/daemon-host/src/supervisor.ts).
// - NOT here yet (follow-ups of X1): the renderer connect handshake and the attestation of connections, the answers to the
//   daemon's requests (anchor storage, native confirmation, trust, settings). Without `onRequest` every request goes unanswered,
//   which the daemon treats as a refusal.
import { randomBytes } from 'crypto';
import { app, utilityProcess } from 'electron';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { DaemonSupervisor, daemonEnvironment, type DaemonChild, type SupervisedConfig } from '../../packages/daemon-host/supervisor.js';

const MAX_STDERR_LINE = 512;

interface IShutdownEvent { join(id: string, promise: Promise<void>): void }
interface ILifecycle { readonly onWillShutdown: (listener: (event: IShutdownEvent) => unknown) => unknown }
interface ILog { trace(message: string): void; warn(message: string): void; error(message: string): void }

export function startAxisMainSeam(lifecycle: ILifecycle, log: ILog, userDataPath: string): DaemonSupervisor {
	const config: SupervisedConfig = {
		// D-3: the application data directory. The worktree root is never inside a registered repository (the daemon checks).
		dataDir: join(userDataPath, 'axis-daemon'),
		worktreeRoot: join(userDataPath, 'worktrees'),
		platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
		logLevel: 'info',
		devDiagnostics: !app.isPackaged,
	};

	const supervisor = new DaemonSupervisor({
		config,
		randomBytes: n => randomBytes(n),
		now: () => performance.now(),
		timers: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
		spawn: () => {
			const child = utilityProcess.fork(FileAccess.asFileUri('vs/axis/daemon/node/axisDaemonMain.js').fsPath, [], {
				serviceName: 'axis-daemon',
				env: daemonEnvironment(process.env),
				execArgv: [],
				stdio: 'pipe',
			});
			child.stderr?.on('data', (chunk: Buffer) => log.trace(`axis daemon: ${chunk.toString('utf8').trimEnd().slice(0, MAX_STDERR_LINE)}`));
			const handle: DaemonChild = {
				postMessage: message => child.postMessage(message),
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

	// The shutdown message is the only graceful path on Windows, where a utility process is ended by TerminateProcess.
	lifecycle.onWillShutdown(event => event.join('axisDaemon', supervisor.shutdown()));
	supervisor.start();
	return supervisor;
}
