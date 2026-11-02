'use strict';

// Extension compatibility probe. The extension host loads this module through
// --extensionTestsPath and calls run(). It reads one scenario (written by
// run.sh), runs its checks against the real extensions installed in the
// --extensions-dir, writes a JSON result and rejects if any check failed.
//
// Environment:
//   AXIS_MATRIX_SCENARIO_FILE  path to the scenario JSON (required)
//   AXIS_MATRIX_RESULT         path for the result JSON (required)

const fs = require('fs');
const vscode = require('vscode');

const DEFAULT_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 500;

const SEVERITY = {
	error: vscode.DiagnosticSeverity.Error,
	warning: vscode.DiagnosticSeverity.Warning,
	information: vscode.DiagnosticSeverity.Information,
	hint: vscode.DiagnosticSeverity.Hint,
};

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
async function poll(fn, ms, label) {
	const deadline = Date.now() + ms;
	let last = fail('no attempt completed');
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last.ok) {
				return last;
			}
		} catch (err) {
			last = fail(`error: ${err && err.message ? err.message : String(err)}`);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return fail(`timed out after ${ms} ms waiting for ${label}; last: ${last.detail}`);
}

function timeoutOf(check) {
	return typeof check.timeoutMs === 'number' ? check.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function workspaceFolder() {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new Error('no workspace folder is open');
	}
	return folders[0];
}

function fileUri(relativePath) {
	return vscode.Uri.joinPath(workspaceFolder().uri, ...relativePath.split('/'));
}

function normalizePath(p) {
	return p.replace(/\\/g, '/');
}

function sameFile(uri, relativePath) {
	return normalizePath(uri.path).endsWith('/' + relativePath);
}

async function openEditor(relativePath) {
	const document = await vscode.workspace.openTextDocument(fileUri(relativePath));
	await vscode.window.showTextDocument(document, { preview: false });
	return document;
}

async function readFixtureText(relativePath) {
	const bytes = await vscode.workspace.fs.readFile(fileUri(relativePath));
	return Buffer.from(bytes).toString('utf8');
}

