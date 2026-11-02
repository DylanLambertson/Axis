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

function artifact(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-artifact-'));
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

const notices = { 'LICENSE.txt': 'MIT', 'ThirdPartyNotices.txt': 'notices' };

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
