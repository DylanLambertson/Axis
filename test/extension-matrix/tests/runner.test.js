'use strict';

// Exercises probe/runner.js run() against a minimal in-memory stand-in for the
// 'vscode' module. This covers scenario loading, check dispatch, result
// writing and failure reporting. It says nothing about real extension
// behaviour, which needs an Axis build.
// Run with: node --test test/extension-matrix/tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function createFakeVscode(state) {
	class Position {
		constructor(line, character) {
			this.line = line;
			this.character = character;
		}
	}
	const workspaceUri = { path: '/ws', fsPath: '/ws' };
	return {
		version: '1.144.0',
		Position,
		DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
		UIKind: { Desktop: 1, Web: 2 },
		ExtensionKind: { UI: 1, Workspace: 2 },
		env: { appName: 'Fake Axis', uiKind: 1, remoteName: undefined },
		Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
		workspace: {
			workspaceFolders: [{ uri: workspaceUri }],
			openTextDocument: async uri => ({
				uri,
				lineAt: line => ({ text: state.files[uri.path].split('\n')[line] }),
			}),
		},
		window: { showTextDocument: async () => undefined },
		languages: { getDiagnostics: uri => state.diagnostics[uri.path] || [] },
		commands: {
			executeCommand: async (id, uri, position) => {
				state.commandCalls.push({ id, path: uri.path, position });
				return state.hovers[uri.path] || [];
			},
		},
		extensions: {
			getExtension: id => state.extensions[id],
		},
	};
}

function loadRunnerWith(fake) {
	const runnerPath = require.resolve('../probe/runner');
	delete require.cache[runnerPath];
	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'vscode') {
			return fake;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		return require(runnerPath);
	} finally {
		Module._load = originalLoad;
	}
}

function baseState() {
	const ext = { isActive: false, packageJSON: { version: '1.2.3', enabledApiProposals: ['testObserver'] }, extensionKind: 2 };
	ext.activate = async () => {
		ext.isActive = true;
	};
	return {
		files: { '/ws/src/main.ts': "import { add } from './math';\n\nconst total: number = add(1, 2);\nconst wrong: number = 'x';\n" },
		diagnostics: {
			'/ws/src/main.ts': [{ severity: 0, source: 'ts', code: 2322, message: "Type 'string' is not assignable", range: { start: { line: 3 } } }],
		},
		hovers: { '/ws/src/main.ts': [{ contents: [{ value: 'function add(a: number, b: number): number' }] }] },
		extensions: { 'pub.ext': ext },
		commandCalls: [],
	};
}

function complete(scenario) {
	return { fixture: 'typescript', requires: [], setup: [], settings: {}, extensions: [], disableExtensions: [], ...scenario };
}

function withScenario(scenario, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-runner-'));
	const scenarioFile = path.join(dir, 'scenario.json');
	const resultFile = path.join(dir, 'result.json');
	fs.writeFileSync(scenarioFile, JSON.stringify(complete(scenario)));
	const saved = { s: process.env.AXIS_MATRIX_SCENARIO_FILE, r: process.env.AXIS_MATRIX_RESULT };
	process.env.AXIS_MATRIX_SCENARIO_FILE = scenarioFile;
	process.env.AXIS_MATRIX_RESULT = resultFile;
	return Promise.resolve(fn(resultFile)).finally(() => {
		for (const [key, value] of [['AXIS_MATRIX_SCENARIO_FILE', saved.s], ['AXIS_MATRIX_RESULT', saved.r]]) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
}

test('run() passes and writes a result when every check succeeds', async () => {
	const state = baseState();
	const runner = loadRunnerWith(createFakeVscode(state));
	const scenario = {
		id: 'S90-fake-pass',
		extensions: ['pub.ext', 'missing.ext'],
		checks: [
			{ type: 'activate', extension: 'pub.ext' },
			{ type: 'diagnostics', file: 'src/main.ts', line: 3, severity: 'error', sourceAnyOf: ['ts'], timeoutMs: 200 },
			{ type: 'hover', file: 'src/main.ts', at: { line: 2, token: 'add' }, contains: 'add(a: number, b: number): number', timeoutMs: 200 },
		],
	};
	await withScenario(scenario, async resultFile => {
		await runner.run();
		const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
		assert.equal(result.status, 'passed');
		assert.deepEqual(result.checks.map(c => c.status), ['passed', 'passed', 'passed']);
		assert.equal(result.host.uiKind, 'desktop');
		assert.equal(result.proposedApiMayBeForcedOn, true);
		assert.deepEqual(result.extensions[0], {
			id: 'pub.ext', installed: true, version: '1.2.3', active: true, extensionKind: 'workspace', declaredApiProposals: ['testObserver'],
		});
		assert.deepEqual(result.extensions[1], { id: 'missing.ext', installed: false });
		const { line, character } = state.commandCalls[0].position;
		assert.deepEqual({ line, character }, { line: 2, character: 23 });
	});
});

test('run() records failures, writes the result and rejects', async () => {
	const runner = loadRunnerWith(createFakeVscode(baseState()));
	const scenario = {
		id: 'S91-fake-fail',
		checks: [
			{ type: 'activate', extension: 'not.installed' },
			{ type: 'diagnostics', file: 'src/main.ts', line: 0, timeoutMs: 50 },
		],
	};
	await withScenario(scenario, async resultFile => {
		await assert.rejects(runner.run(), /2 of 2 checks failed in S91-fake-fail/);
		const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
		assert.equal(result.status, 'failed');
		assert.match(result.checks[0].detail, /not installed or is disabled/);
		assert.match(result.checks[1].detail, /timed out after 50 ms/);
	});
});

test('run() rejects an invalid scenario file before running any check', async () => {
	const state = baseState();
	const runner = loadRunnerWith(createFakeVscode(state));
	await withScenario({ id: 'S92-bad', checks: [{ type: 'hover', file: '/etc/passwd' }] }, async resultFile => {
		await assert.rejects(runner.run(), /invalid scenario file/);
		assert.equal(fs.existsSync(resultFile), false);
		assert.equal(state.commandCalls.length, 0);
	});
});
