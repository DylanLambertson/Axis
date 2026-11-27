// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/workspaces/test/common/axisDaemonNotice.test.ts) by OS-5.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { BRAND } from '@axis/ui';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { AXIS_ERROR_CODES, type AxisDaemonStatus } from '../../src/daemon/axisDaemonClient.js';
import { approvalsAvailability, daemonNotice, errorPhrase, type IAxisNoticeInput } from '../../src/workspaces/axisDaemonNotice.js';
import { changesLabel } from '../../src/workspaces/axisWorkspaceModel.js';
import { type IAxisWorktreeInfo } from '../../src/workspaces/axisWorkspaceData.js';

function notice(status: AxisDaemonStatus, extra: Partial<IAxisNoticeInput> = {}): string {
	return daemonNotice({ status, notRegistered: false, staleError: undefined, truncatedProjects: false, hasRows: true, ...extra }).text;
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
			['no-data', notice({ kind: 'ready' }, { staleError: 'E_TIMEOUT', hasRows: false })],
			['not-registered', notice({ kind: 'ready' }, { notRegistered: true })],
			['truncated', notice({ kind: 'ready' }, { truncatedProjects: true })],
		]);
		assert.strictEqual(new Set(texts.values()).size, texts.size, 'no two states share a text');
		assert.match(texts.get('f-crash')!, /crashed repeatedly/);
		assert.match(texts.get('f-degraded')!, /degraded mode/);
		assert.match(texts.get('f-pty')!, /terminal host/);
		assert.match(texts.get('down')!, /is not connected/);
		assert.match(texts.get('not-registered')!, /No repository is registered/);
		assert.match(texts.get('stale')!, /timed out/);
		assert.match(texts.get('no-data')!, /timed out/);
		assert.doesNotMatch(texts.get('no-data')!, /last data/, 'a failed first read shows no data, so it never claims to show the last data (mutant: one stale text)');
		assert.match(notice({ kind: 'ready' }, { notRegistered: true, staleError: 'E_TIMEOUT' }), /did not answer/, 'a stale empty listing is not "no repository is registered"');
		for (const [state, text] of texts) {
			assert.doesNotMatch(text, /disk/, `${state}: the own shell reads no files, so no notice says rows come from disk`);
			assert.ok(text.includes(`${BRAND.productName} service`) || text.includes(`${BRAND.productName} window`), `${state}: the name comes from BRAND`);
			assert.doesNotMatch(text, /\{\d+\}/, `${state}: no placeholder is left unfilled`);
		}
		assert.match(texts.get('not-registered')!, /Add a project/, 'the empty state says what to do');
	});

	test('a failed state is an error that says what to do, a stale one is a warning', () => {
		assert.strictEqual(daemonNotice({ status: { kind: 'failed', reason: 'crash_loop' }, notRegistered: false, staleError: undefined, truncatedProjects: false, hasRows: true }).severity, 'error');
		assert.strictEqual(daemonNotice({ status: { kind: 'ready' }, notRegistered: false, staleError: 'E_TIMEOUT', truncatedProjects: false, hasRows: true }).severity, 'warning');
		assert.match(notice({ kind: 'failed', reason: 'crash_loop' }), new RegExp(`Restart ${BRAND.productName}`));
	});

	test('a failure and a degraded host outrank a stale marker (review SF2)', () => {
		assert.match(notice({ kind: 'failed', reason: 'lock_held' }, { staleError: 'E_TIMEOUT' }), new RegExp(`Another ${BRAND.productName}`));
		assert.match(notice({ kind: 'degraded' }, { staleError: 'E_METHOD_NOT_FOUND' }), /degraded mode/, 'review SF2: a degraded host with registered projects fails its worktree read; the cause is said, not "did not answer" (mutant: stale first)');
		assert.match(notice({ kind: 'ready' }, { staleError: 'E_TIMEOUT' }), /did not answer/);
		assert.match(notice({ kind: 'degraded' }, { notRegistered: true }), /degraded mode/, 'F2: degraded outranks "not registered" (mutant: the old order)');
		assert.match(notice({ kind: 'failed', reason: 'crash_loop' }, { staleError: 'E_TIMEOUT' }), /crashed repeatedly/);
		assert.match(notice({ kind: 'ready' }, { notRegistered: true }), /No repository is registered/);
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

	test('review SF2: approval cards only from a ready service; every other state says why and offers no Approve', () => {
		const fresh = { origin: 'daemon', staleError: undefined } as const;
		assert.deepStrictEqual(approvalsAvailability({ kind: 'ready' }, fresh), { cards: true, line: '' });
		for (const status of [{ kind: 'degraded' }, { kind: 'connecting' }, { kind: 'down' }, { kind: 'failed', reason: 'crash_loop' }] as const) {
			const a = approvalsAvailability(status, fresh);
			assert.strictEqual(a.cards, false, `${status.kind}: mutant: stale cards with Approve`);
			assert.ok(a.line.length > 0);
		}
		assert.match(approvalsAvailability({ kind: 'degraded' }, fresh).line, /degraded mode/);
		assert.match(approvalsAvailability({ kind: 'connecting' }, fresh).line, /connecting/);
	});

	test('review B1: a ready service shows cards only from a fresh read', () => {
		const stale = approvalsAvailability({ kind: 'ready' }, { origin: 'daemon', staleError: 'E_TIMEOUT' });
		assert.strictEqual(stale.cards, false, 'mutant: cards from a failed read');
		assert.match(stale.line, /did not answer the last read/);
		const unread = approvalsAvailability({ kind: 'ready' }, { origin: 'none', staleError: undefined });
		assert.strictEqual(unread.cards, false, 'mutant: cards before any read');
		assert.match(unread.line, /nothing has been read/);
	});

	test('review N2: the degraded notice says which reads work and that runs and approvals are unavailable', () => {
		const text = notice({ kind: 'degraded' });
		assert.match(text, /only project and audit reads work/);
		assert.match(text, /Workspaces, runs and approvals are unavailable/);
		assert.doesNotMatch(text, /Reading works/);
	});
});
