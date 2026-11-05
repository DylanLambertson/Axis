/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement, isAncestor, isHTMLElement } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ITextEditorSelection } from '../../../../platform/editor/common/editor.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IAxisWorkbenchLayoutService } from '../../../browser/axisLayoutService.js';
import { AXIS_VIEW_MODE_SETTING, AxisLayoutKind, AxisSplitCollapse, AxisViewKind, AxisViewMode, IAxisLayoutRequest, toAxisViewMode } from '../../../common/axisView.js';
import { AxisViewState } from '../common/axisViewState.js';
import { AxisFocusMemory } from './axisFocusMemory.js';

/** `agent`, `ide` or `split`: what the window shows. */
export const AxisViewContext = new RawContextKey<string>('axis.view', 'ide', localize('axis.view.context', "What the Axis window shows: agent, ide or split."));
/** The id of the focused Axis workspace, or empty while the dashboard shows. */
export const AxisFocusedWorkspaceContext = new RawContextKey<string>('axis.focusedWorkspace', '', localize('axis.focusedWorkspace.context', "The id of the focused Axis workspace."));

export interface IAxisShowViewOptions {
	/** Move keyboard focus into the view. Default true. */
	readonly focus?: boolean;
}

/** A location to open in the IDE view (docs/design/axis-agent-shell.md section 3.4). */
export interface IAxisRevealTarget {
	readonly resource: URI;
	readonly selection?: ITextEditorSelection;
}

export interface IAxisViewChange {
	readonly layout: AxisLayoutKind;
	/** The view that has (or receives) focus; in split mode, the focused half. */
	readonly view: AxisViewKind;
}

export const IAxisViewService = createDecorator<IAxisViewService>('axisViewService');

/**
 * Which Axis view the window shows, per workspace, globally or split
 * (docs/design/axis-agent-shell.md sections 3.3 to 3.5, docs/UX.md "View switching").
 */
export interface IAxisViewService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeView: Event<IAxisViewChange>;

	readonly mode: AxisViewMode;

	/** The view the window shows now; in split mode, the half that last had focus. */
	readonly activeView: AxisViewKind;

	/** The collapsed half in split mode. */
	readonly splitCollapsed: AxisSplitCollapse;

	/** The focused workspace id, or `undefined` while the dashboard shows. */
	readonly focusedWorkspaceId: string | undefined;

	/** The view recorded for a workspace (the focused one by default) under the current mode. */
	currentView(workspaceId?: string): AxisViewKind;

	/** Shows a view. In split mode, moves focus to that half (expanding it if collapsed). */
	show(view: AxisViewKind, options?: IAxisShowViewOptions): void;

	/** Toggles the view; in split mode, moves focus to the other half. */
	toggle(): void;

	/** Opens a location in the IDE view per mode: switches to it, or opens in the IDE half. */
	reveal(target: IAxisRevealTarget): Promise<void>;

	/**
	 * Records a change of the focused workspace (`undefined`: the dashboard). In
	 * `perWorkspace` mode the window switches to that workspace's view.
	 */
	setFocusedWorkspace(workspaceId: string | undefined, label?: string, options?: IAxisShowViewOptions): void;

	/** Collapses a split half to its header, or expands both (`none`). No effect outside split mode. */
	setSplitCollapsed(collapsed: AxisSplitCollapse): void;
}

