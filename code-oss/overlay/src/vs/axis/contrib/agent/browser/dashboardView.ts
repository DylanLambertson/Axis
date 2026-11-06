/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { fromNow } from '../../../../base/common/date.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AxisApprovalCards } from './approvalCards.js';
import { IAxisCliRun } from '../../../services/workspaces/common/axisWorkspaceData.js';
import { AxisRowState, branchLabel, changesLabel, IAxisWorkspaceEntry, rowStateOf } from '../../../services/workspaces/common/axisWorkspaceModel.js';
import { daemonNotice } from '../../../services/workspaces/common/axisDaemonNotice.js';
import { IAxisWorkspaceService } from '../../../services/workspaces/browser/axisWorkspaceService.js';
import { MAX_DISCOVERED_WORKTREES } from '../../../services/workspaces/common/worktreeDiscovery.js';

/** Terminal count per workspace key, from `AxisWorkspaceTerminals`. */
export interface IAxisTerminalCounts {
	count(workspaceKey: string): number;
}

export function rowStateLabel(state: AxisRowState): string {
	switch (state) {
		case 'idle': return localize('axis.state.idle', "idle");
		case 'running': return localize('axis.state.running', "running");
		case 'quiet': return localize('axis.state.quiet', "quiet (may be waiting for input)");
		case 'failed': return localize('axis.state.failed', "failed");
		case 'done': return localize('axis.state.done', "done");
		case 'external': return localize('axis.state.external', "external (not created by Axis)");
		case 'missing': return localize('axis.state.missing', "folder missing");
	}
}

export function runLabel(run: IAxisCliRun): string {
	const agent = run.agentId ?? localize('axis.run.unknownAgent', "CLI");
	switch (run.status) {
		case 'failed': return localize('axis.run.failed', "{0}: failed, exit code {1}", agent, String(run.exitCode ?? '?'));
		case 'finished': return localize('axis.run.finished', "{0}: exited, code {1}", agent, String(run.exitCode ?? 0));
		case 'quiet': return localize('axis.run.quiet', "{0}: quiet (may be waiting for input)", agent);
		default: return `${agent}: ${run.status}`;
	}
}

/**
 * The dashboard (docs/design/axis-agent-shell.md section 4.2, docs/UX.md): one
 * dense row per workspace, grouped by project. The rows are a listbox with a
 * roving tab stop: arrow keys, Home and End move, Enter opens the workspace.
 * Every state is written as text.
 */
export class AxisDashboardView extends Disposable {

	readonly element: HTMLElement;
	/** One persistent live region: it is updated only when its text changes, so an unchanged poll is not announced again. */
	private readonly notice: HTMLElement;
	private readonly header: HTMLElement;
	private readonly list: HTMLElement;
	private readonly rowDisposables = this._register(new DisposableStore());
	private rows: HTMLElement[] = [];
	private activeIndex = 0;

	constructor(
		private readonly terminalCounts: IAxisTerminalCounts,
		@IAxisWorkspaceService private readonly workspaceService: IAxisWorkspaceService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.axis-dashboard');
		this.notice = append(this.element, $('.axis-dashboard-note.axis-dashboard-notice'));
		this.notice.setAttribute('role', 'status');
		this.header = append(this.element, $('.axis-dashboard-header'));
		this.element.appendChild(this._register(new AxisApprovalCards(this.workspaceService)).element); // after the header, before the list
		this.list = append(this.element, $('.axis-dashboard-list'));
		this.list.setAttribute('role', 'listbox');
		this.list.tabIndex = -1;
		this.list.setAttribute('aria-label', localize('axis.dashboard.listLabel', "Workspaces"));
		this._register(addDisposableListener(this.list, EventType.KEY_DOWN, e => this.onKeyDown(new StandardKeyboardEvent(e))));
		this._register(this.workspaceService.onDidChangeWorkspaces(() => this.render()));
		this.render();
	}

	render(): void {
		this.renderNotice();
		this.renderHeader();
		this.renderRows();
	}

