/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AXIS_OPEN_EXTERNAL_ALLOWED_SCHEMES, axisIsAllowedOpenExternalUrl } from '../../../../../platform/native/common/native.js';

// Security patch 2030 (threat model EL-5): openExternal hands only these schemes to the OS.
suite('Axis openExternal allow-list', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('allows only http, https and mailto', () => {
		assert.deepStrictEqual([...AXIS_OPEN_EXTERNAL_ALLOWED_SCHEMES], ['http', 'https', 'mailto']);
		for (const url of ['https://open-vsx.org/', 'HTTP://example.com/a?b=c', 'mailto:someone@example.com']) {
			assert.strictEqual(axisIsAllowedOpenExternalUrl(url), true, url);
		}
	});

	test('refuses file, custom and malformed URLs', () => {
		for (const url of ['file:///etc/passwd', 'FILE:///C:/Windows/System32/calc.exe', 'axis://agents/new', 'vscode://file/a', 'x-apple.systempreferences:com.apple.preference.security', 'smb://host/share', 'javascript:alert(1)', 'C:\\Windows\\notepad.exe', '/usr/bin/open', '', ' https://example.com', 'https//example.com']) {
			assert.strictEqual(axisIsAllowedOpenExternalUrl(url), false, url);
		}
	});
});