export class AxisViewService extends Disposable implements IAxisViewService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeView = this._register(new Emitter<IAxisViewChange>());
	readonly onDidChangeView = this._onDidChangeView.event;

	private readonly state: AxisViewState;
	private readonly focusMemory = new AxisFocusMemory();
	private readonly viewContext: IContextKey<string>;
	private readonly focusedWorkspaceContext: IContextKey<string>;

	private _mode: AxisViewMode;
	private _focusedWorkspaceId: string | undefined;
	private _focusedWorkspaceLabel: string | undefined;
	private _activeView: AxisViewKind;

	constructor(
		@IAxisWorkbenchLayoutService private readonly layoutService: IAxisWorkbenchLayoutService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		this.state = new AxisViewState(storageService);
		this.viewContext = AxisViewContext.bindTo(contextKeyService);
		this.focusedWorkspaceContext = AxisFocusedWorkspaceContext.bindTo(contextKeyService);

		this._mode = toAxisViewMode(this.configurationService.getValue(AXIS_VIEW_MODE_SETTING));
		this._activeView = this._mode === 'split' ? 'agent' : this.state.get(this._mode, undefined);

		if (this.layoutService.hasAgentPart()) {
			this.applyLayout(undefined);
		} else {
			this._register(Event.once(this.layoutService.onDidCreateAgentPart)(() => this.applyLayout(undefined)));
		}

		// A restored Agent view hides the editor that upstream would focus: never leave focus on the body
		this.layoutService.whenRestored.then(() => this.focusIfLost());

		this._register(this.layoutService.onDidRequestIdeView(() => {
			if (this._mode === 'split') {
				this.setSplitCollapsed('none');
			} else {
				this.show('ide', { focus: false });
			}
			this.focusIfLost();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AXIS_VIEW_MODE_SETTING)) {
				const mode = toAxisViewMode(this.configurationService.getValue(AXIS_VIEW_MODE_SETTING));
				if (mode !== this._mode) {
					this.rememberFocus();
					this._mode = mode;
					this._activeView = mode === 'split' ? this._activeView : this.currentView();
					this.applyLayout(this._activeView);
				}
			}
		}));
	}

	get mode(): AxisViewMode {
		return this._mode;
	}

	get activeView(): AxisViewKind {
		return this._activeView;
	}

	get splitCollapsed(): AxisSplitCollapse {
		return this.state.getSplitCollapsed();
	}

	get focusedWorkspaceId(): string | undefined {
		return this._focusedWorkspaceId;
	}

	currentView(workspaceId: string | undefined = this._focusedWorkspaceId): AxisViewKind {
		return this._mode === 'split' ? this._activeView : this.state.get(this._mode, workspaceId);
	}

	show(view: AxisViewKind, options?: IAxisShowViewOptions): void {
		this.rememberFocus();
		if (this._mode === 'split') {
			const collapsed = this.state.getSplitCollapsed();
			if (collapsed === view) {
				this.state.setSplitCollapsed('none');
			}
		} else {
			this.state.set(this._mode, this._focusedWorkspaceId, view);
		}
		this._activeView = view;
		this.applyLayout(options?.focus === false ? undefined : view);
	}

	toggle(): void {
		if (this._mode === 'split') {
			const agentHasFocus = this.layoutService.getAgentPart()?.hasFocus() ?? false;
			this.show(agentHasFocus ? 'ide' : 'agent');
			return;
		}
		this.show(this._activeView === 'agent' ? 'ide' : 'agent');
	}

	async reveal(target: IAxisRevealTarget): Promise<void> {
		this.rememberFocus();
		if (this._mode === 'split') {
			if (this.state.getSplitCollapsed() === 'ide') {
				this.state.setSplitCollapsed('none');
			}
		} else {
			this.state.set(this._mode, this._focusedWorkspaceId, 'ide');
		}
		this._activeView = 'ide';
		this.applyLayout(undefined);

		// Focus rule 1: opening a location focuses the editor at that file and line.
		await this.editorService.openEditor({
			resource: target.resource,
			options: { selection: target.selection, revealIfOpened: true, pinned: true }
		});
		this.focusIfLost();
	}

	setFocusedWorkspace(workspaceId: string | undefined, label?: string, options?: IAxisShowViewOptions): void {
		if (workspaceId === this._focusedWorkspaceId) {
			this._focusedWorkspaceLabel = label ?? this._focusedWorkspaceLabel;
			return;
		}

		this.rememberFocus();
		this._focusedWorkspaceId = workspaceId;
		this._focusedWorkspaceLabel = label;
		this.focusedWorkspaceContext.set(workspaceId ?? '');

		if (this._mode === 'perWorkspace') {
			this._activeView = this.currentView(workspaceId);
		}
		this.applyLayout(options?.focus === false ? undefined : this._activeView, true);
	}

	setSplitCollapsed(collapsed: AxisSplitCollapse): void {
		if (this._mode !== 'split') {
			return;
		}
		this.rememberFocus();
		this.state.setSplitCollapsed(collapsed);
		// Keep focus out of a half that is collapsing.
		const focusView: AxisViewKind | undefined = collapsed === 'agent' ? 'ide' : collapsed === 'ide' ? 'agent' : undefined;
		if (focusView) {
			this._activeView = focusView;
		}
		this.applyLayout(focusView);
	}

	private layoutRequest(): IAxisLayoutRequest {
		if (this._mode === 'split') {
			return { kind: 'split', collapsed: this.state.getSplitCollapsed() };
		}
		return { kind: this._activeView, collapsed: 'none' };
	}

	/** Records where focus is, so that coming back to that view restores it (focus rule 2). */
	private rememberFocus(): void {
		const active = getActiveElement();
		if (!isHTMLElement(active) || active === active.ownerDocument.body) {
			return;
		}
		const view: AxisViewKind = this.isInAgentPart(active) ? 'agent' : 'ide';
		this.focusMemory.remember(this._focusedWorkspaceId, view, active);
	}

	private isInAgentPart(element: HTMLElement): boolean {
		const agentPart = this.layoutService.getAgentPart();
		return !!agentPart && isAncestor(element, agentPart.element);
	}

	/**
	 * Applies the layout for the current state and, when asked, moves focus into
	 * a view: its last focused element, else its primary region (focus rule 1).
	 */
	private applyLayout(focusView: AxisViewKind | undefined, forceAnnounce = false): void {
		const request = this.layoutRequest();
		const before = this.layoutService.appliedLayout;
		this.viewContext.set(request.kind);
		this.layoutService.applyLayout(request);

		if (focusView) {
			this.focusView(focusView);
		}

		const changed = !before || before.kind !== request.kind || before.collapsed !== request.collapsed;
		if (changed || forceAnnounce || focusView) {
			if (before) {
				this.announce(focusView ?? this._activeView); // not for the layout restored at startup
			}
			this._onDidChangeView.fire({ layout: request.kind, view: focusView ?? this._activeView });
		}
	}

	private focusView(view: AxisViewKind): void {
		const accept = (element: HTMLElement) => {
			const visible = element.getClientRects().length > 0;
			return visible && (view === 'agent' ? this.isInAgentPart(element) : !this.isInAgentPart(element));
		};
		if (this.focusMemory.restore(this._focusedWorkspaceId, view, accept)) {
			return;
		}
		this.focusPrimary(view);
	}

	private focusPrimary(view: AxisViewKind): void {
		if (view === 'agent') {
			this.layoutService.focusAgentPart();
		} else if (this.editorService.activeEditorPane) {
			this.editorService.activeEditorPane.focus();
		} else {
			this.layoutService.focusPart(Parts.EDITOR_PART, mainWindow);
		}
	}

	private focusIfLost(): void {
		if (this._store.isDisposed) {
			return;
		}
		const active = getActiveElement();
		if (active && active !== active.ownerDocument.body && active.getClientRects().length > 0) {
			return; // focus is on a rendered element; an element of a hidden part counts as lost
		}
		this.focusPrimary(this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow) && this._activeView === 'ide' ? 'ide' : 'agent');
	}

	/** Focus rule 3: announce the view and the workspace through a polite live region. */
	private announce(view: AxisViewKind): void {
		const label = this._focusedWorkspaceLabel;
		const where = label ? localize('axis.view.announce.workspace', "workspace {0}", label) : localize('axis.view.announce.dashboard', "dashboard");
		const message = view === 'agent'
			? localize('axis.view.agent.announce', "Agent view, {0}", where)
			: localize('axis.view.ide.announce', "IDE view, {0}", where);
		status(message);
	}
}

registerSingleton(IAxisViewService, AxisViewService, InstantiationType.Delayed);
