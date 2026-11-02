'use strict';

// Tests for scan-report.js: attribution of log findings to extensions (review
// B2) and the positive control for proposed-API restriction (review B1).
// Run with: node --test 'test/extension-matrix/tests/*.test.js'

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scan = require('../scan-report');

const SCRIPT = path.join(__dirname, '..', 'scan-report.js');

const PYTHON_STRIPPED = "2026-11-02 10:00:00.000 [error] Extension 'ms-python.python CANNOT USE these API proposals 'contribEditorContentMenu, testObserver'. You MUST start in extension development mode or use the --enable-proposed-api command line flag";
const ENVS_STRIPPED = "2026-11-02 10:00:00.001 [error] Extension 'ms-python.vscode-python-envs CANNOT USE these API proposals 'terminalShellEnv'. You MUST start in extension development mode or use the --enable-proposed-api command line flag";
const YAML_DEPENDENCY = "2026-11-02 10:00:01.000 [error] Cannot activate the 'YAML' extension because it depends on unknown extension 'x.missing'";
const PRETTIER_FAILED = '2026-11-02 10:00:02.000 [error] Activating extension esbenp.prettier-vscode failed due to an error:';

function makeExtensionsDir(root) {
	const dir = path.join(root, 'extensions');
	const add = (folder, manifest, nls) => {
		fs.mkdirSync(path.join(dir, folder), { recursive: true });
		fs.writeFileSync(path.join(dir, folder, 'package.json'), JSON.stringify(manifest));
		if (nls) {
			fs.writeFileSync(path.join(dir, folder, 'package.nls.json'), JSON.stringify(nls));
		}
	};
	add('ms-python.python-2026.4.0', { publisher: 'ms-python', name: 'python', version: '2026.4.0', displayName: 'Python', enabledApiProposals: ['contribEditorContentMenu', 'testObserver'] });
	add('ms-python.vscode-python-envs-1.40.0', { publisher: 'ms-python', name: 'vscode-python-envs', version: '1.40.0', displayName: 'Python Environments', enabledApiProposals: ['terminalShellEnv'] });
	add('redhat.vscode-yaml-2.0.0', { publisher: 'redhat', name: 'vscode-yaml', version: '2.0.0', displayName: '%displayName%' }, { displayName: 'YAML' });
	add('esbenp.prettier-vscode-12.4.0', { publisher: 'esbenp', name: 'prettier-vscode', version: '12.4.0', displayName: 'Prettier - Code formatter' });
	fs.writeFileSync(path.join(dir, 'extensions.json'), '[]');
	return dir;
}

