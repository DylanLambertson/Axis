#!/usr/bin/env node
// Feature-checklist smoke test for the Theia prototype (ADR 0002 criterion 1).
// Starts the built backend on a scratch copy of the TypeScript matrix fixture
// (made a Git repository with one modified file), drives headless Chrome with
// the keyboard and prints one JSON line per step. Screenshots go to <shots-dir>.
//
//   node scripts/smoke.mjs <work-dir> <shots-dir> [--plugins <dir>] [--port 3130]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const protoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(protoDir, '../..');
const CHROME = process.env.AXIS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const [workDir, shotsDir] = args;
if (!workDir || !shotsDir) { throw new Error('usage: smoke.mjs <work-dir> <shots-dir> [--plugins <dir>] [--port <p>]'); }
const opt = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
const plugins = path.resolve(opt('--plugins') || path.join(protoDir, 'plugins'));
const port = Number(opt('--port') || 3130);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { throw new Error('bad --port'); }

// Workspace: TypeScript fixture, committed, then one file changed.
const work = path.resolve(workDir);
fs.rmSync(work, { recursive: true, force: true });
const ws = path.join(work, 'workspace');
fs.mkdirSync(ws, { recursive: true });
fs.cpSync(path.join(repoDir, 'test/extension-matrix/fixtures/typescript'), ws, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', ws, '-c', 'user.name=Axis Smoke', '-c', 'user.email=smoke@example.invalid',
	'-c', 'commit.gpgsign=false', ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'Add fixture');
fs.appendFileSync(path.join(ws, 'src/math.ts'), '// changed for the SCM check\n');
fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
function report(step, status, detail) {
	const row = { step, status, detail };
	results.push(row);
	process.stdout.write(JSON.stringify(row) + '\n');
}

