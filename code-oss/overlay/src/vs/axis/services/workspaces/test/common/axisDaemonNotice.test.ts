/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AXIS_ERROR_CODES, AxisDaemonStatus } from '../../../daemon/common/axisDaemonClient.js';
import { daemonNotice, errorPhrase, IAxisNoticeInput } from '../../common/axisDaemonNotice.js';
import { changesLabel } from '../../common/axisWorkspaceModel.js';
import { IAxisWorktreeInfo } from '../../common/axisWorkspaceData.js';

function notice(status: AxisDaemonStatus, extra: Partial<IAxisNoticeInput> = {}): string {
	return daemonNotice({ status, notRegistered: false, staleError: undefined, truncatedProjects: false, ...extra }).text;
}

suite('Axis daemon notice and changes label', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every state has its own fixed text', () => {
		const texts = new Map<string, string>([
			['connecting', notice({ kind: 'connecting' })],
			['down', notice({ kind: 'down' })],
			['ready', notice({ kind: 'ready' })],
			['degraded', notice({ kind: 'degraded' })],
			['f-degraded', notice({ kind: 'failed', reason: 'degraded' })],
			['f-crash', notice({ kind: 'failed', reason: 'crash_loop' })],
			['f-lock', notice({ kind: 'failed', reason: 'lock_held' })],
			['f-config', notice({ kind: 'failed', reason: 'bad_config' })],
			['f-pty', notice({ kind: 'failed', reason: 'pty_required' })],
			['stale', notice({ kind: 'ready' }, { staleError: 'E_TIMEOUT' })],
			['not-registered', notice({ kind: 'ready' }, { notRegistered: true })],
			['truncated', notice({ kind: 'ready' }, { truncatedProjects: true })],
		]);
		assert.strictEqual(new Set(texts.values()).size, texts.size, 'no two states share a text');
		assert.match(texts.get('f-crash')!, /crashed repeatedly/);
		assert.match(texts.get('f-degraded')!, /degraded mode/);
		assert.match(texts.get('f-pty')!, /terminal host/);
		assert.match(texts.get('down')!, /not running/);
		assert.match(texts.get('not-registered')!, /No repository is registered/);
		assert.match(texts.get('stale')!, /timed out/);
	});

	test('a failed state is an error that says what to do, a stale one is a warning', () => {
		assert.strictEqual(daemonNotice({ status: { kind: 'failed', reason: 'crash_loop' }, notRegistered: false, staleError: undefined, truncatedProjects: false }).severity, 'error');
		assert.strictEqual(daemonNotice({ status: { kind: 'ready' }, notRegistered: false, staleError: 'E_TIMEOUT', truncatedProjects: false }).severity, 'warning');
		assert.match(notice({ kind: 'failed', reason: 'crash_loop' }), /Restart Axis/);
	});

	test('a failure outranks a stale marker, and a stale marker outranks the degraded note', () => {
		assert.match(notice({ kind: 'failed', reason: 'lock_held' }, { staleError: 'E_TIMEOUT' }), /Another Axis/);
		assert.match(notice({ kind: 'degraded' }, { staleError: 'E_TIMEOUT' }), /did not answer/);
	});

	test('error phrases are fixed text for every code, never the code or anything from the daemon', () => {
		for (const code of AXIS_ERROR_CODES) {
			const phrase = errorPhrase(code);
			assert.ok(phrase.length > 0 && !phrase.includes('E_') && !phrase.includes('/'), `${code}: ${phrase}`);
		}
		assert.notStrictEqual(errorPhrase('E_TIMEOUT'), errorPhrase('E_UNAVAILABLE'));
	});

	test('the Changes column reads status fields as words', () => {
		const wt = (extra: Partial<IAxisWorktreeInfo>): IAxisWorktreeInfo => ({ origin: 'axis', projectId: 'p', branch: 'x', head: null, path: '/w', locked: false, present: true, ...extra });
		assert.strictEqual(changesLabel(wt({})), 'not read');
		assert.strictEqual(changesLabel(wt({ ahead: 0, behind: 0 })), 'not read');
		assert.strictEqual(changesLabel(wt({ dirty: { staged: 0, unstaged: 0, untracked: 0 } })), 'clean');
		assert.strictEqual(changesLabel(wt({ dirty: { staged: 2, unstaged: 1, untracked: 3 } })), '2 staged, 1 modified, 3 untracked');
		assert.strictEqual(changesLabel(wt({ dirty: { staged: 0, unstaged: 0, untracked: 3 }, ahead: 1, behind: 2 })), '3 untracked, 1 ahead, 2 behind');
		assert.strictEqual(changesLabel(wt({ dirty: { staged: 0, unstaged: 0, untracked: 0 }, behind: 4 })), 'clean, 4 behind');
		assert.strictEqual(changesLabel(wt({ ahead: 3 })), '3 ahead');
	});
});
