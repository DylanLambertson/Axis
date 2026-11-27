// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs the overlay's side-panel unit tests (mocha, as upstream runs them) against the prepared web root.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { env, www } from './env.mjs';

const test = join(www, 'vs/axis/contrib/sidePanel/test/common/axisSidePanelEditor.test.js');
const result = spawnSync(process.execPath, [join(env.mocha(), 'bin/mocha.js'), '--ui', 'tdd', '--exit', test], { encoding: 'utf8' });
process.stdout.write(result.stdout + result.stderr);
process.exit(result.status ?? 1);
