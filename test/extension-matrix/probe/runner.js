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
const {
	ok,
	fail,
	errorText,
	withTimeout,
	poll,
	timeoutOf,
	normalizePath,
	tokenColumn,
	hoverText,
	describeDiagnostic,
	matchesDiagnostic,
	normalizeText,
	findExpectedLocation,
	frameMatches,
	describeCheck,
	overallStatus,
	validateScenario,
} = require('./logic');

const SEVERITY = {
	error: vscode.DiagnosticSeverity.Error,
	warning: vscode.DiagnosticSeverity.Warning,
	information: vscode.DiagnosticSeverity.Information,
	hint: vscode.DiagnosticSeverity.Hint,
};

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
	const column = tokenColumn(document.lineAt(at.line).text, at.token);
	if (column < 0) {
		throw new Error(`token '${at.token}' not found on line ${at.line} of ${document.uri.path}`);
	}
	return new vscode.Position(at.line, column);
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
			const matching = all.filter(d => matchesDiagnostic(d, check, SEVERITY));
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
			const { hit, seen } = findExpectedLocation(results, check.expectAnyOf);
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
				if (frameMatches(top, check.file, check.line)) {
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
	const problems = validateScenario(scenario);
	if (problems.length > 0) {
		throw new Error(`invalid scenario file:\n${problems.join('\n')}`);
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

	// Written after every check so that a host timeout still leaves evidence.
	const writeResult = () => fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
	result.status = 'running';
	writeResult();

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
		writeResult();
	}

	result.extensions = extensionReport(scenario.extensions || []);
	result.finishedAt = new Date().toISOString();
	const failed = result.checks.filter(c => c.status !== 'passed').length;
	result.status = overallStatus(result.checks);
	writeResult();

	if (failed > 0) {
		throw new Error(`${failed} of ${result.checks.length} checks failed in ${scenario.id}; see ${resultPath}`);
	}
};
