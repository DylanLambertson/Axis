'use strict';

// Drives run.sh with a stand-in app (a shell script that writes log files the
// way a normal window would) to test the scan guard (review B1), the scenario
// attribution (review B2), the full-set proposed-API scan and the tier
// selection. Needs bash and jq.
// Run with: node --test 'test/extension-matrix/tests/*.test.js'

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MATRIX = path.join(__dirname, '..');
const RUN_SH = path.join(MATRIX, 'run.sh');

const PYTHON_STRIPPED = "[error] Extension 'ms-python.python CANNOT USE these API proposals 'testObserver'. You MUST start in extension development mode";
const THEME_FAILED = '[error] Activating extension GitHub.github-vscode-theme failed due to an error:';

// Stand-in app. Test-host runs (AXIS_MATRIX_RESULT set) write a passing
// result; normal windows write FAKE_LOG_LINES into <logsPath>/w1/renderer.log
// and record their arguments.
const FAKE_APP = `#!/usr/bin/env bash
set -euo pipefail
logs=""
for arg in "$@"; do
	if [[ "$prev" == "--logsPath" ]]; then logs="$arg"; fi
	prev="$arg"
done
if [[ -n "\${AXIS_MATRIX_RESULT:-}" ]]; then
	printf '{"status":"passed","checks":[{"status":"passed","check":"fake","detail":"stub"}]}\\n' >"$AXIS_MATRIX_RESULT"
	exit 0
fi
mkdir -p "$logs/w1"
printf '%s\\n' "$@" >"$logs/../args.txt"
printf '%b' "\${FAKE_LOG_LINES:-}" >"$logs/w1/renderer.log"
exit 0
`.replace('set -euo pipefail\nlogs=""', 'set -euo pipefail\nprev=""\nlogs=""');

function setup(root) {
	const bin = path.join(root, 'bin');
	fs.mkdirSync(bin);
	const app = path.join(bin, 'axis');
	fs.writeFileSync(app, FAKE_APP, { mode: 0o755 });
	const devDir = path.join(root, 'checkout', 'scripts');
	fs.mkdirSync(devDir, { recursive: true });
	const devLauncher = path.join(devDir, 'code.sh');
	fs.writeFileSync(devLauncher, FAKE_APP, { mode: 0o755 });

	const extDir = path.join(root, 'extensions');
	const add = (folder, manifest) => {
		fs.mkdirSync(path.join(extDir, folder), { recursive: true });
		fs.writeFileSync(path.join(extDir, folder, 'package.json'), JSON.stringify(manifest));
	};
	add('ms-python.python-2026.4.0', { publisher: 'ms-python', name: 'python', version: '2026.4.0', enabledApiProposals: ['testObserver'] });
	add('github.github-vscode-theme-6.3.5', { publisher: 'GitHub', name: 'github-vscode-theme', version: '6.3.5' });
	return { app, devLauncher, extDir, work: path.join(root, 'work') };
}

function run(env, args) {
	const result = spawnSync('bash', [RUN_SH, ...args], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env },
	});
	return { ...result, output: result.stdout + result.stderr };
}

