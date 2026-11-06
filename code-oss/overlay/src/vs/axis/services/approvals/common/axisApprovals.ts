/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AxisDaemonCallError } from '../../daemon/common/axisDaemonClient.js';

/*
 * Approval cards (docs/design/axis-shell-a4.md). The cards are display of daemon-issued challenges; the daemon
 * decides everything. The renderer's only power is to forward a user's answer to `axis.approvals/1.resolve`, and only
 * on a trusted gesture. For tier 4 and above (or a native flag) Approve is the first step only: it moves the
 * challenge to awaiting the native confirmation, which main shows and the user settles in that dialog.
 */

/** A pending challenge as `axis.approvals/1.pending` lists it, text already cleaned. */
export interface IAxisApprovalCard {
	readonly challengeId: string;
	readonly digest: string;
	readonly contract: string;
	readonly method: string;
	readonly tier: number;
	readonly targetSummary: string;
	readonly nativeConfirmationRequired: boolean;
	/** Epoch milliseconds. */
	readonly expiresAt: number;
}

export type AxisApprovalDecision = 'approve' | 'deny';

/** The lowest tier whose approval also needs the native confirmation from main (ADR 0003 D4). */
export const NATIVE_TIER = 4;

/** Shared by the view and any composer: a node inside a match of this selector never counts as a place an answer may come from. */
export const COMPOSER_SELECTOR = '.axis-composer';

/** How long a card must have been visible and in the same place before a click on it counts. */
export const APPROVAL_GUARD_MS = 500;

/**
 * Whether Approve only starts the native confirmation (so the button says so and the user is told to expect the
 * dialog). Either signal is enough: a tier of 4 or more, or a daemon flag. The native dialog is the real gate and
 * is never answered from the renderer.
 */
export function needsNativeConfirmation(card: Pick<IAxisApprovalCard, 'tier' | 'nativeConfirmationRequired'>): boolean {
	return card.tier >= NATIVE_TIER || card.nativeConfirmationRequired;
}

export function isExpired(card: Pick<IAxisApprovalCard, 'expiresAt'>, now: number): boolean {
	return !(now < card.expiresAt);
}

/** Two-way lookup used by the controller: the card currently listed for this id, if any. */
export function findCard(cards: readonly IAxisApprovalCard[] | undefined, challengeId: string): IAxisApprovalCard | undefined {
	return cards?.find(card => card.challengeId === challengeId);
}

/** What the DOM event gives the gate; `target` is compared by identity. */
export interface IAxisGestureEvent {
	readonly isTrusted: boolean;
	readonly type: string;
	readonly target: unknown;
}

export interface IAxisGestureNode {
	contains(other: unknown): boolean;
}

/** Where the gesture happened, read by the view at the time of the event. */
export interface IAxisGestureScope {
	/** The card element the decision belongs to. */
	readonly card: IAxisGestureNode;
	/** The approve or deny button of that card. */
	readonly button: unknown;
	/** `document.activeElement` when the event was handled. */
	readonly activeElement: unknown;
	/** True for a node inside the composer (or any other agent-facing input). */
	isInComposer(node: unknown): boolean;
}

/**
 * A decision counts only when the browser says a user produced it (`isTrusted`, which script-dispatched and
 * `element.click()` events never have), it is a click on that card's own button, and the keyboard focus is inside
 * the card and not in the composer.
 */
export function isTrustedGesture(event: IAxisGestureEvent, scope: IAxisGestureScope): boolean {
	return event.isTrusted === true
		&& event.type === 'click'
		&& event.target === scope.button
		&& scope.card.contains(scope.button)
		&& scope.card.contains(scope.activeElement)
		&& !scope.isInComposer(scope.activeElement);
}

/**
 * The scope the view hands to the gate, read at the time of the event: the card element itself, the button, and the
 * document's active element. The view calls this and nothing else to build it.
 */
export function scopeFor(card: IAxisGestureNode & { readonly ownerDocument: { readonly activeElement: unknown } }, button: unknown, isInComposer: (node: unknown) => boolean): IAxisGestureScope {
	return { card, button, activeElement: card.ownerDocument.activeElement, isInComposer };
}

/** Closed outcomes the controller reports; the view maps each to fixed text. */
export type AxisApprovalOutcome =
	| { readonly kind: 'approved' }
	| { readonly kind: 'denied' }
	| { readonly kind: 'awaiting-native' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'stale' }
	| { readonly kind: 'untrusted' }
	| { readonly kind: 'too-soon' }
	| { readonly kind: 'settled' }
	| { readonly kind: 'busy' }
	| { readonly kind: 'failed'; readonly code: string };

export interface IAxisApprovalResolveReply {
	readonly challengeId: string;
	readonly state: 'approved' | 'denied' | 'expired';
	readonly nativeRequired: boolean;
}

