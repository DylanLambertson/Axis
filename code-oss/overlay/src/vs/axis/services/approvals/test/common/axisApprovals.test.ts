/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonApi } from '../../../daemon/common/axisDaemonApi.js';
import { AxisDaemonCallError } from '../../../daemon/common/axisDaemonClient.js';
import { readPendingChallenges } from '../../../daemon/common/axisDaemonReplies.js';
import { challengeWire, CHALLENGE_ID, DIGEST, FakeDaemonClient } from '../../../daemon/test/common/axisDaemonFixtures.js';
import { DAEMON_RESOLVE_REPLIES } from '../../../daemon/test/common/axisResolveReplies.js';
import { APPROVAL_GUARD_MS, AxisApprovalController, IAxisApprovalCard, IAxisGestureEvent, IAxisGestureScope, isTrustedGesture, needsNativeConfirmation, scopeFor } from '../../common/axisApprovals.js';
import { outcomeText } from '../../common/axisApprovalText.js';

const NOW = 1_000_000;

function card(extra: Record<string, unknown> = {}): IAxisApprovalCard {
	return readPendingChallenges({ challenges: [challengeWire(extra)] })[0];
}

/** A card element, its button and the focus, as plain objects. */
class Dom {
	readonly button = { name: 'approve' };
	readonly other = { name: 'composer-input' };
	readonly inside = new Set<unknown>([this.button]);
	active: unknown = this.button;
	readonly composer = new Set<unknown>([this.other]);
	scope(): IAxisGestureScope {
		return { card: { contains: n => this.inside.has(n) }, button: this.button, activeElement: this.active, isInComposer: n => this.composer.has(n) };
	}
	click(over: Partial<IAxisGestureEvent> = {}): IAxisGestureEvent {
		return { isTrusted: true, type: 'click', target: this.button, ...over };
	}
}