function withSetup(fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-runsh-'));
	try {
		return fn(setup(root));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function summary(work) {
	const runs = path.join(work, 'runs');
	const [latest] = fs.readdirSync(runs).sort().reverse();
	return fs.readFileSync(path.join(runs, latest, 'summary.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
}

test('B1: scans refuse a development build', () => withSetup(s => {
	const viaEnv = run({ AXIS_APP: s.app, VSCODE_DEV: '1', MATRIX_WORK_DIR: s.work }, ['--scenario', 'S11-theme', '--extensions-dir', s.extDir, '--activation-scan', '1']);
	assert.equal(viaEnv.status, 1);
	assert.match(viaEnv.output, /VSCODE_DEV is set/);

	const viaLauncher = run({ AXIS_APP: s.devLauncher, MATRIX_WORK_DIR: s.work }, ['--proposed-api-scan', '1', '--extensions-dir', s.extDir]);
	assert.equal(viaLauncher.status, 1);
	assert.match(viaLauncher.output, /not the dev launcher/);

	// Without a scan the dev launcher is accepted (test hosts allow proposals anyway).
	const probeOnly = run({ AXIS_APP: s.devLauncher, MATRIX_WORK_DIR: s.work }, ['--scenario', 'S11-theme', '--extensions-dir', s.extDir]);
	assert.equal(probeOnly.status, 0, probeOnly.output);
}));

test('B2: Python stripping does not mark an unrelated scenario', () => withSetup(s => {
	const result = run({ AXIS_APP: s.app, MATRIX_WORK_DIR: s.work, FAKE_LOG_LINES: `${PYTHON_STRIPPED}\\n` },
		['--scenario', 'S11-theme', '--extensions-dir', s.extDir, '--activation-scan', '2']);
	assert.equal(result.status, 0, result.output);
	assert.deepEqual(summary(s.work)[0].slice(0, 3), ['S11-theme', 'passed', 'activation-scan: clean']);
}));

test('B2: a finding naming the scenario extension is reported', () => withSetup(s => {
	const result = run({ AXIS_APP: s.app, MATRIX_WORK_DIR: s.work, FAKE_LOG_LINES: `${PYTHON_STRIPPED}\\n${THEME_FAILED}\\n` },
		['--scenario', 'S11-theme', '--extensions-dir', s.extDir, '--activation-scan', '2']);
	assert.equal(result.status, 0, result.output);
	assert.equal(summary(s.work)[0][2], 'activation-scan: findings');
}));

test('B1: no restriction in the logs gives inconclusive, not clean', () => withSetup(s => {
	run({ AXIS_APP: s.app, MATRIX_WORK_DIR: s.work, FAKE_LOG_LINES: '' },
		['--scenario', 'S11-theme', '--extensions-dir', s.extDir, '--activation-scan', '2']);
	assert.equal(summary(s.work)[0][2], 'activation-scan: inconclusive');
}));

test('activation scan opens the checked fixture files', () => withSetup(s => {
	run({ AXIS_APP: s.app, MATRIX_WORK_DIR: s.work, FAKE_LOG_LINES: `${PYTHON_STRIPPED}\\n` },
		['--scenario', 'S13-yaml', '--extensions-dir', s.extDir, '--activation-scan', '2']);
	const scenarioDir = summary(s.work)[0][3];
	const args = fs.readFileSync(path.join(scenarioDir, 'scan', 'args.txt'), 'utf8').split('\n');
	assert.ok(args.includes(path.join(scenarioDir, 'workspace', 'service.yaml')), args.join(' '));
}));

test('proposed-API scan writes the per-extension table', () => withSetup(s => {
	const result = run({ AXIS_APP: s.app, MATRIX_WORK_DIR: s.work, FAKE_LOG_LINES: `${PYTHON_STRIPPED}\\n` },
		['--proposed-api-scan', '2', '--extensions-dir', s.extDir]);
	assert.equal(result.status, 0, result.output);
	const [row] = summary(s.work);
	assert.deepEqual(row.slice(0, 2), ['proposed-api-scan', 'complete']);
	const tsv = fs.readFileSync(path.join(row[3], 'proposed-api.tsv'), 'utf8');
	assert.match(tsv, /^ms-python\.python\t2026\.4\.0\t1\ttestObserver\t0$/m);
}));

test('run.sh rejects a scenario with an unsafe fixture before copying anything', () => withSetup(s => {
	const scenarios = JSON.parse(fs.readFileSync(path.join(MATRIX, 'scenarios.json'), 'utf8'));
	scenarios.scenarios = scenarios.scenarios.filter(x => x.id === 'S11-theme').map(x => ({ ...x, fixture: '../../..' }));
	const file = path.join(path.dirname(s.work), 'scenarios.json');
	fs.writeFileSync(file, JSON.stringify(scenarios));
	const result = run({ AXIS_APP: s.app, MATRIX_WORK_DIR: s.work, MATRIX_SCENARIOS: file }, ['--scenario', 'S11-theme', '--extensions-dir', s.extDir]);
	assert.equal(result.status, 1);
	assert.match(result.output, /error/);
	assert.equal(summary(s.work)[0][1], 'error');
}));

test('the optional tier installs the core extensions its scenarios use', () => {
	const scenarios = JSON.parse(fs.readFileSync(path.join(MATRIX, 'scenarios.json'), 'utf8')).scenarios;
	const manifest = JSON.parse(fs.readFileSync(path.join(MATRIX, 'extensions.json'), 'utf8'));
	const builtins = new Set([...manifest.builtins.map(b => b.id), 'vscode.git']);
	for (const tier of ['core', 'optional']) {
		const listed = spawnSync('bash', ['-c', `source "${path.join(MATRIX, 'lib.sh')}" && select_artifacts linux-x64 ${tier} | cut -f1`], { encoding: 'utf8' });
		assert.equal(listed.status, 0, listed.stderr);
		const selected = new Set(listed.stdout.trim().split('\n'));
		for (const scenario of scenarios.filter(x => x.tier === tier)) {
			for (const id of scenario.extensions.filter(e => !builtins.has(e))) {
				assert.ok(selected.has(id), `${scenario.id} needs ${id}, which --tier ${tier} does not install`);
			}
		}
	}
});
