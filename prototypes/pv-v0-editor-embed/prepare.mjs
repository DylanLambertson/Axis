// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Builds the harness web root: links every folder of the compiled upstream `out/vs` except `axis`, transpiles the
// overlay (`AXIS_OVERLAY_SRC`, default this repository's) into `vs/axis`, and copies the page.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { env, www } from './env.mjs';

const ts = createRequire(import.meta.url)(env.typescript());
const out = env.upstreamOut();
rmSync(www, { recursive: true, force: true });
mkdirSync(join(www, 'vs'), { recursive: true });
for (const name of readdirSync(out)) {
	if (name !== 'axis') {
		symlinkSync(join(out, name), join(www, 'vs', name));
	}
}
const options = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, useDefineForClassFields: false, experimentalDecorators: true };
function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			walk(path);
		} else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
			const target = join(www, 'vs/axis', path.slice(env.overlay.length + 1).replace(/\.ts$/, '.js'));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: options }).outputText);
		}
	}
}
walk(env.overlay);
for (const page of ['page.html', 'scan.html']) {
	copyFileSync(join(env.here, page), join(www, page));
}