function positionOf(document, at) {
	const text = document.lineAt(at.line).text;
	const index = text.indexOf(at.token);
	if (index < 0) {
		throw new Error(`token '${at.token}' not found on line ${at.line} of ${document.uri.path}`);
	}
	return new vscode.Position(at.line, index + Math.floor(at.token.length / 2));
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

function normalizeText(text) {
	return text.replace(/\r\n/g, '\n');
}

const CHECKS = {
	async activate(check) {
		const extension = vscode.extensions.getExtension(check.extension);
		if (!extension) {
			return fail(`${check.extension} is not installed or is disabled`);
		}
		await withTimeout(Promise.resolve(extension.activate()), timeoutOf(check), `activation of ${check.extension}`);
		return extension.isActive
			? ok(`active (version ${extension.packageJSON.version})`)
			: fail('activate() resolved but isActive is false');
	},

	async diagnostics(check) {
		const document = await openEditor(check.file);
		const minCount = typeof check.minCount === 'number' ? check.minCount : 1;
		return poll(() => {
			const all = vscode.languages.getDiagnostics(document.uri);
			const matching = all.filter(d =>
				(!check.severity || d.severity === SEVERITY[check.severity]) &&
				(check.line === undefined || d.range.start.line === check.line) &&
				(!check.sourceAnyOf || check.sourceAnyOf.includes(d.source)) &&
				(!check.codeAnyOf || check.codeAnyOf.includes(diagnosticCode(d))) &&
				(!check.messageContains || d.message.includes(check.messageContains)));
			const summary = all.slice(0, 5).map(describeDiagnostic).join(' | ') || 'none';
			return matching.length >= minCount
				? ok(`${matching.length} matching of ${all.length}: ${matching.slice(0, 3).map(describeDiagnostic).join(' | ')}`)
				: fail(`${matching.length} matching of ${all.length}; diagnostics: ${summary}`);
		}, timeoutOf(check), `diagnostics in ${check.file}`);
	},

	async hover(check) {
		const document = await openEditor(check.file);
		const position = positionOf(document, check.at);
		return poll(async () => {
			const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position);
			const text = hoverText(hovers);
			return text.includes(check.contains)
				? ok(`hover contains '${check.contains}'`)
				: fail(`hover text: ${JSON.stringify(text.slice(0, 200))}`);
		}, timeoutOf(check), `hover in ${check.file}`);
	},

	async definition(check) {
		const document = await openEditor(check.file);
		const position = positionOf(document, check.at);
		return poll(async () => {
			const results = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
			const locations = (results || []).map(r => ({
				uri: r.targetUri || r.uri,
				range: r.targetSelectionRange || r.targetRange || r.range,
			}));
			const hit = locations.find(l => check.expectAnyOf.some(e => sameFile(l.uri, e.file) && l.range.start.line === e.line));
			const seen = locations.map(l => `${l.uri.path}:${l.range.start.line}`).join(', ') || 'none';
			return hit ? ok(`definition at ${hit.uri.path}:${hit.range.start.line}`) : fail(`definitions: ${seen}`);
		}, timeoutOf(check), `definition in ${check.file}`);
	},

	async format(check) {
		const document = await openEditor(check.file);
		const expected = normalizeText(await readFixtureText(check.expectFile));
		try {
			await vscode.commands.executeCommand('editor.action.formatDocument');
			return await poll(() => normalizeText(document.getText()) === expected
				? ok(`${check.file} matches ${check.expectFile}`)
				: fail(`text after format: ${JSON.stringify(document.getText().slice(0, 200))}`),
			timeoutOf(check), `formatting of ${check.file}`);
		} finally {
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		}
	},

	async breakpoint(check) {
		const uri = fileUri(check.file);
		const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(check.line, 0)), true);
		const stopped = [];
		const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker(session) {
				return {
					onDidSendMessage(message) {
						if (message && message.type === 'event' && message.event === 'stopped') {
							stopped.push({ session, body: message.body || {} });
						}
					},
				};
			},
		});
		vscode.debug.addBreakpoints([breakpoint]);
		try {
			const started = await vscode.debug.startDebugging(workspaceFolder(), check.launch);
			if (!started) {
				return fail(`startDebugging('${check.launch}') returned false`);
			}
			return await poll(async () => {
				if (stopped.length === 0) {
					return fail('no stopped event yet');
				}
				const event = stopped[stopped.length - 1];
				const trace = await event.session.customRequest('stackTrace', { threadId: event.body.threadId, startFrame: 0, levels: 1 });
				const top = trace && trace.stackFrames && trace.stackFrames[0];
				const sourcePath = top && top.source && top.source.path ? normalizePath(top.source.path) : '';
				// DAP lines are 1-based for the VS Code client.
				if (top && top.line - 1 === check.line && sourcePath.endsWith('/' + check.file)) {
					return ok(`stopped (${event.body.reason}) at ${check.file}:${top.line} in ${event.session.type}`);
				}
				return fail(`stopped (${event.body.reason}) at ${sourcePath || '?'}:${top ? top.line : '?'}`);
			}, timeoutOf(check), `a stop at ${check.file}:${check.line + 1}`);
		} finally {
			tracker.dispose();
			vscode.debug.removeBreakpoints([breakpoint]);
			if (vscode.debug.activeDebugSession) {
				await vscode.debug.stopDebugging();
			}
		}
	},

	async theme(check) {
		const expectedKind = vscode.ColorThemeKind[check.expectKind];
		if (expectedKind === undefined) {
			throw new Error(`unknown ColorThemeKind '${check.expectKind}'`);
		}
		await vscode.workspace.getConfiguration('workbench').update('colorTheme', check.value, vscode.ConfigurationTarget.Global);
		return poll(() => {
			const kind = vscode.window.activeColorTheme.kind;
			return kind === expectedKind
				? ok(`'${check.value}' applied (kind ${check.expectKind})`)
				: fail(`active theme kind is ${vscode.ColorThemeKind[kind]}`);
		}, timeoutOf(check), `theme '${check.value}'`);
	},

	async commandsRegistered(check) {
		return poll(async () => {
			const commands = new Set(await vscode.commands.getCommands(true));
			const missing = check.commands.filter(c => !commands.has(c));
			return missing.length === 0 ? ok(`${check.commands.length} commands registered`) : fail(`missing: ${missing.join(', ')}`);
		}, timeoutOf(check), 'command registration');
	},

	async command(check) {
		await withTimeout(Promise.resolve(vscode.commands.executeCommand(check.command, ...(check.args || []))), timeoutOf(check), check.command);
		return ok(`${check.command} executed without error`);
	},

	async gitRepositories(check) {
		const git = vscode.extensions.getExtension('vscode.git');
		if (!git) {
			return fail('built-in vscode.git is not available');
		}
		const api = (await git.activate()).getAPI(1);
		return poll(() => api.repositories.length >= check.min
			? ok(`${api.repositories.length} repositories open`)
			: fail(`${api.repositories.length} repositories open`),
		timeoutOf(check), 'git repositories');
	},

	async openNotebook(check) {
		const notebook = await vscode.workspace.openNotebookDocument(fileUri(check.file));
		await vscode.window.showNotebookDocument(notebook);
		return notebook.notebookType === check.expectNotebookType
			? ok(`opened as ${notebook.notebookType}`)
			: fail(`opened as ${notebook.notebookType}`);
	},
};

