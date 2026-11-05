/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAxisWorkspaceEntry } from '../../../services/workspaces/common/axisWorkspaceModel.js';
import { IAxisTerminalCounts } from './dashboardView.js';

/**
 * Terminals per workspace (docs/design/axis-agent-shell.md section 4.4, Phase 0
 * residual): upstream terminals whose cwd is the worktree. On a focus change
 * the other workspaces' terminals move to the background and the focused
 * workspace's come back, so their processes keep running (`moveToBackground`,
 * `showBackgroundTerminal`, as sessions does per session). They are user
 * terminals on the upstream pty host, labelled "not managed by Axis".
 */
export class AxisWorkspaceTerminals extends Disposable implements IAxisTerminalCounts {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** Terminal instance id → workspace key. */
	private readonly owners = new Map<number, string>();
	private focusedKey: string | undefined;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.terminalService.onDidDisposeInstance(instance => {
			if (this.owners.delete(instance.instanceId)) {
				this._onDidChange.fire();
			}
		}));
	}

	count(workspaceKey: string): number {
		let count = 0;
		for (const owner of this.owners.values()) {
			if (owner === workspaceKey) {
				count++;
			}
		}
		return count;
	}

	/** Instances of a workspace, in creation order. */
	instancesOf(workspaceKey: string): ITerminalInstance[] {
		return this.terminalService.instances.filter(instance => this.owners.get(instance.instanceId) === workspaceKey);
	}

	/** Swaps the visible terminals to those of the focused workspace (none on the dashboard). */
	async setFocused(entry: IAxisWorkspaceEntry | undefined): Promise<void> {
		const key = entry?.key;
		if (key === this.focusedKey) {
			return;
		}
		this.focusedKey = key;
		for (const instance of this.terminalService.instances) {
			const owner = this.owners.get(instance.instanceId);
			if (owner !== undefined && owner !== key && this.terminalService.foregroundInstances.includes(instance)) {
				this.terminalService.moveToBackground(instance);
			}
		}
		if (!key) {
			return;
		}
		const instances = this.instancesOf(key);
		for (const instance of instances) {
			if (!this.terminalService.foregroundInstances.includes(instance)) {
				await this.terminalService.showBackgroundTerminal(instance, true);
			}
		}
		if (instances.length) {
			this.terminalService.setActiveInstance(instances[instances.length - 1]);
		}
	}

	/** Creates a terminal whose cwd is the workspace's worktree, and shows the panel. */
	async create(entry: IAxisWorkspaceEntry, options: { focus: boolean }): Promise<ITerminalInstance | undefined> {
		if (!entry.worktree.present) {
			return undefined;
		}
		try {
			const instance = await this.terminalService.createTerminal({
				cwd: URI.file(entry.worktree.path),
				config: { name: localize('axis.terminal.name', "{0} (not managed by Axis)", entry.label) },
				location: TerminalLocation.Panel,
			});
			this.owners.set(instance.instanceId, entry.key);
			this.terminalService.setActiveInstance(instance);
			await this.terminalGroupService.showPanel(options.focus);
			this._onDidChange.fire();
			return instance;
		} catch (error) {
			this.logService.error('[Axis] could not create a workspace terminal', error);
			return undefined;
		}
	}
}
