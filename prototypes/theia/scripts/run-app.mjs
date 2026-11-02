#!/usr/bin/env node
// Starts the built browser-app backend, opens it in a dedicated headless
// Chrome through puppeteer-core, and reports start-up timings and memory.
// Optionally waits for a matrix probe result file and takes a screenshot.
//
//   node scripts/run-app.mjs --workspace <dir> --plugins <dir> --config-dir <dir>
//        [--port 3100] [--settle-ms 15000] [--screenshot <png>]
//        [--result <file> --timeout-ms 600000] [--out <metrics.json>] [--headful]
//        [--open <file relative to the workspace>]
//
// Environment passed to the backend (and so to the plugin host): the caller's
// environment plus THEIA_CONFIG_DIR=<config-dir>.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const protoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.AXIS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
	const opts = { port: 3100, settleMs: 15000, timeoutMs: 600000, headful: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) { throw new Error(`${a} needs a value`); }
			return argv[++i];
		};
		switch (a) {
			case '--workspace': opts.workspace = path.resolve(next()); break;
			case '--plugins': opts.plugins = path.resolve(next()); break;
			case '--config-dir': opts.configDir = path.resolve(next()); break;
			case '--port': opts.port = Number(next()); break;
			case '--settle-ms': opts.settleMs = Number(next()); break;
			case '--timeout-ms': opts.timeoutMs = Number(next()); break;
			case '--screenshot': opts.screenshot = path.resolve(next()); break;
			case '--result': opts.result = path.resolve(next()); break;
			case '--out': opts.out = path.resolve(next()); break;
			case '--open': opts.open = next(); break;
			case '--headful': opts.headful = true; break;
			default: throw new Error(`unknown argument: ${a}`);
		}
	}
	for (const k of ['workspace', 'plugins', 'configDir']) {
		if (!opts[k]) { throw new Error(`--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} is required`); }
	}
	if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) { throw new Error('bad --port'); }
	return opts;
}

// Sum of RSS (KiB) for a process and all of its descendants, from one ps snapshot.
function treeRss(rootPid) {
	const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' });
	const rows = out.trim().split('\n').map(l => {
		const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
		return m && { pid: +m[1], ppid: +m[2], rss: +m[3], comm: m[4] };
	}).filter(Boolean);
	const keep = new Set([rootPid]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const r of rows) {
			if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); grew = true; }
		}
	}
	const procs = rows.filter(r => keep.has(r.pid));
	return { totalKiB: procs.reduce((s, r) => s + r.rss, 0), processes: procs.map(r => ({ pid: r.pid, rssKiB: r.rss, comm: path.basename(r.comm) })) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	fs.mkdirSync(opts.configDir, { recursive: true });
	const metrics = { workspace: opts.workspace, plugins: opts.plugins, startedAt: new Date().toISOString() };

	const t0 = performance.now();
	const backend = spawn(process.execPath, [
		path.join(protoDir, 'browser-app/lib/backend/main.js'), opts.workspace,
		'--hostname=127.0.0.1', `--port=${opts.port}`, `--plugins=local-dir:${opts.plugins}`
	], { cwd: path.join(protoDir, 'browser-app'), env: { ...process.env, THEIA_CONFIG_DIR: opts.configDir }, stdio: ['ignore', 'pipe', 'pipe'] });
	const logPath = opts.out ? opts.out.replace(/\.json$/, '') + '.backend.log' : null;
	const log = logPath ? fs.createWriteStream(logPath) : null;
	let listening;
	const listeningP = new Promise((resolve, reject) => {
		const onData = chunk => {
			log?.write(chunk);
			if (!listening && /listening on/i.test(String(chunk))) { listening = performance.now(); resolve(); }
		};
		backend.stdout.on('data', onData);
		backend.stderr.on('data', onData);
		backend.on('exit', code => reject(new Error(`backend exited early with code ${code}`)));
	});

	let browser;
	try {
		await Promise.race([listeningP, sleep(60000).then(() => { throw new Error('backend did not listen within 60 s'); })]);
		metrics.backendListeningMs = Math.round(listening - t0);

		const userDataDir = fs.mkdtempSync(path.join(path.dirname(opts.configDir), 'chrome-'));
		browser = await puppeteer.launch({
			executablePath: CHROME, headless: !opts.headful, userDataDir,
			defaultViewport: { width: 1440, height: 900 },
			args: ['--no-first-run', '--no-default-browser-check', '--window-size=1440,900']
		});
		const page = await browser.newPage();
		const consoleErrors = [];
		page.on('console', m => { if (m.type() === 'error') { consoleErrors.push(m.text().slice(0, 300)); } });
		const tNav = performance.now();
		await page.goto(`http://127.0.0.1:${opts.port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
		// Theia removes the .theia-preload overlay once the shell is attached and the layout is restored.
		await page.waitForFunction(() => !document.querySelector('.theia-preload') && !!document.querySelector('#theia-app-shell'), { timeout: 120000, polling: 50 });
		const tReady = performance.now();
		metrics.navigationToShellReadyMs = Math.round(tReady - tNav);
		metrics.spawnToShellReadyMs = Math.round(tReady - t0);

		if (opts.open) {
			// Quick open (Cmd/Ctrl+P), type the relative path, Enter.
			const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
			await page.keyboard.down(mod);
			await page.keyboard.press('KeyP');
			await page.keyboard.up(mod);
			await page.waitForSelector('.quick-input-widget input', { visible: true, timeout: 10000 });
			await page.keyboard.type(opts.open, { delay: 20 });
			await sleep(1500);
			await page.keyboard.press('Enter');
			await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
			metrics.openedFile = opts.open;
		}

		if (opts.result) {
			const deadline = Date.now() + opts.timeoutMs;
			let status = 'missing';
			while (Date.now() < deadline) {
				if (fs.existsSync(opts.result)) {
					try { status = JSON.parse(fs.readFileSync(opts.result, 'utf8')).status; } catch { status = 'unreadable'; }
					if (status && status !== 'running') { break; }
				}
				await sleep(1000);
			}
			metrics.probeStatus = Date.now() >= deadline ? `timeout (${status})` : status;
		} else {
			await sleep(opts.settleMs);
		}

		metrics.backendTree = treeRss(backend.pid);
		const chromeTree = treeRss(browser.process().pid);
		metrics.chromeTreeTotalKiB = chromeTree.totalKiB;
		const pm = await page.metrics();
		metrics.pageJsHeapUsedMiB = Math.round(pm.JSHeapUsedSize / 1048576);
		metrics.pageJsHeapTotalMiB = Math.round(pm.JSHeapTotalSize / 1048576);
		metrics.consoleErrors = consoleErrors.slice(0, 50);
		metrics.consoleErrorCount = consoleErrors.length;
		if (opts.screenshot) {
			await page.screenshot({ path: opts.screenshot });
			metrics.screenshot = opts.screenshot;
		}
	} finally {
		if (browser) { await browser.close().catch(() => {}); }
		backend.kill('SIGTERM');
		await sleep(1000);
		if (backend.exitCode === null) { backend.kill('SIGKILL'); }
		log?.end();
	}
	const text = JSON.stringify(metrics, null, 2) + '\n';
	if (opts.out) { fs.writeFileSync(opts.out, text); }
	process.stdout.write(text);
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
