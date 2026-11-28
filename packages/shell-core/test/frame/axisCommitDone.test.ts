// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-6 review SF3, review 2 F3/F4/N1: the notice after a commit says what the reply's closed result shows about git's
// index, and no more. It never claims the index matches the commit and never prescribes a reset, which would replace
// the person's own staging on a committed path (the git-ops test real-index-refresh-user-staging shows the replies for
// that case: `{ refreshed: 0 }` with their staging kept, and `{ skipped: 'lock_lost' }` after another git's add).
import assert from 'node:assert';
import { suite, test } from 'node:test';
import { GIT_INDEX_REFRESH_SKIPS } from '@axis/protocol';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { commitDone } from '../../src/frame/axisCommitDone.js';

const CHECK = 'Before you commit in a terminal, check git status and git diff --cached: a staged change there may be an old copy that would undo part of this commit, or a change you staged yourself.';
const MARKER = 'PRIVATE_MARKER_FOR_REVIEW';
const REFRESHED = "Committed. Entries in git's index that could safely follow the commit were updated, and staged changes you made yourself were kept. If you commit in a terminal, check git diff --cached first.";
const NOT_REPORTED = `Committed. The service did not say whether git's index was updated. Staged changes you made yourself were kept. ${CHECK}`;

/** What no notice may say: a reset (it discards the person's staging), index equality, or a certain undo. */
function claimsNothingUnsafe(text: string, what: string): void {
	assert.ok(!/git reset|reset -q|git restore|rm .*index\.lock|delete the lock/i.test(text), `${what}: no reset or lock removal is prescribed`);
	assert.ok(!/matches|now equal|in sync/i.test(text), `${what}: no claim that the index matches the commit`);
	assert.ok(!/would undo it|shows the committed files/i.test(text), `${what}: no certain claim about git status or a terminal commit`);
}

suite('Axis commit done (DC-0 index refresh)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('refreshed: a success that says only eligible entries were updated, for any count, zero included (a refresh that kept the person\'s staging on a committed path)', () => {
		for (const refreshed of [0, 3, Number.MAX_SAFE_INTEGER]) {
			const n = commitDone({ refreshed });
			assert.strictEqual(n.severity, 'info');
			assert.strictEqual(n.text, REFRESHED);
			claimsNothingUnsafe(n.text, `refreshed ${refreshed}`);
		}
	});

	test('every skip of the protocol list is a warning: the commit stands, the index was not updated, why, and what to check, never a reset', () => {
		const reasons = new Set<string>();
		for (const skipped of GIT_INDEX_REFRESH_SKIPS) {
			const n = commitDone({ skipped });
			assert.strictEqual(n.severity, 'warning', skipped);
			assert.ok(n.text.startsWith("Committed, but git's index was not updated. "), skipped);
			assert.ok(n.text.endsWith(` Staged changes you made yourself were kept. ${CHECK}`), skipped);
			assert.ok(!/refused|failed to commit|not committed/i.test(n.text), `a skip is not a failed commit: ${skipped}`);
			claimsNothingUnsafe(n.text, skipped);
			reasons.add(n.text.slice("Committed, but git's index was not updated. ".length, n.text.indexOf(' Staged changes')));
		}
		assert.strictEqual(reasons.size, GIT_INDEX_REFRESH_SKIPS.length, 'each reason has its own sentence');
		assert.match(commitDone({ skipped: 'locked' }).text, /An index\.lock file was in the way: another git program may still be running, or one left its lock behind\. Let any running git program finish first\./);
		assert.match(commitDone({ skipped: 'lock_lost' }).text, /removed or replaced while the update was under way, so another git program may have changed the index\./);
		assert.match(commitDone({ skipped: 'head_moved' }).text, /may no longer point at the commit just made\./);
		assert.match(commitDone({ skipped: 'unmerged' }).text, /conflict stages left as they are\./);
	});

	test('an unknown skip reason is not echoed and still warns', () => {
		const n = commitDone({ skipped: MARKER });
		assert.strictEqual(n.severity, 'warning');
		assert.ok(!n.text.includes(MARKER));
		assert.match(n.text, /The update was skipped\./);
		assert.ok(n.text.endsWith(CHECK));
		assert.match(commitDone({ skipped: 'toString' }).text, /The update was skipped\./, 'an inherited name is not a reason');
	});

	test('absent, unreadable, malformed (review 2 N1) or contradictory: committed, the update not reported, with the check to make', () => {
		const values: unknown[] = [
			undefined, null, {}, 'refreshed', { refreshed: '3' }, Object.create({ refreshed: 1 }), Object.create({ skipped: 'locked' }),
			{ refreshed: -1 }, { refreshed: 0.5 }, { refreshed: Infinity }, { refreshed: NaN }, { refreshed: Number.MAX_SAFE_INTEGER + 1 }, { refreshed: -0.5 },
			{ refreshed: 1, skipped: 'locked' }, { refreshed: 1, skipped: undefined }, { skipped: 'locked', refreshed: undefined },
			{ get refreshed() { throw new Error(MARKER); } },
			new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(MARKER); } }),
		];
		for (const value of values) {
			const n = commitDone(value);
			assert.strictEqual(n.severity, 'warning', String(value));
			assert.strictEqual(n.text, NOT_REPORTED);
			claimsNothingUnsafe(n.text, 'not reported');
		}
	});

	test('no getter on the result is run, and an accessor field counts as present', () => {
		let reads = 0;
		const n = commitDone({ get skipped() { reads++; return 'locked'; }, get refreshed() { reads++; return 1; } });
		assert.strictEqual(reads, 0);
		assert.strictEqual(n.text, NOT_REPORTED);
		assert.strictEqual(commitDone({ refreshed: 2, get skipped() { reads++; return 'locked'; } }).text, NOT_REPORTED, 'a getter beside a count is a contradiction');
		assert.strictEqual(commitDone({ skipped: 'locked', get refreshed() { reads++; return 1; } }).text, NOT_REPORTED);
		assert.strictEqual(reads, 0);
	});
});
