// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/view/test/browser/axisViewService.test.ts, suite "Axis view state") by OS-5,
// with cases added for the scopes and the round trip.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { AXIS_GLOBAL_VIEW_STORAGE_KEY, AXIS_SPLIT_COLLAPSED_STORAGE_KEY, AXIS_WORKSPACE_VIEWS_STORAGE_KEY, AxisViewState, MAX_WORKSPACE_VIEW_RECORDS, type AxisStorageScope, type IAxisViewStorage } from '../../src/view/axisViewState.js';

class MemoryStorage implements IAxisViewStorage {
	readonly values = new Map<string, string>();
	get(key: string, scope: AxisStorageScope): string | undefined { return this.values.get(`${scope}:${key}`); }
	store(key: string, value: string, scope: AxisStorageScope): void { this.values.set(`${scope}:${key}`, value); }
}

suite('Axis view state', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ignores malformed records', () => {
		const storage = new MemoryStorage();
		const state = new AxisViewState(storage);
		for (const raw of ['{', '[]', 'null', '{"ws":{"view":"split"}}', '{"ws":null}']) {
			storage.store(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, raw, 'workspace');
			assert.strictEqual(state.get('perWorkspace', 'ws'), 'agent', raw);
		}
		storage.store(AXIS_GLOBAL_VIEW_STORAGE_KEY, 'split', 'application');
		assert.strictEqual(state.get('global', 'ws'), 'agent');
	});

	test('keeps a bounded number of workspace records, dropping the oldest', () => {
		const storage = new MemoryStorage();
		const state = new AxisViewState(storage);
		for (let i = 0; i <= MAX_WORKSPACE_VIEW_RECORDS; i++) {
			state.set('perWorkspace', `ws-${i}`, 'ide');
		}
		const records = JSON.parse(storage.get(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, 'workspace')!);
		assert.strictEqual(Object.keys(records).length, MAX_WORKSPACE_VIEW_RECORDS);
		assert.strictEqual(state.get('perWorkspace', 'ws-0'), 'agent');
		assert.strictEqual(state.get('perWorkspace', `ws-${MAX_WORKSPACE_VIEW_RECORDS}`), 'ide');
	});

	test('setting a remembered workspace again makes it the newest, so it outlives the bound', () => {
		const storage = new MemoryStorage();
		const state = new AxisViewState(storage);
		state.set('perWorkspace', 'keep', 'ide');
		for (let i = 1; i < MAX_WORKSPACE_VIEW_RECORDS; i++) {
			state.set('perWorkspace', `ws-${i}`, 'ide');
		}
		state.set('perWorkspace', 'keep', 'ide');
		state.set('perWorkspace', 'one-more', 'ide');
		assert.strictEqual(state.get('perWorkspace', 'keep'), 'ide', 'mutant: no re-insert drops the refreshed record');
		assert.strictEqual(state.get('perWorkspace', 'ws-1'), 'agent');
	});

	test('global mode lives in the application scope, per-workspace mode in the workspace scope', () => {
		const storage = new MemoryStorage();
		const state = new AxisViewState(storage);
		state.set('global', 'ws', 'ide');
		assert.deepStrictEqual([...storage.values.keys()], [`application:${AXIS_GLOBAL_VIEW_STORAGE_KEY}`]);
		assert.strictEqual(state.get('global', undefined), 'ide');
		assert.strictEqual(state.get('perWorkspace', 'ws'), 'agent', 'the global view is not a workspace record');
		state.set('perWorkspace', undefined, 'ide');
		assert.deepStrictEqual(JSON.parse(storage.get(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, 'workspace')!), { '': { view: 'ide' } }, 'no workspace is the dashboard key');
		assert.strictEqual(state.get('perWorkspace', undefined), 'ide');
	});

	test('the collapsed split half round-trips in the workspace scope, and junk reads as none', () => {
		const storage = new MemoryStorage();
		const state = new AxisViewState(storage);
		assert.strictEqual(state.getSplitCollapsed(), 'none');
		state.setSplitCollapsed('ide');
		assert.strictEqual(storage.get(AXIS_SPLIT_COLLAPSED_STORAGE_KEY, 'workspace'), 'ide');
		assert.strictEqual(state.getSplitCollapsed(), 'ide');
		storage.store(AXIS_SPLIT_COLLAPSED_STORAGE_KEY, 'sideways', 'workspace');
		assert.strictEqual(state.getSplitCollapsed(), 'none');
	});
});
