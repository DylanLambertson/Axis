/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { bannerContent, trustSource, windowProjectState } from '../../common/axisProjectActions.js';

suite('Axis project banner (S3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ro = { id: 'p', name: 'repo', trusted: false };
	const tr = { id: 'p', name: 'repo', trusted: true };

	const states = [{ kind: 'none' } as const, { kind: 'registered', project: tr, known: false } as const, { kind: 'registered', project: ro, known: false } as const, { kind: 'registered', project: tr, known: true } as const, { kind: 'registered', project: ro, known: true } as const];

	test('the source: not usable is offline whatever the rows say; connected with discovery rows is unregistered', () => {
		assert.strictEqual(trustSource(false, 'daemon'), 'offline', 'a flip to down while daemon rows are shown: no stale trust');
		assert.strictEqual(trustSource(false, 'discovery'), 'offline');
		assert.strictEqual(trustSource(true, 'discovery'), 'unregistered');
		assert.strictEqual(trustSource(true, 'daemon'), 'daemon');
	});

	test('(1) offline: run trust unknown and no action, for every state', () => {
		for (const state of states) {
			const c = bannerContent(state, 'offline');
			assert.match(c.text, /Run trust unknown/);
			assert.strictEqual(c.action, undefined, 'mutant: an action offered offline');
		}
	});

	test('(2) connected, not registered: "not an Axis project" and Add only, never a trust claim or Trust/Stop', () => {
		for (const state of states) {
			const c = bannerContent(windowProjectState({ source: 'unregistered', projects: [tr, ro], localCheckoutProjectIds: ['p'] }), 'unregistered');
			assert.strictEqual(c.action?.id, 'add');
			assert.doesNotMatch(c.text, /trusted to run|read only/);
			// Even a state that claims to be known cannot get Trust or Stop without daemon rows.
			assert.strictEqual(bannerContent(state, 'unregistered').action?.id, 'add', 'mutant: Trust/Stop from discovery');
		}
	});

	test('(3) Trust and Stop only from daemon rows; add when the daemon holds no project for this folder', () => {
		assert.strictEqual(bannerContent({ kind: 'none' }, 'daemon').action?.id, 'add');
		const r = bannerContent({ kind: 'registered', project: ro, known: true }, 'daemon');
		assert.strictEqual(r.action?.id, 'trust');
		assert.match(r.text, /read only/);
		assert.match(r.action!.label, /…$/, 'a dialog follows: the label says so');
		const t = bannerContent({ kind: 'registered', project: tr, known: true }, 'daemon');
		assert.strictEqual(t.action?.id, 'untrust');
		assert.match(t.text, /trusted to run/);
		assert.strictEqual(bannerContent({ kind: 'registered', project: tr, known: false }, 'daemon').action?.id, 'add', 'a row not known from the daemon never gets Stop');
	});
});
