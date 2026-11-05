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
import { IAxisLayoutRequest, isAxisViewKind, sameLayoutRequest, toAxisSplitCollapse } from '../common/axisView.js';
import { AXIS_AGENT_PART_ID, IAxisAgentPart, IAxisWorkbenchLayoutService } from './axisLayoutService.js';
import { axisPartVisibility, IAxisIdePartsState, parseIdePartsState, showsIdeParts } from './axisViewLayout.js';
import { AgentPart } from './parts/agentPart.js';

/** IDE-view visibility of the parts the Agent view hides, kept while they are hidden. */
const IDE_PARTS_STORAGE_KEY = 'axis.layout.ideParts';
/** The layout shown last in this Code OSS workspace, used to read restored upstream state. */
const LAST_LAYOUT_STORAGE_KEY = 'axis.layout.last';
/** Share of the agent half in split mode (docs/design/axis-agent-shell.md section 3.6). */
const SPLIT_RATIO_STORAGE_KEY = 'axis.layout.splitRatio';
const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * Reads the upstream layout's grid.
 *
 * `Layout.workbenchGrid` is private upstream and the grid offers no extension
 * point for a new part. Axis reads the field instead of patching `layout.ts`
 * (ADR 0002 decision 2). `AxisWorkbench.createWorkbenchLayout` calls this at
 * startup, so an upstream sync that renames the field fails the first launch
 * with this message instead of misbehaving later.
 */
export function getUpstreamWorkbenchGrid(layout: object): SerializableGrid<ISerializableView> {
	const grid = (layout as { readonly workbenchGrid?: unknown }).workbenchGrid;
	if (!(grid instanceof SerializableGrid)) {
		throw new Error('Axis: the upstream workbench grid (Layout.workbenchGrid) was not found; update AxisWorkbench for this Code OSS version.');
	}
	return grid;
}

export function parseLayoutRequest(raw: string | undefined): IAxisLayoutRequest | undefined {
	if (!raw) {
		return undefined;
	}
	if (isAxisViewKind(raw)) {
		return { kind: raw, collapsed: 'none' };
	}
	if (raw.startsWith('split')) {
		return { kind: 'split', collapsed: toAxisSplitCollapse(raw.slice('split:'.length)) };
	}
	return undefined;
}

function serializeLayoutRequest(request: IAxisLayoutRequest): string {
	return request.kind === 'split' ? `split:${request.collapsed}` : request.kind;
}

/**
 * The Axis workbench (docs/design/axis-agent-shell.md section 3). It is the
 * upstream workbench, so the IDE view is the upstream layout unchanged, plus
 * the agent part as one more leaf of the same grid, to the right of the
 * editor. A layout swap changes part visibility and sizes only.
 *
 * Upstream treats "editor hidden" as "panel maximized" (`isPanelMaximized`,
 * `toggleMaximizedPanel`) and forces the panel open when the editor hides.
 * While the agent part replaces the editor, `isPanelMaximized`,
 * `toggleMaximizedPanel` and (during the swap only) `isVisible` are
 * overridden so that the panel keeps the user's visibility.
 */
export class AxisWorkbench extends Workbench implements IAxisWorkbenchLayoutService {

	private readonly _onDidCreateAgentPart = this._register(new Emitter<void>());
	readonly onDidCreateAgentPart = this._onDidCreateAgentPart.event;

	private readonly _onDidApplyLayout = this._register(new Emitter<IAxisLayoutRequest>());
	readonly onDidApplyLayout = this._onDidApplyLayout.event;

	private readonly _onDidRequestIdeView = this._register(new Emitter<void>());
	readonly onDidRequestIdeView = this._onDidRequestIdeView.event;

	private axisInstantiationService: IInstantiationService | undefined;
	private axisStorageService: IStorageService | undefined;
	private agentPart: AgentPart | undefined;
	private _appliedLayout: IAxisLayoutRequest | undefined;
	private swapping = false;
	private suppressForcedPanel = false;

