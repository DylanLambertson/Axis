// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from 'node:assert';
import { suite, test } from 'node:test';
import { BRAND } from '@axis/ui';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { type AxisDaemonStatus } from '../../src/daemon/axisDaemonClient.js';
import { screenStateOf, storageNotice, type AxisSecureStorage } from '../../src/frame/axisScreenState.js';
import { emptySnapshot, type IAxisSnapshot } from '../../src/workspaces/axisSnapshotLoader.js';

const ROWS: IAxisSnapshot = { origin: 'daemon', projects: [{ id: 'p', name: 'repo', trusted: true }], entries: [], approvals: [], notRegistered: false, truncatedProjects: false, staleError: undefined };

function state(status: AxisDaemonStatus, snapshot: IAxisSnapshot | undefined, secureStorage: AxisSecureStorage = 'available') {
	return screenStateOf({ status, snapshot, secureStorage });
}

suite('Axis screen state', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('each daemon status and snapshot maps to one closed screen kind', () => {
		assert.strictEqual(state({ kind: 'connecting' }, undefined).kind, 'loading');
		assert.strictEqual(state({ kind: 'down' }, ROWS).kind, 'disconnected', 'rows of a daemon that went down are not shown as current');
		assert.strictEqual(state({ kind: 'failed', reason: 'crash_loop' }, ROWS).kind, 'failed');
		assert.strictEqual(state({ kind: 'ready' }, undefined).kind, 'loading', 'connected, the first read is still running');
		assert.strictEqual(state({ kind: 'ready' }, emptySnapshot()).kind, 'loading');
		assert.strictEqual(state({ kind: 'ready' }, emptySnapshot('E_TIMEOUT')).kind, 'unreadable');
		assert.strictEqual(state({ kind: 'ready' }, { ...ROWS, notRegistered: true, projects: [] }).kind, 'empty');
		assert.strictEqual(state({ kind: 'ready' }, ROWS).kind, 'ready');
		assert.strictEqual(state({ kind: 'degraded' }, ROWS).kind, 'ready', 'a degraded daemon still serves reads');
		assert.strictEqual(state({ kind: 'ready' }, { ...ROWS, staleError: 'E_TIMEOUT' }).kind, 'ready', 'stale rows are drawn, with a notice');
	});

	test('a fresh ready screen has no notice; every other state says what is wrong in words', () => {
		assert.deepStrictEqual(state({ kind: 'ready' }, ROWS).notices, []);
		assert.match(state({ kind: 'ready' }, { ...ROWS, staleError: 'E_TIMEOUT' }).notices[0]!.text, /last data it gave/);
		assert.match(state({ kind: 'ready' }, emptySnapshot('E_TIMEOUT')).notices[0]!.text, /nothing has been read/, 'no rows: never "the last data" (mutant: hasRows always true)');
		assert.match(state({ kind: 'connecting' }, undefined).notices[0]!.text, /Connecting/);
		assert.match(state({ kind: 'down' }, ROWS).notices[0]!.text, /not connected/);
		assert.match(state({ kind: 'ready' }, { ...ROWS, notRegistered: true }).notices[0]!.text, /Add a project/);
		assert.strictEqual(state({ kind: 'failed', reason: 'lock_held' }, undefined).notices[0]!.severity, 'error');
	});

	test('a stale marker from a daemon that is no longer usable is not reported as a failed read', () => {
		const notices = state({ kind: 'down' }, { ...ROWS, staleError: 'E_TIMEOUT' }).notices;
		assert.strictEqual(notices.length, 1);
		assert.doesNotMatch(notices[0]!.text, /did not answer/);
	});

	test('read only: a degraded daemon or no secure storage; the storage notice leads by severity order', () => {
		assert.strictEqual(state({ kind: 'ready' }, ROWS).readOnly, false);
		assert.strictEqual(state({ kind: 'degraded' }, ROWS).readOnly, true);
		assert.strictEqual(state({ kind: 'ready' }, ROWS, 'unavailable').readOnly, true);
		assert.strictEqual(state({ kind: 'ready' }, ROWS, 'unknown').readOnly, false, 'unknown is not a refusal; the daemon decides');
		const both = state({ kind: 'failed', reason: 'crash_loop' }, undefined, 'unavailable').notices;
		assert.deepStrictEqual(both.map(n => n.severity), ['error', 'warning'], 'most severe first');
		const storage = state({ kind: 'ready' }, ROWS, 'unavailable').notices;
		assert.deepStrictEqual(storage, [storageNotice()]);
		assert.ok(storageNotice().text.startsWith(`No secure storage: ${BRAND.productName} is read only.`));
	});
});
