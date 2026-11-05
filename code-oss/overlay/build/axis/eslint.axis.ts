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

// Layer rules for `src/vs/axis` (docs/design/axis-shell.md section 3.7). They are
// allow-lists: no upstream target lists `vs/axis`, so upstream code cannot import
// Axis code. More specific targets come first, because the first match wins.
const axisCore = [
	'vs/base/~',
	'vs/base/parts/*/~',
	'vs/platform/*/~',
	'vs/editor/~',
	'vs/editor/contrib/*/~',
	'vs/workbench/~',
	'vs/workbench/services/*/~',
	'vs/axis/~',
	'vs/axis/services/*/~',
];

const axisMainEntry = [
	...axisCore,
	'vs/editor/editor.all.js',
	'vs/workbench/api/~',
	'vs/workbench/contrib/*/~',
	'vs/axis/contrib/*/~',
];

/** Extra `local/code-import-patterns` targets for the `vs/axis` layers. */
export const axisImportPatternTargets: object[] = [
	{
		target: 'src/vs/axis/axis.common.main.ts',
		layer: 'browser',
		restrictions: [...axisMainEntry, 'vs/workbench/workbench.common.main.js'],
	},
	{
		target: 'src/vs/axis/axis.desktop.main.ts',
		layer: 'electron-browser',
		restrictions: [...axisMainEntry, 'vs/workbench/workbench.desktop.main.js', 'vs/axis/axis.common.main.js'],
	},
	{
		target: 'src/vs/axis/axis.web.main.ts',
		layer: 'browser',
		restrictions: [...axisMainEntry, 'vs/workbench/workbench.web.main.js', 'vs/axis/axis.common.main.js'],
	},
	{
		target: 'src/vs/axis/axis.web.main.internal.ts',
		layer: 'browser',
		restrictions: ['vs/base/~', 'vs/platform/*/~', 'vs/axis/~', 'vs/axis/axis.web.main.js'],
	},
	{
		target: 'src/vs/axis/~',
		restrictions: [...axisCore, 'vs/workbench/browser/**'],
	},
	{
		target: 'src/vs/axis/services/*/~',
		restrictions: [...axisCore, 'vs/workbench/contrib/*/~'],
	},
	{
		target: 'src/vs/axis/contrib/*/~',
		restrictions: [...axisCore, 'vs/workbench/browser/**', 'vs/workbench/contrib/*/~', 'vs/axis/contrib/*/~'],
	},
];

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