suite('Axis approval cards', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let client: FakeDaemonClient;
	let listed: IAxisApprovalCard[] | undefined;
	let now: number;
	let mono: number;
	let refreshes: number;
	let controller: AxisApprovalController;
	let dom: Dom;

	function resolves(): unknown[] {
		return client.calls.filter(c => c.method === 'resolve').map(c => c.params);
	}

	/** Lists these cards, lays them out and lets the guard time pass. */
	function show(cards: IAxisApprovalCard[]): void {
		listed = cards;
		controller.layout();
		mono += APPROVAL_GUARD_MS + 1;
	}

	/** Lists the cards as a new listing: ids that were answered before are open again. */
	function relist(cards: IAxisApprovalCard[]): void {
		show([]);
		show(cards);
	}

	setup(() => {
		client = new FakeDaemonClient();
		client.replies.set('axis.approvals.resolve', (p: unknown) => ({ challengeId: (p as { challengeId: string }).challengeId, state: (p as { decision: string }).decision === 'approve' ? 'approved' : 'denied', nativeRequired: false }));
		listed = [card()];
		now = NOW;
		mono = 5_000;
		refreshes = 0;
		dom = new Dom();
		controller = new AxisApprovalController(new AxisDaemonApi(client), () => listed, () => now, () => mono, () => { refreshes++; });
		show([card()]);
	});

	teardown(() => client.dispose());

	test('a trusted click on a tier 3 card sends the id, the decision and the shown digest, nothing else', async () => {
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'approved' });
		assert.deepStrictEqual(resolves(), [{ challengeId: CHALLENGE_ID, decision: 'approve', digest: DIGEST }]);
		relist([card()]);
		assert.deepStrictEqual(await controller.decide(card(), 'deny', dom.click(), dom.scope()), { kind: 'denied' });
		assert.strictEqual((resolves()[1] as { decision: string }).decision, 'deny');
		assert.ok(refreshes >= 2, 'the list is read again after an answer');
	});

	test('a synthetic event is never an answer, however it is shaped', async () => {
		for (const event of [dom.click({ isTrusted: false }), dom.click({ isTrusted: undefined as unknown as boolean }), dom.click({ isTrusted: 'true' as unknown as boolean }), dom.click({ type: 'keydown' }), dom.click({ type: 'mousedown' })]) {
			assert.deepStrictEqual(await controller.decide(card(), 'approve', event, dom.scope()), { kind: 'untrusted' });
		}
		assert.deepStrictEqual(resolves(), []);
	});

	test('a click whose target is not the card\'s own button is refused', async () => {
		dom.inside.add(dom.other);
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click({ target: dom.other }), dom.scope()), { kind: 'untrusted' });
		assert.deepStrictEqual(resolves(), []);
	});

	test('focus must be inside the card, and never in the composer', async () => {
		dom.active = dom.other; // focus outside the card (the composer)
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'untrusted' });
		dom.inside.add(dom.other); // even a composer node that were somehow inside the card is refused
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'untrusted' });
		dom.active = undefined;
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'untrusted' });
		assert.deepStrictEqual(resolves(), []);
	});

	test('the button must belong to the card', async () => {
		const label = { name: 'card-label' };
		const scope = { ...dom.scope(), activeElement: label, card: { contains: (n: unknown) => n === label } }; // focus is in the card, the button is not
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), scope), { kind: 'untrusted' });
		assert.deepStrictEqual(resolves(), []);
	});

	test('tier 4 and 5 and the native flag: Approve starts the native confirmation and says so; the dialog is not answered here', async () => {
		for (const extra of [{ tier: 4, nativeConfirmationRequired: true }, { tier: 5, nativeConfirmationRequired: true }, { tier: 4, nativeConfirmationRequired: false }, { tier: 2, nativeConfirmationRequired: true }]) {
			relist([card(extra)]);
			assert.strictEqual(needsNativeConfirmation(listed![0]), true, JSON.stringify(extra));
			client.calls.length = 0;
			client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: true });
			assert.deepStrictEqual(await controller.decide(listed![0], 'approve', dom.click(), dom.scope()), { kind: 'awaiting-native' }, JSON.stringify(extra));
			assert.deepStrictEqual(resolves(), [{ challengeId: CHALLENGE_ID, decision: 'approve', digest: DIGEST }], 'one resolve, nothing else');
			assert.ok(client.calls.every(c => c.contract === 'axis.approvals'), 'no other call: the dialog is main\'s, never the renderer\'s');
		}
		for (const tier of [0, 1, 2, 3]) {
			assert.strictEqual(needsNativeConfirmation(card({ tier })), false, `tier ${tier}`);
		}
	});

	test('a native card needs the same trusted gesture: an untrusted event sends nothing', async () => {
		relist([card({ tier: 4, nativeConfirmationRequired: true })]);
		for (const event of [dom.click({ isTrusted: false }), dom.click({ type: 'keydown' }), dom.click({ target: dom.other })]) {
			assert.deepStrictEqual(await controller.decide(listed![0], 'approve', event, dom.scope()), { kind: 'untrusted' });
		}
		dom.active = dom.other;
		assert.deepStrictEqual(await controller.decide(listed![0], 'approve', dom.click(), dom.scope()), { kind: 'untrusted' });
		assert.deepStrictEqual(resolves(), []);
	});

	test('every reply the real daemon sends is read as what it means: a tier 4 or 5 Deny is denied, not a failure', async () => {
		const expected = { approve: { kind: 'approved' }, deny: { kind: 'denied' } } as const;
		for (const row of DAEMON_RESOLVE_REPLIES) {
			relist([card({ tier: row.tier, nativeConfirmationRequired: row.tier >= 4 })]);
			if (row.late) {
				now = 2_000_000 - 1; // the card is not expired here; the daemon finds it expired
			}
			client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: row.state, nativeRequired: row.nativeRequired });
			const outcome = row.state === 'expired' ? { kind: 'expired' } : row.decision === 'approve' && row.nativeRequired ? { kind: 'awaiting-native' } : expected[row.decision];
			assert.deepStrictEqual(await controller.decide(listed![0], row.decision, dom.click(), dom.scope()), outcome, JSON.stringify(row));
			assert.deepStrictEqual(await controller.decide(listed![0], row.decision, dom.click(), dom.scope()), { kind: 'settled' }, `${JSON.stringify(row)}: settled, so no second resolve`);
			now = NOW;
		}
		assert.strictEqual(resolves().length, DAEMON_RESOLVE_REPLIES.length);
	});

	test('a native flag that does not match the card is refused, either way', async () => {
		relist([card()]);
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: true });
		assert.deepStrictEqual(await controller.decide(listed![0], 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'invalid_reply' }, 'a native step on a card that has none');
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'denied', nativeRequired: true });
		assert.deepStrictEqual(await controller.decide(listed![0], 'deny', dom.click(), dom.scope()), { kind: 'failed', code: 'invalid_reply' });
		relist([card({ tier: 4, nativeConfirmationRequired: true })]);
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(listed![0], 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'invalid_reply' }, 'a native card is never settled without the dialog');
	});

	test('a stale challenge is refused: gone from the list, or listed with another digest', async () => {
		const shown = card();
		listed = [];
		assert.deepStrictEqual(await controller.decide(shown, 'approve', dom.click(), dom.scope()), { kind: 'stale' });
		listed = undefined;
		assert.deepStrictEqual(await controller.decide(shown, 'approve', dom.click(), dom.scope()), { kind: 'stale' });
		listed = [card({ digest: 'cd'.repeat(32) })]; // not laid out: the shown digest no longer matches the listing
		assert.deepStrictEqual(await controller.decide(shown, 'approve', dom.click(), dom.scope()), { kind: 'stale' });
		assert.deepStrictEqual(resolves(), []);
		assert.strictEqual(refreshes, 3, 'a stale answer asks for a fresh list');
	});

	test('an expired challenge is not sent, and the boundary instant is expired', async () => {
		now = 2_000_000 - 1;
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'approved' });
		now = 2_000_000;
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'expired' });
		now = 3_000_000;
		assert.deepStrictEqual(await controller.decide(card(), 'deny', dom.click(), dom.scope()), { kind: 'expired' });
		assert.strictEqual(resolves().length, 1);
	});

	test('a second answer while one is in flight is refused, then allowed after it ends', async () => {
		let release!: () => void;
		client.replies.set('axis.approvals.resolve', () => new Promise(resolve => { release = () => resolve({ challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: false }); }));
		const first = controller.decide(card(), 'approve', dom.click(), dom.scope());
		assert.deepStrictEqual(await controller.decide(card(), 'deny', dom.click(), dom.scope()), { kind: 'busy' });
		release();
		assert.deepStrictEqual(await first, { kind: 'approved' });
		assert.strictEqual(resolves().length, 1);
		assert.deepStrictEqual(await controller.decide(card(), 'deny', dom.click(), dom.scope()), { kind: 'settled' }, 'answered: a repeat sends nothing');
		assert.strictEqual(resolves().length, 1);
	});

	/** One answer per challenge: lets the test ask again by listing it afresh. */
	function again(): IAxisApprovalCard {
		relist([card()]);
		return listed![0];
	}

	test('outcomes: expired, native pending, a call failure, and replies that do not match the question', async () => {
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'expired', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(again(), 'approve', dom.click(), dom.scope()), { kind: 'expired' });
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: true });
		relist([card({ tier: 4, nativeConfirmationRequired: true })]);
		assert.deepStrictEqual(await controller.decide(listed![0], 'approve', dom.click(), dom.scope()), { kind: 'awaiting-native' });
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(again(), 'deny', dom.click(), dom.scope()), { kind: 'failed', code: 'invalid_reply' }, 'approved is not an answer to deny');
		client.replies.set('axis.approvals.resolve', { challengeId: 'chal_BBBBBBBBBBBBBBBBBBBBBB', state: 'approved', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(again(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'invalid_reply' }, 'another challenge id');
		client.replies.set('axis.approvals.resolve', () => { throw new AxisDaemonCallError('E_POLICY_DENIED'); });
		assert.deepStrictEqual(await controller.decide(again(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'E_POLICY_DENIED' });
		client.replies.set('axis.approvals.resolve', () => { throw new Error('secret path /home/x'); });
		assert.deepStrictEqual(await controller.decide(again(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'E_INTERNAL' });
	});

	test('the answer text is fixed per outcome and never carries a code or daemon text', () => {
		const texts = [
			outcomeText({ kind: 'approved' }), outcomeText({ kind: 'denied' }), outcomeText({ kind: 'awaiting-native' }), outcomeText({ kind: 'expired' }),
			outcomeText({ kind: 'stale' }), outcomeText({ kind: 'untrusted' }), outcomeText({ kind: 'too-soon' }), outcomeText({ kind: 'settled' }), outcomeText({ kind: 'busy' }),
		];
		assert.strictEqual(new Set(texts).size, texts.length);
		assert.strictEqual(outcomeText({ kind: 'failed', code: 'E_POLICY_DENIED' }), outcomeText({ kind: 'failed', code: 'secret' }));
		assert.ok(!outcomeText({ kind: 'failed', code: 'E_POLICY_DENIED' }).includes('E_'));
	});

	test('agent-authored text with markup stays text: it is kept as a string, cleaned of control and bidi characters, and never parsed', () => {
		const markup = '<img src=x onerror=alert(1)><button>Approve</button>‮&amp;';
		const [c] = readPendingChallenges({ challenges: [challengeWire({ targetSummary: markup })] });
		assert.ok(c.targetSummary.includes('<img src=x onerror=alert(1)><button>Approve</button>'), 'markup is preserved as characters for textContent');
		assert.ok(!c.targetSummary.includes('‮'), 'a bidi override does not survive');
		assert.strictEqual(typeof c.targetSummary, 'string');
	});

	test('a card is not answerable until it has been in place for the guard time, and never when it was not laid out', async () => {
		show([]);
		listed = [card()];
		assert.deepStrictEqual(await controller.decide(listed[0], 'approve', dom.click(), dom.scope()), { kind: 'too-soon' }, 'listed but never laid out');
		controller.layout();
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), APPROVAL_GUARD_MS);
		mono += APPROVAL_GUARD_MS - 1;
		assert.deepStrictEqual(await controller.decide(listed[0], 'approve', dom.click(), dom.scope()), { kind: 'too-soon' });
		mono += 1;
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), 0);
		assert.deepStrictEqual(await controller.decide(listed[0], 'approve', dom.click(), dom.scope()), { kind: 'approved' });
		assert.strictEqual(resolves().length, 1, 'the guard sent nothing before it ended');
	});

	test('a card that moves, or comes back with another digest, is guarded again; an unchanged one is not', async () => {
		const a = card();
		const b = card({ challengeId: 'chal_BBBBBBBBBBBBBBBBBBBBBB', digest: 'cd'.repeat(32) });
		show([a, b]);
		controller.layout();
		assert.strictEqual(controller.guardRemaining(a.challengeId), 0, 'laying out again does not restart the guard');
		show([a]); // b leaves: a, before it, does not move
		assert.strictEqual(controller.guardRemaining(a.challengeId), 0, 'a card before the gap stays answerable');
		show([a, b]);
		const c = card({ challengeId: 'chal_CCCCCCCCCCCCCCCCCCCCCC', digest: 'ef'.repeat(32) });
		listed = [c, b]; // a leaves and c arrives: b moves up one place
		controller.layout();
		assert.ok(controller.guardRemaining(b.challengeId) > 0, 'b moved');
		assert.ok(controller.guardRemaining(c.challengeId) > 0, 'c is new');
		assert.deepStrictEqual(await controller.decide(b, 'approve', dom.click(), dom.scope()), { kind: 'too-soon' });
		show([card()]);
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), 0);
		listed = [card({ digest: 'ee'.repeat(32) })];
		controller.layout();
		assert.ok(controller.guardRemaining(CHALLENGE_ID) > 0, 'another digest is another card');
		assert.strictEqual(resolves().length, 0);
	});

	test('layout keeps shown cards where they are and adds new ones last', () => {
		const a = card({ challengeId: 'chal_AAAAAAAAAAAAAAAAAAAAAA' });
		const b = card({ challengeId: 'chal_BBBBBBBBBBBBBBBBBBBBBB', digest: 'cd'.repeat(32) });
		const c = card({ challengeId: 'chal_CCCCCCCCCCCCCCCCCCCCCC', digest: 'ef'.repeat(32) });
		const ids = (cards: IAxisApprovalCard[]) => cards.map(x => x.challengeId.charAt(5));
		listed = [a, b];
		assert.deepStrictEqual(ids(controller.layout()), ['A', 'B']);
		listed = [c, b, a]; // the daemon lists c first, and in another order: shown cards do not move
		assert.deepStrictEqual(ids(controller.layout()), ['A', 'B', 'C']);
		listed = [c, a]; // b is gone: the gap closes, the order of the rest stays
		assert.deepStrictEqual(ids(controller.layout()), ['A', 'C']);
		listed = undefined;
		assert.deepStrictEqual(controller.layout(), []);
	});

	test('a card answered once stays settled while it is listed, and is answerable again only as a new listing', async () => {
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'approved' });
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'settled' });
		assert.deepStrictEqual(await controller.decide(card(), 'deny', dom.click(), dom.scope()), { kind: 'settled' });
		assert.strictEqual(resolves().length, 1);
		client.replies.set('axis.approvals.resolve', () => { throw new AxisDaemonCallError('E_CONFLICT'); });
		relist([card()]);
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'E_CONFLICT' }, 'a failure does not settle');
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'E_CONFLICT' });
	});

	test('the view\'s scope is the card element, its button, and the active element read from the card\'s document', () => {
		const button = { name: 'b' };
		const label = { name: 'label' };
		const doc = { activeElement: label as unknown };
		const cardElement = { ownerDocument: doc, contains: (n: unknown) => n === button || n === label };
		const scope = scopeFor(cardElement, button, () => false);
		assert.strictEqual(scope.card, cardElement);
		assert.strictEqual(scope.button, button);
		assert.strictEqual(scope.activeElement, label, 'not the button, and read from the document');
		doc.activeElement = { name: 'page-body' };
		const later = scopeFor(cardElement, button, () => false);
		assert.strictEqual(later.card.contains(later.activeElement), false, 'focus outside the card fails the gate');
		assert.strictEqual(isTrustedGesture({ isTrusted: true, type: 'click', target: button }, later), false);
		const inComposer = scopeFor({ ...cardElement, contains: () => true }, button, n => n === label);
		doc.activeElement = label;
		assert.strictEqual(scopeFor({ ...cardElement, contains: () => true }, button, n => n === label).isInComposer(label), true);
		assert.strictEqual(inComposer.isInComposer(button), false);
	});

	test('a card that moves on screen is guarded again; one that stays put is not', async () => {
		controller.placed(CHALLENGE_ID, 300, 10);
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), 0, 'the first position is only recorded');
		controller.placed(CHALLENGE_ID, 300, 10);
		controller.layout();
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), 0, 'same place, same list: still answerable');
		controller.placed(CHALLENGE_ID, 268, 10); // a worktree row above was removed: the region slid up 32 px
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), APPROVAL_GUARD_MS);
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'too-soon' });
		mono += APPROVAL_GUARD_MS;
		controller.placed(CHALLENGE_ID, 268, 40);
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), APPROVAL_GUARD_MS, 'a sideways move counts too');
		mono += APPROVAL_GUARD_MS;
		listed = [card({ digest: 'ee'.repeat(32) })];
		controller.layout(); // guarded again for the digest; the last position is kept
		mono += APPROVAL_GUARD_MS;
		controller.placed(CHALLENGE_ID, 100, 40);
		assert.strictEqual(controller.guardRemaining(CHALLENGE_ID), APPROVAL_GUARD_MS, 'a move after a re-layout is still a move');
		controller.placed('chal_ZZZZZZZZZZZZZZZZZZZZZZ', 1, 1);
		assert.strictEqual(controller.guardRemaining('chal_ZZZZZZZZZZZZZZZZZZZZZZ'), APPROVAL_GUARD_MS, 'an unknown id stays guarded');
		assert.strictEqual(resolves().length, 0);
	});

	test('a listing that could not be read keeps the answered ids: no second resolve for a card already answered', async () => {
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'approved' });
		listed = undefined;
		assert.deepStrictEqual(controller.layout(), []);
		show([card()]);
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'settled' });
		assert.strictEqual(resolves().length, 1);
		show([]); // a listing that was read and no longer has it
		show([card()]);
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'approved' });
	});
});
