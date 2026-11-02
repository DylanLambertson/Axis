/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Extensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { AXIS_DEFAULT_SETTINGS } from '../../browser/axisDefaults.contribution.js';

suite('Axis defaults', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers every Axis default as a built-in default override', () => {
		const overrides = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationDefaultsOverrides();
		for (const [key, expected] of Object.entries(AXIS_DEFAULT_SETTINGS)) {
			const override = overrides.get(key);
			assert.ok(override, `no default override registered for ${key}`);
			assert.deepStrictEqual(override.value, expected, key);
			assert.strictEqual(override.source, 'axisDefaults', `${key} is not attributed to axisDefaults`);
		}
	});

	test('disables the built-in AI features and telemetry', () => {
		assert.strictEqual(AXIS_DEFAULT_SETTINGS['chat.disableAIFeatures'], true);
		assert.strictEqual(AXIS_DEFAULT_SETTINGS['telemetry.telemetryLevel'], 'off');
		assert.strictEqual(AXIS_DEFAULT_SETTINGS['workbench.welcomePage.experimentalOnboarding'], false);
	});

	test('defaults to the Axis themes', () => {
		assert.strictEqual(AXIS_DEFAULT_SETTINGS['workbench.colorTheme'], 'Axis Dark');
		assert.strictEqual(AXIS_DEFAULT_SETTINGS['workbench.preferredDarkColorTheme'], 'Axis Dark');
		assert.strictEqual(AXIS_DEFAULT_SETTINGS['workbench.preferredLightColorTheme'], 'Axis Light');
	});
});