const backend = spawn(process.execPath, [path.join(protoDir, 'browser-app/lib/backend/main.js'), ws,
	'--hostname=127.0.0.1', `--port=${port}`, `--plugins=local-dir:${plugins}`],
	{ cwd: path.join(protoDir, 'browser-app'), env: { ...process.env, THEIA_CONFIG_DIR: path.join(work, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
const backendLog = fs.createWriteStream(path.join(work, 'backend.log'));
backend.stdout.pipe(backendLog);
backend.stderr.pipe(backendLog);

let browser;
try {
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('backend did not listen in 60 s')), 60000);
		const on = c => { if (/listening on/i.test(String(c))) { clearTimeout(t); resolve(); } };
		backend.stdout.on('data', on);
		backend.stderr.on('data', on);
	});
	browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: fs.mkdtempSync(path.join(work, 'chrome-')),
		defaultViewport: { width: 1440, height: 900 }, args: ['--no-first-run', '--no-default-browser-check'] });
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => !document.querySelector('.theia-preload') && !!document.querySelector('#theia-app-shell'), { timeout: 120000 });
	const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : null; }, sel);
	const shot = name => page.screenshot({ path: path.join(shotsDir, `smoke-${name}.png`) });
	const step = async (name, fn) => {
		try { const [status, detail] = await fn(); report(name, status, detail); } catch (e) { report(name, 'failed', String(e && e.message || e).slice(0, 300)); }
		await shot(name).catch(() => {});
	};
	// Runs a command from the palette (F1). Picks the row whose label is exactly `label`.
	const runCommand = async label => {
		await page.keyboard.press('Escape');
		await page.keyboard.press('F1');
		await page.waitForSelector('.quick-input-widget .quick-input-box input', { visible: true, timeout: 10000 });
		await page.keyboard.type(label, { delay: 10 });
		await sleep(800);
		const labels = await page.$$eval('.quick-input-list .monaco-list-row', rows => rows.map(r => (r.getAttribute('aria-label') || r.innerText).split(/[,\n]/)[0].trim()));
		const idx = labels.findIndex(l => l === label);
		if (idx < 0) { await page.keyboard.press('Escape'); throw new Error(`no palette entry '${label}'; saw ${JSON.stringify(labels.slice(0, 5))}`); }
		for (let i = 0; i < idx; i++) { await page.keyboard.press('ArrowDown'); }
		await page.keyboard.press('Enter');
	};

	await step('shell: Axis top bar and theme', async () => {
		const bar = await text('#axis-top-bar');
		const bg = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--theia-editor-background').trim());
		return [bar && bar.includes('Agents: idle') && /^#111214/i.test(bg) ? 'works' : 'failed', `top bar: ${JSON.stringify(bar)}; --theia-editor-background ${bg}`];
	});
	await step('command palette (F1)', async () => {
		await page.keyboard.press('F1');
		await page.waitForSelector('.quick-input-widget .quick-input-box input', { visible: true, timeout: 10000 });
		await page.keyboard.type('Toggle Bottom Panel', { delay: 10 });
		await sleep(600);
		const first = await text('.quick-input-list .monaco-list-row');
		await page.keyboard.press('Escape');
		return [first ? 'works' : 'failed', `first entry: ${JSON.stringify(first)}`];
	});
	await step('explorer', async () => {
		await runCommand('File Explorer: Toggle Explorer View').catch(() => runCommand('View: Toggle Explorer'));
		await sleep(1000);
		const t = await text('#files');
		return [t && t.includes('src') && t.includes('debug.js') ? 'works' : 'failed', JSON.stringify((t || '').slice(0, 160))];
	});
	await step('editor: open, edit, save', async () => {
		await page.keyboard.press('Escape');
		await page.keyboard.down(MOD); await page.keyboard.press('KeyP'); await page.keyboard.up(MOD);
		await page.waitForSelector('.quick-input-widget .quick-input-box input', { visible: true, timeout: 10000 });
		await page.keyboard.type('main.ts', { delay: 20 });
		await sleep(1200);
		await page.keyboard.press('Enter');
		await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
		await sleep(800);
		await page.click('.monaco-editor .view-lines');
		await page.keyboard.down(MOD); await page.keyboard.press('ArrowDown'); await page.keyboard.up(MOD);
		await page.keyboard.press('Enter');
		await page.keyboard.type('// axis-smoke-edit', { delay: 5 });
		await page.keyboard.down(MOD); await page.keyboard.press('KeyS'); await page.keyboard.up(MOD);
		await sleep(1500);
		const onDisk = fs.readFileSync(path.join(ws, 'src/main.ts'), 'utf8');
		return [onDisk.includes('axis-smoke-edit') ? 'works' : 'failed', `saved to disk: ${onDisk.includes('axis-smoke-edit')}`];
	});
	await step('diagnostics: problems in status bar', async () => {
		let s = '';
		for (let i = 0; i < 40; i++) {
			s = (await text('#theia-statusBar')) || '';
			const m = await page.$('#theia-statusBar .codicon-error');
			if (m && /[1-9]/.test(await page.evaluate(e => e.parentElement.innerText, m))) { break; }
			await sleep(1000);
		}
		return [/[1-9]/.test(s) ? 'works' : 'failed', `status bar: ${JSON.stringify(s.replace(/\s+/g, ' ').slice(0, 200))}`];
	});
	await step('search (Find in Files)', async () => {
		await runCommand('Search: Find in Files').catch(() => runCommand('Find in Files'));
		await sleep(800);
		await page.keyboard.type('add', { delay: 20 });
		await page.keyboard.press('Enter');
		await sleep(3000);
		const t = (await text('#search-in-workspace')) || '';
		return [/\d+ results? in \d+ files?/i.test(t) ? 'works' : 'failed', JSON.stringify(t.replace(/\s+/g, ' ').slice(0, 200))];
	});
	await step('terminal: real shell', async () => {
		const marker = path.join(work, 'terminal-marker.txt');
		await runCommand('Terminal: Create New Terminal');
		await page.waitForSelector('.terminal-container .xterm', { timeout: 20000 });
		await sleep(2500);
		await page.click('.terminal-container .xterm');
		await page.keyboard.type(`echo hi-$((40+2)) > '${marker}'`, { delay: 5 });
		await page.keyboard.press('Enter');
		for (let i = 0; i < 20 && !fs.existsSync(marker); i++) { await sleep(500); }
		const out = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null;
		return [out === 'hi-42' ? 'works' : 'failed', `shell wrote ${JSON.stringify(out)}`];
	});
	await step('SCM / Git', async () => {
		await runCommand('Source Control: Toggle Source Control View').catch(() => runCommand('View: Toggle Source Control'));
		let t = '';
		for (let i = 0; i < 20; i++) {
			t = (await text('#scm-view-container')) || (await text('.theia-scm')) || '';
			if (t.includes('math.ts')) { break; }
			await sleep(1000);
		}
		return [t.includes('math.ts') ? 'works' : 'failed', JSON.stringify(t.replace(/\s+/g, ' ').slice(0, 200))];
	});
	await step('debug view', async () => {
		await runCommand('View: Toggle Debug');
		await sleep(1500);
		const t = (await text('#debug')) || (await text('.theia-debug-container')) || '';
		return [t ? 'renders' : 'failed', JSON.stringify(t.replace(/\s+/g, ' ').slice(0, 200))];
	});
	await step('extensions view (Open VSX)', async () => {
		await runCommand('Extensions: Toggle Extensions View').catch(() => runCommand('View: Toggle Extensions'));
		await sleep(3000);
		const t = (await text('#vsx-extensions-view-container')) || '';
		return [/installed/i.test(t) ? 'works' : 'failed', JSON.stringify(t.replace(/\s+/g, ' ').slice(0, 200))];
	});
	await step('Axis AI panel toggle', async () => {
		await runCommand('Axis: Toggle AI Panel');
		await sleep(1000);
		const t = await text('#axis-ai-panel');
		return [t && t.includes('Composer') ? 'works' : 'failed', JSON.stringify(t)];
	});
} finally {
	if (browser) { await browser.close().catch(() => {}); }
	backend.kill('SIGTERM');
	await sleep(1000);
	if (backend.exitCode === null) { backend.kill('SIGKILL'); }
	fs.writeFileSync(path.join(work, 'smoke.json'), JSON.stringify(results, null, 2) + '\n');
}