function describeCheck(check) {
	const target = check.extension || check.file || check.command || check.value || '';
	return `${check.type}${target ? ' ' + target : ''}`;
}

function extensionReport(ids) {
	return ids.map(id => {
		const extension = vscode.extensions.getExtension(id);
		if (!extension) {
			return { id, installed: false };
		}
		return {
			id,
			installed: true,
			version: extension.packageJSON.version,
			active: extension.isActive,
			extensionKind: extension.extensionKind === vscode.ExtensionKind.UI ? 'ui' : 'workspace',
			declaredApiProposals: extension.packageJSON.enabledApiProposals || [],
		};
	});
}

function requiredEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`environment variable ${name} is not set`);
	}
	return value;
}

exports.run = async function run() {
	const scenario = JSON.parse(fs.readFileSync(requiredEnv('AXIS_MATRIX_SCENARIO_FILE'), 'utf8'));
	const resultPath = requiredEnv('AXIS_MATRIX_RESULT');
	if (!scenario || !Array.isArray(scenario.checks)) {
		throw new Error('scenario file has no checks array');
	}

	const result = {
		scenario: scenario.id,
		startedAt: new Date().toISOString(),
		host: {
			appName: vscode.env.appName,
			version: vscode.version,
			uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
			remoteName: vscode.env.remoteName || null,
			platform: process.platform,
			arch: process.arch,
		},
		// Extension test hosts allow proposed API for every extension unless the
		// product quality is "stable", so these results may hide proposed-API
		// gaps. run.sh --activation-scan covers that in a normal window.
		proposedApiMayBeForcedOn: true,
		checks: [],
	};

	for (const check of scenario.checks) {
		const started = Date.now();
		let outcome;
		try {
			const handler = CHECKS[check.type];
			outcome = handler ? await handler(check) : fail(`unknown check type '${check.type}'`);
		} catch (err) {
			outcome = fail(`error: ${errorText(err)}`);
		}
		result.checks.push({
			check: describeCheck(check),
			status: outcome.ok ? 'passed' : 'failed',
			detail: outcome.detail,
			durationMs: Date.now() - started,
		});
	}

	result.extensions = extensionReport(scenario.extensions || []);
	result.finishedAt = new Date().toISOString();
	const failed = result.checks.filter(c => c.status !== 'passed').length;
	result.status = failed === 0 ? 'passed' : 'failed';
	fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');

	if (failed > 0) {
		throw new Error(`${failed} of ${result.checks.length} checks failed in ${scenario.id}; see ${resultPath}`);
	}
};
