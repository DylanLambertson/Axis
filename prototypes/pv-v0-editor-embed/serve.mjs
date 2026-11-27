// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Static server for the harness: serves the web root as ES modules. A CSS file imported from a module is answered
// with an empty module (the upstream build bundles CSS; the compiled tree does not), and /all.css concatenates the
// CSS of vs/base, vs/platform and vs/editor so the editor renders.
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };

async function allCss(root) {
	const parts = [];
	async function walk(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				await walk(path).catch(() => undefined);
			} else if (path.endsWith('.css')) {
				parts.push(await readFile(path, 'utf8'));
			}
		}
	}
	for (const dir of ['vs/base', 'vs/platform', 'vs/editor']) {
		await walk(join(root, dir));
	}
	return parts.join('\n');
}

export function startServer(root, port) {
	let css;
	const server = createServer(async (request, response) => {
		try {
			const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
			if (path === '/all.css') {
				css ??= await allCss(root);
				response.writeHead(200, { 'content-type': 'text/css' });
				response.end(css);
				return;
			}
			const file = join(root, path);
			if (!file.startsWith(root)) {
				throw new Error('outside the root');
			}
			if (extname(file) === '.css' && request.headers['sec-fetch-dest'] === 'script') {
				response.writeHead(200, { 'content-type': 'text/javascript' });
				response.end('');
				return;
			}
			const body = await readFile(file);
			response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
			response.end(body);
		} catch {
			response.writeHead(404);
			response.end();
		}
	});
	return new Promise(done => server.listen(port, '127.0.0.1', () => done(server)));
}
