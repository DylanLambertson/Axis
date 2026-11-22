/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The dashboard's project banner (S3): this window's project, its run trust and the one action that fits. Run trust is shown only
// from the daemon; without it the banner says it is unknown and offers nothing. Buttons are plain `type=button`, never focused or
// defaulted by the banner, so no Enter on load can trust anything; every action still ends in main's own dialog.

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AxisProjectAction, bannerContent, outcomeSentence, windowLocalCheckoutIds, windowProjectState } from '../../../services/projects/common/axisProjectActions.js';
import { IAxisProjectActionsService } from '../../../services/projects/common/axisProjectActionsService.js';
import { IAxisWorkspaceService } from '../../../services/workspaces/browser/axisWorkspaceService.js';

const COMMAND: Record<AxisProjectAction, string> = { add: 'axis.project.add', trust: 'axis.project.trust', untrust: 'axis.project.untrust' };

export class AxisProjectBanner extends Disposable {
	readonly element: HTMLElement;
	private readonly text: HTMLElement;
	private readonly button: HTMLButtonElement;
	private readonly outcome: HTMLElement;
	private action: AxisProjectAction | undefined;

	constructor(
		@IAxisWorkspaceService private readonly workspaces: IAxisWorkspaceService,
		@IAxisProjectActionsService private readonly actions: IAxisProjectActionsService,
		@IWorkspaceContextService private readonly context: IWorkspaceContextService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this.element = $('.axis-project-banner');
		this.text = append(this.element, $('span.axis-project-banner-text'));
		this.button = append(this.element, $('button.axis-project-banner-action')) as HTMLButtonElement;
		this.button.type = 'button';
		this.outcome = append(this.element, $('span.axis-project-banner-outcome'));
		this._register(addDisposableListener(this.button, 'click', () => {
			if (this.action !== undefined && this.actions.waiting === undefined) {
				void this.commands.executeCommand(COMMAND[this.action]);
			}
		}));
		this._register(this.workspaces.onDidChangeWorkspaces(() => this.render()));
		this._register(this.actions.onDidChange(() => this.render()));
		this.render();
	}

	render(): void {
		const folders = this.context.getWorkspace().folders.filter(f => f.uri.scheme === Schemas.file).map(f => f.uri.fsPath);
		const origin = this.workspaces.dataOrigin;
		const state = windowProjectState({ origin, projects: this.workspaces.projects, localCheckoutProjectIds: windowLocalCheckoutIds(this.workspaces.workspaces, folders) });
		const content = bannerContent(state, origin);
		this.text.textContent = content.text;
		this.action = content.action?.id;
		this.button.hidden = content.action === undefined;
		this.button.textContent = content.action?.label ?? '';
		this.button.disabled = this.actions.waiting !== undefined;
		const waiting = this.actions.waiting !== undefined;
		const last = this.actions.lastOutcome;
		this.outcome.textContent = waiting
			? localize('axis.banner.waiting', "Waiting for confirmation in the Axis dialog.")
			: last === undefined ? '' : outcomeSentence(last);
	}
}