function withTemp(fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-scan-'));
	try {
		return fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function findings(lines) {
	return scan.parseLogText(lines.join('\n'), 'window1/renderer.log');
}

test('parseLogText recognizes the four Code OSS message formats', () => {
	const parsed = findings([PYTHON_STRIPPED, YAML_DEPENDENCY, PRETTIER_FAILED, 'unrelated line',
		"Cannot activate the 'Python Debugger' extension because its dependency 'Python' failed to activate"]);
	assert.deepEqual(parsed.map(f => [f.kind, f.subject]), [
		['proposals-stripped', 'ms-python.python'],
		['unknown-dependency', 'YAML'],
		['activation-failed', 'esbenp.prettier-vscode'],
		['dependency-failed', 'Python Debugger'],
	]);
	assert.equal(parsed[0].detail, 'contribEditorContentMenu, testObserver');
});

test('readInstalled resolves ids and localized display names', () => withTemp(root => {
	const installed = scan.readInstalled(makeExtensionsDir(root));
	assert.deepEqual(installed.map(e => [e.id, e.displayName]), [
		['esbenp.prettier-vscode', 'Prettier - Code formatter'],
		['ms-python.python', 'Python'],
		['ms-python.vscode-python-envs', 'Python Environments'],
		['redhat.vscode-yaml', 'YAML'],
	]);
}));

test('B2: a scenario only reports findings that name its own extensions', () => withTemp(root => {
	const installed = scan.readInstalled(makeExtensionsDir(root));
	const logged = findings([PYTHON_STRIPPED, ENVS_STRIPPED, YAML_DEPENDENCY]);

	const prettier = scan.analyse(logged, installed, ['esbenp.prettier-vscode']);
	assert.equal(prettier.status, 'clean');
	assert.equal(prettier.allFindings.length, 3, 'the full extract keeps every line');

	const yaml = scan.analyse(logged, installed, ['redhat.vscode-yaml']);
	assert.equal(yaml.status, 'findings');
	assert.deepEqual(yaml.relevantFindings.map(f => f.kind), ['unknown-dependency']);

	const python = scan.analyse(logged, installed, ['MS-Python.Python']);
	assert.equal(python.status, 'findings', 'ids compare case-insensitively');
}));

test('B1: without any CANNOT USE line the result is inconclusive, never clean', () => withTemp(root => {
	const installed = scan.readInstalled(makeExtensionsDir(root));
	const report = scan.analyse(findings([]), installed, ['esbenp.prettier-vscode']);
	assert.equal(report.status, 'inconclusive');
	assert.equal(report.control.state, 'not-restricted');
	assert.deepEqual(report.control.missing, ['ms-python.python', 'ms-python.vscode-python-envs']);
}));

test('B1: a partial positive control is also inconclusive', () => withTemp(root => {
	const installed = scan.readInstalled(makeExtensionsDir(root));
	const report = scan.analyse(findings([PYTHON_STRIPPED]), installed, ['esbenp.prettier-vscode']);
	assert.equal(report.status, 'inconclusive');
	assert.equal(report.control.state, 'partial');
	assert.deepEqual(report.control.missing, ['ms-python.vscode-python-envs']);
}));

test('B1: with no extension that declares proposals there is no control', () => {
	const installed = [{ id: 'esbenp.prettier-vscode', version: '12.4.0', displayName: 'Prettier', enabledApiProposals: [] }];
	const report = scan.analyse(findings([]), installed, ['esbenp.prettier-vscode']);
	assert.equal(report.control.state, 'no-control');
	assert.equal(report.status, 'inconclusive');
});

test('full-set scan produces the per-extension proposed-API table', () => withTemp(root => {
	const installed = scan.readInstalled(makeExtensionsDir(root));
	const report = scan.analyse(findings([PYTHON_STRIPPED, ENVS_STRIPPED, PRETTIER_FAILED]), installed, null);
	assert.equal(report.status, 'complete');
	const python = report.extensions.find(e => e.id === 'ms-python.python');
	assert.deepEqual(python.strippedProposals, ['contribEditorContentMenu', 'testObserver']);
	const tsv = scan.toTsv(report).trim().split('\n');
	assert.equal(tsv[0], 'extension\tversion\tdeclared\tstripped\tactivation_errors');
	assert.ok(tsv.includes('esbenp.prettier-vscode\t12.4.0\t0\t-\t1'));
	assert.ok(tsv.includes('ms-python.python\t2026.4.0\t2\tcontribEditorContentMenu,testObserver\t0'));
}));

test('unattributable findings are kept but do not change the scenario status', () => withTemp(root => {
	const installed = scan.readInstalled(makeExtensionsDir(root));
	const logged = findings([PYTHON_STRIPPED, ENVS_STRIPPED, "Cannot activate the 'Unknown Thing' extension because it depends on unknown extension 'a.b'"]);
	const report = scan.analyse(logged, installed, ['esbenp.prettier-vscode']);
	assert.equal(report.status, 'clean');
	assert.equal(report.unattributed.length, 1);
}));

function runCli(args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('CLI writes the artifacts and prints the status word', () => withTemp(root => {
	const extDir = makeExtensionsDir(root);
	const logs = path.join(root, 'logs', '20261102T100000', 'window1');
	fs.mkdirSync(logs, { recursive: true });
	fs.writeFileSync(path.join(logs, 'renderer.log'), [PYTHON_STRIPPED, ENVS_STRIPPED, YAML_DEPENDENCY].join('\n'));
	const scenarioFile = path.join(root, 'scenario.json');
	fs.writeFileSync(scenarioFile, JSON.stringify({ id: 'S13-yaml', extensions: ['redhat.vscode-yaml'] }));
	const out = path.join(root, 'out');

	const result = runCli(['--logs', path.join(root, 'logs'), '--extensions-dir', extDir, '--scenario-file', scenarioFile, '--out', out]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), 'findings');
	assert.equal(fs.readFileSync(path.join(out, 'activation-scan-full.txt'), 'utf8').trim().split('\n').length, 3);
	assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'activation-scan.json'), 'utf8')).control.state, 'verified');
	assert.ok(fs.existsSync(path.join(out, 'proposed-api.tsv')));
}));

test('CLI reports no-logs, and error (exit 2) on unreadable manifests', () => withTemp(root => {
	const extDir = makeExtensionsDir(root);
	const empty = runCli(['--logs', path.join(root, 'missing'), '--extensions-dir', extDir, '--out', path.join(root, 'o1')]);
	assert.equal(empty.stdout.trim(), 'no-logs');

	fs.mkdirSync(path.join(root, 'logs'));
	fs.writeFileSync(path.join(root, 'logs', 'main.log'), PYTHON_STRIPPED);
	fs.writeFileSync(path.join(extDir, 'esbenp.prettier-vscode-12.4.0', 'package.json'), '{ not json');
	const broken = runCli(['--logs', path.join(root, 'logs'), '--extensions-dir', extDir, '--out', path.join(root, 'o2')]);
	assert.equal(broken.status, 2);
	assert.equal(broken.stdout.trim(), 'error');

	const badArgs = runCli(['--logs']);
	assert.equal(badArgs.status, 2);
}));
