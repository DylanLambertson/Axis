#!/usr/bin/env node
'use strict';

// Analyses the logs of a normal (non-development) Axis window for proposed-API
// stripping and extension activation errors, and attributes every finding to
// an installed extension. Called by run.sh (--activation-scan and
// --proposed-api-scan); the functions are exported for unit tests.
//
// Usage:
//   node scan-report.js --logs <dir> --extensions-dir <dir> --out <dir>
//                       [--scenario-file <scenario.json>]
//
// Prints one status word on stdout:
//   clean         restriction verified; no finding names the scenario's extensions
//   findings      restriction verified; at least one finding names them
//   complete      (no scenario) restriction verified; per-extension table written
//   inconclusive  the positive control failed: an installed extension that
//                 declares proposed APIs was not reported as restricted, so the
//                 window may not restrict proposed API at all
//   no-logs       the window wrote no log files
// Exits 2 (and prints "error") if logs or extension manifests cannot be read.

const fs = require('node:fs');
const path = require('node:path');

// Message formats at Code OSS 1.144.0:
//   extensionsProposedApi.ts:112        Extension '<id> CANNOT USE these API proposals '<a, b>'. ...
//   extHostExtensionActivator.ts:450    Activating extension <id> failed due to an error:
//   extHostExtensionActivator.ts:313    Cannot activate the '<name>' extension because it depends on unknown extension '<id>'
//   extHostExtensionActivator.ts:404    Cannot activate the '<name>' extension because its dependency '<name>' failed to activate
const PATTERNS = [
	{ kind: 'proposals-stripped', re: /Extension '([^'\s]+) CANNOT USE these API proposals '([^']*)'/, byName: false },
	{ kind: 'activation-failed', re: /Activating extension (\S+) failed due to an error/, byName: false },
	{ kind: 'unknown-dependency', re: /Cannot activate the '([^']+)' extension because it depends on unknown extension '([^']+)'/, byName: true },
	{ kind: 'dependency-failed', re: /Cannot activate the '([^']+)' extension because its dependency '([^']+)' failed to activate/, byName: true },
];

function listLogFiles(dir) {
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listLogFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.log')) {
			files.push(full);
		}
	}
	return files.sort();
}

// Returns one finding per matching log line.
function parseLogText(text, source) {
	const findings = [];
	for (const line of text.split(/\r?\n/)) {
		for (const pattern of PATTERNS) {
			const m = pattern.re.exec(line);
			if (m) {
				findings.push({
					kind: pattern.kind,
					subject: m[1],
					byName: pattern.byName,
					detail: m[2] || '',
					source,
					line: line.trim(),
				});
				break;
			}
		}
	}
	return findings;
}

function resolveDisplayName(dir, manifest) {
	const name = manifest.displayName;
	const placeholder = typeof name === 'string' && /^%(.+)%$/.exec(name);
	if (!placeholder) {
		return typeof name === 'string' ? name : undefined;
	}
	const nlsPath = path.join(dir, 'package.nls.json');
	if (!fs.existsSync(nlsPath)) {
		return undefined;
	}
	const nls = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));
	const value = nls[placeholder[1]];
	return typeof value === 'string' ? value : value && typeof value.message === 'string' ? value.message : undefined;
}

// Reads each installed extension's package.json (as data) from an extensions dir.
function readInstalled(extensionsDir) {
	const installed = [];
	for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = path.join(extensionsDir, entry.name);
		const manifestPath = path.join(dir, 'package.json');
		if (!fs.existsSync(manifestPath)) {
			continue;
		}
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		if (typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string') {
			throw new Error(`manifest without publisher/name: ${manifestPath}`);
		}
		installed.push({
			id: `${manifest.publisher}.${manifest.name}`.toLowerCase(),
			version: manifest.version,
			displayName: resolveDisplayName(dir, manifest),
			enabledApiProposals: Array.isArray(manifest.enabledApiProposals) ? manifest.enabledApiProposals : [],
		});
	}
	return installed.sort((a, b) => a.id.localeCompare(b.id));
}

// Adds extensionId (lower case) to each finding, or null when the subject
// matches no installed extension.
function attribute(findings, installed) {
	const ids = new Set(installed.map(e => e.id));
	const byName = new Map(installed.filter(e => e.displayName).map(e => [e.displayName, e.id]));
	return findings.map(f => {
		let extensionId = null;
		if (!f.byName && ids.has(f.subject.toLowerCase())) {
			extensionId = f.subject.toLowerCase();
		} else if (f.byName) {
			extensionId = byName.get(f.subject) || (ids.has(f.subject.toLowerCase()) ? f.subject.toLowerCase() : null);
		}
		return { ...f, extensionId };
	});
}

function splitProposals(detail) {
	return detail.split(',').map(p => p.trim()).filter(p => p && p !== '*');
}

