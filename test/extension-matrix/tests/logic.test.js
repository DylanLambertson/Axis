'use strict';

// Unit tests for probe/logic.js. Run with: node --test test/extension-matrix/tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../probe/logic');

const SEVERITIES = { error: 0, warning: 1, information: 2, hint: 3 };

function diagnostic(overrides) {
	return { severity: 0, source: 'ts', code: 2322, message: 'Type mismatch', range: { start: { line: 3 } }, ...overrides };
}

test('tokenColumn points inside the first occurrence of the token', () => {
	assert.equal(logic.tokenColumn('const total: number = add(1, 2);', 'add'), 23);
	assert.equal(logic.tokenColumn('\ttotal := add(1, 2)', 'add'), 11);
	assert.equal(logic.tokenColumn('name: axis', 'name'), 2);
	assert.equal(logic.tokenColumn('nothing here', 'add'), -1);
});

test('pathEndsWith matches on a path-segment boundary and normalizes backslashes', () => {
	assert.ok(logic.pathEndsWith('/tmp/ws/src/math.ts', 'src/math.ts'));
	assert.ok(logic.pathEndsWith('C:\\ws\\src\\math.ts', 'src/math.ts'));
	assert.ok(!logic.pathEndsWith('/tmp/ws/src/xmath.ts', 'math.ts'));
	assert.ok(!logic.pathEndsWith('/tmp/ws/math.ts.bak', 'math.ts'));
});

test('hoverText joins strings and MarkdownString values and ignores unknown parts', () => {
	const hovers = [
		{ contents: ['plain', { value: '```ts\nfunction add(a: number, b: number): number\n```' }] },
		{ contents: [{ language: 'ts' }, null] },
	];
	const text = logic.hoverText(hovers);
	assert.ok(text.includes('plain'));
	assert.ok(text.includes('add(a: number, b: number): number'));
	assert.equal(logic.hoverText(undefined), '');
});

test('diagnosticCode handles missing, scalar and object codes', () => {
	assert.equal(logic.diagnosticCode({}), '');
	assert.equal(logic.diagnosticCode({ code: 2322 }), '2322');
	assert.equal(logic.diagnosticCode({ code: { value: 'no-unused-vars', target: {} } }), 'no-unused-vars');
});

test('matchesDiagnostic applies every filter that is present', () => {
	const d = diagnostic({ source: 'eslint', code: { value: 'prefer-const' }, range: { start: { line: 0 } } });
	assert.ok(logic.matchesDiagnostic(d, { line: 0, sourceAnyOf: ['eslint'], codeAnyOf: ['no-unused-vars', 'prefer-const'] }, SEVERITIES));
	assert.ok(!logic.matchesDiagnostic(d, { line: 1 }, SEVERITIES));
	assert.ok(!logic.matchesDiagnostic(d, { severity: 'warning' }, SEVERITIES));
	assert.ok(!logic.matchesDiagnostic(d, { sourceAnyOf: ['ts'] }, SEVERITIES));
	assert.ok(!logic.matchesDiagnostic(d, { messageContains: 'Incorrect type' }, SEVERITIES));
	assert.ok(logic.matchesDiagnostic(diagnostic(), {}, SEVERITIES));
});

test('findExpectedLocation accepts Location and LocationLink results', () => {
	const location = { uri: { path: '/ws/math.hpp' }, range: { start: { line: 3 } } };
	const link = {
		targetUri: { path: '/ws/math.cpp' },
		targetRange: { start: { line: 1 } },
		targetSelectionRange: { start: { line: 2 } },
	};
	const expect = [{ file: 'math.cpp', line: 2 }];
	assert.equal(logic.findExpectedLocation([location, link], expect).hit.uri.path, '/ws/math.cpp');
	assert.equal(logic.findExpectedLocation([location], expect).hit, undefined);
	assert.equal(logic.findExpectedLocation([location], expect).seen, '/ws/math.hpp:3');
	assert.equal(logic.findExpectedLocation(undefined, expect).seen, 'none');
});

test('frameMatches converts 1-based DAP lines to 0-based scenario lines', () => {
	const frame = { line: 3, source: { path: '/ws/debug.js' } };
	assert.ok(logic.frameMatches(frame, 'debug.js', 2));
	assert.ok(!logic.frameMatches(frame, 'debug.js', 3));
	assert.ok(!logic.frameMatches({ line: 3, source: {} }, 'debug.js', 2));
	assert.ok(!logic.frameMatches(undefined, 'debug.js', 2));
});

