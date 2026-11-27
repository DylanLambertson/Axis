/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The Electron side of main's answers and of the connect handshake (tickets X1b and X1c, docs/design/main-answers.md). Every
// decision is made by the tested modules under `vs/axis/packages/daemon-host/main/`; this file only reads Electron and upstream
// services and hands the values over. NOT verifiable on Linux CI (no Electron types or runtime there): the macOS and Windows builds
// verify it (main-answers.md section 5).
import { isAbsolute, normalize } from 'path';
import { dialog, MessageChannelMain, safeStorage, type IpcMainEvent, type MessagePortMain } from 'electron';
import { FileAccess } from '../../../base/common/network.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../platform/environment/electron-main/environmentMainService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { getResolvedShellEnv } from '../../../platform/shell/node/shellEnv.js';
import { StorageScope } from '../../../platform/storage/common/storage.js';
import { IApplicationStorageMainService } from '../../../platform/storage/electron-main/storageMainService.js';
import { IWindowsMainService } from '../../../platform/windows/electron-main/windows.js';
import { isSingleFolderWorkspaceIdentifier } from '../../../platform/workspace/common/workspace.js';
import type { AnchorCipher } from '../../packages/daemon-host/main/anchor-store.js';
import type { SettingsSource, TrustSource } from '../../packages/daemon-host/main/answers.js';
import type { ConnectSender, PortPair } from '../../packages/daemon-host/main/connect-broker.js';
import type { NativeDialogPort } from '../../packages/daemon-host/main/native-queue.js';
import type { ProjectDialog } from '../../packages/daemon-host/main/project-actions.js';
import { TRUST_STORAGE_KEY, isPathTrusted, trustedFolders } from '../../packages/daemon-host/main/trust-model.js';

type Platform = 'darwin' | 'linux' | 'win32';

/** The upstream services main's answers read, resolved once (an accessor is only valid inside `invokeFunction`). */
export interface AxisMainServices {
	readonly windows: IWindowsMainService;
	readonly configuration: IConfigurationService;
	readonly applicationStorage: IApplicationStorageMainService;
	readonly environment: IEnvironmentMainService;
	readonly log: ILogService;
}

export function resolveMainServices(instantiation: IInstantiationService): AxisMainServices {
	return instantiation.invokeFunction(accessor => ({
		windows: accessor.get(IWindowsMainService),
		configuration: accessor.get(IConfigurationService),
		applicationStorage: accessor.get(IApplicationStorageMainService),
		environment: accessor.get(IEnvironmentMainService),
		log: accessor.get(ILogService),
	}));
}

/**
 * Main's resolved shell environment (upstream's resolver, cached by it, honouring `--force-disable-user-env` and its timeout), for
 * the pty process's program resolution (PV-X1b). Upstream skips it on Windows and when started from a CLI.
 */
export function resolvedShellEnv(services: AxisMainServices): () => Promise<Readonly<Record<string, string | undefined>>> {
	return () => getResolvedShellEnv(services.configuration, services.log, services.environment.args, process.env);
}

/** `safeStorage` as the anchor cipher. `secure` only for a real OS backend: never Linux `basic_text` or `unknown`. */
export function safeStorageCipher(platform: Platform): AnchorCipher {
	return {
		status: () => {
			if (!safeStorage.isEncryptionAvailable()) {
				return 'unavailable';
			}
			if (platform === 'linux') {
				const backend = safeStorage.getSelectedStorageBackend();
				return backend === 'basic_text' || backend === 'unknown' ? 'insecure' : 'secure';
			}
			return 'secure';
		},
		encrypt: plain => new Uint8Array(safeStorage.encryptString(plain)),
		decrypt: data => safeStorage.decryptString(Buffer.from(data)),
	};
}

