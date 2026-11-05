/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/agentPart.css';
import { $, append, Dimension, getActiveElement, isAncestor } from '../../../base/browser/dom.js';
import { LayoutPriority } from '../../../base/browser/ui/grid/grid.js';
import { Emitter } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Part } from '../../../workbench/browser/part.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { AxisSplitCollapse } from '../../common/axisView.js';
import { AXIS_AGENT_PART_ID, IAxisAgentPart, IAxisAgentPartContent, IAxisSplitHeaderState } from '../axisLayoutService.js';

/** Height of the split header, and width of the collapsed agent half. */
export const AXIS_SPLIT_HEADER_SIZE = 32;
const EXPANDED_MINIMUM_WIDTH = 320;

/**
 * The Axis agent part: the one Axis-owned part in the workbench grid
 * (docs/design/axis-agent-shell.md sections 3.1 and 4.1). It is the flex part
 * in the Agent view, hidden in the IDE view, and one half of the split.
 *
 * In split mode it draws a header with the collapse controls of both halves
 * (docs/UX.md: a collapsed pane stays reachable by F6 and by its header).
 */
export class AgentPart extends Part implements IAxisAgentPart {

	readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 160;

	private _collapsed = false;
	get minimumWidth(): number { return this._collapsed ? AXIS_SPLIT_HEADER_SIZE : EXPANDED_MINIMUM_WIDTH; }
	get maximumWidth(): number { return this._collapsed ? AXIS_SPLIT_HEADER_SIZE : Number.POSITIVE_INFINITY; }
	get priority(): LayoutPriority { return this._collapsed ? LayoutPriority.Low : LayoutPriority.High; }

	private readonly _onDidRequestCollapse = this._register(new Emitter<AxisSplitCollapse>());
	readonly onDidRequestCollapse = this._onDidRequestCollapse.event;

	private root: HTMLElement | undefined;
	private header: HTMLElement | undefined;
	private firstHeaderButton: HTMLButtonElement | undefined;
	private contentContainer: HTMLElement | undefined;
	private placeholder: HTMLElement | undefined;
	private content: IAxisAgentPartContent | undefined;
	private headerState: IAxisSplitHeaderState = { split: false, collapsed: 'none' };

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super(AXIS_AGENT_PART_ID, { hasTitle: false }, themeService, storageService, layoutService);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		const root = this.root = append(parent, $('.content.axis-agent-root'));
		this.header = append(root, $('.axis-split-header'));
		this.contentContainer = append(root, $('.axis-agent-content'));
		if (this.content) {
			this.contentContainer.appendChild(this.content.element);
		} else {
			this.renderPlaceholder(this.contentContainer);
		}
		this.renderHeader();
		return root;
	}

	/** Replaces the placeholder with the agent content (the dashboard and the workspace view). */
	setContent(content: IAxisAgentPartContent): void {
		const hadFocus = this.hasFocus();
		this.content = content;
		this.placeholder = undefined;
		if (this.contentContainer) {
			this.contentContainer.replaceChildren(content.element);
			this.layoutContent();
		}
		if (hadFocus) {
			content.focus(); // focus was on the placeholder, which is gone: never leave it on the body
		}
	}

	/** Shows or hides the split header and the collapsed strip. Returns whether the size constraints changed. */
	setHeaderState(state: IAxisSplitHeaderState): boolean {
		const collapsed = state.split && state.collapsed === 'agent';
		const constraintsChanged = collapsed !== this._collapsed;
		this.headerState = state;
		this._collapsed = collapsed;
		this.renderHeader();
		if (constraintsChanged) {
			this._onDidChange.fire(undefined);
		}
		return constraintsChanged;
	}

	get collapsed(): boolean {
		return this._collapsed;
	}

	private renderHeader(): void {
		const header = this.header;
		if (!header || !this.root) {
			return;
		}
		header.replaceChildren();
		this.firstHeaderButton = undefined;
		const { split, collapsed } = this.headerState;
		this.root.classList.toggle('split', split);
		this.root.classList.toggle('collapsed', this._collapsed);
		header.hidden = !split;
		if (!split) {
			return;
		}

		if (this._collapsed) {
			this.addHeaderButton(header, 'expand-agent', localize('axis.split.expandAgent', "Expand Agent View"), localize('axis.split.agentShort', "Agent"), 'none');
			return;
		}

		append(header, $('span.axis-split-title')).textContent = localize('axis.split.agentTitle', "Agent view");
		const actions = append(header, $('.axis-split-actions'));
		if (collapsed === 'ide') {
			this.addHeaderButton(actions, 'expand-ide', localize('axis.split.expandIde', "Expand IDE View"), localize('axis.split.ideCollapsed', "IDE view (collapsed): expand"), 'none');
		} else {
			this.addHeaderButton(actions, 'collapse-agent', localize('axis.split.collapseAgent', "Collapse Agent View"), localize('axis.split.collapseAgentShort', "Collapse agent"), 'agent');
			this.addHeaderButton(actions, 'collapse-ide', localize('axis.split.collapseIde', "Collapse IDE View"), localize('axis.split.collapseIdeShort', "Collapse IDE"), 'ide');
		}
	}

	private addHeaderButton(parent: HTMLElement, kind: string, ariaLabel: string, label: string, request: AxisSplitCollapse): void {
		const button = append(parent, $<HTMLButtonElement>(`button.axis-split-button.${kind}`));
		button.type = 'button';
		button.textContent = label;
		button.setAttribute('aria-label', ariaLabel);
		button.title = ariaLabel;
		button.addEventListener('click', () => this._onDidRequestCollapse.fire(request));
		this.firstHeaderButton ??= button;
	}

	private renderPlaceholder(container: HTMLElement): void {
		const placeholder = this.placeholder = append(container, $('.axis-agent-placeholder'));
		placeholder.tabIndex = 0;
		append(placeholder, $('h2')).textContent = localize('axis.agent.title', "Agent view");
		append(placeholder, $('p')).textContent = localize('axis.agent.empty', "No workspaces to show yet.");
	}

	hasFocus(): boolean {
		return !!this.element && isAncestor(getActiveElement(), this.element);
	}

	focus(): void {
		if (this._collapsed) {
			this.firstHeaderButton?.focus();
			return;
		}
		if (this.content) {
			this.content.focus();
			return;
		}
		this.placeholder?.focus();
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		// Like the upstream parts, size the part's own element to its grid cell.
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		this.layoutContent();
	}

	private layoutContent(): void {
		const dimension = this.dimension;
		if (!dimension || !this.content || this._collapsed) {
			return;
		}
		const headerHeight = this.headerState.split ? AXIS_SPLIT_HEADER_SIZE : 0;
		this.content.layout(new Dimension(dimension.width, Math.max(0, dimension.height - headerHeight)));
	}

	toJSON(): object {
		return { type: AXIS_AGENT_PART_ID };
	}
}
