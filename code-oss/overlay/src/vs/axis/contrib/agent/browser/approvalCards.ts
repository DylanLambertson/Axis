/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AxisApprovalDecision, IAxisApprovalCard, isRendererResolvable } from '../../../services/approvals/common/axisApprovals.js';
import { outcomeText } from '../../../services/approvals/common/axisApprovalText.js';
import { IAxisWorkspaceService } from '../../../services/workspaces/browser/axisWorkspaceService.js';

/** Cards drawn at once; the rest are counted in a note. */
export const MAX_RENDERED_CARDS = 20;
/** Anything inside a node matching this is the composer or another agent-facing input; a decision from there is refused. */
export const COMPOSER_SELECTOR = '.axis-composer';

/**
 * The approval cards of the Agent view (docs/design/axis-shell-a4.md). Every card is display of a challenge the
 * daemon issued, written with `textContent` only. Tier 4 and 5 cards, and any card the daemon marks as needing a
 * native confirmation, have no buttons. The others get approve and deny, whose handler passes the DOM event to the
 * workspace service so the gesture is judged there; this class decides nothing about trust.
 */
export class AxisApprovalCards extends Disposable {

	readonly element: HTMLElement;
	private readonly status: HTMLElement;
	private readonly list: HTMLElement;
	private readonly cardDisposables = this._register(new DisposableStore());

	constructor(private readonly workspaceService: IAxisWorkspaceService) {
		super();
		this.element = $('.axis-approvals');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('axis.approvals.label', "Approvals"));
		this.status = append(this.element, $('.axis-approvals-status'));
		this.status.setAttribute('role', 'status');
		this.list = append(this.element, $('.axis-approvals-list'));
		this._register(this.workspaceService.onDidChangeWorkspaces(() => this.render()));
		this.render();
	}

	render(): void {
		const cards = this.workspaceService.approvalCards;
		const focused = this.list.ownerDocument.activeElement;
		const refocus = focused instanceof HTMLElement && this.list.contains(focused) ? { id: focused.dataset.challenge, decision: focused.dataset.decision } : undefined;
		this.cardDisposables.clear();
		this.list.replaceChildren();
		this.element.hidden = !cards.length;
		for (const card of cards.slice(0, MAX_RENDERED_CARDS)) {
			this.renderCard(card);
		}
		if (cards.length > MAX_RENDERED_CARDS) {
			append(this.list, $('.axis-approvals-more')).textContent = localize('axis.approvals.more', "{0} more approvals are not shown.", cards.length - MAX_RENDERED_CARDS);
		}
		if (refocus?.id) {
			const target = [...this.list.querySelectorAll<HTMLElement>('button')].find(b => b.dataset.challenge === refocus.id && b.dataset.decision === refocus.decision);
			target?.focus();
		}
	}

	private renderCard(card: IAxisApprovalCard): void {
		const element = append(this.list, $('.axis-approval-card'));
		element.setAttribute('role', 'group');
		element.dataset.challenge = card.challengeId;
		element.dataset.tier = String(card.tier);
		const name = `${card.contract}.${card.method}`;
		const title = append(element, $('h3.axis-approval-title'));
		title.textContent = localize('axis.approval.title', "Approval needed: {0}", name);
		element.setAttribute('aria-label', title.textContent);
		const rows: [string, string][] = [
			[localize('axis.approval.what', "Request"), name],
			[localize('axis.approval.target', "Target"), card.targetSummary],
			[localize('axis.approval.tier', "Tier"), String(card.tier)],
			[localize('axis.approval.expires', "Expires"), new Date(card.expiresAt).toLocaleTimeString()],
		];
		const fields = append(element, $('dl.axis-approval-fields'));
		for (const [label, value] of rows) {
			append(fields, $('dt')).textContent = label;
			append(fields, $('dd')).textContent = value;
		}
		if (!isRendererResolvable(card)) {
			append(element, $('p.axis-approval-native')).textContent = localize('axis.approval.native', "This approval is answered in the confirmation dialog, not here.");
			return;
		}
		const actions = append(element, $('.axis-approval-actions'));
		this.addButton(actions, element, card, 'approve', localize('axis.approval.approve', "Approve"));
		this.addButton(actions, element, card, 'deny', localize('axis.approval.deny', "Deny"));
	}

	private addButton(actions: HTMLElement, cardElement: HTMLElement, card: IAxisApprovalCard, decision: AxisApprovalDecision, label: string): void {
		const button = append(actions, $<HTMLButtonElement>('button.axis-button'));
		button.type = 'button';
		button.textContent = label;
		button.dataset.challenge = card.challengeId;
		button.dataset.decision = decision;
		this.cardDisposables.add(addDisposableListener(button, 'click', event => {
			const scope = {
				card: cardElement,
				button,
				activeElement: cardElement.ownerDocument.activeElement,
				isInComposer: (node: unknown) => node instanceof Element && node.closest(COMPOSER_SELECTOR) !== null,
			};
			this.workspaceService.decideApproval(card, decision, event, scope).then(outcome => {
				if (!this._store.isDisposed) {
					this.status.textContent = outcomeText(outcome);
				}
			});
		}));
	}
}
