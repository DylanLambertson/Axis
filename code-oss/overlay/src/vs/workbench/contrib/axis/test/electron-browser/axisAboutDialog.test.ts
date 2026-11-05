/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOSProperties } from '../../../../../platform/native/common/native.js';
import { createNativeAboutDialogDetails } from '../../../../../platform/dialogs/electron-browser/dialog.js';
import product from '../../../../../platform/product/common/product.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';

// Replaces the upstream platform/dialogs/test/electron-browser/dialog.test.ts, which
// tests the Copilot version lines that Axis removes from the About dialog.
suite('Axis About dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const osProperties: IOSProperties = { type: 'Test OS', release: '1.0', arch: 'test-arch', platform: 'test', cpus: [] };

	function labels(value: string): string[] {
		return value.split('\n').map(line => line.slice(0, line.indexOf(':')));
	}

	test('lists no Copilot versions, even when the product reports them', () => {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
			copilotVersions: { runtime: '1.0.84', sdk: '0.1.23' }
		};
		const { details, detailsToCopy } = createNativeAboutDialogDetails(productService, osProperties);
		const expected = ['Version', 'Commit', 'Date', 'Electron', 'ElectronBuildId', 'Chromium', 'Node.js', 'V8', 'OS'];
		assert.deepStrictEqual(labels(details), expected);
		assert.deepStrictEqual(labels(detailsToCopy), expected);
		assert.ok(!/copilot/i.test(details));
		assert.ok(details.endsWith('OS: Test OS test-arch 1.0'));
	});
});
