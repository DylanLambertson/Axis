/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The Axis pty process from main (ticket PV-X1b, docs/design/pty-exec-node.md §6): resolves `git` and `gh` once, forks the FIXED
// entry `vs/axis/pty/node/axisPtyMain.js` with the PTY-5 environment and a per-start 0700 scratch, supervises it, and hands the pty
// process and the daemon one control channel whenever either (re)starts. Every decision is in packages/daemon-host/src/main/
// (pty-launch, pty-supervisor, pty-handover), tested without Electron; this file only gives them Electron's objects.
//
// - Started by the seam BEFORE the daemon, under the same start gate (`shouldStartDaemon`): the pty process never runs when the
//   daemon does not.
// - No path, argument or environment comes from a renderer. The process gets no `execArgv`, piped stdio (stdout drained, stderr
//   cut and logged at trace) and opens no socket; ports reach it only on its parent port, which only main writes.
// - Shutdown is the seam's: the daemon first, then this process (SIGTERM, then SIGKILL), bounded (`shutdownInOrder`).
import { dirname } from 'path';
import { MessageChannelMain, utilityProcess, type MessagePortMain } from 'electron';
import { FileAccess } from '../../../base/common/network.js';
import { ControlHandover } from '../../packages/daemon-host/main/pty-handover.js';
import { createPtySpawn, preparePtyScratchRoot, ptyScratchRoot, resolvePtyPrograms, type PtyForkedChild } from '../../packages/daemon-host/main/pty-launch.js';
import { PtySupervisor, shutdownInOrder } from '../../packages/daemon-host/main/pty-supervisor.js';
import { DEFAULT_RESTART_POLICY, type SupervisedConfig, type SupervisorTimers } from '../../packages/daemon-host/supervisor.js';

const MAX_STDERR_LINE = 512;
/** How long main waits for the daemon's stop before it stops the pty process anyway: the daemon's own kill bound, plus a margin. */
const DAEMON_STOP_BOUND_MS = DEFAULT_RESTART_POLICY.stopGraceMs + 1_000;

interface ILog { trace(message: string): void; warn(message: string): void; error(message: string): void }

export interface IAxisPty {
	/** The control hand-over: the seam reports each daemon child to it, as the supervisor here reports each pty child. */
	readonly handover: ControlHandover<MessagePortMain>;
	/** Settles once the pty process was started (or could not be): the seam starts the daemon after it. */
	readonly started: Promise<void>;
	/** Stops the daemon (`daemonStop`) first, then the pty process; bounded. */
	shutdown(daemonStop: () => Promise<void>): Promise<void>;
}

/**
 * Starts the pty process. `shellEnv` is main's resolved shell environment (so a Finder-started app finds `/opt/homebrew/bin/gh`);
 * when it cannot be resolved main's own environment is used.
 */
export function startAxisPty(config: SupervisedConfig, shellEnv: () => Promise<Readonly<Record<string, string | undefined>>>, log: ILog, timers: SupervisorTimers): IAxisPty {
	const handover = new ControlHandover<MessagePortMain>({
		createChannel: () => new MessageChannelMain(),
		closePort: port => port.close(),
		onEvent: (event, fields) => event === 'post_failed' ? log.warn(`axis pty: ${event} side=${fields.side}`) : log.trace(`axis pty: ${event}`),
	});

	const started = shellEnv().catch(() => ({})).then(resolved => {
		const env = { ...process.env, ...resolved };
		// The Axis data root holds the daemon's data and the managed worktrees: a program found inside it is never chosen.
		const base = dirname(config.dataDir);
		const programs = resolvePtyPrograms(env, config.platform, [base, config.worktreeRoot]);
		log.trace(`axis pty: git=${programs.gitPath === undefined ? 'missing' : 'found'} gh=${programs.ghPath === undefined ? 'missing' : 'found'}`);
		const root = ptyScratchRoot(config.dataDir);
		const scratchRoot = config.platform !== 'win32' && preparePtyScratchRoot(root) ? root : undefined;
		const supervisor = new PtySupervisor({
			spawn: createPtySpawn({
				platform: config.platform,
				shellEnv: env,
				programs,
				scratchRoot,
				fork: childEnv => forkPty(childEnv, log),
				onEvent: event => log.warn(`axis pty: ${event}`),
			}),
			timers,
			now: () => performance.now(),
			onEvent: (event, fields) => {
				const text = `axis pty: ${event}${fields.code === undefined ? '' : ` code=${fields.code}`}${fields.reason === undefined ? '' : ` reason=${fields.reason}`}`;
				if (event === 'failed') {
					log.error(text);
				} else if (event === 'restart_scheduled') {
					log.warn(text);
				} else {
					log.trace(text);
				}
			},
			onChild: (child, alive) => handover.pty(child as PtyForkedChild, alive),
		});
		supervisor.start();
		return supervisor;
	});

	return {
		handover,
		started: started.then(() => undefined),
		shutdown: async daemonStop => {
			const supervisor = await started;
			await shutdownInOrder(daemonStop, supervisor, timers, DAEMON_STOP_BOUND_MS);
			handover.dispose();
		},
	};
}

/** Forks the FIXED pty entry with exactly `env`; the handle the launch and the hand-over use. */
function forkPty(env: Record<string, string>, log: ILog): PtyForkedChild {
	const child = utilityProcess.fork(FileAccess.asFileUri('vs/axis/pty/node/axisPtyMain.js').fsPath, [], {
		serviceName: 'axis-pty',
		env,
		execArgv: [],
		stdio: 'pipe',
	});
	child.stdout?.on('data', () => { /* drained and dropped: an unread pipe would block the process */ });
	child.stderr?.on('data', (chunk: Buffer) => log.trace(`axis pty: ${chunk.toString('utf8').trimEnd().slice(0, MAX_STDERR_LINE)}`));
	return {
		// `pty-control` carries exactly one MessagePortMain; main sends the pty process nothing else.
		postMessage: (message, transfer) => transfer === undefined ? child.postMessage(message) : child.postMessage(message, transfer as MessagePortMain[]),
		kill: signal => {
			if (signal === 'SIGKILL' && child.pid !== undefined) {
				process.kill(child.pid, 'SIGKILL');
			} else {
				child.kill();
			}
		},
		onExit: handler => {
			const listener = (code: number) => handler(typeof code === 'number' ? code : null);
			child.on('exit', listener);
			return () => void child.off('exit', listener);
		},
	};
}
