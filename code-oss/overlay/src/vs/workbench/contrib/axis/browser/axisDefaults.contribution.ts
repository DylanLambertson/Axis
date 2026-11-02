/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/**
 * Axis default settings (docs/design/axis-shell.md section 2.2). They change only the
 * defaults: users can still override every key. Registered as built-in defaults,
 * so APPLICATION-scoped keys are honoured, and experiments cannot override them.
 */
export const AXIS_DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
	// Brand themes; OS auto-detection picks the matching variant.
	'workbench.colorTheme': 'Axis Dark',
	'workbench.preferredDarkColorTheme': 'Axis Dark',
	'workbench.preferredLightColorTheme': 'Axis Light',

	// Layout (docs/UX.md "Default layout"); explicit because the Axis shell relies on it.
	'workbench.activityBar.location': 'default',
	'workbench.sideBar.location': 'left',
	'workbench.panel.defaultLocation': 'bottom',
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'workbench.statusBar.visible': true,
	'window.commandCenter': true,
	'workbench.layoutControl.enabled': true,
	'workbench.experimental.modernUI': true,
	'window.density.layout': 'compact',
	'workbench.shadows': false,
	'editor.fontSize': 13,

	// Upstream walkthroughs and onboarding are VS Code- and Copilot-branded.
	'workbench.startupEditor': 'none',
	'workbench.welcomePage.walkthroughs.openOnInstall': false,
	'workbench.welcomePage.experimentalOnboarding': false,

	// Hides the built-in Copilot UI and disables the agent host until the
	// decision 6 patch set removes it (ADR 0002).
	'chat.disableAIFeatures': true,

	// No telemetry or online preference services.
	'telemetry.telemetryLevel': 'off',
	'telemetry.feedback.enabled': false,
	'workbench.settings.enableNaturalLanguageSearch': false,
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	overrides: { ...AXIS_DEFAULT_SETTINGS },
	source: 'axisDefaults',
	preventExperimentOverride: true,
}]);
