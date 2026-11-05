/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { axisPartVisibility, DEFAULT_IDE_PARTS_STATE, parseIdePartsState, showsIdeParts } from '../../browser/axisViewLayout.js';
import { getUpstreamWorkbenchGrid, parseLayoutRequest } from '../../browser/workbench.js';
import { AXIS_AGENT_PART_ID } from '../../browser/axisLayoutService.js';
import { AXIS_PART_CYCLE, AxisNavigablePart, nextVisiblePart } from '../../browser/axisPartNavigation.js';

suite('Axis view layout', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Agent view shows only the agent part of the swapped parts', () => {
		for (const ide of [{ activityBar: true, sideBar: true }, { activityBar: false, sideBar: false }]) {
			assert.deepStrictEqual(axisPartVisibility({ kind: 'agent', collapsed: 'none' }, ide), { agent: true, agentCollapsed: false, editor: false, activityBar: false, sideBar: false });
		}
	});

	test('the IDE view shows the editor and restores the remembered IDE parts', () => {
		assert.deepStrictEqual(axisPartVisibility({ kind: 'ide', collapsed: 'none' }, { activityBar: true, sideBar: false }), { agent: false, agentCollapsed: false, editor: true, activityBar: true, sideBar: false });
		assert.deepStrictEqual(axisPartVisibility({ kind: 'ide', collapsed: 'none' }, { activityBar: false, sideBar: true }), { agent: false, agentCollapsed: false, editor: true, activityBar: false, sideBar: true });
	});

	test('split shows both halves; a collapsed half keeps a header or hides the IDE parts', () => {
		assert.deepStrictEqual(axisPartVisibility({ kind: 'split', collapsed: 'none' }, DEFAULT_IDE_PARTS_STATE), { agent: true, agentCollapsed: false, editor: true, activityBar: true, sideBar: true });
		assert.deepStrictEqual(axisPartVisibility({ kind: 'split', collapsed: 'agent' }, DEFAULT_IDE_PARTS_STATE), { agent: true, agentCollapsed: true, editor: true, activityBar: true, sideBar: true });
		assert.deepStrictEqual(axisPartVisibility({ kind: 'split', collapsed: 'ide' }, DEFAULT_IDE_PARTS_STATE), { agent: true, agentCollapsed: false, editor: false, activityBar: false, sideBar: false });
		assert.strictEqual(showsIdeParts({ kind: 'split', collapsed: 'agent' }), true);
		assert.strictEqual(showsIdeParts({ kind: 'split', collapsed: 'ide' }), false);
	});

	test('the agent part or the editor is always shown', () => {
		for (const request of [{ kind: 'agent', collapsed: 'none' }, { kind: 'ide', collapsed: 'none' }, { kind: 'split', collapsed: 'none' }, { kind: 'split', collapsed: 'agent' }, { kind: 'split', collapsed: 'ide' }] as const) {
			const visibility = axisPartVisibility(request, DEFAULT_IDE_PARTS_STATE);
			assert.ok(visibility.agent || visibility.editor, `${request.kind}:${request.collapsed}`);
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

	test('the stored layout parses, and anything else is ignored', () => {
		assert.deepStrictEqual(parseLayoutRequest('agent'), { kind: 'agent', collapsed: 'none' });
		assert.deepStrictEqual(parseLayoutRequest('split:ide'), { kind: 'split', collapsed: 'ide' });
		assert.deepStrictEqual(parseLayoutRequest('split:bogus'), { kind: 'split', collapsed: 'none' });
		assert.strictEqual(parseLayoutRequest('maximized'), undefined);
		assert.strictEqual(parseLayoutRequest(undefined), undefined);
	});

	test('reading the upstream grid fails loudly when the field is missing', () => {
		assert.throws(() => getUpstreamWorkbenchGrid({}), /Layout\.workbenchGrid/);
		assert.throws(() => getUpstreamWorkbenchGrid({ workbenchGrid: {} }), /Layout\.workbenchGrid/);
	});
});

suite('Axis part navigation (F6)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const visible = (...parts: AxisNavigablePart[]) => (part: AxisNavigablePart) => parts.includes(part);

	test('the agent part comes after the editor, and hidden parts are skipped', () => {
		assert.strictEqual(AXIS_PART_CYCLE.indexOf(AXIS_AGENT_PART_ID), AXIS_PART_CYCLE.indexOf(Parts.EDITOR_PART) + 1);
		const split = visible(Parts.EDITOR_PART, AXIS_AGENT_PART_ID, Parts.PANEL_PART, Parts.STATUSBAR_PART);
		assert.strictEqual(nextVisiblePart(Parts.EDITOR_PART, true, split), AXIS_AGENT_PART_ID);
		assert.strictEqual(nextVisiblePart(AXIS_AGENT_PART_ID, true, split), Parts.PANEL_PART);
		assert.strictEqual(nextVisiblePart(Parts.PANEL_PART, false, split), AXIS_AGENT_PART_ID);
		assert.strictEqual(nextVisiblePart(Parts.STATUSBAR_PART, true, split), Parts.EDITOR_PART, 'wraps around');
	});

	test('in the Agent view the hidden editor is never a target', () => {
		const agentView = visible(AXIS_AGENT_PART_ID, Parts.STATUSBAR_PART);
		assert.strictEqual(nextVisiblePart(Parts.STATUSBAR_PART, true, agentView), AXIS_AGENT_PART_ID);
		assert.strictEqual(nextVisiblePart(undefined, true, agentView), AXIS_AGENT_PART_ID);
		assert.strictEqual(nextVisiblePart(AXIS_AGENT_PART_ID, true, visible(AXIS_AGENT_PART_ID)), undefined);
	});
});
