/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// Axis additions to the upstream ESLint flat config, spread into eslint.config.js
// by the shell patch (docs/design/axis-shell.md section 3.7, P8). Keeping them here
// keeps the upstream footprint to the import and the spread lines.

/** Paths owned by Axis. Upstream files keep the Microsoft MIT header. */
export const axisOwnedFiles = [
	'src/vs/axis/**',
	'src/vs/workbench/contrib/axis/**',
	'build/axis/**',
	'extensions/theme-axis/**',
];

/** Extra `local/code-import-patterns` targets. Stage 2 adds the `vs/axis` layers here. */
export const axisImportPatternTargets: object[] = [];

/** Flat-config blocks appended after the upstream ones, so they win for Axis files. */
export const axisConfigs = [
	{
		files: axisOwnedFiles,
		rules: {
			'header/header': [
				2,
				'block',
				[
					'---------------------------------------------------------------------------------------------',
					' *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.',
					' *--------------------------------------------------------------------------------------------'
				]
			]
		}
	}
];
