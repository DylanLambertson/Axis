/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { changeGroupLabel, changeKindGlyph, changeKindLabel, changeRowLabel, changesSummary, flatRows, IAxisChangeRow, MAX_CHANGE_ROWS } from '../../../services/changes/common/axisChanges.js';
import { AxisChangesSource } from '../../../services/changes/common/axisChangesSource.js';
import { IAxisViewService } from '../../../services/view/browser/axisViewService.js';

/** Rows moved by Page Up and Page Down. */
const PAGE = 10;

/**
 * The Changes view of the workspace view (docs/design/axis-agent-shell.md section 4.3,
 * task A5). Read-only: it lists the worktree's conflicts, staged, unstaged and untracked
 * files from `IGitService` state (`AxisChangesSource`), and opens a row's diff, or every
 * row in a multi-diff, through `IAxisViewService.reveal`. It has no action that changes git.
 *
 * Accessibility: a listbox of option rows in one group per state, with a roving tab stop
 * (Up, Down, Home, End, Page Up, Page Down move; Enter or Space opens). Each row shows its
 * state as a letter and a word before the name, so state is never colour alone, and its
 * accessible name puts the fixed state text first. Every text is set with `textContent`
 * from the model, which has already cleaned file names (`cleanDisplayText`).
 */
export class AxisChangesView extends Disposable {

	readonly element: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly reviewAll: HTMLButtonElement;
	private readonly list: HTMLElement;
	private readonly note: HTMLElement;
	private readonly source: AxisChangesSource;
	private readonly rowDisposables = this._register(new DisposableStore());
	private rows: HTMLElement[] = [];
	private visible: IAxisChangeRow[] = [];
	private activeIndex = 0;
	private activeId: string | undefined;
	private workspaceLabel = '';

	constructor(
		@IGitService gitService: IGitService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IAxisViewService private readonly viewService: IAxisViewService,
	) {
		super();
		this.source = this._register(new AxisChangesSource(gitService, root => contextService.isInsideWorkspace(root)));
		this.element = $('section.axis-workspace-changes');
		const header = append(this.element, $('.axis-changes-header'));
		const title = append(header, $('h3.axis-section-title'));
		title.textContent = localize('axis.changes.title', "Changes");
		title.id = 'axis-workspace-changes-title';
		this.reviewAll = append(header, $<HTMLButtonElement>('button.axis-button.axis-changes-review'));
		this.reviewAll.type = 'button';
		this.reviewAll.textContent = localize('axis.changes.reviewAll', "Review all");
		this.reviewAll.setAttribute('aria-label', localize('axis.changes.reviewAllLabel', "Review all changes in one multi-diff editor"));
		this._register(addDisposableListener(this.reviewAll, EventType.CLICK, () => this.openAll()));
		this.summary = append(this.element, $('p.axis-changes-summary'));
		this.list = append(this.element, $('.axis-changes-list'));
		this.list.setAttribute('role', 'listbox');
		this.list.setAttribute('aria-labelledby', title.id);
		this.list.tabIndex = -1;
		this._register(addDisposableListener(this.list, EventType.KEY_DOWN, e => this.onKeyDown(new StandardKeyboardEvent(e))));
		this.note = append(this.element, $('p.axis-note.axis-changes-note'));
		this._register(this.source.onDidChange(() => this.render()));
		this._register(contextService.onDidChangeWorkspaceFolders(() => {
			if (this.source.status === 'notMounted' || this.source.status === 'unavailable') {
				this.source.refresh();
			}
		}));
		this.render();
	}

	/** Shows a worktree's changes (`undefined`: none); `label` names the workspace in the multi-diff title. */
	setRoot(root: URI | undefined, label: string): void {
		this.workspaceLabel = label;
		this.source.setRoot(root);
	}

	private render(): void {
		const focusWasInside = this.list.contains(this.list.ownerDocument.activeElement);
		const { status, changes } = this.source;
		this.rowDisposables.clear();
		this.list.replaceChildren();
		this.rows = [];
		this.visible = flatRows(changes);
		this.reviewAll.disabled = this.visible.length === 0;
		this.summary.textContent = status === 'ready' ? changesSummary(changes) : '';
		this.note.textContent = this.noteText();
		this.list.hidden = this.visible.length === 0;

		let index = 0;
		for (const group of changes.groups) {
			const box = append(this.list, $('.axis-changes-group'));
			box.setAttribute('role', 'group');
			const heading = append(box, $('.axis-changes-group-title'));
			heading.id = `axis-changes-group-${group.id}`;
			heading.textContent = localize('axis.changes.groupTitle', "{0} · {1}", changeGroupLabel(group.id), group.total);
			box.setAttribute('aria-labelledby', heading.id);
			for (const row of group.rows) {
				this.rows.push(this.renderRow(box, row, index++));
			}
		}
		const kept = this.activeId === undefined ? -1 : this.visible.findIndex(row => row.id === this.activeId);
		this.setActive(kept >= 0 ? kept : Math.min(this.activeIndex, this.rows.length - 1), focusWasInside);
	}