export interface IAxisApprovalResolver {
	resolveApproval(challengeId: string, decision: AxisApprovalDecision, digest: string): Promise<IAxisApprovalResolveReply>;
}

/**
 * Decides whether a gesture may become an `axis.approvals/1.resolve` call, and keeps the cards in a stable order
 * with a guard time per card. It holds no timer and no listener; both clocks are injected (`now` is epoch time, for
 * expiry; `mono` is monotonic, for the guard).
 * `cards` is the latest listing; the digest sent is the one the user was shown and must still be the listed one.
 */
export class AxisApprovalController {

	private readonly inFlight = new Set<string>();
	/** Answered ids, kept until the id leaves the listing, so a repeated click or key repeat sends nothing. */
	private readonly settled = new Set<string>();
	/** Display order: existing cards never move, new ones go last. */
	private order: string[] = [];
	/** When each card last appeared, moved or changed (monotonic). */
	private readonly since = new Map<string, { mono: number; index: number; digest: string }>();

	constructor(
		private readonly resolver: IAxisApprovalResolver,
		private readonly cards: () => readonly IAxisApprovalCard[] | undefined,
		private readonly now: () => number,
		private readonly mono: () => number,
		private readonly refresh: () => void,
	) { }

	/**
	 * The cards in display order. An id that was shown keeps its place (a gone card closes the gap behind it, which
	 * counts as a move for the cards after it); a new id goes last. A card that is new, moved or has another digest
	 * starts its guard time again.
	 */
	layout(): IAxisApprovalCard[] {
		const listed = this.cards() ?? [];
		const byId = new Map(listed.map(card => [card.challengeId, card]));
		const kept = this.order.filter(id => byId.has(id));
		const added = listed.map(card => card.challengeId).filter(id => !kept.includes(id));
		this.order = [...kept, ...added];
		const t = this.mono();
		const ordered = this.order.map(id => byId.get(id)!);
		ordered.forEach((card, index) => {
			const before = this.since.get(card.challengeId);
			if (!before || before.index !== index || before.digest !== card.digest) {
				this.since.set(card.challengeId, { mono: t, index, digest: card.digest });
			}
		});
		for (const id of [...this.since.keys()]) {
			if (!byId.has(id)) {
				this.since.delete(id);
				this.settled.delete(id);
			}
		}
		return ordered;
	}

	/** Milliseconds until a click on this card counts; 0 when it may be answered. Unknown ids are guarded for the whole time. */
	guardRemaining(challengeId: string): number {
		const entry = this.since.get(challengeId);
		return entry ? Math.max(0, APPROVAL_GUARD_MS - (this.mono() - entry.mono)) : APPROVAL_GUARD_MS;
	}

	async decide(shown: Pick<IAxisApprovalCard, 'challengeId' | 'digest'>, decision: AxisApprovalDecision, event: IAxisGestureEvent, scope: IAxisGestureScope): Promise<AxisApprovalOutcome> {
		if (!isTrustedGesture(event, scope)) {
			return { kind: 'untrusted' };
		}
		const current = findCard(this.cards(), shown.challengeId);
		if (!current || current.digest !== shown.digest) {
			this.refresh();
			return { kind: 'stale' };
		}
		if (this.guardRemaining(current.challengeId) > 0) {
			return { kind: 'too-soon' };
		}
		if (isExpired(current, this.now())) {
			this.refresh();
			return { kind: 'expired' };
		}
		if (this.settled.has(current.challengeId)) {
			return { kind: 'settled' };
		}
		if (this.inFlight.has(current.challengeId)) {
			return { kind: 'busy' };
		}
		this.inFlight.add(current.challengeId);
		try {
			const reply = await this.resolver.resolveApproval(current.challengeId, decision, current.digest);
			if (reply.challengeId !== current.challengeId) {
				return { kind: 'failed', code: 'invalid_reply' };
			}
			if (reply.state === 'expired') {
				this.settled.add(current.challengeId);
				return { kind: 'expired' };
			}
			if (reply.state !== (decision === 'approve' ? 'approved' : 'denied')) {
				return { kind: 'failed', code: 'invalid_reply' }; // the answer must be the one that was asked for
			}
			if (reply.nativeRequired && !(reply.state === 'approved' && needsNativeConfirmation(current))) {
				return { kind: 'failed', code: 'invalid_reply' }; // a native step was asked for on a card that has none
			}
			this.settled.add(current.challengeId);
			return reply.nativeRequired ? { kind: 'awaiting-native' } : { kind: reply.state };
		} catch (error) {
			return { kind: 'failed', code: error instanceof AxisDaemonCallError ? error.code : 'E_INTERNAL' };
		} finally {
			this.inFlight.delete(current.challengeId);
			this.refresh();
		}
	}
}
