/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
// Contrast test for the Axis built-in themes (docs/design/axis-shell-stage1.md §2.3, task S1.4).
// Checks every foreground against each surface it is drawn on, using the WCAG 2.2
// relative-luminance formula; translucent colours are composited over the surface first.
//   - text and placeholders: >= 4.5:1 (SC 1.4.3)
//   - focus indicators and control borders: >= 3:1 (SC 1.4.11)
// Stated exceptions (disabled text, line numbers) are listed below with their floor.
// Run with: node --test test/theme-axis/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../../scripts/code-oss/gen-theme-syntax.mjs';

const themesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../code-oss/overlay/extensions/theme-axis/themes');

function loadColors(file) {
	return parseJsonc(fs.readFileSync(path.join(themesDir, file), 'utf8')).colors;
}

export function parseHex(hex) {
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
	if (!m) {
		throw new Error(`not a #RRGGBB or #RRGGBBAA colour: ${hex}`);
	}
	const n = parseInt(m[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}

export function composite(fg, bg) {
	const mix = (f, b) => f * fg.a + b * (1 - fg.a);
	return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function luminance({ r, g, b }) {
	const lin = v => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const CANVAS = ['titleBar.activeBackground', 'titleBar.inactiveBackground', 'activityBar.background', 'statusBar.background'];
const SURFACE = ['editor.background', 'sideBar.background', 'panel.background', 'tab.activeBackground', 'tab.inactiveBackground', 'sideBarSectionHeader.background', 'terminal.background', 'commandCenter.background'];
const RAISED = ['editorWidget.background', 'quickInput.background', 'menu.background', 'notifications.background', 'dropdown.background'];
const ALL = [...CANVAS, ...SURFACE, ...RAISED];

// [foreground, surfaces it is drawn on, minimum ratio]. A surface may be
// "a|b": colour a (possibly translucent) composited over opaque colour b.
const TEXT = 4.5;
const NON_TEXT = 3;
const checks = [
	['foreground', ALL, TEXT],
	['editor.foreground', ['editor.background'], TEXT],
	['descriptionForeground', ALL, TEXT],
	['input.placeholderForeground', ['input.background', ...RAISED], TEXT],
	['input.foreground', ['input.background'], TEXT],
	['tab.activeForeground', ['tab.activeBackground'], TEXT],
	['tab.inactiveForeground', ['tab.inactiveBackground'], TEXT],
	['titleBar.activeForeground', ['titleBar.activeBackground'], TEXT],
	['titleBar.inactiveForeground', ['titleBar.inactiveBackground'], TEXT],
	['activityBar.foreground', ['activityBar.background'], TEXT],
	['activityBar.inactiveForeground', ['activityBar.background'], TEXT],
	['statusBar.foreground', ['statusBar.background', 'statusBar.noFolderBackground'], TEXT],
	['statusBar.noFolderForeground', ['statusBar.noFolderBackground'], TEXT],
	['statusBar.debuggingForeground', ['statusBar.debuggingBackground'], TEXT],
	['statusBarItem.errorForeground', ['statusBarItem.errorBackground'], TEXT],
	['statusBarItem.warningForeground', ['statusBarItem.warningBackground'], TEXT],
	['errorForeground', ALL, TEXT],
	['dropdown.foreground', ['dropdown.background'], TEXT],
	['quickInput.foreground', ['quickInput.background'], TEXT],
	['menu.foreground', ['menu.background'], TEXT],
	['notifications.foreground', ['notifications.background'], TEXT],
	['panelTitle.activeForeground', ['panel.background'], TEXT],
	['panelTitle.inactiveForeground', ['panel.background'], TEXT],
	['editorLineNumber.activeForeground', ['editor.background'], TEXT],
	['foreground', ['list.inactiveSelectionBackground|sideBar.background', 'list.inactiveSelectionBackground|editor.background'], TEXT],
	['commandCenter.foreground', ['commandCenter.background', 'commandCenter.activeBackground|commandCenter.background'], TEXT],
	['textLink.foreground', ALL, TEXT],
	['textLink.activeForeground', ALL, TEXT],
	['button.foreground', ['button.background', 'button.hoverBackground'], TEXT],
	['button.secondaryForeground', ['button.secondaryBackground'], TEXT],
	['activityBarBadge.foreground', ['activityBarBadge.background'], TEXT],
	['badge.foreground', ['badge.background'], TEXT],
	['statusBarItem.remoteForeground', ['statusBarItem.remoteBackground'], TEXT],
	['list.activeSelectionForeground', ['list.activeSelectionBackground|sideBar.background', 'quickInputList.focusBackground|quickInput.background'], TEXT],
	['menu.selectionForeground', ['menu.selectionBackground|menu.background'], TEXT],
	['foreground', ['list.hoverBackground|sideBar.background', 'list.hoverBackground|quickInput.background'], TEXT],
	['keybindingLabel.foreground', ['keybindingLabel.background'], TEXT],
	['settings.headerForeground', ['editor.background'], TEXT],
	['focusBorder', ALL, NON_TEXT],
	['list.focusOutline', ALL, NON_TEXT],
	['input.border', ALL, NON_TEXT],
	['checkbox.border', ALL, NON_TEXT],
	['tab.activeBorderTop', ['tab.activeBackground'], NON_TEXT],
	['activityBar.activeBorder', ['activityBar.background'], NON_TEXT],
	['panelTitle.activeBorder', ['panel.background'], NON_TEXT],
	['icon.foreground', ALL, NON_TEXT],
	['dropdown.border', ALL, NON_TEXT],
	// Diagnostics: squiggles and Problems icons on the surfaces they are drawn on.
	['editorError.foreground', [...SURFACE, ...RAISED], NON_TEXT],
	['editorWarning.foreground', [...SURFACE, ...RAISED], NON_TEXT],
	['editorInfo.foreground', [...SURFACE, ...RAISED], NON_TEXT],
];

// Stated exceptions: below 4.5:1 by design, never used for body or placeholder text.
const exceptions = [
	['disabledForeground', ALL, NON_TEXT],
	['editorLineNumber.foreground', ['editor.background'], NON_TEXT],
];

function surfaceColor(colors, spec) {
	const layers = spec.split('|').map(k => {
		assert.ok(colors[k], `surface colour ${k} is not set`);
		return parseHex(colors[k]);
	});
	let result = layers.pop();
	assert.equal(result.a, 1, `base surface ${spec} must be opaque`);
	while (layers.length) {
		result = composite(layers.pop(), result);
	}
	return result;
}

export function evaluate(colors, list) {
	const results = [];
	for (const [fgKey, surfaces, min] of list) {
		assert.ok(colors[fgKey], `foreground ${fgKey} is not set`);
		for (const spec of surfaces) {
			const bg = surfaceColor(colors, spec);
			const fg = composite(parseHex(colors[fgKey]), bg);
			results.push({ fgKey, spec, min, ratio: contrast(fg, bg) });
		}
	}
	return results;
}

test('contrast helpers match known WCAG values', () => {
	assert.equal(contrast(parseHex('#FFFFFF'), parseHex('#000000')).toFixed(1), '21.0');
	assert.equal(contrast(parseHex('#FFFFFF'), parseHex('#5823F6')).toFixed(1), '7.0');
	const half = composite(parseHex('#00000080'), parseHex('#FFFFFF'));
	assert.ok(Math.abs(half.r - 127.5) < 1);
});

for (const file of ['axis-dark.json', 'axis-light.json']) {
	test(`${file}: foregrounds meet WCAG 2.2 AA on every surface they are drawn on`, () => {
		const colors = loadColors(file);
		const failures = evaluate(colors, checks).filter(r => r.ratio < r.min);
		assert.deepEqual(failures.map(f => `${f.fgKey} on ${f.spec}: ${f.ratio.toFixed(2)} < ${f.min}`), []);
	});

	test(`${file}: stated exceptions stay at or above 3:1`, () => {
		const colors = loadColors(file);
		const failures = evaluate(colors, exceptions).filter(r => r.ratio < r.min);
		assert.deepEqual(failures.map(f => `${f.fgKey} on ${f.spec}: ${f.ratio.toFixed(2)} < ${f.min}`), []);
	});

	test(`${file}: every colour is a valid hex value`, () => {
		for (const [key, value] of Object.entries(loadColors(file))) {
			assert.doesNotThrow(() => parseHex(value), key);
		}
	});
}

// Print the tightest pairs so the PR can quote them.
if (process.env.AXIS_CONTRAST_REPORT) {
	for (const file of ['axis-dark.json', 'axis-light.json']) {
		const rows = evaluate(loadColors(file), [...checks, ...exceptions]).sort((a, b) => a.ratio / a.min - b.ratio / b.min);
		console.log(`# ${file}: 8 tightest pairs`);
		for (const r of rows.slice(0, 8)) {
			console.log(`${r.ratio.toFixed(2)}\t(min ${r.min})\t${r.fgKey} on ${r.spec}`);
		}
	}
}