// Positive control: every installed extension that declares proposed APIs
// must be reported as restricted. Otherwise restriction is not proven.
function positiveControl(findings, installed) {
	const expected = installed.filter(e => e.enabledApiProposals.length > 0).map(e => e.id);
	const restricted = new Set(findings.filter(f => f.kind === 'proposals-stripped' && f.extensionId).map(f => f.extensionId));
	const seen = expected.filter(id => restricted.has(id));
	const missing = expected.filter(id => !restricted.has(id));
	let state;
	if (expected.length === 0) {
		state = 'no-control';
	} else if (missing.length === 0) {
		state = 'verified';
	} else if (seen.length === 0) {
		state = 'not-restricted';
	} else {
		state = 'partial';
	}
	return { state, expected, seen, missing };
}

function perExtension(findings, installed) {
	return installed.map(e => {
		const own = findings.filter(f => f.extensionId === e.id);
		const stripped = [...new Set(own.filter(f => f.kind === 'proposals-stripped').flatMap(f => splitProposals(f.detail)))];
		return {
			id: e.id,
			version: e.version,
			declaredProposals: e.enabledApiProposals,
			strippedProposals: stripped,
			activationErrors: own.filter(f => f.kind !== 'proposals-stripped').map(f => f.line),
		};
	});
}

// scenarioExtensions: ids the scenario tests, or null for a full-set scan.
function analyse(findings, installed, scenarioExtensions) {
	const attributed = attribute(findings, installed);
	const control = positiveControl(attributed, installed);
	const scope = scenarioExtensions ? new Set(scenarioExtensions.map(id => id.toLowerCase())) : null;
	const relevant = scope ? attributed.filter(f => f.extensionId && scope.has(f.extensionId)) : attributed.filter(f => f.extensionId);
	let status;
	if (control.state !== 'verified') {
		status = 'inconclusive';
	} else if (!scope) {
		status = 'complete';
	} else {
		status = relevant.length > 0 ? 'findings' : 'clean';
	}
	return {
		status,
		control,
		scenarioExtensions: scope ? [...scope] : null,
		relevantFindings: relevant,
		unattributed: attributed.filter(f => !f.extensionId),
		extensions: perExtension(attributed, installed),
		allFindings: attributed,
	};
}

function toTsv(report) {
	const rows = [['extension', 'version', 'declared', 'stripped', 'activation_errors'].join('\t')];
	for (const e of report.extensions) {
		rows.push([e.id, e.version, e.declaredProposals.length, e.strippedProposals.join(',') || '-', e.activationErrors.length].join('\t'));
	}
	return rows.join('\n') + '\n';
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (!['--logs', '--extensions-dir', '--out', '--scenario-file'].includes(key) || value === undefined) {
			throw new Error(`bad argument: ${key}`);
		}
		args[key.slice(2)] = value;
	}
	for (const required of ['logs', 'extensions-dir', 'out']) {
		if (!args[required]) {
			throw new Error(`--${required} is required`);
		}
	}
	return args;
}

function main(argv) {
	const args = parseArgs(argv);
	fs.mkdirSync(args.out, { recursive: true });
	if (!fs.existsSync(args.logs) || listLogFiles(args.logs).length === 0) {
		fs.writeFileSync(path.join(args.out, 'activation-scan.json'), JSON.stringify({ status: 'no-logs' }, null, 2) + '\n');
		return 'no-logs';
	}
	const findings = [];
	for (const file of listLogFiles(args.logs)) {
		findings.push(...parseLogText(fs.readFileSync(file, 'utf8'), path.relative(args.logs, file)));
	}
	const installed = readInstalled(args['extensions-dir']);
	let scenarioExtensions = null;
	if (args['scenario-file']) {
		const scenario = JSON.parse(fs.readFileSync(args['scenario-file'], 'utf8'));
		if (!Array.isArray(scenario.extensions)) {
			throw new Error('scenario file has no extensions array');
		}
		scenarioExtensions = scenario.extensions;
	}
	const report = analyse(findings, installed, scenarioExtensions);
	fs.writeFileSync(path.join(args.out, 'activation-scan.json'), JSON.stringify(report, null, 2) + '\n');
	fs.writeFileSync(path.join(args.out, 'activation-scan-full.txt'), findings.map(f => `${f.source}: ${f.line}`).join('\n') + (findings.length ? '\n' : ''));
	fs.writeFileSync(path.join(args.out, 'proposed-api.tsv'), toTsv(report));
	return report.status;
}

module.exports = { PATTERNS, listLogFiles, parseLogText, readInstalled, attribute, positiveControl, perExtension, analyse, toTsv, parseArgs, main };

if (require.main === module) {
	try {
		process.stdout.write(main(process.argv.slice(2)) + '\n');
	} catch (err) {
		process.stderr.write(`scan-report: ${err && err.message ? err.message : String(err)}\n`);
		process.stdout.write('error\n');
		process.exit(2);
	}
}
