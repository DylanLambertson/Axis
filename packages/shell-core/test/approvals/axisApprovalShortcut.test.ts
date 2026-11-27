// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (contrib/sidePanel/test/common/axisSidePanelEditor.test.ts, the shortcut cases) by OS-5,
// with the badge cases added.

import assert from 'node:assert';
import { suite, test } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../testing.js';
import { approvalShortcutAllowed, approvalShortcutAria, approvalShortcutKeys, approvalShortcutLabel, isApprovalChord, type IAxisKeyGesture, type IAxisKeyScope } from '../../src/approvals/axisApprovalShortcut.js';

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
	return { isTrusted: true, type: 'keydown', key: 'Enter', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, target, ...extra };
}

suite('Axis approval shortcut', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the approval chord is Mod+Enter alone, per platform', () => {
		assert.strictEqual(isApprovalChord(key(1), false), true);
		assert.strictEqual(isApprovalChord(key(1, { ctrlKey: false, metaKey: true }), true), true);
		assert.strictEqual(isApprovalChord(key(1), true), false, 'Ctrl+Enter on macOS');
		assert.strictEqual(isApprovalChord(key(1, { metaKey: true }), false), false, 'Ctrl+Meta+Enter');
		assert.strictEqual(isApprovalChord(key(1, { ctrlKey: true, metaKey: true }), true), false, 'Cmd+Ctrl+Enter on macOS');
		assert.strictEqual(isApprovalChord(key(1, { shiftKey: true }), false), false);
		assert.strictEqual(isApprovalChord(key(1, { altKey: true }), false), false);
		assert.strictEqual(isApprovalChord(key(1, { key: 'NumpadEnter' }), false), false);
		assert.strictEqual(isApprovalChord(key(1, { type: 'keyup' }), false), false);
	});

	test('a real Mod+Enter on the card with the focus in it is allowed', () => {
		const dom = new Dom();
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny), dom.scope(), false), true);
	});

	test('script-dispatched, auto-repeated, composing or wrong-chord key events are refused', () => {
		const dom = new Dom();
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { isTrusted: false }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { repeat: true }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { isComposing: true }), dom.scope(), false), false, 'IME composition');
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { ctrlKey: false }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed({ ...key(dom.deny), isTrusted: 'true' as unknown as boolean }, dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed({ ...key(dom.deny), repeat: undefined as unknown as boolean }, dom.scope(), false), false, 'a missing repeat flag is not "not repeated"');
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
		dom.active = dom.deny;
		assert.strictEqual(approvalShortcutAllowed(key(dom.composerInput), dom.scope(), false), false, 'composer target, focus moved to Deny (review S1)');
		dom.active = dom.composerInput;
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny), dom.scope(), false), false, 'composer focus, target Deny');
	});

	test('the badge shows the platform keys, and its spoken name and aria value match the chord the gate accepts', () => {
		assert.deepStrictEqual(approvalShortcutKeys(true), ['⌘', '↩']);
		assert.deepStrictEqual(approvalShortcutKeys(false), ['Ctrl', 'Enter']);
		assert.strictEqual(approvalShortcutLabel(true), 'Command+Return');
		assert.strictEqual(approvalShortcutLabel(false), 'Control+Enter');
		assert.strictEqual(approvalShortcutAria(true), 'Meta+Enter');
		assert.strictEqual(approvalShortcutAria(false), 'Control+Enter');
		for (const mac of [true, false]) {
			const [modifier] = approvalShortcutAria(mac).split('+');
			const event = key(1, { ctrlKey: modifier === 'Control', metaKey: modifier === 'Meta' });
			assert.strictEqual(isApprovalChord(event, mac), true, `the aria value names the chord on ${mac ? 'macOS' : 'other platforms'}`);
		}
	});
});
