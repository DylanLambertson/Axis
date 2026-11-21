/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { AxisChangeGroupId, changeGroupLabel, changeKindGlyph, changeKindLabel, changeRowLabel, changesSummary, diffTargetOf, flatRows, focusAfterUpdate, IAxisChangeRow, MAX_CHANGE_ROWS, nextActiveIndex, reviewAllTargetOf } from '../../../services/changes/common/axisChanges.js';
import { AxisChangesSource, CLOSED_REPOSITORIES_KEY, gitEntryOf, hasClosedRepositories, isRepositoryRoot } from '../../../services/changes/common/axisChangesSource.js';
import { placeInOrder } from '../../../services/changes/common/axisOrderedChildren.js';
import { IAxisViewService } from '../../../services/view/browser/axisViewService.js';

/** Rows moved by Page Up and Page Down. */
const PAGE = 10;

interface IRowView {
	readonly element: HTMLElement;
	row: IAxisChangeRow;
	/** What the row shows now; the row is redrawn only when this changes. */
	shown: string;
}

interface IGroupView {
	readonly box: HTMLElement;
	readonly heading: HTMLElement;
}

/**
 * The Changes view of the workspace view (docs/design/axis-shell-a5.md). Read-only: it lists
 * the worktree's conflicts, staged, unstaged and untracked files from `IGitService` state
 * (`AxisChangesSource`), and opens a row's diff (`diffTargetOf`), or every row in a
 * multi-diff (`reviewAllTargetOf`), through `IAxisViewService.reveal`. Axis adds no action
 * that changes git here.
 *
 * Accessibility: a listbox of option rows in one group per state, with a roving tab stop
 * (Up, Down, Home, End, Page Up, Page Down move; Enter or Space opens). Each row shows its
 * state as a letter and a word before the name, and its accessible name puts the fixed
 * state text first. Every text is set with `textContent` from the model, which has already
 * cleaned file names (`cleanDisplayText`).
 *
 * Focus (`focusAfterUpdate`): a row keeps its element while its file stays listed, and the
 * DOM is updated in place, so the focused row is neither blurred nor re-announced by a git
 * update and the element the view service remembers when a diff opens is still there on the
 * way back. An update never moves focus onto a row from another control; focus that would
 * be lost (the list emptied, a control hidden) goes to the always-visible heading.
 */
export class AxisChangesView extends Disposable {

	readonly element: HTMLElement;
	private readonly title: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly reviewAll: HTMLButtonElement;
	private readonly list: HTMLElement;
	private readonly note: HTMLElement;
	private readonly retry: HTMLButtonElement;
	private readonly source: AxisChangesSource;
	private readonly views = this._register(new DisposableMap<string, DisposableStore>());
	private readonly byId = new Map<string, IRowView>();
	private readonly groupViews = new Map<AxisChangeGroupId, IGroupView>();
	private rows: HTMLElement[] = [];
	private visible: IAxisChangeRow[] = [];
	private activeIndex = 0;
	private activeId: string | undefined;
	private workspaceLabel = '';

