/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isResourceDiffEditorInput, isResourceEditorInput, isResourceMultiDiffEditorInput } from '../../../../../workbench/common/editor.js';
import { editorInputForReveal } from '../../common/axisRevealInput.js';

const A = URI.file('/w/a/x.ts');
const GIT = A.with({ scheme: 'git', query: JSON.stringify({ path: A.fsPath, ref: '~' }) });

suite('Axis reveal input', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a file opens at its selection, pinned, reusing an open editor', () => {
		assert.deepStrictEqual(editorInputForReveal({ resource: A, selection: { startLineNumber: 3, startColumn: 1 } }), {
			resource: A, options: { selection: { startLineNumber: 3, startColumn: 1 }, revealIfOpened: true, pinned: true },
		});
		assert.deepStrictEqual(editorInputForReveal({ kind: 'file', resource: A }), { resource: A, options: { revealIfOpened: true, pinned: true } });
	});

	test('a diff with both sides is a diff editor with no selection, so it opens at the first change', () => {
		const input = editorInputForReveal({ kind: 'diff', original: GIT, modified: A, label: 'x.ts (Not staged)' });
		assert.ok(isResourceDiffEditorInput(input));
		assert.deepStrictEqual(input, { original: { resource: GIT }, modified: { resource: A }, label: 'x.ts (Not staged)', options: { revealIfOpened: true, pinned: true } });
		assert.strictEqual((input.options as { selection?: unknown }).selection, undefined);
	});

	test('a one-sided diff opens the side that exists at line 1; no side opens nothing', () => {
		const added = editorInputForReveal({ kind: 'diff', original: undefined, modified: A, label: 'x' });
		assert.ok(isResourceEditorInput(added) && !isResourceDiffEditorInput(added));
		assert.strictEqual(added.resource, A);
		const deleted = editorInputForReveal({ kind: 'diff', original: GIT, modified: undefined, label: 'x' });
		assert.ok(isResourceEditorInput(deleted));
		assert.strictEqual(deleted.resource, GIT);
		assert.deepStrictEqual(deleted.options, { selection: { startLineNumber: 1, startColumn: 1 }, revealIfOpened: true, pinned: true });
		assert.strictEqual(editorInputForReveal({ kind: 'diff', original: undefined, modified: undefined, label: 'x' }), undefined);
	});

	test('a multi-diff lists every item with a side, goes to the worktree file and is transient', () => {
		const B = URI.file('/w/a/y.ts');
		const input = editorInputForReveal({
			kind: 'multiDiff', label: 'Changes in a', items: [
				{ original: GIT, modified: A, resource: A },
				{ original: undefined, modified: B, resource: B },
				{ original: undefined, modified: undefined, resource: B },
			],
		});
		assert.ok(isResourceMultiDiffEditorInput(input));
		assert.deepStrictEqual(input, {
			resources: [
				{ original: { resource: GIT }, modified: { resource: A }, goToFileResource: A },
				{ original: { resource: undefined }, modified: { resource: B }, goToFileResource: B },
			],
			label: 'Changes in a', isTransient: true, options: { revealIfOpened: true, pinned: true },
		});
		assert.strictEqual(editorInputForReveal({ kind: 'multiDiff', label: 'none', items: [] }), undefined);
	});
});
