/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AXIS_VIEW_MODE_SETTING, DEFAULT_AXIS_VIEW_MODE } from '../../../common/axisView.js';
import { IAxisViewService } from '../../../services/view/browser/axisViewService.js';

const AXIS_CATEGORY = localize2('axis.category', "Axis");

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'axis',
	order: 1,
	title: localize('axis.configuration.title', "Axis"),
	type: 'object',
	properties: {
		[AXIS_VIEW_MODE_SETTING]: {
			type: 'string',
			enum: ['perWorkspace', 'global'],
			enumDescriptions: [
				localize('axis.view.mode.perWorkspace', "Each workspace remembers whether it shows the Agent view or the IDE view."),
				localize('axis.view.mode.global', "One view applies to every workspace."),
			],
			default: DEFAULT_AXIS_VIEW_MODE,
			scope: ConfigurationScope.APPLICATION,
			description: localize('axis.view.mode', "How Axis chooses between the Agent view and the IDE view when you focus a workspace."),
		}
	}
});

/** Creates the view service early, so the restored view is applied when the grid is built. */
class AxisViewStartupContribution {
	static readonly ID = 'workbench.contrib.axisViewStartup';

	constructor(@IAxisViewService _viewService: IAxisViewService) { }
}

registerWorkbenchContribution2(AxisViewStartupContribution.ID, AxisViewStartupContribution, WorkbenchPhase.BlockRestore);

// Shortcuts: docs/design/axis-agent-shell-policies.md section 8 (decision D-7).

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
		const viewService = accessor.get(IAxisViewService);
		viewService.setFocusedWorkspace(undefined);
		viewService.show('agent');
	}
});
