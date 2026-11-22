/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The project commands (S3, docs/design/project-registration-and-trust.md §4): Add Project…, Trust Project to Run… and Stop
// Trusting Project. Each asks main, which takes the folder from this window and draws its own dialog; the renderer never names a
// path or a project. None takes arguments, so no extension or keybinding can aim one anywhere.

import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AxisProjectAction, AxisProjectOutcome, outcomeSentence } from '../../../services/projects/common/axisProjectActions.js';
import { IAxisProjectActionsService } from '../../../services/projects/common/axisProjectActionsService.js';
import { IAxisWorkspaceService } from '../../../services/workspaces/browser/axisWorkspaceService.js';
import { AXIS_CATEGORY } from '../../view/browser/axisView.contribution.js';

/** What the user hears while main's dialog is open. */
export function waitingSentence(): string {
	return localize('axis.project.waiting', "Waiting for confirmation in the Axis dialog.");
}

/**
 * Run one action: announce the wait, ask main, announce the fixed outcome sentence, refresh the views, and give focus back to
 * where it was (main's dialog took it). Shared by the commands and the dashboard buttons.
 */
export async function runProjectAction(accessor: ServicesAccessor, action: AxisProjectAction): Promise<AxisProjectOutcome> {
	const actions = accessor.get(IAxisProjectActionsService);
	const workspaces = accessor.get(IAxisWorkspaceService);
	const before = getActiveElement();
	status(waitingSentence());
	const outcome = await actions.run(action);
	status(outcomeSentence(outcome));
	void workspaces.refresh();
	if (isHTMLElement(before) && before.isConnected) {
		before.focus();
	}
	return outcome;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'axis.project.add', title: localize2('axis.project.add', "Add Project…"), category: AXIS_CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<AxisProjectOutcome> {
		return runProjectAction(accessor, 'add');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'axis.project.trust', title: localize2('axis.project.trust', "Trust Project to Run…"), category: AXIS_CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<AxisProjectOutcome> {
		return runProjectAction(accessor, 'trust');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'axis.project.untrust', title: localize2('axis.project.untrust', "Stop Trusting Project"), category: AXIS_CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<AxisProjectOutcome> {
		return runProjectAction(accessor, 'untrust');
	}
});
