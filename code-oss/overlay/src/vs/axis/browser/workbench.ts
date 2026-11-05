/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Direction, ISerializableView, SerializableGrid, Sizing } from '../../base/browser/ui/grid/grid.js';
import { Emitter } from '../../base/common/event.js';
import { localize } from '../../nls.js';
import { IInstantiationService, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { Workbench } from '../../workbench/browser/workbench.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { AxisViewKind, isAxisViewKind } from '../common/axisView.js';
import { AXIS_AGENT_PART_ID, IAxisWorkbenchLayoutService } from './axisLayoutService.js';
import { axisPartVisibility, IAxisIdePartsState, parseIdePartsState } from './axisViewLayout.js';
import { AgentPart } from './parts/agentPart.js';

/** IDE-view visibility of the parts the Agent view hides, kept while the Agent view shows. */
const IDE_PARTS_STORAGE_KEY = 'axis.layout.ideParts';
/** The view the layout showed last in this Code OSS workspace, used to read restored upstream state. */
const LAST_VIEW_STORAGE_KEY = 'axis.layout.lastView';

/**
 * Reads the upstream layout's grid.
 *
 * `Layout.workbenchGrid` is private upstream and the grid offers no extension
 * point for a new part. Axis reads the field instead of patching `layout.ts`
 * (ADR 0002 decision 2); the check fails loudly if an upstream sync renames it.
 */
export function getUpstreamWorkbenchGrid(layout: object): SerializableGrid<ISerializableView> {
	const grid = (layout as { readonly workbenchGrid?: unknown }).workbenchGrid;
	if (!(grid instanceof SerializableGrid)) {
		throw new Error('Axis: the upstream workbench grid (Layout.workbenchGrid) was not found; update AxisWorkbench for this Code OSS version.');
	}
	return grid;
}

/**
 * The Axis workbench (docs/design/axis-agent-shell.md section 3). It is the
 * upstream workbench, so the IDE view is the upstream layout unchanged, plus
 * the agent part as one more leaf of the same grid, above the editor. A view
 * swap changes part visibility only.
 *
 * Upstream treats "editor hidden" as "panel maximized" (`isPanelMaximized`,
 * `toggleMaximizedPanel`) and forces the panel open when the editor hides.
 * While the Agent view hides the editor, `isPanelMaximized`,
 * `toggleMaximizedPanel` and (during the swap only) `isVisible` are
 * overridden so that the panel keeps the user's visibility and showing or
 * hiding it does not bring the editor back.
 */
export class AxisWorkbench extends Workbench implements IAxisWorkbenchLayoutService {

	private readonly _onDidCreateAgentPart = this._register(new Emitter<void>());
	readonly onDidCreateAgentPart = this._onDidCreateAgentPart.event;

	private readonly _onDidApplyView = this._register(new Emitter<AxisViewKind>());
	readonly onDidApplyView = this._onDidApplyView.event;

	private readonly _onDidRequestIdeView = this._register(new Emitter<void>());
	readonly onDidRequestIdeView = this._onDidRequestIdeView.event;

	private axisInstantiationService: IInstantiationService | undefined;
	private axisStorageService: IStorageService | undefined;
	private agentPart: AgentPart | undefined;
	private _appliedView: AxisViewKind | undefined;
	private swapping = false;
	private suppressForcedPanel = false;

	get appliedView(): AxisViewKind | undefined {
		return this._appliedView;
	}

	protected override initLayout(accessor: ServicesAccessor): void {
		super.initLayout(accessor);

		this.axisInstantiationService = accessor.get(IInstantiationService);
		this.axisStorageService = accessor.get(IStorageService);

		// Explicit editor opens while the Agent view shows (decision D-5). Like
		// upstream, listen only once editors have restored, so that restoring
		// the previous session's editors does not count as an open.
		const editorService = accessor.get(IEditorService);
		const editorGroupService = accessor.get(IEditorGroupsService);
		editorGroupService.whenRestored.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			this._register(editorService.onDidVisibleEditorsChange(e => {
				if (e.isExplicit && this._appliedView === 'agent' && !this.swapping && editorService.visibleEditors.length > 0) {
					this._onDidRequestIdeView.fire();
				}
			}));
		});
	}

	protected override createWorkbenchLayout(): void {
		super.createWorkbenchLayout();

		const instantiationService = this.axisInstantiationService;
		if (!instantiationService) {
			throw new Error('Axis: initLayout must run before createWorkbenchLayout.');
		}

		const container = document.createElement('div');
		container.classList.add('part', 'axis-agent');
		container.id = AXIS_AGENT_PART_ID;
		container.setAttribute('role', 'region');
		container.setAttribute('aria-label', localize('axis.agentPart', "Agent"));

		const agentPart = this.agentPart = this._register(instantiationService.createInstance(AgentPart));
		agentPart.create(container);

		const grid = getUpstreamWorkbenchGrid(this);
		const editorPart = this.getPart(Parts.EDITOR_PART);
		grid.addView(agentPart, Sizing.Invisible(Math.max(agentPart.minimumHeight, grid.getViewSize(editorPart).height)), editorPart, Direction.Up);

		// An IDE-only part revealed while the Agent view shows (an editor opened by
		// an upstream path, a command that opens a side bar view): go to the IDE view.
		this._register(this.onDidChangePartVisibility(e => {
			if ((e.partId === Parts.EDITOR_PART || e.partId === Parts.SIDEBAR_PART) && e.visible && this._appliedView === 'agent' && !this.swapping) {
				this._onDidRequestIdeView.fire();
			}
		}));

		this._onDidCreateAgentPart.fire();
	}

	hasAgentPart(): boolean {
		return !!this.agentPart;
	}

	getAgentPart(): AgentPart | undefined {
		return this.agentPart;
	}

	isAgentPartVisible(): boolean {
		return !!this.agentPart && getUpstreamWorkbenchGrid(this).isViewVisible(this.agentPart);
	}

	focusAgentPart(): void {
		this.agentPart?.focus();
	}

	applyView(view: AxisViewKind): void {
		const agentPart = this.agentPart;
		if (!agentPart || view === this._appliedView) {
			return;
		}

		const storage = this.axisStorageService;
		const previous = this._appliedView ?? this.readLastView();
		const grid = getUpstreamWorkbenchGrid(this);

		this.swapping = true;
		try {
			if (view === 'agent') {

				// Remember the IDE view's parts, unless the restored layout already is the Agent view
				if (previous === 'ide') {
					this.storeIdePartsState({
						activityBar: this.isVisible(Parts.ACTIVITYBAR_PART),
						sideBar: this.isVisible(Parts.SIDEBAR_PART)
					});
				}

				this._appliedView = 'agent';
				const target = axisPartVisibility('agent', this.readIdePartsState());

				grid.setViewVisible(agentPart, target.agent);
				this.setPartHidden(!target.activityBar, Parts.ACTIVITYBAR_PART);
				this.setPartHidden(!target.sideBar, Parts.SIDEBAR_PART);

				// Upstream shows the panel whenever the editor hides (and opens its
				// view, which can start a terminal). Keep the user's panel visibility.
				this.suppressForcedPanel = true;
				try {
					this.setPartHidden(!target.editor, Parts.EDITOR_PART);
				} finally {
					this.suppressForcedPanel = false;
				}
			} else {
				const target = axisPartVisibility('ide', this.readIdePartsState());
				this._appliedView = 'ide';

				this.setPartHidden(!target.editor, Parts.EDITOR_PART);
				grid.setViewVisible(agentPart, target.agent);

				// Coming back from the Agent view: restore the IDE view's parts, keeping
				// any part that was revealed to get here. Otherwise the restored upstream
				// layout already is the IDE view; leave it alone.
				if (previous === 'agent') {
					if (target.activityBar && !this.isVisible(Parts.ACTIVITYBAR_PART)) {
						this.setPartHidden(false, Parts.ACTIVITYBAR_PART);
					}
					if (target.sideBar && !this.isVisible(Parts.SIDEBAR_PART)) {
						this.setPartHidden(false, Parts.SIDEBAR_PART);
					}
				}
			}
		} finally {
			this.swapping = false;
		}

		storage?.store(LAST_VIEW_STORAGE_KEY, view, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidApplyView.fire(view);
	}

	override isVisible(part: Parts, targetWindow?: Window): boolean {
		if (this.suppressForcedPanel && part === Parts.PANEL_PART) {
			return true; // see applyView: stops `setEditorHidden` from forcing the panel open
		}
		return super.isVisible(part, targetWindow);
	}

	override isPanelMaximized(): boolean {
		if (this._appliedView === 'agent') {
			return false; // the editor is hidden by the Agent view, not by a maximized panel
		}
		return super.isPanelMaximized();
	}

	override toggleMaximizedPanel(): void {
		if (this._appliedView === 'agent') {
			return; // maximizing the panel over the agent part is not supported in M3
		}
		super.toggleMaximizedPanel();
	}

	private readLastView(): AxisViewKind {
		const value = this.axisStorageService?.get(LAST_VIEW_STORAGE_KEY, StorageScope.WORKSPACE);
		return isAxisViewKind(value) ? value : 'ide';
	}

	private readIdePartsState(): IAxisIdePartsState {
		return parseIdePartsState(this.axisStorageService?.get(IDE_PARTS_STORAGE_KEY, StorageScope.WORKSPACE));
	}

	private storeIdePartsState(state: IAxisIdePartsState): void {
		this.axisStorageService?.store(IDE_PARTS_STORAGE_KEY, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
