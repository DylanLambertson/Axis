/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAxisWorkbenchLayoutService } from '../../../browser/axisLayoutService.js';
import { AXIS_VIEW_MODE_SETTING, AxisViewKind, AxisViewMode, toAxisViewMode } from '../../../common/axisView.js';
import { AxisViewState } from '../common/axisViewState.js';

/** `agent` or `ide`: the view the window shows. */
export const AxisViewContext = new RawContextKey<string>('axis.view', 'ide', localize('axis.view.context', "The Axis view the window shows: agent or ide."));
/** The id of the focused Axis workspace, or empty while the dashboard shows. */
export const AxisFocusedWorkspaceContext = new RawContextKey<string>('axis.focusedWorkspace', '', localize('axis.focusedWorkspace.context', "The id of the focused Axis workspace."));

export interface IAxisShowViewOptions {
	/** Move keyboard focus into the view. Default true. */
	readonly focus?: boolean;
}

export const IAxisViewService = createDecorator<IAxisViewService>('axisViewService');

/**
 * Which Axis view the window shows, per workspace or globally
 * (docs/design/axis-agent-shell.md section 3.3).
 */
export interface IAxisViewService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeView: Event<AxisViewKind>;

	readonly mode: AxisViewMode;

	/** The view the window shows now. */
	readonly activeView: AxisViewKind;

	/** The focused workspace id, or `undefined` while nothing is focused. */
	readonly focusedWorkspaceId: string | undefined;

	/** The view recorded for a workspace (the focused one by default) under the current mode. */
	currentView(workspaceId?: string): AxisViewKind;

	show(view: AxisViewKind, options?: IAxisShowViewOptions): void;

	toggle(): void;

	/**
	 * Records a change of the focused workspace. In `perWorkspace` mode the
	 * window switches to that workspace's view; in `global` mode it keeps the view.
	 */
	setFocusedWorkspace(workspaceId: string | undefined): void;
}

export class AxisViewService extends Disposable implements IAxisViewService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeView = this._register(new Emitter<AxisViewKind>());
	readonly onDidChangeView = this._onDidChangeView.event;

	private readonly state: AxisViewState;
	private readonly viewContext: IContextKey<string>;
	private readonly focusedWorkspaceContext: IContextKey<string>;

	private _mode: AxisViewMode;
	private _focusedWorkspaceId: string | undefined;
	private _activeView: AxisViewKind;

	constructor(
		@IAxisWorkbenchLayoutService private readonly layoutService: IAxisWorkbenchLayoutService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this.state = new AxisViewState(storageService);
		this.viewContext = AxisViewContext.bindTo(contextKeyService);
		this.focusedWorkspaceContext = AxisFocusedWorkspaceContext.bindTo(contextKeyService);

		this._mode = toAxisViewMode(this.configurationService.getValue(AXIS_VIEW_MODE_SETTING));
		this._activeView = this.state.get(this._mode, undefined);

		if (this.layoutService.hasAgentPart()) {
			this.applyToLayout(this._activeView, false);
		} else {
			this._register(Event.once(this.layoutService.onDidCreateAgentPart)(() => this.applyToLayout(this._activeView, false)));
		}

		// A restored Agent view hides the editor that upstream would focus: never leave focus on the body
		this.layoutService.whenRestored.then(() => this.focusIfLost());

		this._register(this.layoutService.onDidRequestIdeView(() => {
			this.show('ide', { focus: false });
			this.focusIfLost();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AXIS_VIEW_MODE_SETTING)) {
				this._mode = toAxisViewMode(this.configurationService.getValue(AXIS_VIEW_MODE_SETTING));
				this.applyToLayout(this.currentView(), false);
			}
		}));
	}

	get mode(): AxisViewMode {
		return this._mode;
	}

	get activeView(): AxisViewKind {
		return this._activeView;
	}

	get focusedWorkspaceId(): string | undefined {
		return this._focusedWorkspaceId;
	}

	currentView(workspaceId: string | undefined = this._focusedWorkspaceId): AxisViewKind {
		return this.state.get(this._mode, workspaceId);
	}

	show(view: AxisViewKind, options?: IAxisShowViewOptions): void {
		this.state.set(this._mode, this._focusedWorkspaceId, view);
		this.applyToLayout(view, options?.focus !== false);
	}

	toggle(): void {
		this.show(this._activeView === 'agent' ? 'ide' : 'agent');
	}

	setFocusedWorkspace(workspaceId: string | undefined): void {
		if (workspaceId === this._focusedWorkspaceId) {
			return;
		}

		this._focusedWorkspaceId = workspaceId;
		this.focusedWorkspaceContext.set(workspaceId ?? '');

		if (this._mode === 'perWorkspace') {
			this.applyToLayout(this.currentView(workspaceId), false);
		}
	}

	private focusIfLost(): void {
		if (this._store.isDisposed) {
			return;
		}
		const active = getActiveElement();
		if (active && active !== active.ownerDocument.body) {
			return;
		}
		if (this._activeView === 'agent') {
			this.layoutService.focusAgentPart();
		} else {
			this.layoutService.focusPart(Parts.EDITOR_PART, mainWindow);
		}
	}

	private applyToLayout(view: AxisViewKind, focus: boolean): void {
		const changed = view !== this._activeView;
		this._activeView = view;
		this.viewContext.set(view);
		this.layoutService.applyView(view);

		if (focus) {
			if (view === 'agent') {
				this.layoutService.focusAgentPart();
			} else {
				this.layoutService.focusPart(Parts.EDITOR_PART, mainWindow);
			}
		}

		if (changed) {
			status(view === 'agent' ? localize('axis.view.agent.announce', "Agent view") : localize('axis.view.ide.announce', "IDE view"));
			this._onDidChangeView.fire(view);
		}
	}
}

registerSingleton(IAxisViewService, AxisViewService, InstantiationType.Delayed);
