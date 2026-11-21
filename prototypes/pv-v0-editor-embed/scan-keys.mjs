// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Lists every default keybinding at the pin (desktop workbench main, or web with --web; plus the built-in extensions'
// package.json keybindings) that can fire while focus is in the side-panel editor and is not an editor command, and
// probes whether its command reads the editor part's active editor directly (or delegates, so it may). The probe
// cannot see a command that reaches the active editor through another service, so every candidate, whatever its
// verdict, must be classified by hand in the policy; only extension-host commands are accepted as a class.
// A handler that never returns is recorded as 'hung' and the scan continues in a fresh page.
// With --check, exits non-zero when a candidate is missing from AXIS_SIDE_PANEL_COMMAND_POLICY (the gate to re-run on
// every upstream sync). Usage: node scan-keys.mjs [--web] [--json file] [--check]
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env, www } from './env.mjs';
import { startServer } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)(env.playwrightCore());
const server = await startServer(www, env.port);
const browser = await chromium.launch({ executablePath: env.chromium() });

async function freshPage() {
	const page = await browser.newPage();
	page.on('dialog', dialog => dialog.dismiss());
	await page.goto(`http://127.0.0.1:${env.port}/scan.html${process.argv.includes('--web') ? '?main=web' : ''}`);
	await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
	return page;
}

let page = await freshPage();
const total = await page.evaluate(() => window.total);
const extensionKeys = await page.evaluate(() => window.extensionKeyCount);
const loadErrors = await page.evaluate(() => window.errs);
const count = await page.evaluate(() => window.count);
const rows = [];
for (let i = 0; i < count; i++) {
	const row = await page.evaluate(n => window.describe(n), i);
	const timeout = new Promise(done => setTimeout(() => done(undefined), 5000));
	const result = await Promise.race([page.evaluate(n => window.probe(n), i), timeout]).catch(() => undefined);
	if (result === undefined) {
		rows.push({ ...row, verdict: 'hung', reads: [], threw: '' });
		await page.close().catch(() => undefined);
		page = await freshPage();
	} else {
		rows.push({ ...row, ...result });
	}
}
await browser.close();
server.close();

const counts = {};
for (const row of rows) {
	counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
}
if (loadErrors.length) {
	console.log('load errors:', loadErrors.map(e => e.split('\n')[0]));
}
console.log(`default keybindings: ${total}, extension package.json keybindings: ${extensionKeys}; candidates: ${rows.length}`, counts);
for (const row of rows) {
	console.log(`${row.verdict.padEnd(20)} ${String(row.keys).padEnd(26)} ${row.command}  ${row.source === 'core' ? '' : row.source} ${row.reads.join(' ')}`);
}
const at = process.argv.indexOf('--json');
if (at > 0) {
	writeFileSync(process.argv[at + 1], JSON.stringify(rows, null, '\t'));
}
if (process.argv.includes('--check')) {
	const { unclassifiedCommands } = await import(pathToFileURL(join(www, 'vs/axis/contrib/sidePanel/common/axisSidePanelEditor.js')).href);
	const candidates = rows.filter(r => r.verdict !== 'extension-host').map(r => r.command);
	const missing = unclassifiedCommands(candidates);
	console.log(missing.length ? `UNCLASSIFIED (${missing.length}): ${missing.join(', ')}` : `policy covers all ${new Set(candidates).size} candidate commands`);
	process.exit(missing.length ? 1 : 0);
}
