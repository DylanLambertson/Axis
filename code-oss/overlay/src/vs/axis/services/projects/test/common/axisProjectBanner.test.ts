/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { bannerContent, projectChip, trustSource } from '../../common/axisProjectActions.js';

suite('Axis project banner (S3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	const all = ['trusted', 'read_only', 'not_registered', 'unknown'] as const;

	test('the source: not usable is offline whatever the rows say; connected with discovery rows is unregistered', () => {
		assert.strictEqual(trustSource({ kind: 'down' }, 'daemon'), 'offline', 'a flip to down while daemon rows are shown: no stale trust');
		assert.strictEqual(trustSource({ kind: 'failed', reason: 'crash_loop' }, 'daemon'), 'offline');
		assert.strictEqual(trustSource({ kind: 'connecting' }, 'discovery'), 'offline');
		assert.strictEqual(trustSource({ kind: 'ready' }, 'discovery'), 'unregistered');
		assert.strictEqual(trustSource({ kind: 'ready' }, 'daemon'), 'daemon');
		assert.strictEqual(trustSource({ kind: 'degraded' }, 'daemon'), 'degraded', 'F2: usable for reads, but never a trust source (mutant: degraded as daemon)');
	});

	test('offline (degraded host included, via status unknown): run trust unknown and no action, whatever main last said', () => {
		for (const trust of all) {
			const c = bannerContent(trust, 'offline');
			assert.match(c.text, /Run trust unknown/);
			assert.strictEqual(c.action, undefined, 'mutant: an action offered offline');
		}
		assert.strictEqual(bannerContent('unknown', 'daemon').action, undefined, 'main could not tell (degraded, busy, no folder): no button');
	});

	test('connected: exactly one action from main\'s status of THIS folder: Add, Trust to Run… or Stop Trusting', () => {
		assert.strictEqual(bannerContent('not_registered', 'unregistered').action?.id, 'add', 'the S3 case: a first project from discovery rows');
		for (const stale of ['trusted', 'read_only'] as const) {
			assert.strictEqual(bannerContent(stale, 'unregistered').action, undefined, 'a trust answer with discovery rows is stale: no Trust/Stop (review N3)');
		}
		for (const source of ['daemon'] as const) {
			assert.strictEqual(bannerContent('not_registered', source).action?.id, 'add');
			const r = bannerContent('read_only', source);
			assert.strictEqual(r.action?.id, 'trust');
			assert.match(r.text, /read only/);
			assert.match(r.action!.label, /…$/, 'a dialog follows: the label says so');
			const t = bannerContent('trusted', source);
			assert.strictEqual(t.action?.id, 'untrust');
			assert.match(t.text, /trusted to run/);
		}
		assert.doesNotMatch(bannerContent('not_registered', 'daemon').text, /trusted to run|read only/, 'never a trust claim for an unregistered folder');
	});

	test('F2 degraded: no run trust shown and no action, whatever main last said; the chips say unknown', () => {
		for (const trust of all) {
			const c = bannerContent(trust, 'degraded');
			assert.match(c.text, /read only \(degraded\)/);
			assert.strictEqual(c.action, undefined, 'mutant: an action while degraded');
		}
		for (const trusted of [true, false]) {
			const chip = projectChip({ id: 'p', name: 'repo', trusted }, 'degraded');
			assert.match(chip.label, /run trust unknown/);
			assert.doesNotMatch(chip.label, /trusted to run|read only/);
		}
	});
});
