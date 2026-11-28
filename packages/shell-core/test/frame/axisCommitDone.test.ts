// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-6 review SF3: the notice after a commit says whether git's index was updated, from the reply's closed result.
import assert from 'node:assert';
import { suite, test } from 'node:test';
import { GIT_INDEX_REFRESH_SKIPS } from '@axis/protocol';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { commitDone } from '../../src/frame/axisCommitDone.js';

const RECOVERY = 'run git reset -q -- followed by the committed paths';
const MARKER = 'PRIVATE_MARKER_FOR_REVIEW';

suite('Axis commit done (DC-0 index refresh)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('refreshed: a plain success that says the index matches; any count, zero included', () => {
		for (const refreshed of [0, 3]) {
			const n = commitDone({ refreshed });
			assert.strictEqual(n.severity, 'info');
			assert.strictEqual(n.text, "Committed. Staged changes you made yourself were kept. Git's index now matches the new commit.");
		}
	});

	test('every skip of the protocol list is a warning that the commit stands, the index was not updated, why, and how to fix it', () => {
		const reasons = new Set<string>();
		for (const skipped of GIT_INDEX_REFRESH_SKIPS) {
			const n = commitDone({ skipped });
			assert.strictEqual(n.severity, 'warning', skipped);
			assert.ok(n.text.startsWith("Committed, but git's index was not updated. "), skipped);
			assert.ok(n.text.includes('Staged changes you made yourself were kept.'), skipped);
			assert.ok(n.text.includes('git status shows the committed files as staged changes that undo the commit'), skipped);
			assert.ok(n.text.includes('a plain git commit in a terminal would undo it'), skipped);
			assert.ok(n.text.includes(RECOVERY), skipped);
			assert.ok(!/refused|failed to commit|not committed/i.test(n.text), `a skip is not a failed commit: ${skipped}`);
			reasons.add(n.text.split('. ')[1] ?? '');
		}
		assert.strictEqual(reasons.size, GIT_INDEX_REFRESH_SKIPS.length, 'each reason has its own sentence');
		assert.match(commitDone({ skipped: 'locked' }).text, /Another git program was using the index\./);
		assert.match(commitDone({ skipped: 'lock_lost' }).text, /The index lock was removed while the update was under way\./);
	});

	test('an unknown skip reason is not echoed and still warns', () => {
		const n = commitDone({ skipped: MARKER });
		assert.strictEqual(n.severity, 'warning');
		assert.ok(!n.text.includes(MARKER));
		assert.match(n.text, /The update was skipped\./);
		assert.ok(n.text.includes(RECOVERY));
		assert.match(commitDone({ skipped: 'toString' }).text, /The update was skipped\./, 'an inherited name is not a reason');
	});

	test('absent (a reply from before the refresh) or unreadable: committed, the update not reported, with the check to make', () => {
		for (const value of [undefined, null, {}, 'refreshed', { refreshed: '3' }, Object.create({ refreshed: 1 }), { get refreshed() { throw new Error(MARKER); } }]) {
			const n = commitDone(value);
			assert.strictEqual(n.severity, 'warning');
			assert.ok(n.text.startsWith('Committed. Staged changes you made yourself were kept. '));
			assert.match(n.text, /did not say whether git's index was updated/);
			assert.match(n.text, /git reset -q -- followed by those paths/);
		}
	});

	test('no getter on the result is run', () => {
		let reads = 0;
		commitDone({ get skipped() { reads++; return 'locked'; }, get refreshed() { reads++; return 1; } });
		assert.strictEqual(reads, 0);
	});
});