test('normalizeText folds CRLF line endings', () => {
	assert.equal(logic.normalizeText('a\r\nb\n'), 'a\nb\n');
});

test('poll returns the first ok result and survives thrown errors', async () => {
	let calls = 0;
	const result = await logic.poll(async () => {
		calls++;
		if (calls === 1) {
			throw new Error('not started');
		}
		return calls >= 3 ? logic.ok('ready') : logic.fail('waiting');
	}, 1000, 'readiness', 1);
	assert.deepEqual(result, { ok: true, detail: 'ready' });
	assert.equal(calls, 3);
});

test('poll reports the last detail on timeout', async () => {
	const result = await logic.poll(() => logic.fail('still waiting'), 20, 'nothing', 5);
	assert.equal(result.ok, false);
	assert.match(result.detail, /timed out after 20 ms waiting for nothing; last: still waiting/);
});

test('withTimeout rejects slow promises and passes fast ones through', async () => {
	assert.equal(await logic.withTimeout(Promise.resolve(7), 50, 'fast'), 7);
	await assert.rejects(logic.withTimeout(new Promise(() => {}), 10, 'slow'), /timed out after 10 ms: slow/);
});

test('timeoutOf and describeCheck', () => {
	assert.equal(logic.timeoutOf({}), logic.DEFAULT_TIMEOUT_MS);
	assert.equal(logic.timeoutOf({ timeoutMs: 5 }), 5);
	assert.equal(logic.describeCheck({ type: 'activate', extension: 'a.b' }), 'activate a.b');
	assert.equal(logic.describeCheck({ type: 'gitRepositories', min: 1 }), 'gitRepositories');
});

test('overallStatus requires at least one check and all passed', () => {
	assert.equal(logic.overallStatus([]), 'failed');
	assert.equal(logic.overallStatus([{ status: 'passed' }]), 'passed');
	assert.equal(logic.overallStatus([{ status: 'passed' }, { status: 'failed' }]), 'failed');
});

function scenarioWith(overrides) {
	return {
		id: 'S99-ok',
		fixture: 'yaml',
		requires: [],
		setup: [],
		settings: {},
		extensions: ['a.b'],
		disableExtensions: [],
		checks: [{ type: 'activate', extension: 'a.b' }],
		...overrides,
	};
}

test('validateScenario accepts a complete scenario', () => {
	assert.deepEqual(logic.validateScenario(scenarioWith({})), []);
	assert.deepEqual(logic.validateScenario(null), ['scenario is not an object']);
});

test('validateScenario rejects malformed checks', () => {
	const problems = logic.validateScenario(scenarioWith({
		id: 'bad id',
		checks: [
			{ type: 'nope' },
			{ type: 'hover', file: '../escape.ts', at: { line: 1 }, contains: 'x' },
			{ type: 'breakpoint', launch: 'x', file: 'a.js', line: '2' },
			{ type: 'activate', extension: 'a.b', timeoutMs: -1 },
		],
	}));
	assert.equal(problems.length, 6, problems.join('\n'));
	assert.ok(problems.some(p => p.includes('invalid scenario id')));
	assert.ok(problems.some(p => p.includes('unknown type')));
	assert.ok(problems.some(p => p.includes('path must stay inside the workspace')));
	assert.ok(problems.some(p => p.includes('at needs a numeric line and a token')));
	assert.ok(problems.some(p => p.includes('line must be number')));
	assert.ok(problems.some(p => p.includes('timeoutMs must be a positive integer')));
});

test('validateScenario rejects missing or unsafe top-level fields', () => {
	const cases = [
		[{ fixture: '../etc' }, 'fixture must match'],
		[{ fixture: undefined }, 'fixture must match'],
		[{ requires: undefined }, 'requires must be'],
		[{ requires: ['go; rm -rf /'] }, 'requires must be'],
		[{ setup: ['curl | sh'] }, 'setup must be'],
		[{ settings: [] }, 'settings must be an object'],
		[{ extensions: ['not an id'] }, 'extensions must be'],
		[{ disableExtensions: undefined }, 'disableExtensions must be'],
	];
	for (const [overrides, message] of cases) {
		const problems = logic.validateScenario(scenarioWith(overrides));
		assert.equal(problems.length, 1, `${JSON.stringify(overrides)}: ${problems.join('; ')}`);
		assert.ok(problems[0].includes(message), problems[0]);
	}
});