	private renderNotice(): void {
		const service = this.workspaceService;
		const notice = daemonNotice({ status: service.daemonStatus, notRegistered: service.notRegistered, staleError: service.staleError, truncatedProjects: service.truncatedProjects });
		const sample = localize('axis.dashboard.sampleRuns', "Agent runs are sample data (axis.preview.sampleRuns); the Axis service is not running.");
		const text = service.runsProvenance !== 'sample' ? notice.text : service.daemonStatus.kind === 'down' ? sample : `${notice.text} ${sample}`;
		if (this.notice.textContent !== text) {
			this.notice.textContent = text;
		}
		this.notice.dataset.severity = notice.severity;
	}

	private renderHeader(): void {
		this.header.replaceChildren();
		const title = append(this.header, $('h2.axis-dashboard-title'));
		title.textContent = localize('axis.dashboard.title', "Workspaces");
		const projects = this.workspaceService.projects;
		if (projects.length) {
			append(this.header, $('span.axis-dashboard-project')).textContent = projects.map(p => p.trusted ? p.name : localize('axis.project.restricted', "{0} (Restricted Mode)", p.name)).join(', ');
		}
		const pending = this.workspaceService.pendingApprovals;
		if (pending) {
			append(this.header, $('span.axis-dashboard-note')).textContent = pending === 1
				? localize('axis.dashboard.approvalsOne', "1 approval waiting")
				: localize('axis.dashboard.approvals', "{0} approvals waiting", pending);
		}
		const refused = this.workspaceService.refusedWorktrees;
		if (refused) {
			const warning = append(this.header, $('span.axis-dashboard-note.axis-dashboard-refused'));
			warning.setAttribute('role', 'note');
			warning.textContent = refused === 1
				? localize('axis.dashboard.refusedOne', "1 worktree entry is not listed: its folder is missing, its .git file does not point back to this repository, or it is past the first {0} entries.", MAX_DISCOVERED_WORKTREES)
				: localize('axis.dashboard.refused', "{0} worktree entries are not listed: their folders are missing, their .git files do not point back to this repository, or they are past the first {1} entries.", refused, MAX_DISCOVERED_WORKTREES);
		}
		const refresh = append(this.header, $<HTMLButtonElement>('button.axis-button'));
		refresh.type = 'button';
		refresh.textContent = localize('axis.dashboard.refresh', "Refresh");
		refresh.onclick = () => this.workspaceService.refresh();
	}

	private renderRows(): void {
		const hadFocus = this.list.contains(this.list.ownerDocument.activeElement);
		this.rowDisposables.clear();
		this.list.replaceChildren();
		this.rows = [];

		if (!this.workspaceService.loaded) {
			append(this.list, $('.axis-dashboard-empty')).textContent = localize('axis.dashboard.loading', "Reading workspaces…");
			return;
		}

		const workspaces = this.workspaceService.workspaces;
		if (!workspaces.length) {
			this.renderEmpty(hadFocus);
			return;
		}

		const columns = append(this.list, $('.axis-dashboard-columns'));
		columns.setAttribute('aria-hidden', 'true');
		for (const label of [localize('axis.col.name', "Name"), localize('axis.col.branch', "Branch"), localize('axis.col.state', "State"), localize('axis.col.agents', "Agents"), localize('axis.col.terminals', "Terminals"), localize('axis.col.changes', "Changes"), localize('axis.col.activity', "Last activity")]) {
			append(columns, $('span')).textContent = label;
		}

		let projectId: string | undefined;
		workspaces.forEach((entry, index) => {
			if (entry.project.id !== projectId) {
				projectId = entry.project.id;
				const group = append(this.list, $('.axis-dashboard-group'));
				group.setAttribute('role', 'presentation');
				group.textContent = entry.project.name;
			}
			this.rows.push(this.renderRow(entry, index));
		});

		const focusedIndex = workspaces.findIndex(w => w.key === this.workspaceService.focused?.key);
		this.setActive(Math.min(focusedIndex === -1 ? this.activeIndex : focusedIndex, this.rows.length - 1), hadFocus);
	}

