/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AXIS_PROJECT_ACTIONS, AXIS_PROJECT_OUTCOMES, AXIS_PROJECT_REQUEST_CHANNEL, AXIS_PROJECT_RESULT_CHANNEL, AxisProjectActionClient, IAxisProjectTransport, AXIS_MAX_INLINE_NAME, AXIS_MAX_TOOLTIP_NAME, isolateName, outcomeSentence, plainName, projectActionRequest, projectChip, toAnswer, toOutcome, toWindowRunTrust } from '../../common/axisProjectActions.js';

/** A transport that records what the renderer sends and lets the test answer as main. */
function fakeTransport() {
	const sent: Array<{ channel: string; payload: unknown }> = [];
	let listener: ((payload: unknown) => void) | undefined;
	const transport: IAxisProjectTransport = {
		send: (channel, payload) => void sent.push({ channel, payload }),
		on: (channel, l) => { assert.strictEqual(channel, AXIS_PROJECT_RESULT_CHANNEL); listener = l; return () => { listener = undefined; }; },
	};
	return { transport, sent, answer: (payload: unknown) => listener?.(payload), listening: () => listener !== undefined };
}

const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

suite('Axis project actions (renderer, S3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the request is exactly { nonce, action }: no path or project id can ride along, and a bad nonce or action is refused', () => {
		assert.deepStrictEqual(Object.keys(projectActionRequest('n1', 'trust')).sort(), ['action', 'nonce']);
		assert.throws(() => projectActionRequest('bad nonce', 'trust'));
		assert.throws(() => projectActionRequest('n1', 'own' as never));
		assert.ok(Object.isFrozen(projectActionRequest('n1', 'add')));
	});

	test('outcomes are closed: anything else from main is unavailable, and every outcome has a fixed sentence', () => {
		for (const o of AXIS_PROJECT_OUTCOMES) {
			assert.strictEqual(toOutcome(o), o);
			const s = outcomeSentence(o);
			assert.ok(s.length > 0 && !UNSAFE.test(s), o);
		}
		for (const v of ['Trusted!', '', undefined, 1, { outcome: 'trusted' }, 'added_read_only ']) {
			assert.strictEqual(toOutcome(v), 'unavailable', String(v));
		}
		assert.strictEqual(new Set(AXIS_PROJECT_OUTCOMES.map(outcomeSentence)).size, AXIS_PROJECT_OUTCOMES.length, 'each outcome says something different');
	});

	test('status: a request like the others, three closed answers; anything else is unknown', () => {
		assert.deepStrictEqual(projectActionRequest('n1', 'status'), { nonce: 'n1', action: 'status' });
		assert.deepStrictEqual(['status_trusted', 'status_read_only', 'status_not_registered', 'unavailable', 'busy', 'no_folder', 'trusted'].map(o => toWindowRunTrust(o as never)),
			['trusted', 'read_only', 'not_registered', 'unknown', 'unknown', 'unknown', 'unknown'], 'an action outcome (trusted) is not a status (mutant: mapped)');
		assert.ok(!(AXIS_PROJECT_ACTIONS as readonly string[]).includes('status'), 'status is not a user action: no command or button asks for it');
	});

	test('chips use a glyph AND words; trust from discovery is shown as unknown, never as trusted to run', () => {
		const trusted = { id: 'p1', name: 'one', trusted: true };
		const ro = { id: 'p2', name: 'two', trusted: false };
		assert.match(projectChip(trusted, 'daemon').label, /trusted to run/);
		assert.match(projectChip(ro, 'daemon').label, /read only/);
		assert.match(projectChip(ro, 'daemon').hint, /If the repository changed, review and trust it again/);
		const unknown = projectChip(trusted, 'offline');
		assert.match(unknown.label, /run trust unknown/);
		assert.doesNotMatch(unknown.label, /trusted to run/, 'mutant: discovery shown as trusted');
		for (const project of [trusted, ro]) {
			const added = projectChip(project, 'unregistered');
			assert.match(added.label, /not added to Axis/);
			assert.doesNotMatch(added.label, /trusted to run|read only/, 'mutant: a trust claim from discovery');
		}
		for (const c of [projectChip(trusted, 'daemon'), projectChip(ro, 'daemon'), unknown, projectChip(ro, 'unregistered')]) {
			assert.ok(c.glyph.length > 0 && c.label.length > 0);
		}
	});

	test('the client sends one request, matches the answer by nonce, ignores foreign or late answers, and times out as unavailable', async () => {
		const t = fakeTransport();
		const client = new AxisProjectActionClient(t.transport, () => 'r-a-n-d', 50);
		const pending = client.run('trust');
		assert.strictEqual(t.sent.length, 1);
		assert.strictEqual(t.sent[0].channel, AXIS_PROJECT_REQUEST_CHANNEL);
		const { nonce } = t.sent[0].payload as { nonce: string };
		assert.deepStrictEqual(t.sent[0].payload, { nonce, action: 'trust' });
		t.answer({ nonce: 'someone-else', outcome: 'trusted' });
		t.answer(null);
		t.answer({ nonce, outcome: 'Trusted, trust me' });
		assert.strictEqual(await pending, 'unavailable', 'an answer outside the closed set is unavailable');
		const second = client.run('add');
		const n2 = (t.sent[1].payload as { nonce: string }).nonce;
		assert.notStrictEqual(n2, nonce);
		t.answer({ nonce: n2, outcome: 'added_read_only' });
		assert.strictEqual(await second, 'added_read_only');
		assert.strictEqual(await client.run('untrust'), 'unavailable', 'no answer within the bound');
		client.dispose();
		assert.strictEqual(t.listening(), false);
	});

	test('dispose answers a waiting call unavailable; a transport that throws is unavailable', async () => {
		const t = fakeTransport();
		const client = new AxisProjectActionClient(t.transport, () => 'x', 10_000);
		const waiting = client.run('add');
		client.dispose();
		assert.strictEqual(await waiting, 'unavailable');
		const throwing = new AxisProjectActionClient({ send: () => { throw new Error('closed'); }, on: () => () => undefined }, () => 'x', 10_000);
		assert.strictEqual(await throwing.run('add'), 'unavailable');
		throwing.dispose();
	});

	test('names inside sentences: isolated, cleaned of reordering characters, and cut with an ellipsis; the sentence stays whole', () => {
		const rtl = 'مشروع-تجريبي-طويل-جدا-with-a-very-long-latin-tail-for-the-ellipsis-check';
		const shown = isolateName(rtl);
		assert.ok(shown.startsWith('\u2068') && shown.endsWith('\u2069'), 'a first-strong isolate');
		const inner = [...shown.slice(1, -1)];
		assert.strictEqual(inner.length, AXIS_MAX_INLINE_NAME);
		assert.strictEqual(inner[inner.length - 1], '\u2026');
		assert.strictEqual(isolateName('repo'), '\u2068repo\u2069', 'a short name is whole');
		const spoof = 'evil\u202Edetsurt\u202C\u200Fname';
		assert.doesNotMatch(isolateName(spoof).slice(1, -1), /[\p{Cc}\p{Cf}]/u, 'mutant: an override inside the name reorders the sentence');
		assert.strictEqual(plainName(spoof), 'evildetsurtname');
		assert.strictEqual(isolateName('\u202E\u200F'), '\u2068(unnamed)\u2069', 'a name of control characters only gets a placeholder (review N4)');
		assert.strictEqual([...plainName('x'.repeat(500))].length, AXIS_MAX_TOOLTIP_NAME, 'the tooltip is capped');
		const label = projectChip({ id: 'p', name: rtl, trusted: false }, 'unregistered').label;
		assert.ok(label.endsWith('\u2069: not added to Axis'), 'the words after the name are intact');
	});

	test('PV-D1-0: main\'s answer is read strictly: projectId only on a registered status, only in the id shape, and no other key', () => {
		assert.deepStrictEqual(toAnswer({ nonce: 'n', outcome: 'status_read_only', projectId: 'p-7' }), { outcome: 'status_read_only', projectId: 'p-7' });
		assert.deepStrictEqual(toAnswer({ nonce: 'n', outcome: 'status_trusted' }), { outcome: 'status_trusted' });
		assert.deepStrictEqual(toAnswer({ nonce: 'n', outcome: 'trusted', projectId: 'p-7' }), { outcome: 'unavailable' }, 'an id on an action outcome');
		assert.deepStrictEqual(toAnswer({ nonce: 'n', outcome: 'status_not_registered', projectId: 'p-7' }), { outcome: 'unavailable' });
		for (const bad of ['../x', '', 'a b', 'x'.repeat(65), 7, { id: 'p' }]) {
			assert.deepStrictEqual(toAnswer({ nonce: 'n', outcome: 'status_read_only', projectId: bad }), { outcome: 'unavailable' }, JSON.stringify(bad));
		}
		assert.deepStrictEqual(toAnswer({ nonce: 'n', outcome: 'status_read_only', projectId: 'p-7', name: 'repo' }), { outcome: 'unavailable' }, 'any other key (mutant: ignored)');
		assert.deepStrictEqual(toAnswer({ nonce: 'n', outcome: 'status_read_only', path: '/home/u/r' }), { outcome: 'unavailable' });
	});
});
