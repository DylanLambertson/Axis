/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
// Tests scripts/code-oss/check-artifacts.sh against fake artifact trees.
// Run with: node --test test/code-oss/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/code-oss/check-artifacts.sh');

const tempDirs = [];
test.after(() => {
	for (const dir of tempDirs) {
		// Restore permissions a test removed, so the directory can be deleted.
		spawnSync('chmod', ['-R', 'u+rwx', dir]);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix = 'axis-artifact-') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function artifact(files, dir = tempDir()) {
	fs.mkdirSync(dir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
	}
	return dir;
}

// Minimal asar archive: 16-byte pickle header followed by the JSON file table.
function asar(table) {
	const json = Buffer.from(JSON.stringify(table));
	const head = Buffer.alloc(16);
	head.writeUInt32LE(4, 0);
	head.writeUInt32LE(json.length + 8, 4);
	head.writeUInt32LE(json.length + 4, 8);
	head.writeUInt32LE(json.length, 12);
	return Buffer.concat([head, json]);
}

function run(...args) {
	return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

// A PATH with the system tools the script needs but no node.
function runWithoutNode(...args) {
	return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
}

const notices = { 'LICENSE.txt': 'MIT', 'ThirdPartyNotices.txt': 'notices', 'out/main.js': '' };
const copilotAsar = asar({ files: { '@github': { files: { 'copilot-sdk': { files: { 'index.js': { size: 0, offset: '0' } } } } } } });

test('passes a clean artifact, including plain strings that name a package', () => {
	const dir = artifact({ ...notices, 'out/main.js': 'const tags = ["@anthropic-ai/sdk", "@github/copilot-sdk"];' });
	const r = run('--notices', dir);
	assert.equal(r.status, 0, r.stderr);
});

test('fails on Copilot and agent SDK packages, entry points and imports', () => {
	const dir = artifact({
		...notices,
		'node_modules/@github/copilot-sdk/index.js': '',
		'node_modules/@anthropic-ai/sdk/index.js': '',
		'extensions/copilot/package.json': '{}',
		'out/vs/platform/agentHost/node/agentHostMain.js': '',
		'out/bundle.js': 'import{a}from"@vscode/copilot-api";',
		'out/req.js': 'const s=require("@anthropic-ai/sdk");',
	});
	const r = run(dir);
	assert.equal(r.status, 1);
	for (const needle of ['@github/copilot-sdk', '@anthropic-ai/sdk', 'extensions/copilot', 'agentHostMain', 'out/bundle.js', 'out/req.js']) {
		assert.match(r.stderr, new RegExp(needle.replace(/[/.]/g, '\\$&')), needle);
	}
});

test('reads paths inside node_modules.asar', () => {
	const dir = artifact({ ...notices });
	fs.writeFileSync(path.join(dir, 'node_modules.asar'), asar({ files: { '@vscode': { files: { 'copilot-api': { files: { 'index.js': { size: 0, offset: '0' } } } } } } }));
	const r = run(dir);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /node_modules\.asar:node_modules\/@vscode\/copilot-api/);
});

test('--notices requires the licence and third-party notices', () => {
	const dir = artifact({ 'out/main.js': '' });
	const r = run('--notices', dir);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /missing .*LICENSE\.txt/);
	assert.match(r.stderr, /missing .*ThirdPartyNotices\.txt/);
});

test('fails on SDK packages unpacked next to node_modules.asar', () => {
	const dir = artifact({ ...notices, 'node_modules.asar.unpacked/@github/copilot-darwin-x64/copilot.node': 'bin' });
	fs.writeFileSync(path.join(dir, 'node_modules.asar'), asar({ files: {} }));
	const r = run(dir);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /forbidden path node_modules\.asar\.unpacked\/@github\/copilot-darwin-x64/);
});

test('fails closed when an asar exists and node is not on PATH', () => {
	const dir = artifact({ ...notices });
	fs.writeFileSync(path.join(dir, 'node_modules.asar'), copilotAsar);
	assert.ok(!fs.existsSync('/usr/bin/node') && !fs.existsSync('/bin/node'), 'this test needs a PATH without node');
	const r = runWithoutNode(dir);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /node is needed/);
	assert.doesNotMatch(r.stderr, /passed/);
});

test('fails closed on a corrupt or truncated asar', () => {
	const truncated = artifact({ ...notices });
	fs.writeFileSync(path.join(truncated, 'node_modules.asar'), copilotAsar.subarray(0, 40));
	const garbage = artifact({ ...notices });
	fs.writeFileSync(path.join(garbage, 'node_modules.asar'), Buffer.from('this is not an asar archive at all'));
	for (const dir of [truncated, garbage]) {
		const r = run(dir);
		assert.equal(r.status, 1, dir);
		assert.match(r.stderr, /cannot read asar archive/);
	}
});

test('fails closed on an unreadable directory', (t) => {
	if (process.getuid?.() === 0) {
		t.skip('root can read any directory');
		return;
	}
	const dir = artifact({ ...notices, 'node_modules/@github/copilot-sdk/index.js': '' });
	fs.chmodSync(path.join(dir, 'node_modules/@github'), 0o000);
	const r = run(dir);
	fs.chmodSync(path.join(dir, 'node_modules/@github'), 0o755);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /cannot list/);
});

test('fails on a directory that is not a packaged artifact', () => {
	const r = run(tempDir());
	assert.equal(r.status, 1);
	assert.match(r.stderr, /no out\/ directory/);
});

test('--expect fails when a requested artifact is missing', () => {
	const parent = tempDir('axis-artifacts-');
	const reh = artifact({ ...notices }, path.join(parent, 'vscode-reh-darwin-x64'));
	const web = artifact({ ...notices }, path.join(parent, 'vscode-reh-web-darwin-x64'));
	const missing = run('--expect', 'desktop,reh,reh-web', reh, web);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /missing desktop artifact/);
	const app = artifact({ 'Contents/Resources/app/out/main.js': '' }, path.join(parent, 'Axis.app'));
	assert.equal(run('--expect', 'desktop,reh,reh-web', app, reh, web).status, 0);
	assert.equal(run(path.join(parent, 'does-not-exist')).status, 1);
});

test('fails on Codex and Copilot extension folders', () => {
	const dir = artifact({ ...notices, 'node_modules/@openai/codex/bin/codex.js': '', 'extensions/github.copilot-chat-1.0.0/package.json': '{}' });
	const r = run(dir);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /@openai\/codex/);
	assert.match(r.stderr, /github\.copilot-chat/);
});
