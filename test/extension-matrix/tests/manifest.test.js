'use strict';

// Consistency tests for extensions.json, scenarios.json and the fixtures.
// Run with: node --test test/extension-matrix/tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateScenario, tokenColumn } = require('../probe/logic');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(root, 'scenarios.json'), 'utf8'));
const scenarioIds = new Set(scenarios.scenarios.map(s => s.id));
const knownIds = new Set([
	...manifest.extensions.map(e => e.id.toLowerCase()),
	...manifest.builtins.map(b => b.id.toLowerCase()),
	'vscode.git',
]);

function fixtureLines(scenario, relative) {
	return fs.readFileSync(path.join(root, 'fixtures', scenario.fixture, relative), 'utf8').split('\n');
}

test('every pinned artifact is well formed', () => {
	for (const ext of manifest.extensions) {
		assert.match(ext.version, /^\d+\.\d+\.\d+$/, ext.id);
		assert.ok(['core', 'supporting', 'optional'].includes(ext.tier), ext.id);
		assert.ok(['open-vsx', 'vendor'].includes(ext.openVsx.publisherType), `${ext.id} publisherType`);
		assert.ok(ext.artifacts.length > 0, ext.id);
		for (const a of ext.artifacts) {
			assert.match(a.sha256, /^[0-9a-f]{64}$/, `${ext.id} ${a.platform}`);
			assert.match(a.url, /^https:\/\/(open-vsx\.org\/api\/|github\.com\/vadimcn\/codelldb\/releases\/download\/)/, a.url);
			assert.ok(['universal', ...manifest.platforms].includes(a.platform), `${ext.id} ${a.platform}`);
			if (a.source === 'open-vsx') {
				assert.ok(a.url.includes(`/${ext.version}/`), `${ext.id} url does not carry the pinned version`);
			}
		}
	}
});

test('every extension resolves an artifact for each Axis platform', () => {
	for (const ext of manifest.extensions) {
		for (const platform of manifest.platforms) {
			const found = ext.artifacts.some(a => a.platform === platform || a.platform === 'universal');
			assert.ok(found, `${ext.id} has no artifact for ${platform}`);
		}
	}
});

test('manifest and scenarios reference each other', () => {
	for (const ext of [...manifest.extensions, ...manifest.builtins]) {
		for (const id of ext.scenarios) {
			assert.ok(scenarioIds.has(id), `${ext.id} references unknown scenario ${id}`);
		}
	}
	for (const scenario of scenarios.scenarios) {
		for (const id of [...scenario.extensions, ...scenario.disableExtensions]) {
			assert.ok(knownIds.has(id.toLowerCase()), `${scenario.id} references unpinned extension ${id}`);
		}
	}
});

test('every scenario is valid and its fixture references resolve', () => {
	for (const scenario of scenarios.scenarios) {
		assert.deepEqual(validateScenario(scenario), [], scenario.id);
		assert.ok(fs.statSync(path.join(root, 'fixtures', scenario.fixture)).isDirectory(), scenario.id);
		for (const check of scenario.checks) {
			for (const rel of [check.file, check.expectFile].filter(Boolean)) {
				assert.ok(fs.existsSync(path.join(root, 'fixtures', scenario.fixture, rel)), `${scenario.id}: missing ${rel}`);
			}
			if (check.file && typeof check.line === 'number') {
				const lines = fixtureLines(scenario, check.file);
				assert.ok(lines[check.line] && lines[check.line].trim() !== '', `${scenario.id}: ${check.file}:${check.line} is empty`);
			}
			if (check.at) {
				const lines = fixtureLines(scenario, check.file);
				assert.ok(tokenColumn(lines[check.at.line] || '', check.at.token) >= 0, `${scenario.id}: token ${check.at.token} not on ${check.file}:${check.at.line}`);
			}
			for (const e of check.expectAnyOf || []) {
				const lines = fixtureLines(scenario, e.file);
				assert.ok(lines[e.line] && lines[e.line].trim() !== '', `${scenario.id}: ${e.file}:${e.line} is empty`);
			}
		}
	}
});

test('both Python language-server configurations are covered (decision D3)', () => {
	const byId = Object.fromEntries(scenarios.scenarios.map(s => [s.id, s]));
	assert.equal(byId['S02-python-default-ls'].settings['python.languageServer'], undefined);
	assert.ok(byId['S02-python-default-ls'].disableExtensions.includes('detachhead.basedpyright'));
	assert.equal(byId['S03-python-basedpyright'].settings['python.languageServer'], 'None');
});

test('only optional scenarios use optional extensions (decision D5)', () => {
	const optional = new Set(manifest.extensions.filter(e => e.tier === 'optional').map(e => e.id));
	for (const scenario of scenarios.scenarios) {
		if (scenario.extensions.some(id => optional.has(id))) {
			assert.equal(scenario.tier, 'optional', scenario.id);
		}
	}
});
