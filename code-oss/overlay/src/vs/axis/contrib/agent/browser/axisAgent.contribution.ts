/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/axisAgent.css';
import { $, Dimension } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IAxisAgentPartContent, IAxisWorkbenchLayoutService } from '../../../browser/axisLayoutService.js';
import { IAxisViewService } from '../../../services/view/browser/axisViewService.js';
import { IAxisWorkspaceService } from '../../../services/workspaces/browser/axisWorkspaceService.js';
import { AXIS_SAMPLE_RUNS_SETTING } from '../../../services/workspaces/common/axisSampleRuns.js';
import { AxisDashboardView, IAxisTerminalCounts } from './dashboardView.js';

const AXIS_CATEGORY = localize2('axis.agent.category', "Axis");

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'axis',
	properties: {
		[AXIS_SAMPLE_RUNS_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('axis.preview.sampleRuns', "Show sample CLI runs on the dashboard, labelled as sample data, until the Axis service exists."),
		}
	}
});

/** Terminals per workspace come with the workspace view; until then every count is zero. */
const NO_TERMINALS: IAxisTerminalCounts = { count: () => 0 };

/**
 * The agent part's content: the dashboard (docs/design/axis-agent-shell.md
 * section 4.2). Opening a row focuses that workspace; its view follows.
 */
class AxisAgentContent extends Disposable implements IAxisAgentPartContent {

	readonly element = $('.axis-agent-view');
	private readonly dashboard: AxisDashboardView;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAxisWorkspaceService private readonly workspaceService: IAxisWorkspaceService,
		@IAxisWorkbenchLayoutService private readonly layoutService: IAxisWorkbenchLayoutService,
	) {
		super();
		this.dashboard = this._register(instantiationService.createInstance(AxisDashboardView, NO_TERMINALS));
		this.element.appendChild(this.dashboard.element);
		this._register(this.workspaceService.onDidChangeWorkspaces(() => this.focusIfLost()));
		this.layoutService.whenRestored.then(() => {
			this.focusIfLost();
			setTimeout(() => this.focusIfLost(), 0); // after upstream's own post-restore focus
		});
	}

	/**
	 * The content renders after an asynchronous read; upstream restore may have
	 * put focus on the hidden editor meanwhile. Focus never stays on the body
	 * while the agent part shows (docs/UX.md focus rule 2).
	 */
	private focusIfLost(): void {
		if (this._store.isDisposed) {
			return;
		}
		const active = this.element.ownerDocument.activeElement;
		// Lost: the body, or an element that is not rendered (inside the hidden editor).
		const lost = !active || active === this.element.ownerDocument.body || active.getClientRects().length === 0;
		if (lost && this.layoutService.isAgentPartVisible()) {
			this.focus();
		}
	}

	layout(dimension: Dimension): void {
		this.dashboard.layout(dimension);
	}

	focus(): void {
		this.dashboard.focus();
	}
}

/** Puts the agent content into the agent part once the part exists. */
class AxisAgentContentContribution extends Disposable {
	static readonly ID = 'workbench.contrib.axisAgentContent';

	constructor(
		@IAxisWorkbenchLayoutService layoutService: IAxisWorkbenchLayoutService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const install = () => {
			const content = this._register(instantiationService.createInstance(AxisAgentContent));
			layoutService.getAgentPart()?.setContent(content);
		};
		if (layoutService.hasAgentPart()) {
			install();
		} else {
			this._register(Event.once(layoutService.onDidCreateAgentPart)(install));
		}
	}
}

registerWorkbenchContribution2(AxisAgentContentContribution.ID, AxisAgentContentContribution, WorkbenchPhase.BlockRestore);

// Commands and shortcuts: docs/UX.md "Keyboard" (decision D-7).

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.dashboard.show',
			title: localize2('axis.dashboard.show', "Show Dashboard"),
			category: AXIS_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.Digit0,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.Digit0 },
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAxisWorkspaceService).focus(undefined, { focus: false });
		accessor.get(IAxisViewService).show('agent'); // in split mode: focus the agent half
	}
});

for (let n = 1; n <= 9; n++) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `axis.workspace.focus.${n}`,
				title: localize2('axis.workspace.focusN', "Focus Workspace {0}", n),
				category: AXIS_CATEGORY,
				f1: true,
				keybinding: {
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | (KeyCode.Digit0 + n),
					mac: { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyMod.CtrlCmd | (KeyCode.Digit0 + n) },
				}
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IAxisWorkspaceService).focusIndex(n - 1);
		}
	});
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.workspace.next',
			title: localize2('axis.workspace.next', "Focus Next Workspace"),
			category: AXIS_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.BracketRight,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.BracketRight },
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAxisWorkspaceService).focusRelative(1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.workspace.previous',
			title: localize2('axis.workspace.previous', "Focus Previous Workspace"),
			category: AXIS_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.BracketLeft,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.BracketLeft },
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAxisWorkspaceService).focusRelative(-1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.workspaces.refresh',
			title: localize2('axis.workspaces.refresh', "Refresh Workspaces"),
			category: AXIS_CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IAxisWorkspaceService).refresh();
	}
});
