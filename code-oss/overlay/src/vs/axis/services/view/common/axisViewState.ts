/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AxisViewKind, AxisViewMode, DEFAULT_AXIS_VIEW, isAxisViewKind } from '../../../common/axisView.js';

/** Per-workspace view records, in the per-project Code OSS workspace (design section 3.6). */
export const AXIS_WORKSPACE_VIEWS_STORAGE_KEY = 'axis.view.workspaces';
/** The view used in `global` mode, for every project. */
export const AXIS_GLOBAL_VIEW_STORAGE_KEY = 'axis.view.global';

/** The key used for the window while no workspace is focused (the dashboard). */
export const NO_WORKSPACE_KEY = '';

/** Upper bound on remembered workspaces per project; the oldest records are dropped first. */
export const MAX_WORKSPACE_VIEW_RECORDS = 256;

interface IWorkspaceViewRecord {
	readonly view: AxisViewKind;
}

/**
 * The persisted view state of `IAxisViewService` (design section 3.3): one view
 * per workspace in `perWorkspace` mode, one view for all in `global` mode.
 */
export class AxisViewState {

	constructor(private readonly storageService: IStorageService) { }

	get(mode: AxisViewMode, workspaceId: string | undefined): AxisViewKind {
		if (mode === 'global') {
			const value = this.storageService.get(AXIS_GLOBAL_VIEW_STORAGE_KEY, StorageScope.APPLICATION);
			return isAxisViewKind(value) ? value : DEFAULT_AXIS_VIEW;
		}

		return this.readWorkspaceRecords().get(workspaceId ?? NO_WORKSPACE_KEY)?.view ?? DEFAULT_AXIS_VIEW;
	}

	set(mode: AxisViewMode, workspaceId: string | undefined, view: AxisViewKind): void {
		if (mode === 'global') {
			this.storageService.store(AXIS_GLOBAL_VIEW_STORAGE_KEY, view, StorageScope.APPLICATION, StorageTarget.MACHINE);
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

		this.storageService.store(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, JSON.stringify(Object.fromEntries(records)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private readWorkspaceRecords(): Map<string, IWorkspaceViewRecord> {
		const records = new Map<string, IWorkspaceViewRecord>();
		const raw = this.storageService.get(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, StorageScope.WORKSPACE);
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
