/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { bannerContent } from '../../common/axisProjectActions.js';

suite('Axis project banner (S3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ro = { id: 'p', name: 'repo', trusted: false };
	const tr = { id: 'p', name: 'repo', trusted: true };

	test('without the daemon: run trust unknown and no action, whatever discovery says', () => {
		for (const state of [{ kind: 'none' } as const, { kind: 'registered', project: tr, known: false } as const, { kind: 'registered', project: ro, known: false } as const]) {
			const c = bannerContent(state, 'discovery');
			assert.match(c.text, /Run trust unknown/);
			assert.strictEqual(c.action, undefined, 'mutant: an action offered from discovery');
			assert.doesNotMatch(c.text, /trusted to run/);
		}
	});

	test('from the daemon: add when not a project, trust when read only, stop trusting when trusted', () => {
		assert.strictEqual(bannerContent({ kind: 'none' }, 'daemon').action?.id, 'add');
		const r = bannerContent({ kind: 'registered', project: ro, known: true }, 'daemon');
		assert.strictEqual(r.action?.id, 'trust');
		assert.match(r.text, /read only/);
		assert.match(r.action!.label, /…$/, 'a dialog follows: the label says so');
		const t = bannerContent({ kind: 'registered', project: tr, known: true }, 'daemon');
		assert.strictEqual(t.action?.id, 'untrust');
		assert.match(t.text, /trusted to run/);
	});
});
