/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAxisShowViewOptions, IAxisViewService } from '../../view/browser/axisViewService.js';
import { AxisApprovalController, AxisApprovalDecision, AxisApprovalOutcome, IAxisApprovalCard, IAxisGestureEvent, IAxisGestureScope } from '../../approvals/common/axisApprovals.js';
import { AxisDaemonApi } from '../../daemon/common/axisDaemonApi.js';
import { AxisCallErrorCode, AxisDaemonStatus, IAxisDaemonClient, isUsable, sameStatus, sanitizeStatus } from '../../daemon/common/axisDaemonClient.js';
import { AxisDataProvenance, IAxisProjectInfo } from '../common/axisWorkspaceData.js';
import { cycleIndex, IAxisWorkspaceEntry } from '../common/axisWorkspaceModel.js';
import { AxisDiscoveryDataSource } from '../common/axisDiscoveryDataSource.js';
import { AxisDataOrigin, AxisSnapshotLoader, IAxisSnapshot, sameSnapshot } from '../common/axisSnapshotLoader.js';
import { IAxisRefreshDriver } from '../common/axisRefreshDriver.js';
import { AxisAdaptiveRefreshDriver } from '../common/axisEventDriver.js';

/** The focused workspace key, per Code OSS workspace (design section 3.6). */
const FOCUSED_WORKSPACE_STORAGE_KEY = 'axis.workspaces.focused';

export const IAxisWorkspaceService = createDecorator<IAxisWorkspaceService>('axisWorkspaceService');

/**
 * The workspaces of the window's projects and the focused one
 * (docs/design/axis-agent-shell.md section 1.1, `IAxisWorkspaceService`).
 */
export interface IAxisWorkspaceService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeWorkspaces: Event<void>;
	readonly onDidChangeFocus: Event<IAxisWorkspaceEntry | undefined>;

	readonly loaded: boolean;
	readonly projects: readonly IAxisProjectInfo[];
	/** Rows in dashboard order. */
	readonly workspaces: readonly IAxisWorkspaceEntry[];
	readonly focused: IAxisWorkspaceEntry | undefined;
	readonly runsProvenance: AxisDataProvenance;
	/** Worktree entries discovery refused to list, over all projects (their `.git` does not point back, or they are missing). */
	readonly refusedWorktrees: number;
	/** The Axis service state the rows were read under (docs/design/axis-shell-a2.md). */
	readonly daemonStatus: AxisDaemonStatus;
	/** Whether the rows come from the Axis service or from the worktrees on disk. */
	readonly dataOrigin: AxisDataOrigin;
	/** Set when the last read from the Axis service failed and the rows are the last good ones. */
	readonly staleError: AxisCallErrorCode | undefined;
	/** The daemon is usable but has no registered project, so the rows come from disk. */
	readonly notRegistered: boolean;
	readonly truncatedProjects: boolean;
	/** Open approval challenges; `undefined` when unknown. */
	readonly pendingApprovals: number | undefined;
	/** The challenges to show as cards (display data from the daemon); empty when unknown. */
	readonly approvalCards: readonly IAxisApprovalCard[];
	/**
	 * A user's answer to a card (docs/design/axis-shell-a4.md). Calls `axis.approvals/1.resolve` only for a trusted
	 * gesture on a card below tier 4; every other case returns a closed outcome and sends nothing.
	 */
	decideApproval(card: Pick<IAxisApprovalCard, 'challengeId' | 'digest'>, decision: AxisApprovalDecision, event: IAxisGestureEvent, scope: IAxisGestureScope): Promise<AxisApprovalOutcome>;

	/** Focuses a workspace by key, or the dashboard (`undefined`). */
	focus(key: string | undefined, options?: IAxisShowViewOptions): void;
	/** Focuses the n-th row (0-based) in dashboard order. Returns false if there is none. */
	focusIndex(index: number): boolean;
	/** Focuses the next (`1`) or previous (`-1`) row, wrapping. */
	focusRelative(delta: 1 | -1): void;
	refresh(): Promise<void>;
}

