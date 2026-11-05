/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { TestCodeEditorService } from '../../../../../editor/test/browser/editorTestServices.js';
import { NullCommandService } from '../../../../../platform/commands/test/common/nullCommandService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';

// Security patch 2040 (threat model EL-5): when the main process refuses an external URL,
// the opener reports that nothing was opened and does not fall through to another opener.
suite('Axis OpenerService external results', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(externalResult: boolean) {
		const editorService = new TestCodeEditorService(new TestThemeService());
		const openerService = new OpenerService(editorService, NullCommandService);
		const opened: string[] = [];
		openerService.setDefaultExternalOpener({
			openExternal: async href => {
				opened.push(href);
				return externalResult;
			}
		});
		store.add(editorService);
		return { editorService, openerService, opened };
	}

	test('reports false for a refused external open, for every caller', async () => {
		const { editorService, openerService, opened } = setup(false);
		assert.strictEqual(await openerService.open('file:///tmp/axis/report.txt', { openExternal: true }), false);
		assert.strictEqual(await openerService.open('smb://example.invalid/share', { openExternal: true }), false);
		assert.strictEqual(await openerService.open('vsls:///session'), false);
		assert.strictEqual(await openerService.open('file:///tmp/axis/report.txt', { openExternal: true, allowContributedOpeners: true }), false);
		assert.deepStrictEqual(opened, ['file:///tmp/axis/report.txt', 'smb://example.invalid/share', 'vsls:///session', 'file:///tmp/axis/report.txt']);
		assert.strictEqual(editorService.lastInput, undefined, 'a refused URL must not open in an editor instead');
	});

	test('reports true when the external open succeeds', async () => {
		const { openerService, opened } = setup(true);
		assert.strictEqual(await openerService.open('https://open-vsx.org/'), true);
		assert.strictEqual(await openerService.open('mailto:someone@example.com', { openExternal: true }), true);
		assert.deepStrictEqual(opened, ['https://open-vsx.org/', 'mailto:someone@example.com']);
	});

	test('leaves non-external targets to the other openers', async () => {
		const { editorService, openerService, opened } = setup(false);
		assert.strictEqual(await openerService.open('file:///tmp/axis/report.txt'), true);
		assert.strictEqual(editorService.lastInput?.resource.toString(), 'file:///tmp/axis/report.txt');
		assert.deepStrictEqual(opened, []);
	});
});
