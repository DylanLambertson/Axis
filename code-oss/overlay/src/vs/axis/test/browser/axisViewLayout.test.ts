/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { axisPartVisibility, DEFAULT_IDE_PARTS_STATE, parseIdePartsState } from '../../browser/axisViewLayout.js';
import { getUpstreamWorkbenchGrid } from '../../browser/workbench.js';

suite('Axis view layout', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Agent view shows only the agent part of the swapped parts', () => {
		for (const ide of [{ activityBar: true, sideBar: true }, { activityBar: false, sideBar: false }]) {
			assert.deepStrictEqual(axisPartVisibility('agent', ide), { agent: true, editor: false, activityBar: false, sideBar: false });
		}
	});

	test('the IDE view shows the editor and restores the remembered IDE parts', () => {
		assert.deepStrictEqual(axisPartVisibility('ide', { activityBar: true, sideBar: false }), { agent: false, editor: true, activityBar: true, sideBar: false });
		assert.deepStrictEqual(axisPartVisibility('ide', { activityBar: false, sideBar: true }), { agent: false, editor: true, activityBar: false, sideBar: true });
	});

	test('the agent part and the editor are never both hidden or both shown', () => {
		for (const view of ['agent', 'ide'] as const) {
			const visibility = axisPartVisibility(view, DEFAULT_IDE_PARTS_STATE);
			assert.notStrictEqual(visibility.agent, visibility.editor, view);
		}
	});

	test('the IDE parts state round-trips and tolerates malformed storage', () => {
		const state = { activityBar: false, sideBar: true };
		assert.deepStrictEqual(parseIdePartsState(JSON.stringify(state)), state);
		assert.deepStrictEqual(parseIdePartsState(undefined), DEFAULT_IDE_PARTS_STATE);
		assert.deepStrictEqual(parseIdePartsState('{not json'), DEFAULT_IDE_PARTS_STATE);
		assert.deepStrictEqual(parseIdePartsState('[]'), DEFAULT_IDE_PARTS_STATE);
		assert.deepStrictEqual(parseIdePartsState('{"activityBar":"no","sideBar":false}'), { activityBar: true, sideBar: false });
	});

	test('reading the upstream grid fails loudly when the field is missing', () => {
		assert.throws(() => getUpstreamWorkbenchGrid({}), /Layout\.workbenchGrid/);
		assert.throws(() => getUpstreamWorkbenchGrid({ workbenchGrid: {} }), /Layout\.workbenchGrid/);
	});
});
