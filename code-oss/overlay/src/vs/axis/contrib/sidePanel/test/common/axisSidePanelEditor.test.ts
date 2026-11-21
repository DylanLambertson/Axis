/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { approvalShortcutAllowed, AXIS_SIDE_PANEL_LEAVE_WEIGHT, AXIS_SIDE_PANEL_ROUTE_WEIGHT, AXIS_SIDE_PANEL_ROUTED_KEYS, AxisSidePanelCommand, IAxisKeyGesture, IAxisKeyScope, isApprovalChord, sidePanelEditorOptions } from '../../common/axisSidePanelEditor.js';

/** A card, its Deny button, a node in the composer and a node in a code editor, as plain objects. */
class Dom {
	readonly deny = { name: 'deny' };
	readonly composerInput = { name: 'composer' };
	readonly editorInput = { name: 'editor' };
	readonly outside = { name: 'outside' };
	readonly inside = new Set<unknown>([this.deny]);
	active: unknown = this.deny;
	scope(): IAxisKeyScope {
		return {
			card: { contains: n => this.inside.has(n) },
			activeElement: this.active,
			isInComposer: n => n === this.composerInput,
			isInEditor: n => n === this.editorInput,
		};
	}
}

function key(target: unknown, extra: Partial<IAxisKeyGesture> = {}): IAxisKeyGesture {
	return { isTrusted: true, type: 'keydown', key: 'Enter', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, target, ...extra };
}

suite('Axis side-panel editor (PV-V0 spike)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('forced options win over the user\'s editor settings, which are otherwise kept', () => {
		const user = { fontSize: 19, minimap: { enabled: true, side: 'left' }, unicodeHighlight: { invisibleCharacters: false, nonBasicASCII: false }, renderControlCharacters: false, readOnly: false };
		const options = sidePanelEditorOptions(user, { trusted: false, label: 'a.ts' }) as Record<string, unknown>;
		assert.strictEqual(options.fontSize, 19);
		assert.deepStrictEqual(options.minimap, { enabled: false, side: 'left' });
		assert.deepStrictEqual(options.unicodeHighlight, { invisibleCharacters: true, nonBasicASCII: false, ambiguousCharacters: true });
		assert.strictEqual(options.renderControlCharacters, true);
		assert.strictEqual(options.readOnly, true);
		assert.strictEqual(options.domReadOnly, true);
	});

	test('trust decides read-only, the read-only message and the spoken label', () => {
		const trusted = sidePanelEditorOptions(undefined, { trusted: true, label: 'a.ts' });
		const untrusted = sidePanelEditorOptions(undefined, { trusted: false, label: 'a.ts' });
		assert.strictEqual(trusted.readOnly, false);
		assert.strictEqual(trusted.readOnlyMessage, undefined);
		assert.ok(!String(trusted.ariaLabel).includes('read-only'));
		assert.strictEqual(untrusted.readOnly, true);
		assert.ok(untrusted.readOnlyMessage?.value.includes('Restricted Mode'));
		assert.ok(String(untrusted.ariaLabel).startsWith('a.ts, ') && String(untrusted.ariaLabel).includes('read-only'));
	});

	test('the user\'s settings object is not mutated, and a non-object user value is replaced whole', () => {
		const user = { unicodeHighlight: { invisibleCharacters: false }, minimap: 'yes' };
		const options = sidePanelEditorOptions(user, { trusted: true, label: 'x' }) as Record<string, unknown>;
		assert.deepStrictEqual(user, { unicodeHighlight: { invisibleCharacters: false }, minimap: 'yes' });
		assert.deepStrictEqual(options.minimap, { enabled: false });
	});

	test('routed keys beat the workbench commands they replace; Escape loses to every editor binding', () => {
		assert.ok(AXIS_SIDE_PANEL_ROUTE_WEIGHT > 200, 'above KeybindingWeight.WorkbenchContrib');
		assert.ok(AXIS_SIDE_PANEL_LEAVE_WEIGHT < 0, 'below KeybindingWeight.EditorCore');
		assert.deepStrictEqual(AXIS_SIDE_PANEL_ROUTED_KEYS.map(k => [k.upstreamCommand, k.route]), [
			['workbench.action.files.save', AxisSidePanelCommand.save],
			['workbench.action.files.saveWithoutFormatting', AxisSidePanelCommand.saveWithoutFormatting],
			['workbench.action.files.saveAs', AxisSidePanelCommand.openInIde],
			['workbench.action.closeActiveEditor', AxisSidePanelCommand.close],
			['workbench.action.splitEditor', AxisSidePanelCommand.openInIde],
		]);
		assert.strictEqual(AXIS_SIDE_PANEL_ROUTED_KEYS[0].primary, KeyMod.CtrlCmd | KeyCode.KeyS);
		assert.strictEqual(AXIS_SIDE_PANEL_ROUTED_KEYS[1].primary, KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyS));
		assert.deepStrictEqual(AXIS_SIDE_PANEL_ROUTED_KEYS[3].win, { primary: KeyMod.CtrlCmd | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyCode.KeyW] });
	});

	test('the approval chord is Mod+Enter alone, per platform', () => {
		assert.strictEqual(isApprovalChord(key(1), false), true);
		assert.strictEqual(isApprovalChord(key(1, { ctrlKey: false, metaKey: true }), true), true);
		assert.strictEqual(isApprovalChord(key(1), true), false, 'Ctrl+Enter on macOS');
		assert.strictEqual(isApprovalChord(key(1, { metaKey: true }), false), false, 'Ctrl+Meta+Enter');
		assert.strictEqual(isApprovalChord(key(1, { shiftKey: true }), false), false);
		assert.strictEqual(isApprovalChord(key(1, { altKey: true }), false), false);
		assert.strictEqual(isApprovalChord(key(1, { key: 'NumpadEnter' }), false), false);
		assert.strictEqual(isApprovalChord(key(1, { type: 'keyup' }), false), false);
	});

	test('a real Mod+Enter on the card with the focus in it is allowed', () => {
		const dom = new Dom();
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny), dom.scope(), false), true);
	});

	test('script-dispatched, auto-repeated or wrong-chord key events are refused', () => {
		const dom = new Dom();
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { isTrusted: false }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { repeat: true }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { ctrlKey: false }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed({ ...key(dom.deny), isTrusted: 'true' as unknown as boolean }, dom.scope(), false), false);
	});

	test('an event outside the card, or with the focus outside it, is refused', () => {
		const dom = new Dom();
		assert.strictEqual(approvalShortcutAllowed(key(dom.outside), dom.scope(), false), false, 'target outside');
		dom.active = dom.outside;
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny), dom.scope(), false), false, 'focus outside');
	});

	test('the composer and any code editor never answer a card, even when nested in it', () => {
		const dom = new Dom();
		dom.inside.add(dom.composerInput).add(dom.editorInput);
		dom.active = dom.composerInput;
		assert.strictEqual(approvalShortcutAllowed(key(dom.composerInput), dom.scope(), false), false, 'composer');
		dom.active = dom.editorInput;
		assert.strictEqual(approvalShortcutAllowed(key(dom.editorInput), dom.scope(), false), false, 'editor focus and target');
		dom.active = dom.deny;
		assert.strictEqual(approvalShortcutAllowed(key(dom.editorInput), dom.scope(), false), false, 'editor target, focus on Deny');
		dom.active = dom.editorInput;
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny), dom.scope(), false), false, 'editor focus, target Deny');
	});
});