export class AxisWorkspaceService extends Disposable implements IAxisWorkspaceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces = this._onDidChangeWorkspaces.event;

	private readonly _onDidChangeFocus = this._register(new Emitter<IAxisWorkspaceEntry | undefined>());
	readonly onDidChangeFocus = this._onDidChangeFocus.event;

	private readonly source: AxisDiscoveryDataSource;
	private readonly loader: AxisSnapshotLoader;
	private readonly approvals: AxisApprovalController;
	private readonly driver: IAxisRefreshDriver;
	private snapshot: IAxisSnapshot | undefined;
	private _daemonStatus: AxisDaemonStatus = { kind: 'down' };
	private loadOk = true;
	private _loaded = false;
	private _workspaces: readonly IAxisWorkspaceEntry[] = [];
	private _focusedKey: string | undefined;
	private loading: Promise<void> | undefined;
	private reloadQueued = false;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAxisViewService private readonly viewService: IAxisViewService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IAxisDaemonClient private readonly daemon: IAxisDaemonClient,
	) {
		super();
		this.source = this._register(instantiationService.createInstance(AxisDiscoveryDataSource));
		const cancellation = this._register(new CancellationTokenSource());
		const api = new AxisDaemonApi(this.daemon, cancellation.token);
		this.loader = new AxisSnapshotLoader(this.source, api);
		this.approvals = new AxisApprovalController(api, () => this.snapshot?.approvals, () => Date.now(), () => { this.refresh(); });
		this.driver = this._register(new AxisAdaptiveRefreshDriver(this.daemon));
		this._register(addDisposableListener(mainWindow.document, 'visibilitychange', () => this.driver.setPaused(mainWindow.document.hidden)));
		this._register(this.daemon.onDidChangeStatus(() => this.onDaemonStatus()));
		this._focusedKey = this.storageService.get(FOCUSED_WORKSPACE_STORAGE_KEY, StorageScope.WORKSPACE) || undefined;
		this._register(this.source.onDidChange(() => this.refresh()));
		this.driver.setPaused(mainWindow.document.hidden);
		this.updateDriver();
		this.refresh();
	}

	get loaded(): boolean { return this._loaded; }
	get projects(): readonly IAxisProjectInfo[] { return this.snapshot?.projects ?? []; }
	get workspaces(): readonly IAxisWorkspaceEntry[] { return this._workspaces; }
	get runsProvenance(): AxisDataProvenance { return this.snapshot?.runsProvenance ?? this.source.runsProvenance; }
	get refusedWorktrees(): number { return this.snapshot?.refusedWorktrees ?? 0; }
	get daemonStatus(): AxisDaemonStatus { return this._daemonStatus; }
	get dataOrigin(): AxisDataOrigin { return this.snapshot?.origin ?? 'discovery'; }
	get staleError(): AxisCallErrorCode | undefined { return this.snapshot?.staleError; }
	get notRegistered(): boolean { return this.snapshot?.notRegistered ?? false; }
	get truncatedProjects(): boolean { return this.snapshot?.truncatedProjects ?? false; }
	get pendingApprovals(): number | undefined { return this.snapshot?.approvals?.length; }
	get approvalCards(): readonly IAxisApprovalCard[] { return this.snapshot?.approvals ?? []; }

	decideApproval(card: Pick<IAxisApprovalCard, 'challengeId' | 'digest'>, decision: AxisApprovalDecision, event: IAxisGestureEvent, scope: IAxisGestureScope): Promise<AxisApprovalOutcome> {
		return this.approvals.decide(card, decision, event, scope);
	}

	get focused(): IAxisWorkspaceEntry | undefined {
		return this._focusedKey ? this._workspaces.find(w => w.key === this._focusedKey) : undefined;
	}

	focus(key: string | undefined, options?: IAxisShowViewOptions): void {
		const entry = key ? this._workspaces.find(w => w.key === key) : undefined;
		const newKey = entry?.key;
		const changed = newKey !== this._focusedKey;
		this._focusedKey = newKey;
		this.storageService.store(FOCUSED_WORKSPACE_STORAGE_KEY, newKey ?? '', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (changed) {
			this._onDidChangeFocus.fire(entry);
		}
		this.viewService.setFocusedWorkspace(newKey, entry?.label, options);
	}

	focusIndex(index: number): boolean {
		const entry = this._workspaces[index];
		if (!entry) {
			return false;
		}
		this.focus(entry.key);
		return true;
	}

	focusRelative(delta: 1 | -1): void {
		const current = this._focusedKey ? this._workspaces.findIndex(w => w.key === this._focusedKey) : -1;
		const next = cycleIndex(current === -1 ? undefined : current, delta, this._workspaces.length);
		if (next !== undefined) {
			this.focusIndex(next);
		}
	}

	/** Reloads from the data source. Concurrent calls coalesce into one more load. */
	refresh(): Promise<void> {
		if (this.loading) {
			this.reloadQueued = true;
			return this.loading;
		}
		this.loading = this.load().finally(() => {
			this.loading = undefined;
			if (this.reloadQueued) {
				this.reloadQueued = false;
				this.refresh();
			}
		});
		return this.loading;
	}

	private async load(): Promise<void> {
		try {
			const status = sanitizeStatus(this.daemon.status);
			const snapshot = await this.loader.load(status);
			if (this._store.isDisposed) {
				return;
			}
			const statusChanged = !sameStatus(status, this._daemonStatus);
			this._daemonStatus = status;
			const unchanged = this._loaded && !statusChanged && sameSnapshot(this.snapshot, snapshot);
			this.snapshot = snapshot;
			this._loaded = true;
			this.loadOk = snapshot.staleError === undefined;
			if (unchanged) {
				return;
			}
			const hadFocus = this.focused;
			this._workspaces = snapshot.entries;
			this._onDidChangeWorkspaces.fire();

			const focused = this.focused;
			if (hadFocus && !focused) {
				this.focus(undefined, { focus: false }); // the focused worktree went away
			} else if (!hadFocus && focused) {
				this._onDidChangeFocus.fire(focused); // restored focus from the last session
				this.viewService.setFocusedWorkspace(focused.key, focused.label, { focus: false });
			}
		} catch (error) {
			this.logService.error('[Axis] workspace load failed', error);
			this.loadOk = false;
			this._loaded = true;
			this._onDidChangeWorkspaces.fire();
		}
	}

	/** The daemon changed state: read again now, and poll only while it answers. */
	private onDaemonStatus(): void {
		this.updateDriver();
		this.refresh();
	}

	private updateDriver(): void {
		if (isUsable(sanitizeStatus(this.daemon.status))) {
			this.driver.start(async () => {
				await this.refresh();
				return this.loadOk;
			});
		} else {
			this.driver.stop();
		}
	}
}

registerSingleton(IAxisWorkspaceService, AxisWorkspaceService, InstantiationType.Delayed);