	constructor(
		@IGitService gitService: IGitService,
		@IFileService fileService: IFileService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IAxisViewService private readonly viewService: IAxisViewService,
	) {
		super();
		this.source = this._register(new AxisChangesSource(
			gitService,
			root => contextService.isInsideWorkspace(root),
			root => isRepositoryRoot(root, uri => fileService.stat(uri).then(gitEntryOf, () => gitEntryOf(undefined))),
			() => hasClosedRepositories(contextKeyService.getContextKeyValue(CLOSED_REPOSITORIES_KEY)),
			(run, ms) => disposableTimeout(run, ms),
		));
		const closedKey = new Set([CLOSED_REPOSITORIES_KEY]);
		this._register(contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(closedKey)) {
				this.source.reconsider();
			}
		}));
		this.element = $('section.axis-workspace-changes');
		const header = append(this.element, $('.axis-changes-header'));
		const title = this.title = append(header, $('h3.axis-section-title'));
		title.textContent = localize('axis.changes.title', "Changes");
		title.id = 'axis-workspace-changes-title';
		title.tabIndex = -1; // the focus target when focus would otherwise be lost; always shown
		this.reviewAll = append(header, $<HTMLButtonElement>('button.axis-button.axis-changes-review'));
		this.reviewAll.type = 'button';
		this.reviewAll.textContent = localize('axis.changes.reviewAll', "Review all");
		this.reviewAll.setAttribute('aria-label', localize('axis.changes.reviewAllLabel', "Review the listed changes in one multi-diff editor"));
		this._register(addDisposableListener(this.reviewAll, EventType.CLICK, () => this.openAll()));
		this.summary = append(this.element, $('p.axis-changes-summary'));
		this.list = append(this.element, $('.axis-changes-list'));
		this.list.setAttribute('role', 'listbox');
		this.list.setAttribute('aria-labelledby', title.id);
		this.list.tabIndex = -1;
		this._register(addDisposableListener(this.list, EventType.KEY_DOWN, e => this.onKeyDown(new StandardKeyboardEvent(e))));
		this.note = append(this.element, $('p.axis-note.axis-changes-note'));
		this.retry = append(this.element, $<HTMLButtonElement>('button.axis-button.axis-changes-retry'));
		this.retry.type = 'button';
		this._register(addDisposableListener(this.retry, EventType.CLICK, () => this.source.refresh()));
		this._register(this.source.onDidChange(() => this.render()));
		this._register(contextService.onDidChangeWorkspaceFolders(() => {
			if (this.source.status === 'notMounted' || this.source.status === 'unavailable') { // never 'askFirst': only the user opens those
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
		const document = this.element.ownerDocument;
		const before = this.list.contains(document.activeElement) ? 'row' : this.element.contains(document.activeElement) ? 'control' : 'outside';
		const { status, changes } = this.source;
		this.visible = flatRows(changes);
		this.reviewAll.disabled = this.visible.length === 0;
		this.summary.textContent = status === 'ready' ? changesSummary(changes) : '';
		this.note.textContent = this.noteText();
		this.retry.hidden = status !== 'unavailable' && status !== 'askFirst';
		this.retry.textContent = status === 'askFirst' ? localize('axis.changes.show', "Show changes") : localize('axis.changes.retry', "Try again");

		// Keyed, in-place update: a listed file keeps its element and its place when it can.
		const listed = new Set(this.visible.map(row => row.id));
		for (const id of [...this.byId.keys()]) {
			if (!listed.has(id)) {
				this.byId.delete(id);
				this.views.deleteAndDispose(id);
			}
		}
		const boxes: HTMLElement[] = [];
		this.rows = [];
		for (const group of changes.groups) {
			const view = this.groupView(group.id);
			const heading = localize('axis.changes.groupTitle', "{0} · {1}", changeGroupLabel(group.id), group.total);
			if (view.heading.textContent !== heading) {
				view.heading.textContent = heading;
			}
			const elements = group.rows.map(row => this.rowElement(row));
			placeInOrder(view.box, [view.heading, ...elements]);
			this.rows.push(...elements);
			boxes.push(view.box);
		}
		for (const id of [...this.groupViews.keys()]) {
			if (!changes.groups.some(group => group.id === id)) {
				this.groupViews.delete(id);
			}
		}
		placeInOrder(this.list, boxes);
		this.list.hidden = this.rows.length === 0;

		const index = nextActiveIndex(this.visible, this.activeId, this.activeIndex);
		if (index >= 0) {
			this.setActive(index, false);
		} else {
			this.activeId = undefined;
			this.activeIndex = 0;
		}
		switch (focusAfterUpdate(before, this.element.contains(document.activeElement), this.rows.length > 0)) {
			case 'row':
				if (document.activeElement !== this.rows[this.activeIndex]) {
					this.rows[this.activeIndex].focus();
				}
				break;
			case 'heading':
				this.title.focus();
				break;
		}
	}

	private groupView(id: AxisChangeGroupId): IGroupView {
		let view = this.groupViews.get(id);
		if (!view) {
			const box = $('.axis-changes-group');
			box.setAttribute('role', 'group');
			const heading = append(box, $('.axis-changes-group-title'));
			heading.id = `axis-changes-group-${id}`;
			box.setAttribute('aria-labelledby', heading.id);
			view = { box, heading };
			this.groupViews.set(id, view);
		}
		return view;
	}

	private rowElement(row: IAxisChangeRow): HTMLElement {
		const existing = this.byId.get(row.id);
		const view = existing ?? this.createRow(row);
		view.row = row;
		const shown = [row.kind, changeRowLabel(row), row.name, row.folder, row.previousPath ?? ''].join('\n');
		if (view.shown !== shown) {
			view.shown = shown;
			this.fillRow(view.element, row);
		}
		return view.element;
	}

	private createRow(row: IAxisChangeRow): IRowView {
		const element = $('.axis-change-row');
		element.setAttribute('role', 'option');
		element.tabIndex = -1;
		const view: IRowView = { element, row, shown: '' };
		const store = new DisposableStore();
		store.add(addDisposableListener(element, EventType.FOCUS, () => this.setActive(this.rows.indexOf(element), false)));
		store.add(addDisposableListener(element, EventType.CLICK, () => {
			this.setActive(this.rows.indexOf(element), true);
			this.open(view.row);
		}));
		this.byId.set(row.id, view);
		this.views.set(row.id, store);
		return view;
	}

	private fillRow(element: HTMLElement, row: IAxisChangeRow): void {
		element.className = `axis-change-row kind-${row.kind}`;
		element.setAttribute('aria-label', changeRowLabel(row));
		const state = $('span.axis-change-state');
		state.setAttribute('aria-hidden', 'true');
		append(state, $('span.glyph')).textContent = changeKindGlyph(row.kind);
		append(state, $('span.word')).textContent = changeKindLabel(row.kind);
		const name = $('span.axis-change-name');
		name.textContent = row.name;
		const where = $('span.axis-change-folder');
		const from = row.previousPath ? localize('axis.changes.renamedFrom', "from {0}", row.previousPath) : '';
		where.textContent = [row.folder, from].filter(Boolean).join(' · ');
		element.replaceChildren(state, name, where);
		element.title = row.folder ? `${row.folder}/${row.name}` : row.name;
	}

	private noteText(): string {
		const { status, changes } = this.source;
		switch (status) {
			case 'idle': return '';
			case 'loading': return localize('axis.changes.loading', "Reading the worktree's changes…");
			case 'askFirst': return this.source.waitingForGit
				? localize('axis.changes.waitingForGit', "Waiting for Git to start. Show changes opens this worktree's repository in Git now, and it stays open there, even if you closed it before.")
				: localize('axis.changes.askFirst', "Repositories have been closed in Git in this window. Show changes opens this worktree's repository in Git, and it stays open there, even if you closed it before.");
			case 'notMounted': return localize('axis.changes.notMounted', "Changes show for the folder this window has open. Open this worktree's folder in the window to see its changes.");
			case 'unavailable': return localize('axis.changes.unavailable', "Git has no repository for this worktree. The folder may not be a Git worktree, the git extension may be off or the folder untrusted, or Git may still be starting.");
			case 'ready': {
				const notes: string[] = [];
				const cut = changes.groups.reduce((sum, group) => sum + group.total - group.rows.length, 0);
				if (cut) {
					notes.push(localize('axis.changes.cut', "{0} more changes are not listed (at most {1} per group). The SCM view in the IDE lists all.", cut, MAX_CHANGE_ROWS));
				}
				if (changes.outside) {
					notes.push(localize('axis.changes.outside', "{0} changes outside this worktree are not shown.", changes.outside));
				}
				return notes.join(' ');
			}
		}
	}

	private open(row: IAxisChangeRow): void {
		this.viewService.reveal(diffTargetOf(row));
	}

	private openAll(): void {
		if (this.visible.length) {
			this.viewService.reveal(reviewAllTargetOf(this.visible, this.workspaceLabel));
		}
	}

	private setActive(index: number, focus: boolean): void {
		if (index < 0 || index >= this.rows.length) {
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

	/** Focuses the active row, or the heading when there is none. */
	focus(): void {
		(this.rows[this.activeIndex] ?? this.title).focus();
	}
}
