/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/agentPart.css';
import { $, append, Dimension } from '../../../base/browser/dom.js';
import { LayoutPriority } from '../../../base/browser/ui/grid/grid.js';
import { localize } from '../../../nls.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Part } from '../../../workbench/browser/part.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { AXIS_AGENT_PART_ID } from '../axisLayoutService.js';

/**
 * Content hosted by the agent part. The part owns the grid leaf; the content
 * owns everything inside it (the workspaces rail and the dashboard, task A3).
 */
export interface IAxisAgentPartContent {
	readonly element: HTMLElement;
	layout(dimension: Dimension): void;
	focus(): void;
}

/**
 * The Axis agent part: the one Axis-owned part in the workbench grid
 * (docs/design/axis-agent-shell.md sections 3.1 and 4.1). It is the flex part
 * in the Agent view and hidden in the IDE view.
 */
export class AgentPart extends Part {

	readonly minimumWidth: number = 320;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 160;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	readonly priority: LayoutPriority = LayoutPriority.High;

	private contentContainer: HTMLElement | undefined;
	private placeholder: HTMLElement | undefined;
	private content: IAxisAgentPartContent | undefined;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super(AXIS_AGENT_PART_ID, { hasTitle: false }, themeService, storageService, layoutService);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.contentContainer = append(parent, $('.content.axis-agent-content'));
		if (this.content) {
			this.contentContainer.appendChild(this.content.element);
		} else {
			this.renderPlaceholder(this.contentContainer);
		}
		return this.contentContainer;
	}

	/** Replaces the placeholder with the agent content (the rail and the dashboard). */
	setContent(content: IAxisAgentPartContent): void {
		this.content = content;
		this.placeholder = undefined;
		if (this.contentContainer) {
			this.contentContainer.replaceChildren(content.element);
			if (this.dimension) {
				content.layout(this.dimension);
			}
		}
	}

	private renderPlaceholder(container: HTMLElement): void {
		const placeholder = this.placeholder = append(container, $('.axis-agent-placeholder'));
		placeholder.tabIndex = 0;
		append(placeholder, $('h2')).textContent = localize('axis.agent.title', "Agent view");
		append(placeholder, $('p')).textContent = localize('axis.agent.empty', "No workspaces to show yet.");
	}

	focus(): void {
		if (this.content) {
			this.content.focus();
			return;
		}
		this.placeholder?.focus();
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		this.content?.layout(new Dimension(width, height));
	}

	toJSON(): object {
		return { type: AXIS_AGENT_PART_ID };
	}
}
