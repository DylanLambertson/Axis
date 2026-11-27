// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/projects/test/common/axisProjectBanner.test.ts) by OS-5.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { bannerContent, projectChip, trustSource } from '../../src/projects/axisProjectActions.js';

suite('Axis project banner (S3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	const all = ['trusted', 'read_only', 'not_registered', 'unknown'] as const;

	test('the source: not usable is offline whatever the rows say; daemon rows decide registered or not', () => {
		const rows = { origin: 'daemon', notRegistered: false } as const;
		const empty = { origin: 'daemon', notRegistered: true } as const;
		const none = { origin: 'none', notRegistered: false } as const;
		assert.strictEqual(trustSource({ kind: 'down' }, rows), 'offline', 'a flip to down while daemon rows are shown: no stale trust');
		assert.strictEqual(trustSource({ kind: 'failed', reason: 'crash_loop' }, rows), 'offline');
		assert.strictEqual(trustSource({ kind: 'connecting' }, none), 'offline');
		assert.strictEqual(trustSource({ kind: 'ready' }, none), 'offline', 'no read has worked yet: nothing is known (mutant: none as unregistered)');
		assert.strictEqual(trustSource({ kind: 'ready' }, empty), 'unregistered');
		assert.strictEqual(trustSource({ kind: 'ready' }, rows), 'daemon');
		assert.strictEqual(trustSource({ kind: 'degraded' }, rows), 'degraded', 'F2: usable for reads, but never a trust source (mutant: degraded as daemon)');
		assert.strictEqual(trustSource({ kind: 'degraded' }, none), 'degraded');
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
		assert.strictEqual(bannerContent('not_registered', 'unregistered').action?.id, 'add', 'the S3 case: a first project while the daemon holds none');
		for (const stale of ['trusted', 'read_only'] as const) {
			assert.strictEqual(bannerContent(stale, 'unregistered').action, undefined, 'a trust answer while the daemon holds no project is stale: no Trust/Stop (review N3)');
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