	private renderRow(entry: IAxisWorkspaceEntry, index: number): HTMLElement {
		const row = append(this.list, $('.axis-dashboard-row'));
		row.setAttribute('role', 'option');
		row.tabIndex = -1;
		row.dataset.key = entry.key;
		row.classList.toggle('attention', !!entry.attention);

		const state = rowStateOf(entry);
		const tag = entry.isLocalCheckout ? localize('axis.tag.local', "local checkout") : entry.worktree.locked ? localize('axis.tag.locked', "locked") : undefined;
		const runs = entry.runs.length ? entry.runs.map(runLabel).join('; ') : localize('axis.runs.none', "none");
		const terminals = this.terminalCounts.count(entry.key);
		const lastOutput = Math.max(0, ...entry.runs.map(run => run.lastOutputAt ?? 0));

		const cells: [string, string][] = [
			['name', tag ? `${entry.label} · ${tag}` : entry.label],
			['branch', branchLabel(entry)],
			['state', rowStateLabel(state)],
			['agents', runs],
			['terminals', String(terminals)],
			['changes', changesLabel(entry.worktree)],
			['activity', lastOutput ? fromNow(lastOutput, true) : '—'],
		];
		for (const [kind, text] of cells) {
			const cell = append(row, $(`span.axis-cell.${kind}`));
			cell.textContent = text;
			cell.title = text;
		}
		row.classList.add(`state-${state}`);

		const position = localize('axis.row.position', "{0} of {1}", index + 1, this.workspaceService.workspaces.length);
		row.setAttribute('aria-label', [entry.label, tag, localize('axis.row.branch', "branch {0}", branchLabel(entry)), rowStateLabel(state), localize('axis.row.agents', "agents: {0}", runs), localize('axis.row.terminals', "{0} terminals", terminals), position].filter(Boolean).join(', '));

		this.rowDisposables.add(addDisposableListener(row, EventType.FOCUS, () => this.setActive(index, false)));
		this.rowDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
			this.setActive(index, true);
			this.open(entry);
		}));
		return row;
	}

	private renderEmpty(hadFocus: boolean): void {
		const empty = append(this.list, $('.axis-dashboard-empty'));
		const message = append(empty, $('p'));
		const button = append(empty, $<HTMLButtonElement>('button.axis-button'));
		button.type = 'button';
		if (!this.workspaceService.projects.length) {
			message.textContent = localize('axis.dashboard.noRepo', "No repository is open. Open a folder that is a Git repository to see its workspaces.");
			button.textContent = localize('axis.dashboard.openFolder', "Open Folder…");
			button.onclick = () => this.commandService.executeCommand('workbench.action.files.openFolder');
		} else {
			message.textContent = localize('axis.dashboard.noWorkspaces', "This repository has no worktrees yet.");
			button.textContent = localize('axis.dashboard.refresh2', "Refresh");
			button.onclick = () => this.workspaceService.refresh();
		}
		this.rows = [button];
		button.tabIndex = 0;
		if (hadFocus) {
			button.focus();
		}
	}

	private open(entry: IAxisWorkspaceEntry): void {
		this.workspaceService.focus(entry.key);
	}

	private setActive(index: number, focus: boolean): void {
		if (!this.rows.length || index < 0) {
			return;
		}
		this.activeIndex = index;
		this.rows.forEach((row, i) => {
			row.tabIndex = i === index ? 0 : -1;
			row.setAttribute('aria-selected', String(i === index));
		});
		if (focus) {
			this.rows[index].focus();
		}
	}

	private onKeyDown(event: StandardKeyboardEvent): void {
		const workspaces = this.workspaceService.workspaces;
		if (!workspaces.length) {
			return;
		}
		let next: number | undefined;
		switch (event.keyCode) {
			case KeyCode.DownArrow: next = Math.min(this.activeIndex + 1, this.rows.length - 1); break;
			case KeyCode.UpArrow: next = Math.max(this.activeIndex - 1, 0); break;
			case KeyCode.Home: next = 0; break;
			case KeyCode.End: next = this.rows.length - 1; break;
			case KeyCode.Enter:
			case KeyCode.Space: {
				const entry = workspaces[this.activeIndex];
				if (entry) {
					this.open(entry);
				}
				event.preventDefault();
				event.stopPropagation();
				return;
			}
		}
		if (next !== undefined) {
			this.setActive(next, true);
			event.preventDefault();
			event.stopPropagation();
		}
	}

	/** Focuses the active row (docs/UX.md: the dashboard's primary region is its first row). */
	focus(): void {
		(this.rows[this.activeIndex] ?? this.rows[0] ?? this.list).focus();
	}

	layout(_dimension: Dimension): void {
		// Rows use CSS layout; nothing to measure.
	}
}