/** The workbench URLs main loads (windowImpl.ts): the built one and the `-dev` one. */
export function workbenchUrls(): string[] {
	return ['', '-dev'].map(suffix => FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${suffix}.html`).toString(true));
}

/** What main knows about the sender of `vscode:axisConnect` (never anything the renderer said). */
export function connectSender(services: AxisMainServices, event: IpcMainEvent): ConnectSender {
	const sender = event.sender;
	const destroyed = sender.isDestroyed();
	const codeWindow = destroyed ? undefined : services.windows.getWindowByWebContents(sender);
	return {
		codeWindowId: codeWindow?.id,
		frameUrl: event.senderFrame?.url,
		isMainFrame: !destroyed && event.senderFrame !== null && event.senderFrame !== undefined && event.senderFrame === sender.mainFrame,
		destroyed,
	};
}

export function messageChannel(): PortPair<MessagePortMain> {
	const { port1, port2 } = new MessageChannelMain();
	return { daemonEnd: port1, rendererEnd: port2 };
}

/**
 * The Workspace Trust model as main's application storage holds it (StorageScope.APPLICATION_SHARED). OPEN ITEM (main-answers.md
 * section 3.3, ROADMAP trust enforcement line): renderers WRITE this value through the storage channel, so a compromised renderer
 * can rewrite it. Today it only sets the connection's `trusted` flag (which grants nothing without a main `trust.set`, not built) and
 * cannot make `trust.check` true (no project path is known). Before main registers projects, the run-trust decision must move to a
 * record only main writes, from a prompt main shows.
 */
function trustModel(services: AxisMainServices): string | undefined {
	return services.applicationStorage.get(TRUST_STORAGE_KEY, StorageScope.APPLICATION_SHARED);
}

/** The window's single folder is inside a trusted folder now. Multi-root workspaces and empty windows are untrusted. */
export function windowTrusted(services: AxisMainServices, codeWindowId: number, platform: Platform): boolean {
	const workspace = services.windows.getWindowById(codeWindowId)?.openedWorkspace;
	if (!isSingleFolderWorkspaceIdentifier(workspace) || workspace.uri.scheme !== 'file') {
		return false;
	}
	return isPathTrusted(workspace.uri.fsPath, trustedFolders(trustModel(services), platform), platform);
}

/**
 * The Workspace Trust half of `trust.check` (project-registration-and-trust.md §5.4): main answers for the project path the daemon sends
 * from its journal, and the daemon ANDs it with its own main-confirmed record, so this renderer-writable model alone never grants.
 */
export function trustSource(services: AxisMainServices): TrustSource {
	return { trustModel: () => trustModel(services) };
}

/** Main's configuration service holds the default profile's user settings, the policy and the defaults; the scope choice is CFG-1's. */
export function settingsSource(services: AxisMainServices): SettingsSource {
	return { inspect: key => services.configuration.inspect(key) };
}

/**
 * `dialog.showMessageBox`, modal on the code window; `true` only for the Confirm button. `signal` is aborted when the challenge's
 * lifetime runs out (native-queue.ts), which closes the box, so a dialog left open cannot hold back every other window's.
 */
export function nativeDialog(services: AxisMainServices): NativeDialogPort {
	return {
		confirm: async ({ codeWindowId, summary, signal }) => {
			const win = services.windows.getWindowById(codeWindowId)?.win;
			if (!win || win.isDestroyed()) {
				return false;
			}
			const { response } = await dialog.showMessageBox(win, {
				type: 'warning',
				message: 'Axis needs your confirmation',
				detail: summary,
				buttons: ['Cancel', 'Confirm'],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
				signal,
			});
			return response === 1;
		},
	};
}

/**
 * A project action's dialog (project-registration-and-trust.md §4.2), modal on the code window: Cancel is the first button, the
 * default and the cancel id, so Return, Space and Escape all cancel; a grant is never the default. Aborting the signal closes it.
 */
export function projectDialog(services: AxisMainServices): (codeWindowId: number, d: ProjectDialog, signal: AbortSignal) => Promise<number> {
	return async (codeWindowId, d, signal) => {
		const win = services.windows.getWindowById(codeWindowId)?.win;
		if (!win || win.isDestroyed()) {
			return 0;
		}
		const { response } = await dialog.showMessageBox(win, {
			type: 'question',
			message: d.message,
			detail: d.detail,
			buttons: [...d.buttons],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
			signal,
		});
		return response;
	};
}

/** The window's single `file:` folder as an absolute, normalised path; undefined for a multi-root, empty or remote window. */
export function windowFolder(services: AxisMainServices, codeWindowId: number): string | undefined {
	const workspace = services.windows.getWindowById(codeWindowId)?.openedWorkspace;
	if (!isSingleFolderWorkspaceIdentifier(workspace) || workspace.uri.scheme !== 'file') {
		return undefined;
	}
	const path = normalize(workspace.uri.fsPath);
	return isAbsolute(path) ? path.replace(/[\\/]+$/, '') || path : undefined;
}

/** The Workspace Trust model trusts this path now (renderer-writable: it decides only what the dialog offers, never a grant). */
export function workspaceTrusted(services: AxisMainServices, platform: Platform): (path: string) => boolean {
	return path => isPathTrusted(path, trustedFolders(trustModel(services), platform), platform);
}
