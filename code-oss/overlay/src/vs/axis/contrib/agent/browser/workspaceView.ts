/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAxisViewService } from '../../../services/view/browser/axisViewService.js';
import { IAxisWorkspaceService } from '../../../services/workspaces/browser/axisWorkspaceService.js';
import { branchLabel, IAxisWorkspaceEntry, rowStateOf } from '../../../services/workspaces/common/axisWorkspaceModel.js';
import { rowStateLabel, runLabel } from './dashboardView.js';
import { AxisFileTree } from './fileTree.js';
import { AxisWorkspaceTerminals } from './workspaceTerminals.js';

/**
 * The workspace view (docs/design/axis-agent-shell.md section 4.3, Phase 0
 * slice): a header with the workspace's name, branch and state, the Files
 * tree of its worktree, and its runs. Its terminals live in the panel
 * (`AxisWorkspaceTerminals`). The composer and the activity stream need the
 * Axis service (Phase 1b) and say so instead of showing anything fake.
 */
export class AxisWorkspaceView extends Disposable {

	readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly fileTree: AxisFileTree;
	private readonly activity: HTMLElement;
	private entry: IAxisWorkspaceEntry | undefined;

	constructor(
		private readonly terminals: AxisWorkspaceTerminals,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAxisViewService private readonly viewService: IAxisViewService,
		@IAxisWorkspaceService private readonly workspaceService: IAxisWorkspaceService,
	) {
		super();
		this.element = $('.axis-workspace-view');
		this.element.setAttribute('role', 'region');
		this.header = append(this.element, $('.axis-workspace-header'));
		const body = append(this.element, $('.axis-workspace-body'));

		const files = append(body, $('section.axis-workspace-files'));
		const filesTitle = append(files, $('h3.axis-section-title'));
		filesTitle.textContent = localize('axis.workspace.files', "Files");
		filesTitle.id = 'axis-workspace-files-title';
		this.fileTree = this._register(instantiationService.createInstance(AxisFileTree));
		this.fileTree.element.setAttribute('aria-labelledby', filesTitle.id);
		files.appendChild(this.fileTree.element);
		this._register(this.fileTree.onDidOpen(resource => this.open(resource)));

		this.activity = append(body, $('section.axis-workspace-activity'));
		this._register(this.terminals.onDidChange(() => this.renderHeader()));
	}

	setEntry(entry: IAxisWorkspaceEntry): void {
		const rootChanged = entry.worktree.path !== this.entry?.worktree.path;
		this.entry = entry;
		this.element.setAttribute('aria-label', localize('axis.workspace.label', "Workspace {0}", entry.label));
		this.renderHeader();
		this.renderActivity();
		if (rootChanged) {
			this.fileTree.setRoot(entry.worktree.present ? URI.file(entry.worktree.path) : undefined);
		}
	}

	private renderHeader(): void {
		const entry = this.entry;
		this.header.replaceChildren();
		if (!entry) {
			return;
		}
		const back = this.button(this.header, localize('axis.workspace.back', "Dashboard"), () => this.workspaceService.focus(undefined));
		back.setAttribute('aria-label', localize('axis.workspace.backLabel', "Back to the dashboard"));

		const title = append(this.header, $('h2.axis-workspace-title'));
		title.textContent = entry.label;
		const facts = append(this.header, $('span.axis-workspace-facts'));
		const base = entry.worktree.baseSha ? entry.worktree.baseSha.slice(0, 7) : localize('axis.workspace.baseNotRecorded', "base not recorded");
		const tags = [
			localize('axis.workspace.branch', "branch {0}", branchLabel(entry)),
			base,
			rowStateLabel(rowStateOf(entry)),
			entry.isLocalCheckout ? localize('axis.workspace.local', "local checkout: no agents run here") : undefined,
			localize('axis.workspace.terminals', "{0} terminals", this.terminals.count(entry.key)),
		].filter(Boolean);
		facts.textContent = tags.join(' · ');

		const actions = append(this.header, $('.axis-workspace-actions'));
		this.button(actions, localize('axis.workspace.newTerminal', "New Terminal"), () => this.terminals.create(entry, { focus: true }));
		this.button(actions, localize('axis.workspace.openIde', "Open in IDE"), () => this.viewService.show('ide'));
	}

	private renderActivity(): void {
		const entry = this.entry;
		this.activity.replaceChildren();
		if (!entry) {
			return;
		}
		append(this.activity, $('h3.axis-section-title')).textContent = localize('axis.workspace.runs', "Agent runs");
		if (entry.runs.length) {
			const list = append(this.activity, $('ul.axis-run-list'));
			for (const run of entry.runs) {
				append(list, $('li')).textContent = runLabel(run);
			}
			if (this.workspaceService.runsProvenance === 'sample') {
				append(this.activity, $('p.axis-note')).textContent = localize('axis.workspace.sample', "Sample data: no agent is running.");
			}
		} else {
			append(this.activity, $('p.axis-note')).textContent = entry.isLocalCheckout
				? localize('axis.workspace.localNoRuns', "Agents never run in the local checkout. Open a workspace to run one.")
				: localize('axis.workspace.noService', "No agent runs. The composer and the activity stream need the Axis service, which is not running in this preview.");
		}
		append(this.activity, $('p.axis-note')).textContent = localize('axis.workspace.hint', "Enter on a file opens it in the IDE view. The terminals of this workspace are in the panel.");
	}

	private button(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.axis-button'));
		button.type = 'button';
		button.textContent = label;
		button.onclick = run;
		return button;
	}

	private open(resource: URI): void {
		this.viewService.reveal({ resource, selection: { startLineNumber: 1, startColumn: 1 } });
	}

	/** The workspace view's primary region in Phase 0: the Files tree (the composer comes with Phase 1b). */
	focus(): void {
		this.fileTree.focus();
	}

	layout(_dimension: Dimension): void {
		// CSS layout.
	}
}