	get appliedLayout(): IAxisLayoutRequest | undefined {
		return this._appliedLayout;
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
				if (e.isExplicit && this.agentReplacesEditor() && !this.swapping && editorService.visibleEditors.length > 0) {
					this._onDidRequestIdeView.fire();
				}
			}));
		});

		this._register(this.onWillShutdown(() => this.storeSplitRatio()));
	}

	protected override createWorkbenchLayout(): void {
		super.createWorkbenchLayout();

		const instantiationService = this.axisInstantiationService;
		if (!instantiationService) {
			throw new Error('Axis: initLayout must run before createWorkbenchLayout.');
		}

		// Startup assertion for the guarded accessor: fails the launch loudly if the field moved.
		const grid = getUpstreamWorkbenchGrid(this);

		const container = document.createElement('div');
		container.classList.add('part', 'axis-agent');
		container.id = AXIS_AGENT_PART_ID;
		container.setAttribute('role', 'region');
		container.setAttribute('aria-label', localize('axis.agentPart', "Agent view"));

		const agentPart = this.agentPart = this._register(instantiationService.createInstance(AgentPart));
		agentPart.create(container);

		// Right of the editor: in split mode the IDE half (activity bar, side bar,
		// editor) stays contiguous and the panel spans both halves.
		const editorPart = this.getPart(Parts.EDITOR_PART);
		const editorSize = grid.getViewSize(editorPart);
		grid.addView(agentPart, Sizing.Invisible(Math.max(agentPart.minimumWidth, Math.floor(editorSize.width / 2))), editorPart, Direction.Right);

		this._register(agentPart.onDidRequestCollapse(collapsed => {
			if (this._appliedLayout?.kind === 'split') {
				this.applyLayout({ kind: 'split', collapsed });
			}
		}));

		// Upstream restore (the last side bar view, editors) can reveal IDE parts
		// after the Axis layout was applied: re-assert it once restore is done,
		// and only then treat a revealed IDE part as a request for the IDE view
		// (an editor opened by an upstream path, a command that opens a side bar view).
		this.whenRestored.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.reassertLayout();
			this._register(this.onDidChangePartVisibility(e => {
				if ((e.partId === Parts.EDITOR_PART || e.partId === Parts.SIDEBAR_PART) && e.visible && this.agentReplacesEditor() && !this.swapping) {
					this._onDidRequestIdeView.fire();
				}
			}));
		});

		this._onDidCreateAgentPart.fire();
	}

	/** The Agent view, or a split whose IDE half is collapsed: the editor is hidden on purpose. */
	private agentReplacesEditor(): boolean {
		const applied = this._appliedLayout;
		return !!applied && (applied.kind === 'agent' || (applied.kind === 'split' && applied.collapsed === 'ide'));
	}

	hasAgentPart(): boolean {
		return !!this.agentPart;
	}

	getAgentPart(): IAxisAgentPart | undefined {
		return this.agentPart;
	}

	isAgentPartVisible(): boolean {
		return !!this.agentPart && getUpstreamWorkbenchGrid(this).isViewVisible(this.agentPart);
	}

	focusAgentPart(): void {
		this.agentPart?.focus();
	}

	applyLayout(request: IAxisLayoutRequest): void {
		const agentPart = this.agentPart;
		if (!agentPart || sameLayoutRequest(this._appliedLayout, request)) {
			return;
		}

		const previous = this._appliedLayout ?? this.readLastLayout();
		const grid = getUpstreamWorkbenchGrid(this);
		const wasSplit = previous.kind === 'split' && this._appliedLayout !== undefined;

		this.swapping = true;
		try {
			if (wasSplit && previous.collapsed === 'none') {
				this.storeSplitRatio();
			}

			// Remember the IDE parts before a layout that hides them, unless the
			// restored upstream layout already is such a layout.
			if (showsIdeParts(previous)) {
				this.storeIdePartsState({
					activityBar: this.isVisible(Parts.ACTIVITYBAR_PART),
					sideBar: this.isVisible(Parts.SIDEBAR_PART)
				});
			}

			const target = axisPartVisibility(request, this.readIdePartsState());
			this._appliedLayout = request;

			if (target.editor) {
				this.setPartHidden(false, Parts.EDITOR_PART);
			}

			agentPart.setHeaderState({ split: request.kind === 'split', collapsed: request.kind === 'split' ? request.collapsed : 'none' });
			grid.setViewVisible(agentPart, target.agent);

			if (showsIdeParts(request)) {
				// Back to the IDE parts: restore what the user had, keeping any part
				// that was revealed to get here. Otherwise the restored upstream
				// layout already shows the IDE parts; leave them alone.
				if (!showsIdeParts(previous)) {
					if (target.activityBar && !this.isVisible(Parts.ACTIVITYBAR_PART)) {
						this.setPartHidden(false, Parts.ACTIVITYBAR_PART);
					}
					if (target.sideBar && !this.isVisible(Parts.SIDEBAR_PART)) {
						this.setPartHidden(false, Parts.SIDEBAR_PART);
					}
				}
			} else {
				this.setPartHidden(true, Parts.ACTIVITYBAR_PART);
				this.setPartHidden(true, Parts.SIDEBAR_PART);
			}

			if (!target.editor) {
				// Upstream shows the panel whenever the editor hides (and opens its
				// view, which can start a terminal). Keep the user's panel visibility.
				this.suppressForcedPanel = true;
				try {
					this.setPartHidden(true, Parts.EDITOR_PART);
				} finally {
					this.suppressForcedPanel = false;
				}
			}

			if (request.kind === 'split' && request.collapsed === 'none' && target.editor) {
				this.restoreSplitRatio(grid, agentPart);
			}
		} finally {
			this.swapping = false;
		}

		this.axisStorageService?.store(LAST_LAYOUT_STORAGE_KEY, serializeLayoutRequest(request), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidApplyLayout.fire(request);
	}

	/** Hides again the IDE parts that the applied layout hides, if restore showed them. */
	private reassertLayout(): void {
		const applied = this._appliedLayout;
		if (!applied || showsIdeParts(applied)) {
			return;
		}
		this.swapping = true;
		try {
			this.setPartHidden(true, Parts.ACTIVITYBAR_PART);
			this.setPartHidden(true, Parts.SIDEBAR_PART);
			if (this.isVisible(Parts.EDITOR_PART)) {
				this.suppressForcedPanel = true;
				try {
					this.setPartHidden(true, Parts.EDITOR_PART);
				} finally {
					this.suppressForcedPanel = false;
				}
			}
		} finally {
			this.swapping = false;
		}
	}

	override isVisible(part: Parts, targetWindow?: Window): boolean {
		if (this.suppressForcedPanel && part === Parts.PANEL_PART) {
			return true; // see applyLayout: stops `setEditorHidden` from forcing the panel open
		}
		return super.isVisible(part, targetWindow);
	}

	override isPanelMaximized(): boolean {
		if (this.agentReplacesEditor()) {
			return false; // the editor is hidden by the Axis layout, not by a maximized panel
		}
		return super.isPanelMaximized();
	}

	override toggleMaximizedPanel(): void {
		if (this.agentReplacesEditor()) {
			return; // maximizing the panel over the agent part is not supported in Phase 0
		}
		super.toggleMaximizedPanel();
	}

	private storeSplitRatio(): void {
		const agentPart = this.agentPart;
		if (!agentPart || this._appliedLayout?.kind !== 'split' || this._appliedLayout.collapsed !== 'none') {
			return;
		}
		const grid = getUpstreamWorkbenchGrid(this);
		const agentWidth = grid.getViewSize(agentPart).width;
		const editorWidth = grid.getViewSize(this.getPart(Parts.EDITOR_PART)).width;
		if (agentWidth > 0 && editorWidth > 0) {
			this.axisStorageService?.store(SPLIT_RATIO_STORAGE_KEY, String(agentWidth / (agentWidth + editorWidth)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	private restoreSplitRatio(grid: SerializableGrid<ISerializableView>, agentPart: AgentPart): void {
		const stored = Number(this.axisStorageService?.get(SPLIT_RATIO_STORAGE_KEY, StorageScope.WORKSPACE));
		const ratio = Number.isFinite(stored) && stored > 0.1 && stored < 0.9 ? stored : DEFAULT_SPLIT_RATIO;
		const agentSize = grid.getViewSize(agentPart);
		const total = agentSize.width + grid.getViewSize(this.getPart(Parts.EDITOR_PART)).width;
		if (total > 0) {
			grid.resizeView(agentPart, { width: Math.round(total * ratio), height: agentSize.height });
		}
	}

	private readLastLayout(): IAxisLayoutRequest {
		return parseLayoutRequest(this.axisStorageService?.get(LAST_LAYOUT_STORAGE_KEY, StorageScope.WORKSPACE)) ?? { kind: 'ide', collapsed: 'none' };
	}

	private readIdePartsState(): IAxisIdePartsState {
		return parseIdePartsState(this.axisStorageService?.get(IDE_PARTS_STORAGE_KEY, StorageScope.WORKSPACE));
	}

	private storeIdePartsState(state: IAxisIdePartsState): void {
		this.axisStorageService?.store(IDE_PARTS_STORAGE_KEY, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
