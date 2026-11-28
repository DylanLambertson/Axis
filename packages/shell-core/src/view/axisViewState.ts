// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/view/common/axisViewState.ts) by OS-5. The Code OSS storage service is
// replaced by the two-scope key-value store below; the desktop app backs it (OS-6).

import { DEFAULT_AXIS_VIEW, isAxisViewKind, toAxisSplitCollapse, type AxisSplitCollapse, type AxisViewKind } from './axisView.js';

/** `application`: one value for every project. `workspace`: one value per opened project. */
export type AxisStorageScope = 'application' | 'workspace';

/** The storage the view state needs: string values under a key, in one of two scopes. */
export interface IAxisViewStorage {
	get(key: string, scope: AxisStorageScope): string | undefined;
	store(key: string, value: string, scope: AxisStorageScope): void;
}

/** Per-workspace view records, in the per-project scope (design section 3.6). */
export const AXIS_WORKSPACE_VIEWS_STORAGE_KEY = 'axis.view.workspaces';
/** The view used in `global` mode, for every project. */
export const AXIS_GLOBAL_VIEW_STORAGE_KEY = 'axis.view.global';
/** Which split half is collapsed. */
export const AXIS_SPLIT_COLLAPSED_STORAGE_KEY = 'axis.view.split.collapsed';

/** The key used for the window while no workspace is focused (the dashboard). */
export const NO_WORKSPACE_KEY = '';

/** Upper bound on remembered workspaces per project; the oldest records are dropped first. */
export const MAX_WORKSPACE_VIEW_RECORDS = 256;

interface IWorkspaceViewRecord {
	readonly view: AxisViewKind;
}

/**
 * The persisted view state of the view service (design section 3.3): one view
 * per workspace in `perWorkspace` mode, one view for all in `global` mode, and
 * the collapsed half in `split` mode. Every key is under `axis.*`.
 */
export class AxisViewState {

	constructor(private readonly storageService: IAxisViewStorage) { }

	get(mode: 'perWorkspace' | 'global', workspaceId: string | undefined): AxisViewKind {
		if (mode === 'global') {
			const value = this.storageService.get(AXIS_GLOBAL_VIEW_STORAGE_KEY, 'application');
			return isAxisViewKind(value) ? value : DEFAULT_AXIS_VIEW;
		}

		return this.readWorkspaceRecords().get(workspaceId ?? NO_WORKSPACE_KEY)?.view ?? DEFAULT_AXIS_VIEW;
	}

	set(mode: 'perWorkspace' | 'global', workspaceId: string | undefined, view: AxisViewKind): void {
		if (mode === 'global') {
			this.storageService.store(AXIS_GLOBAL_VIEW_STORAGE_KEY, view, 'application');
			return;
		}

		const records = this.readWorkspaceRecords();
		const key = workspaceId ?? NO_WORKSPACE_KEY;
		records.delete(key); // re-insert so the most recent record is last
		records.set(key, { view });
		while (records.size > MAX_WORKSPACE_VIEW_RECORDS) {
			const oldest = records.keys().next();
			if (oldest.done) {
				break;
			}
			records.delete(oldest.value);
		}

		this.storageService.store(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, JSON.stringify(Object.fromEntries(records)), 'workspace');
	}

	getSplitCollapsed(): AxisSplitCollapse {
		return toAxisSplitCollapse(this.storageService.get(AXIS_SPLIT_COLLAPSED_STORAGE_KEY, 'workspace'));
	}

	setSplitCollapsed(collapsed: AxisSplitCollapse): void {
		this.storageService.store(AXIS_SPLIT_COLLAPSED_STORAGE_KEY, collapsed, 'workspace');
	}

	private readWorkspaceRecords(): Map<string, IWorkspaceViewRecord> {
		const records = new Map<string, IWorkspaceViewRecord>();
		const raw = this.storageService.get(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, 'workspace');
		if (!raw) {
			return records;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return records;
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return records;
		}

		for (const [key, value] of Object.entries(parsed)) {
			const view = (value as Partial<IWorkspaceViewRecord> | null)?.view;
			if (isAxisViewKind(view)) {
				records.set(key, { view });
			}
		}
		return records;
	}
}
