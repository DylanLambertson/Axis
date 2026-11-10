/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AxisApprovalDecision, COMPOSER_SELECTOR, IAxisApprovalCard, needsNativeConfirmation, scopeFor } from '../../../services/approvals/common/axisApprovals.js';
import { outcomeText } from '../../../services/approvals/common/axisApprovalText.js';
import { IAxisWorkspaceService } from '../../../services/workspaces/browser/axisWorkspaceService.js';

/** Cards drawn at once; the rest are counted in a note. */
export const MAX_RENDERED_CARDS = 20;

interface ICardView {
	readonly card: IAxisApprovalCard;
	readonly element: HTMLElement;
	readonly buttons: HTMLButtonElement[];
	readonly disposables: DisposableStore;
}

/**
 * The approval cards of the dashboard (docs/design/axis-shell-a4.md). Every card is display of a challenge the
 * daemon issued, written with `textContent` only. Every card has Deny and Approve; for tier 4 and above (or a native
 * flag) the Approve button says that a native confirmation follows, and that dialog, not this view, settles it.
 * The handler passes the DOM event itself to the workspace service so the gesture is judged there.
 *
 * A card keeps its element for as long as its challenge (and digest) stays listed, and new cards are added last, so
 * a button the user is aiming at is never replaced by another card's. Buttons are disabled while a card is new or has
 * moved (the guard time) and once it has expired. The whole region moves when anything above it changes height (an
 * agent can add or remove worktree rows), so the view reports each card's screen position to the service after
 * drawing, whenever an element above it or the list changes size or anything scrolls, and at the click itself; a card
 * that moved is guarded again. The status line sits below the cards, so an answer's text never moves a card.
 */
export class AxisApprovalCards extends Disposable {

	readonly element: HTMLElement;
	private readonly status: HTMLElement;
	private readonly list: HTMLElement;
	private readonly more: HTMLElement;
	private readonly views = new Map<string, ICardView>();
	private readonly buttonTimer = this._register(new RunOnceScheduler(() => this.updateButtons(), 0));
	private readonly placeTimer = this._register(new RunOnceScheduler(() => this.place(), 0));
	private observer: ResizeObserver | undefined;

	constructor(private readonly workspaceService: IAxisWorkspaceService) {
		super();
		this.element = $('.axis-approvals');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('axis.approvals.label', "Approvals"));
		this.list = append(this.element, $('.axis-approvals-list'));
		this.more = append(this.element, $('.axis-approvals-more'));
		this.status = append(this.element, $('.axis-approvals-status')); // below the cards: its text never moves one
		this.status.setAttribute('role', 'status');
		this._register(this.workspaceService.onDidChangeWorkspaces(() => this.render()));
		this._register(addDisposableListener(this.element.ownerDocument, 'scroll', () => this.placeTimer.schedule(), true));
		this._register(toDisposable(() => this.observer?.disconnect()));
		this._register({ dispose: () => this.views.forEach(view => view.disposables.dispose()) });
		this.render();
	}

	render(): void {
		const all = this.workspaceService.layoutApprovals();
		const cards = all.slice(0, MAX_RENDERED_CARDS);
		const ids = new Set(cards.map(card => card.challengeId));
		for (const [id, view] of this.views) {
			if (!ids.has(id)) {
				view.disposables.dispose();
				view.element.remove();
				this.views.delete(id);
			}
		}
		for (const card of cards) {
			const existing = this.views.get(card.challengeId);
			if (existing && existing.card.digest === card.digest) {
				continue; // same challenge, same place: keep the element the user may be aiming at
			}
			const view = this.createCard(card);
			if (existing) {
				existing.disposables.dispose();
				existing.element.replaceWith(view.element);
			} else {
				this.list.appendChild(view.element); // new cards go last
			}
			this.views.set(card.challengeId, view);
		}
		this.element.hidden = !cards.length;
		this.more.textContent = all.length > cards.length ? localize('axis.approvals.more', "{0} more approvals are not shown.", all.length - cards.length) : '';
		this.updateButtons();
		this.placeTimer.schedule(); // after the rest of the dashboard has drawn for the same change
	}

	/** Watches the size of everything above the region (and the list itself): any change there moves the cards. */
	private observe(): void {
		const parent = this.element.parentElement;
		if (this.observer || !parent) {
			return;
		}
		const observer = this.observer = new ResizeObserver(() => this.placeTimer.schedule());
		observer.observe(parent);
		observer.observe(this.list);
		for (let node = parent.firstElementChild; node && node !== this.element; node = node.nextElementSibling) {
			observer.observe(node);
		}
	}

	/** Reports where each card is on screen; the service guards a card again when its position changed. */
	private place(): void {
		this.observe();
		for (const [id, view] of this.views) {
			const rect = view.element.getBoundingClientRect();
			this.workspaceService.approvalPlaced(id, rect.top, rect.left, rect.width, rect.height);
		}
		this.updateButtons();
	}

	/** Disables the buttons of a card that is new, moved or expired, and schedules the next moment that changes that. */
	private updateButtons(): void {
		const now = Date.now();
		let next = Number.POSITIVE_INFINITY;
		for (const [id, view] of this.views) {
			const guard = this.workspaceService.approvalGuardRemaining(id);
			const untilExpiry = view.card.expiresAt - now;
			const disabled = guard > 0 || untilExpiry <= 0;
			view.buttons.forEach(button => { button.disabled = disabled; });
			for (const wait of [guard, untilExpiry]) {
				if (wait > 0) {
					next = Math.min(next, wait);
				}
			}
		}
		if (next !== Number.POSITIVE_INFINITY) {
			this.buttonTimer.schedule(Math.max(next, 1));
		}
	}

	private createCard(card: IAxisApprovalCard): ICardView {
		const element = $('.axis-approval-card');
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
		const view: ICardView = { card, element, buttons: [], disposables: new DisposableStore() };
		const native = needsNativeConfirmation(card);
		if (native) {
			append(element, $('p.axis-approval-native')).textContent = localize('axis.approval.native', "Approve here, then confirm it in the Axis confirmation dialog; Axis never answers that dialog for you.");
		}
		const actions = append(element, $('.axis-approval-actions'));
		this.addButton(view, actions, name, 'deny', localize('axis.approval.deny', "Deny"));
		this.addButton(view, actions, name, 'approve', native ? localize('axis.approval.approveNative', "Approve, then confirm in the dialog") : localize('axis.approval.approve', "Approve"));
		return view;
	}

	private addButton(view: ICardView, actions: HTMLElement, name: string, decision: AxisApprovalDecision, label: string): void {
		const cardElement = view.element;
		const button = append(actions, $<HTMLButtonElement>('button.axis-button'));
		button.type = 'button';
		button.textContent = label;
		button.dataset.challenge = view.card.challengeId;
		button.dataset.decision = decision;
		button.disabled = true; // enabled by updateButtons once the guard time has passed
		view.buttons.push(button);
		view.disposables.add(addDisposableListener(button, 'click', event => {
			const rect = cardElement.getBoundingClientRect(); // where the card is now: a card that moved since it was last seen is guarded again
			this.workspaceService.approvalPlaced(view.card.challengeId, rect.top, rect.left, rect.width, rect.height);
			const scope = scopeFor(cardElement, button, (node: unknown) => node instanceof Element && node.closest(COMPOSER_SELECTOR) !== null);
			this.workspaceService.decideApproval(view.card, decision, event, scope).then(outcome => {
				if (!this._store.isDisposed) {
					this.updateButtons();
					this.status.textContent = localize('axis.approval.outcomeFor', "{0}: {1}", name, outcomeText(outcome));
				}
			});
		}));
	}
}
