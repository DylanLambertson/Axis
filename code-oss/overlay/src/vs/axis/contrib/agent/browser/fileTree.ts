/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/** Most entries listed per folder; the rest are summarised in one line. */
export const MAX_TREE_CHILDREN = 2000;

/** Names never listed: the worktree's `.git` file or directory. */
const HIDDEN_NAMES = new Set(['.git']);

interface ITreeNode {
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly depth: number;
	expanded: boolean;
	children: ITreeNode[] | undefined;
	truncated: number;
}

/**
 * The Files tree of the workspace view (docs/design/axis-agent-shell.md
 * section 4.3). It lists the worktree with `IFileService`, lazily, and is a
 * WAI-ARIA tree with a roving tab stop: Up and Down move, Right expands or
 * enters, Left collapses or goes to the parent, Enter opens a file
 * (`onDidOpen`) or toggles a folder.
 *
 * The design reuses the upstream `ExplorerView` here; that needs the window's
 * folder to follow the focused workspace (task A2's folder manager), which
 * Phase 0 does not do yet, so this tree reads the worktree directly.
 */
export class AxisFileTree extends Disposable {

	private readonly _onDidOpen = this._register(new Emitter<URI>());
	readonly onDidOpen = this._onDidOpen.event;

	readonly element: HTMLElement;
	private root: ITreeNode | undefined;
	private visible: ITreeNode[] = [];
	private rows: HTMLElement[] = [];
	private activeIndex = 0;
	private generation = 0;
	private readonly rowDisposables = this._register(new DisposableStore());

	constructor(@IFileService private readonly fileService: IFileService) {
		super();
		this.element = $('.axis-file-tree');
		this.element.setAttribute('role', 'tree');
		this.element.setAttribute('aria-label', localize('axis.files.label', "Files"));
		this.element.tabIndex = -1;
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, e => this.onKeyDown(new StandardKeyboardEvent(e))));
	}

	/** Shows a folder; `undefined` clears the tree. */
	async setRoot(folder: URI | undefined): Promise<void> {
		const generation = ++this.generation;
		this.activeIndex = 0;
		this.root = folder ? { resource: folder, name: '', isDirectory: true, depth: -1, expanded: true, children: undefined, truncated: 0 } : undefined;
		if (this.root) {
			await this.loadChildren(this.root);
		}
		if (generation === this.generation) {
			this.render();
		}
	}

	private async loadChildren(node: ITreeNode): Promise<void> {
		try {
			const stat = await this.fileService.resolve(node.resource);
			const children = (stat.children ?? [])
				.filter(child => !HIDDEN_NAMES.has(child.name))
				.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
			node.truncated = Math.max(0, children.length - MAX_TREE_CHILDREN);
			node.children = children.slice(0, MAX_TREE_CHILDREN).map(child => ({
				resource: child.resource,
				name: child.name,
				isDirectory: child.isDirectory,
				depth: node.depth + 1,
				expanded: false,
				children: undefined,
				truncated: 0,
			}));
		} catch {
			node.children = [];
		}
	}

	private render(): void {
		const focusWasInside = this.element.contains(this.element.ownerDocument.activeElement);
		this.rowDisposables.clear();
		this.element.replaceChildren();
		this.visible = [];
		this.rows = [];
		if (!this.root) {
			return;
		}
		if (this.root.children?.length === 0) {
			const empty = append(this.element, $('.axis-file-tree-empty'));
			empty.textContent = localize('axis.files.empty', "This folder is empty or cannot be read.");
			return;
		}
		const walk = (node: ITreeNode) => {
			for (const child of node.children ?? []) {
				this.visible.push(child);
				if (child.isDirectory && child.expanded) {
					walk(child);
				}
			}
		};
		walk(this.root);

		this.visible.forEach((node, index) => {
			const row = append(this.element, $('.axis-file-tree-row'));
			row.setAttribute('role', 'treeitem');
			row.setAttribute('aria-level', String(node.depth + 1));
			row.setAttribute('aria-label', node.isDirectory ? localize('axis.files.folder', "{0}, folder", node.name) : node.name);
			if (node.isDirectory) {
				row.setAttribute('aria-expanded', String(node.expanded));
			}
			row.tabIndex = -1;
			row.style.paddingLeft = `${8 + node.depth * 14}px`;
			const twistie = append(row, $('span.twistie'));
			twistie.textContent = node.isDirectory ? (node.expanded ? '▾' : '▸') : '';
			append(row, $('span.name')).textContent = node.name;
			this.rowDisposables.add(addDisposableListener(row, EventType.FOCUS, () => this.setActive(index, false)));
			this.rowDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
				this.setActive(index, true);
				this.activate(node);
			}));
			this.rows.push(row);
		});
		this.setActive(Math.min(this.activeIndex, this.rows.length - 1), focusWasInside);
	}

	private async activate(node: ITreeNode): Promise<void> {
		if (!node.isDirectory) {
			this._onDidOpen.fire(node.resource);
			return;
		}
		await this.setExpanded(node, !node.expanded);
	}

	private async setExpanded(node: ITreeNode, expanded: boolean): Promise<void> {
		if (expanded && !node.children) {
			await this.loadChildren(node);
		}
		node.expanded = expanded;
		this.render();
	}

	private setActive(index: number, focus: boolean): void {
		if (index < 0 || !this.rows.length) {
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
		const node = this.visible[this.activeIndex];
		if (!node) {
			return;
		}
		let handled = true;
		switch (event.keyCode) {
			case KeyCode.DownArrow: this.setActive(Math.min(this.activeIndex + 1, this.rows.length - 1), true); break;
			case KeyCode.UpArrow: this.setActive(Math.max(this.activeIndex - 1, 0), true); break;
			case KeyCode.Home: this.setActive(0, true); break;
			case KeyCode.End: this.setActive(this.rows.length - 1, true); break;
			case KeyCode.RightArrow:
				if (node.isDirectory && !node.expanded) {
					this.setExpanded(node, true);
				} else if (node.isDirectory && node.children?.length) {
					this.setActive(this.activeIndex + 1, true);
				}
				break;
			case KeyCode.LeftArrow:
				if (node.isDirectory && node.expanded) {
					this.setExpanded(node, false);
				} else {
					const parent = this.visible.slice(0, this.activeIndex).reverse().find(candidate => candidate.depth === node.depth - 1);
					if (parent) {
						this.setActive(this.visible.indexOf(parent), true);
					}
				}
				break;
			case KeyCode.Enter:
			case KeyCode.Space:
				this.activate(node);
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
		(this.rows[this.activeIndex] ?? this.element).focus();
	}
}
