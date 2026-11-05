/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAxisShowViewOptions, IAxisViewService } from '../../view/browser/axisViewService.js';
import { AxisDataProvenance, IAxisProjectInfo } from '../common/axisWorkspaceData.js';
import { attentionOf, cycleIndex, IAxisWorkspaceEntry, orderEntries } from '../common/axisWorkspaceModel.js';
import { displayName } from '../common/worktreeDiscovery.js';
import { AxisDiscoveryDataSource, workspaceKeyOf } from './axisDiscoveryDataSource.js';

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
	private _loaded = false;
	private _projects: readonly IAxisProjectInfo[] = [];
	private _workspaces: readonly IAxisWorkspaceEntry[] = [];
	private _focusedKey: string | undefined;
	private loading: Promise<void> | undefined;
	private reloadQueued = false;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAxisViewService private readonly viewService: IAxisViewService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.source = this._register(instantiationService.createInstance(AxisDiscoveryDataSource));
		this._focusedKey = this.storageService.get(FOCUSED_WORKSPACE_STORAGE_KEY, StorageScope.WORKSPACE) || undefined;
		this._register(this.source.onDidChange(() => this.refresh()));
		this.refresh();
	}

	get loaded(): boolean { return this._loaded; }
	get projects(): readonly IAxisProjectInfo[] { return this._projects; }
	get workspaces(): readonly IAxisWorkspaceEntry[] { return this._workspaces; }
	get runsProvenance(): AxisDataProvenance { return this.source.runsProvenance; }

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
			const projects = await this.source.listProjects();
			const runs = await this.source.listCliRuns();
			const entries: IAxisWorkspaceEntry[] = [];
			for (const project of projects) {
				const localCheckout = await this.source.getLocalCheckout(project.id);
				for (const worktree of await this.source.listWorktrees(project.id)) {
					const key = workspaceKeyOf(worktree);
					const isLocalCheckout = worktree.path === localCheckout;
					const workspaceRuns = isLocalCheckout ? [] : runs.filter(run => run.workspaceId === key);
					entries.push({
						key,
						project,
						worktree,
						isLocalCheckout,
						label: displayName(basename(worktree.path)),
						runs: workspaceRuns,
						attention: attentionOf(worktree, workspaceRuns),
					});
				}
			}
			if (this._store.isDisposed) {
				return;
			}
			const hadFocus = this.focused;
			this._projects = projects;
			this._workspaces = orderEntries(entries, projects.map(p => p.id));
			this._loaded = true;
			this._onDidChangeWorkspaces.fire();

			const focused = this.focused;
			if (hadFocus && !focused) {
				this.focus(undefined, { focus: false }); // the focused worktree went away
			} else if (!hadFocus && focused) {
				this._onDidChangeFocus.fire(focused); // restored focus from the last session
				this.viewService.setFocusedWorkspace(focused.key, focused.label, { focus: false });
			}
		} catch (error) {
			this.logService.error('[Axis] workspace discovery failed', error);
			this._loaded = true;
			this._onDidChangeWorkspaces.fire();
		}
	}
}

registerSingleton(IAxisWorkspaceService, AxisWorkspaceService, InstantiationType.Delayed);
