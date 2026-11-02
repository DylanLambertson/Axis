'use strict';

// Pure helpers for the extension matrix probe. Nothing here imports 'vscode',
// so these functions can be unit-tested with plain Node (tests/*.test.js).

const DEFAULT_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 500;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function ok(detail) {
	return { ok: true, detail };
}

function fail(detail) {
	return { ok: false, detail };
}

function errorText(err) {
	return err && err.stack ? err.stack : String(err);
}

async function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// Calls fn until it returns { ok: true } or the timeout expires. Errors thrown
// by fn count as "not yet" so that providers which are still starting can be
// retried.
async function poll(fn, ms, label, intervalMs = POLL_INTERVAL_MS) {
	const deadline = Date.now() + ms;
	let last = fail('no attempt completed');
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last && last.ok) {
				return last;
			}
		} catch (err) {
			last = fail(`error: ${err && err.message ? err.message : String(err)}`);
		}
		await sleep(intervalMs);
	}
	return fail(`timed out after ${ms} ms waiting for ${label}; last: ${last ? last.detail : 'none'}`);
}

function timeoutOf(check) {
	return typeof check.timeoutMs === 'number' ? check.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function normalizePath(p) {
	return p.replace(/\\/g, '/');
}

// True when an absolute path ends with the given workspace-relative path,
// on a path-segment boundary.
function pathEndsWith(absolutePath, relativePath) {
	return normalizePath(absolutePath).endsWith('/' + relativePath);
}

// Column inside the first occurrence of token on a line, or -1 if absent.
function tokenColumn(lineText, token) {
	const index = lineText.indexOf(token);
	return index < 0 ? -1 : index + Math.floor(token.length / 2);
}

function hoverText(hovers) {
	const parts = [];
	for (const hover of hovers || []) {
		for (const content of hover.contents || []) {
			if (typeof content === 'string') {
				parts.push(content);
			} else if (content && typeof content.value === 'string') {
				parts.push(content.value);
			}
		}
	}
	return parts.join('\n');
}

function diagnosticCode(diagnostic) {
	const code = diagnostic.code;
	if (code === undefined || code === null) {
		return '';
	}
	return typeof code === 'object' ? String(code.value) : String(code);
}

function describeDiagnostic(d) {
	return `[${d.source || '?'}:${diagnosticCode(d)}] line ${d.range.start.line}: ${d.message.split('\n')[0]}`;
}

// severities maps scenario names ("error", ...) to vscode.DiagnosticSeverity.
function matchesDiagnostic(d, check, severities) {
	return (!check.severity || d.severity === severities[check.severity]) &&
		(check.line === undefined || d.range.start.line === check.line) &&
		(!check.sourceAnyOf || check.sourceAnyOf.includes(d.source)) &&
		(!check.codeAnyOf || check.codeAnyOf.includes(diagnosticCode(d))) &&
		(!check.messageContains || d.message.includes(check.messageContains));
}

function normalizeText(text) {
	return text.replace(/\r\n/g, '\n');
}

// Accepts vscode.Location or vscode.LocationLink results.
function normalizeLocation(result) {
	return {
		uri: result.targetUri || result.uri,
		range: result.targetSelectionRange || result.targetRange || result.range,
	};
}

function findExpectedLocation(results, expectAnyOf) {
	const locations = (results || []).map(normalizeLocation);
	const hit = locations.find(l => expectAnyOf.some(e => pathEndsWith(l.uri.path, e.file) && l.range.start.line === e.line));
	const seen = locations.map(l => `${l.uri.path}:${l.range.start.line}`).join(', ') || 'none';
	return { hit, seen };
}

// DAP stack frames use 1-based lines for the VS Code client; scenario lines
// are 0-based.
function frameMatches(frame, file, line) {
	const sourcePath = frame && frame.source && frame.source.path ? normalizePath(frame.source.path) : '';
	return Boolean(frame) && frame.line - 1 === line && pathEndsWith(sourcePath, file);
}

function describeCheck(check) {
	const target = check.extension || check.file || check.command || check.value || '';
	return `${check.type}${target ? ' ' + target : ''}`;
}

function overallStatus(checkResults) {
	return checkResults.length > 0 && checkResults.every(c => c.status === 'passed') ? 'passed' : 'failed';
}

// Required fields per check type. Used to reject malformed scenario files
// before anything is launched.
const CHECK_FIELDS = {
	activate: { extension: 'string' },
	diagnostics: { file: 'string' },
	hover: { file: 'string', at: 'object', contains: 'string' },
	definition: { file: 'string', at: 'object', expectAnyOf: 'array' },
	format: { file: 'string', expectFile: 'string' },
	breakpoint: { launch: 'string', file: 'string', line: 'number' },
	theme: { value: 'string', expectKind: 'string' },
	commandsRegistered: { commands: 'array' },
	command: { command: 'string' },
	gitRepositories: { min: 'number' },
	openNotebook: { file: 'string', expectNotebookType: 'string' },
};

function typeOf(value) {
	return Array.isArray(value) ? 'array' : typeof value;
}

// Returns a list of problems; an empty list means the scenario is usable.
function validateScenario(scenario) {
	const problems = [];
	if (!scenario || typeof scenario !== 'object') {
		return ['scenario is not an object'];
	}
	if (typeof scenario.id !== 'string' || !/^S\d{2}-[a-z0-9-]+$/.test(scenario.id)) {
		problems.push(`invalid scenario id: ${JSON.stringify(scenario.id)}`);
	}
	if (!Array.isArray(scenario.checks) || scenario.checks.length === 0) {
		problems.push(`${scenario.id}: checks must be a non-empty array`);
		return problems;
	}
	scenario.checks.forEach((check, i) => {
		const fields = CHECK_FIELDS[check && check.type];
		if (!fields) {
			problems.push(`${scenario.id} check ${i}: unknown type ${JSON.stringify(check && check.type)}`);
			return;
		}
		for (const [name, type] of Object.entries(fields)) {
			if (typeOf(check[name]) !== type) {
				problems.push(`${scenario.id} check ${i} (${check.type}): ${name} must be ${type}`);
			}
		}
		if (check.at && (typeof check.at.line !== 'number' || typeof check.at.token !== 'string' || check.at.token === '')) {
			problems.push(`${scenario.id} check ${i} (${check.type}): at needs a numeric line and a token`);
		}
		for (const relative of [check.file, check.expectFile, ...(check.expectAnyOf || []).map(e => e && e.file)]) {
			if (relative !== undefined && (typeof relative !== 'string' || relative.startsWith('/') || relative.split('/').includes('..'))) {
				problems.push(`${scenario.id} check ${i} (${check.type}): path must stay inside the workspace: ${JSON.stringify(relative)}`);
			}
		}
		if (check.timeoutMs !== undefined && !(Number.isInteger(check.timeoutMs) && check.timeoutMs > 0)) {
			problems.push(`${scenario.id} check ${i} (${check.type}): timeoutMs must be a positive integer`);
		}
	});
	return problems;
}

module.exports = {
	DEFAULT_TIMEOUT_MS,
	CHECK_FIELDS,
	sleep,
	ok,
	fail,
	errorText,
	withTimeout,
	poll,
	timeoutOf,
	normalizePath,
	pathEndsWith,
	tokenColumn,
	hoverText,
	diagnosticCode,
	describeDiagnostic,
	matchesDiagnostic,
	normalizeText,
	normalizeLocation,
	findExpectedLocation,
	frameMatches,
	describeCheck,
	overallStatus,
	validateScenario,
};
