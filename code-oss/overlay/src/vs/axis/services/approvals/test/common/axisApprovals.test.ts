/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AxisDaemonApi } from '../../../daemon/common/axisDaemonApi.js';
import { AxisDaemonCallError } from '../../../daemon/common/axisDaemonClient.js';
import { readPendingChallenges } from '../../../daemon/common/axisDaemonReplies.js';
import { challengeWire, CHALLENGE_ID, DIGEST, FakeDaemonClient } from '../../../daemon/test/common/axisDaemonFixtures.js';
import { AxisApprovalController, IAxisApprovalCard, IAxisGestureEvent, IAxisGestureScope, isRendererResolvable } from '../../common/axisApprovals.js';
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
	let refreshes: number;
	let controller: AxisApprovalController;
	let dom: Dom;

	function resolves(): unknown[] {
		return client.calls.filter(c => c.method === 'resolve').map(c => c.params);
	}

	setup(() => {
		client = new FakeDaemonClient();
		client.replies.set('axis.approvals.resolve', (p: unknown) => ({ challengeId: (p as { challengeId: string }).challengeId, state: (p as { decision: string }).decision === 'approve' ? 'approved' : 'denied', nativeRequired: false }));
		listed = [card()];
		now = NOW;
		refreshes = 0;
		dom = new Dom();
		controller = new AxisApprovalController(new AxisDaemonApi(client), () => listed, () => now, () => { refreshes++; });
	});

	teardown(() => client.dispose());

	test('a trusted click on a tier 3 card sends the id, the decision and the shown digest, nothing else', async () => {
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'approved' });
		assert.deepStrictEqual(resolves(), [{ challengeId: CHALLENGE_ID, decision: 'approve', digest: DIGEST }]);
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

	test('tier 4 and 5, and a native confirmation flag, are never answered here, approve or deny', async () => {
		for (const extra of [{ tier: 4, nativeConfirmationRequired: true }, { tier: 5, nativeConfirmationRequired: true }, { tier: 4, nativeConfirmationRequired: false }, { tier: 2, nativeConfirmationRequired: true }]) {
			listed = [card(extra)];
			assert.strictEqual(isRendererResolvable(listed[0]), false, JSON.stringify(extra));
			for (const decision of ['approve', 'deny'] as const) {
				assert.deepStrictEqual(await controller.decide(listed[0], decision, dom.click(), dom.scope()), { kind: 'native-only' }, JSON.stringify(extra));
			}
		}
		assert.deepStrictEqual(resolves(), []);
		for (const tier of [0, 1, 2, 3]) {
			assert.strictEqual(isRendererResolvable(card({ tier })), true, `tier ${tier}`);
		}
	});

	test('a stale challenge is refused: gone from the list, or listed with another digest', async () => {
		const shown = card();
		listed = [];
		assert.deepStrictEqual(await controller.decide(shown, 'approve', dom.click(), dom.scope()), { kind: 'stale' });
		listed = undefined;
		assert.deepStrictEqual(await controller.decide(shown, 'approve', dom.click(), dom.scope()), { kind: 'stale' });
		listed = [card({ digest: 'cd'.repeat(32) })];
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
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'denied', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(card(), 'deny', dom.click(), dom.scope()), { kind: 'denied' });
	});

	test('outcomes: expired, native pending, a call failure, and replies that do not match the question', async () => {
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'expired', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'expired' });
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: true });
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'awaiting-native' });
		client.replies.set('axis.approvals.resolve', { challengeId: CHALLENGE_ID, state: 'approved', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(card(), 'deny', dom.click(), dom.scope()), { kind: 'failed', code: 'invalid_reply' }, 'approved is not an answer to deny');
		client.replies.set('axis.approvals.resolve', { challengeId: 'chal_BBBBBBBBBBBBBBBBBBBBBB', state: 'approved', nativeRequired: false });
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'invalid_reply' }, 'another challenge id');
		client.replies.set('axis.approvals.resolve', () => { throw new AxisDaemonCallError('E_POLICY_DENIED'); });
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'E_POLICY_DENIED' });
		client.replies.set('axis.approvals.resolve', () => { throw new Error('secret path /home/x'); });
		assert.deepStrictEqual(await controller.decide(card(), 'approve', dom.click(), dom.scope()), { kind: 'failed', code: 'E_INTERNAL' });
	});

	test('the answer text is fixed per outcome and never carries a code or daemon text', () => {
		const texts = [
			outcomeText({ kind: 'approved' }), outcomeText({ kind: 'denied' }), outcomeText({ kind: 'awaiting-native' }), outcomeText({ kind: 'expired' }),
			outcomeText({ kind: 'stale' }), outcomeText({ kind: 'untrusted' }), outcomeText({ kind: 'native-only' }), outcomeText({ kind: 'busy' }),
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
});
