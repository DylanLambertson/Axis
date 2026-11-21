/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { approvalShortcutAllowed, AXIS_SIDE_PANEL_COMMAND_POLICY, AXIS_SIDE_PANEL_LEAVE_WEIGHT, guardDecision, hasExplicitTarget, IAxisKeyGesture, IAxisKeyScope, isApprovalChord, MAX_LABEL, sidePanelEditorOptions, unclassifiedCommands } from '../../common/axisSidePanelEditor.js';

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

	test('the command policy pins the actions that keep the hidden IDE editor out of reach', () => {
		const policy = AXIS_SIDE_PANEL_COMMAND_POLICY;
		assert.strictEqual(policy.get('workbench.action.files.save'), 'save');
		assert.strictEqual(policy.get('workbench.action.files.saveWithoutFormatting'), 'saveWithoutFormatting');
		assert.strictEqual(policy.get('workbench.action.files.saveAll'), 'saveAllToo');
		assert.strictEqual(policy.get('workbench.action.closeActiveEditor'), 'close');
		for (const id of ['workbench.action.files.saveAs', 'workbench.action.files.copyPathOfActiveFile', 'workbench.action.editor.changeLanguageMode', 'workbench.files.action.compareWithSaved', 'workbench.action.splitEditor', 'workbench.action.files.revert']) {
			assert.strictEqual(policy.get(id), 'openInIde', id);
		}
		for (const id of ['workbench.action.closeEditorsInGroup', 'workbench.action.closeUnmodifiedEditors', 'workbench.action.nextEditor', 'workbench.action.openEditorAtIndex9', 'workbench.action.keepEditor']) {
			assert.strictEqual(policy.get(id), 'block', id);
		}
		for (const id of ['undo', 'redo', 'editor.action.selectAll', 'workbench.action.focusNextPart']) {
			assert.strictEqual(policy.get(id), 'accept', id);
		}
		assert.ok(AXIS_SIDE_PANEL_LEAVE_WEIGHT < 0, 'Escape below KeybindingWeight.EditorCore');
	});

	test('a scan with an unclassified flagged command fails; a classified one passes', () => {
		assert.deepStrictEqual(unclassifiedCommands(['workbench.action.files.save', 'undo']), []);
		assert.deepStrictEqual(unclassifiedCommands(['workbench.action.newThing', 'undo', 'workbench.action.newThing', 'a.b']), ['a.b', 'workbench.action.newThing']);
	});

	test('the guard applies the action only with the side panel focused and no explicit target', () => {
		assert.strictEqual(guardDecision('save', true, false), 'save');
		assert.strictEqual(guardDecision('save', false, false), undefined, 'IDE editor focused: the original runs');
		assert.strictEqual(guardDecision('save', true, true), undefined, 'a tab or Explorer menu names its target');
		assert.strictEqual(guardDecision('block', true, false), 'block');
		assert.strictEqual(guardDecision('accept', true, false), undefined);
		assert.strictEqual(guardDecision('saveAllToo', false, false), 'saveAllToo', 'Save All covers side-panel files whatever has the focus');
		assert.strictEqual(guardDecision('saveAllToo', true, true), 'saveAllToo');
	});

	test('only a URI or an editor context is an explicit target; keybinding args are not', () => {
		assert.strictEqual(hasExplicitTarget([]), false);
		assert.strictEqual(hasExplicitTarget([{}]), false, 'args: {} from keybindings.json');
		assert.strictEqual(hasExplicitTarget([{ preserveFocus: true }, 'x', 3, null]), false);
		assert.strictEqual(hasExplicitTarget([URI.file('/w/a.ts')]), true);
		assert.strictEqual(hasExplicitTarget([undefined, { groupId: 1, editorIndex: 0 }]), true);
		assert.strictEqual(hasExplicitTarget([{ resource: URI.file('/w/a.ts') }]), true);
	});

	test('the policy classifies the commands the probe could not see (go to line or symbol, launchers, groups)', () => {
		for (const id of ['workbench.action.gotoLine', 'workbench.action.gotoSymbol', 'workbench.action.debug.start', 'workbench.action.debug.run', 'workbench.action.tasks.build', 'workbench.action.files.revealActiveFileInWindows']) {
			assert.strictEqual(AXIS_SIDE_PANEL_COMMAND_POLICY.get(id), 'openInIde', id);
		}
		for (const id of ['workbench.action.closeAllEditors', 'workbench.action.focusSecondEditorGroup', 'workbench.action.focusEighthEditorGroup', 'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup']) {
			assert.strictEqual(AXIS_SIDE_PANEL_COMMAND_POLICY.get(id), 'block', id);
		}
	});

	test('the policy classifies what the state matrix found, and the native console follows the IDE (review r3 N2, N6)', () => {
		assert.strictEqual(AXIS_SIDE_PANEL_COMMAND_POLICY.get('workbench.action.terminal.openNativeConsole'), 'openInIde');
		for (const id of ['editor.action.nextCommentingRange', 'editor.action.previousCommentingRange', 'workbench.action.compareEditor.nextChange', 'workbench.action.compareEditor.previousChange',
			'workbench.action.splitEditorInGroup', 'workbench.action.joinEditorInGroup', 'workbench.action.toggleMaximizeEditorGroup']) {
			assert.strictEqual(AXIS_SIDE_PANEL_COMMAND_POLICY.get(id), 'block', id);
		}
		for (const id of ['workbench.action.debug.continue', 'workbench.action.debug.stepOver', 'workbench.action.debug.stop', 'editor.action.announceCursorPosition']) {
			assert.strictEqual(AXIS_SIDE_PANEL_COMMAND_POLICY.get(id), 'accept', id);
		}
	});

	test('the spoken label is cleaned and clamped', () => {
		const label = String(sidePanelEditorOptions(undefined, { trusted: true, label: 'a\u202Egnp.ts\u200B' }).ariaLabel);
		assert.ok(!label.includes('\u202E') && !label.includes('\u200B'), label);
		const long = String(sidePanelEditorOptions(undefined, { trusted: true, label: 'x'.repeat(500) }).ariaLabel);
		assert.ok([...long.split(',')[0]].length <= MAX_LABEL, String(long.length));
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

	test('script-dispatched, auto-repeated, composing or wrong-chord key events are refused', () => {
		const dom = new Dom();
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { isTrusted: false }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { repeat: true }), dom.scope(), false), false);
		assert.strictEqual(approvalShortcutAllowed(key(dom.deny, { isComposing: true }), dom.scope(), false), false, 'IME composition');
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
