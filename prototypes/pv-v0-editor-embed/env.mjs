// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Paths the PV-V0 harness needs, from the environment (see README.md); nothing machine-specific is tracked.
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function required(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`${name} is not set; see prototypes/pv-v0-editor-embed/README.md`);
		process.exit(2);
	}
	return resolve(value);
}

export const env = {
	here,
	overlay: resolve(process.env.AXIS_OVERLAY_SRC ?? join(here, '../../code-oss/overlay/src/vs/axis')),
	work: resolve(process.env.AXIS_PV_V0_WORK ?? join(tmpdir(), 'axis-pv-v0')),
	port: Number(process.env.AXIS_PV_V0_PORT ?? 8951),
	upstreamOut: () => required('AXIS_UPSTREAM_OUT'),
	typescript: () => required('AXIS_TYPESCRIPT'),
	mocha: () => required('AXIS_MOCHA'),
	playwrightCore: () => required('AXIS_PLAYWRIGHT_CORE'),
	chromium: () => required('AXIS_CHROMIUM'),
};
export const www = join(env.work, 'www');
