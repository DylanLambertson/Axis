/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AXIS_VIEW_MODE_SETTING, AXIS_VIEW_MODES, DEFAULT_AXIS_VIEW_MODE } from '../../../common/axisView.js';
import { IAxisViewService } from '../../../services/view/browser/axisViewService.js';
import { focusNeighbourPart } from '../../../browser/axisPartNavigation.js';

export const AXIS_CATEGORY = localize2('axis.category', "Axis");

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'axis',
	order: 1,
	title: localize('axis.configuration.title', "Axis"),
	type: 'object',
	properties: {
		[AXIS_VIEW_MODE_SETTING]: {
			type: 'string',
			enum: [...AXIS_VIEW_MODES],
			enumDescriptions: [
				localize('axis.view.mode.perWorkspace', "Each workspace remembers whether it shows the Agent view or the IDE view."),
				localize('axis.view.mode.global', "One view applies to every workspace."),
				localize('axis.view.mode.split', "The Agent view and the IDE view side by side."),
			],
			default: DEFAULT_AXIS_VIEW_MODE,
			scope: ConfigurationScope.APPLICATION,
			description: localize('axis.view.mode', "How Axis arranges the Agent view and the IDE view."),
		}
	}
});

/** Creates the view service early, so the restored view is applied when the grid is built. */
class AxisViewStartupContribution {
	static readonly ID = 'workbench.contrib.axisViewStartup';

	constructor(@IAxisViewService _viewService: IAxisViewService) { }
}

registerWorkbenchContribution2(AxisViewStartupContribution.ID, AxisViewStartupContribution, WorkbenchPhase.BlockRestore);

// Shortcuts: docs/design/axis-agent-shell-policies.md section 8 (decision D-7), adopted by docs/UX.md.

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.view.toggle',
			title: localize2('axis.view.toggle', "Toggle Agent and IDE View"),
			category: AXIS_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyV,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyV },
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAxisViewService).toggle();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.view.showAgent',
			title: localize2('axis.view.showAgent', "Show Agent View"),
			category: AXIS_CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAxisViewService).show('agent');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.view.showIde',
			title: localize2('axis.view.showIde', "Show IDE View"),
			category: AXIS_CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAxisViewService).show('ide');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.split.collapseAgent',
			title: localize2('axis.split.collapseAgent', "Collapse or Expand the Agent Pane"),
			category: AXIS_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.equals('axis.view', 'split'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const viewService = accessor.get(IAxisViewService);
		viewService.setSplitCollapsed(viewService.splitCollapsed === 'agent' ? 'none' : 'agent');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.split.collapseIde',
			title: localize2('axis.split.collapseIde', "Collapse or Expand the IDE Pane"),
			category: AXIS_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.equals('axis.view', 'split'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const viewService = accessor.get(IAxisViewService);
		viewService.setSplitCollapsed(viewService.splitCollapsed === 'ide' ? 'none' : 'ide');
	}
});

// F6 and Shift+F6 with the agent part in the cycle (docs/UX.md: in split mode
// both halves are in the cycle). They replace the upstream part cycle, whose
// fixed order has no agent part and lands on the hidden editor in the Agent view.

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.action.focusNextPart',
			title: localize2('axis.focusNextPart', "Focus Next Part"),
			category: AXIS_CATEGORY,
			f1: true,
			keybinding: { primary: KeyCode.F6, weight: KeybindingWeight.WorkbenchContrib + 1 }
		});
	}

	run(accessor: ServicesAccessor): void {
		focusNeighbourPart(accessor, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'axis.action.focusPreviousPart',
			title: localize2('axis.focusPreviousPart', "Focus Previous Part"),
			category: AXIS_CATEGORY,
			f1: true,
			keybinding: { primary: KeyMod.Shift | KeyCode.F6, weight: KeybindingWeight.WorkbenchContrib + 1 }
		});
	}

	run(accessor: ServicesAccessor): void {
		focusNeighbourPart(accessor, false);
	}
});