	private renderRow(parent: HTMLElement, row: IAxisChangeRow, index: number): HTMLElement {
		const element = append(parent, $(`.axis-change-row.kind-${row.kind}`));
		element.setAttribute('role', 'option');
		element.setAttribute('aria-label', changeRowLabel(row));
		element.tabIndex = -1;
		const state = append(element, $('span.axis-change-state'));
		state.setAttribute('aria-hidden', 'true');
		append(state, $('span.glyph')).textContent = changeKindGlyph(row.kind);
		append(state, $('span.word')).textContent = changeKindLabel(row.kind);
		append(element, $('span.axis-change-name')).textContent = row.name;
		const where = append(element, $('span.axis-change-folder'));
		const from = row.previousPath ? localize('axis.changes.renamedFrom', "from {0}", row.previousPath) : '';
		where.textContent = [row.folder, from].filter(Boolean).join(' · ');
		element.title = row.folder ? `${row.folder}/${row.name}` : row.name;
		this.rowDisposables.add(addDisposableListener(element, EventType.FOCUS, () => this.setActive(index, false)));
		this.rowDisposables.add(addDisposableListener(element, EventType.CLICK, () => {
			this.setActive(index, true);
			this.open(row);
		}));
		return element;
	}

	private noteText(): string {
		const { status, changes } = this.source;
		switch (status) {
			case 'idle': return '';
			case 'loading': return localize('axis.changes.loading', "Reading the worktree's changes…");
			case 'notMounted': return localize('axis.changes.notMounted', "Changes show for the folder this window has open. Open this worktree's folder in the window to see its changes.");
			case 'unavailable': return localize('axis.changes.unavailable', "Git has no repository for this worktree yet. The git extension may be off, the folder untrusted, or Git still starting.");
			case 'ready': {
				const notes: string[] = [];
				const cut = changes.groups.filter(group => group.total > group.rows.length).reduce((sum, group) => sum + group.total - group.rows.length, 0);
				if (cut) {
					notes.push(localize('axis.changes.cut', "{0} more files are not listed (at most {1} per group). The SCM view in the IDE lists all.", cut, MAX_CHANGE_ROWS));
				}
				if (changes.outside) {
					notes.push(localize('axis.changes.outside', "{0} changes outside this worktree are not shown.", changes.outside));
				}
				return notes.join(' ');
			}
		}
	}

	private open(row: IAxisChangeRow): void {
		this.viewService.reveal({
			kind: 'diff',
			original: row.original,
			modified: row.modified,
			label: localize('axis.changes.diffLabel', "{0} ({1})", row.name, changeGroupLabel(row.group)),
		});
	}

	private openAll(): void {
		if (!this.visible.length) {
			return;
		}
		this.viewService.reveal({
			kind: 'multiDiff',
			label: localize('axis.changes.allLabel', "Changes in {0}", this.workspaceLabel),
			items: this.visible.map(row => ({ original: row.original, modified: row.modified, resource: row.resource })),
		});
	}

	private setActive(index: number, focus: boolean): void {
		if (index < 0 || !this.rows.length) {
			this.activeId = undefined;
			return;
		}
		this.activeIndex = index;
		this.activeId = this.visible[index].id;
		this.rows.forEach((row, i) => {
			row.tabIndex = i === index ? 0 : -1;
			row.setAttribute('aria-selected', String(i === index));
		});
		if (focus) {
			this.rows[index].focus();
		}
	}

	private onKeyDown(event: StandardKeyboardEvent): void {
		const row = this.visible[this.activeIndex];
		if (!row) {
			return;
		}
		const last = this.rows.length - 1;
		let handled = true;
		switch (event.keyCode) {
			case KeyCode.DownArrow: this.setActive(Math.min(this.activeIndex + 1, last), true); break;
			case KeyCode.UpArrow: this.setActive(Math.max(this.activeIndex - 1, 0), true); break;
			case KeyCode.PageDown: this.setActive(Math.min(this.activeIndex + PAGE, last), true); break;
			case KeyCode.PageUp: this.setActive(Math.max(this.activeIndex - PAGE, 0), true); break;
			case KeyCode.Home: this.setActive(0, true); break;
			case KeyCode.End: this.setActive(last, true); break;
			case KeyCode.Enter:
			case KeyCode.Space:
				this.open(row);
				break;
			default:
				handled = false;
		}
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	focus(): void {
		(this.rows[this.activeIndex] ?? this.reviewAll).focus();
	}
}
