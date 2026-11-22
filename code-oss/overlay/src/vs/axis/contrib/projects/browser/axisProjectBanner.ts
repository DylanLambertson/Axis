/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The dashboard's project banner (S3): this window's project, its run trust and the one action that fits. Run trust is shown only
// from the daemon; without it the banner says it is unknown and offers nothing. Buttons are plain `type=button`, never focused or
// defaulted by the banner, so no Enter on load can trust anything; every action still ends in main's own dialog.

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AxisProjectAction, bannerContent, outcomeSentence, trustSource } from '../../../services/projects/common/axisProjectActions.js';
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
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this.element = $('.axis-project-banner');
		this.text = append(this.element, $('span.axis-project-banner-text'));
		this.button = append(this.element, $('button.axis-project-banner-action')) as HTMLButtonElement;
		this.button.type = 'button';
		this.outcome = append(this.element, $('span.axis-project-banner-outcome'));
		// Polite and atomic: the commands also announce through aria status(), but the banner may be what has focus.
		this.outcome.setAttribute('role', 'status');
		this._register(addDisposableListener(this.button, 'click', () => {
			if (this.action !== undefined && this.actions.waiting === undefined) {
				void this.commands.executeCommand(COMMAND[this.action]);
			}
		}));
		// Main reads this window's folder (`status`) when the data changes, never on a timer; its answer re-renders through onDidChange.
		this._register(this.workspaces.onDidChangeWorkspaces(() => { this.actions.refreshStatus(); this.render(); }));
		this.actions.refreshStatus();
		this._register(this.actions.onDidChange(() => this.render()));
		this.render();
	}

	render(): void {
		const source = trustSource(this.workspaces.daemonStatus, this.workspaces.dataOrigin);
		const content = bannerContent(this.actions.windowTrust, source);
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
