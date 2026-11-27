// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from 'node:assert';
import { suite, test } from 'node:test';
import { GIT_COMMIT_REASONS, GIT_PUSH_REASONS, REVIEW_DIFF_REASONS } from '@axis/protocol';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { commitDoneText, refusalText, type AxisRefusalSource } from '../../src/frame/axisRefusalText.js';

const SOURCES: readonly [AxisRefusalSource, readonly string[]][] = [
	['axis.git/1.commit', GIT_COMMIT_REASONS],
	['axis.git/1.push', GIT_PUSH_REASONS],
	['axis.review/1.diff', REVIEW_DIFF_REASONS],
];
const UNKNOWN = refusalText('axis.git/1.commit', 'no_such_reason');

suite('Axis refusal text', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every closed reason of every tabled method has its own fixed sentence, never the unknown one', () => {
		for (const [source, reasons] of SOURCES) {
			for (const reason of reasons) {
				const text = refusalText(source, reason);
				assert.notStrictEqual(text, UNKNOWN, `${source} ${reason}`);
				assert.ok(/^[A-Z].*\.$/.test(text) && !text.includes('_'), `${source} ${reason}: a sentence, not a code: ${text}`);
			}
		}
	});

	test('the Demo 1 vocabulary: the exact sentences for the reasons the checklist names', () => {
		assert.strictEqual(refusalText('axis.git/1.commit', 'head_moved'), 'HEAD or the branch moved since the review. Review the changes again.');
		assert.strictEqual(refusalText('axis.git/1.commit', 'stale'), 'The files changed since the review. Review the changes again.');
		assert.strictEqual(refusalText('axis.git/1.push', 'secrets_found'), 'The outgoing changes match a secret pattern, so they cannot be pushed. Review the plan.');
		assert.strictEqual(refusalText('axis.git/1.push', 'binary_unscanned'), 'The outgoing changes include binary files that cannot be scanned. Review the plan.');
		assert.strictEqual(refusalText('axis.git/1.push', 'untrusted'), 'The project is not trusted for commits and pushes.');
		assert.strictEqual(refusalText('axis.git/1.commit', 'git_drift'), refusalText('axis.git/1.push', 'git_drift'));
	});

	test('an unknown, inherited or missing reason gets one fixed sentence and never echoes the input', () => {
		for (const reason of ['no_such_reason', 'constructor', '__proto__', 'toString', '<b>x</b>', undefined]) {
			assert.strictEqual(refusalText('axis.review/1.diff', reason), 'That was refused. Nothing changed.', String(reason));
		}
	});

	test('DC-0: the commit result says the user\'s staged changes were not touched', () => {
		assert.strictEqual(commitDoneText(), 'Committed without touching your staged changes.');
	});
});
