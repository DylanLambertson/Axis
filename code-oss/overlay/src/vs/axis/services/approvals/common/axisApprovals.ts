/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AxisDaemonCallError } from '../../daemon/common/axisDaemonClient.js';

/*
 * Approval cards (docs/design/axis-shell-a4.md). The cards are display of daemon-issued challenges; the daemon
 * decides everything. The renderer's only power is to forward a user's answer to `axis.approvals/1.resolve` for a
 * challenge below tier 4, and only on a trusted gesture. Tier 4 and above are answered in the native dialog.
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

/** The highest tier the renderer may answer. Tier 4 and 5 need the native confirmation from main. */
export const MAX_RENDERER_TIER = 3;

/**
 * Whether the card gets approve and deny buttons. Both signals must agree that it is not native: a tier of 4 or
 * more, or a daemon that asks for a native confirmation, makes the card display-only (fail closed on a mismatch).
 */
export function isRendererResolvable(card: Pick<IAxisApprovalCard, 'tier' | 'nativeConfirmationRequired'>): boolean {
	return card.tier <= MAX_RENDERER_TIER && !card.nativeConfirmationRequired;
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

/** Closed outcomes the controller reports; the view maps each to fixed text. */
export type AxisApprovalOutcome =
	| { readonly kind: 'approved' }
	| { readonly kind: 'denied' }
	| { readonly kind: 'awaiting-native' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'stale' }
	| { readonly kind: 'untrusted' }
	| { readonly kind: 'native-only' }
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
 * Decides whether a gesture may become an `axis.approvals/1.resolve` call. It holds no timer and no listener.
 * `cards` is the latest listing; the digest sent is the one the user was shown and must still be the listed one.
 */
export class AxisApprovalController {

	private readonly inFlight = new Set<string>();

	constructor(
		private readonly resolver: IAxisApprovalResolver,
		private readonly cards: () => readonly IAxisApprovalCard[] | undefined,
		private readonly now: () => number,
		private readonly refresh: () => void,
	) { }

	async decide(shown: Pick<IAxisApprovalCard, 'challengeId' | 'digest'>, decision: AxisApprovalDecision, event: IAxisGestureEvent, scope: IAxisGestureScope): Promise<AxisApprovalOutcome> {
		if (!isTrustedGesture(event, scope)) {
			return { kind: 'untrusted' };
		}
		const current = findCard(this.cards(), shown.challengeId);
		if (!current || current.digest !== shown.digest) {
			this.refresh();
			return { kind: 'stale' };
		}
		if (isExpired(current, this.now())) {
			this.refresh();
			return { kind: 'expired' };
		}
		if (!isRendererResolvable(current)) {
			return { kind: 'native-only' };
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
				return { kind: 'expired' };
			}
			if (reply.state !== (decision === 'approve' ? 'approved' : 'denied')) {
				return { kind: 'failed', code: 'invalid_reply' }; // the answer must be the one that was asked for
			}
			return reply.state === 'approved' && reply.nativeRequired ? { kind: 'awaiting-native' } : { kind: reply.state };
		} catch (error) {
			return { kind: 'failed', code: error instanceof AxisDaemonCallError ? error.code : 'E_INTERNAL' };
		} finally {
			this.inFlight.delete(current.challengeId);
			this.refresh();
		}
	}
}
