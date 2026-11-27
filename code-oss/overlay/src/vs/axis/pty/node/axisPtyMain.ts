/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The Axis pty process, started by the Axis main seam as an Electron utility process (docs/design/pty-process.md, ticket
// pty-adapter). All logic is in packages/pty-process/src/entry.ts, tested without Electron. This file only hands it the real process
// objects and Code OSS's own node-pty, called directly (not upstream's PtyService, which adds VSCODE_* variables and a nonce: PTY-6).
// It opens no socket; ports arrive only on `process.parentPort`, which only main can write.
import * as nodePty from 'node-pty';
import { createNodePtySpawn, runPtyEntry } from '../../packages/pty-process/index.js';

runPtyEntry({
	parentPort: (process as unknown as { parentPort?: Parameters<typeof runPtyEntry>[0]['parentPort'] }).parentPort,
	process: process as unknown as Parameters<typeof runPtyEntry>[0]['process'],
	env: { ...process.env },
	execArgv: process.execArgv,
	platform: process.platform,
	spawn: createNodePtySpawn((file, args, options) => nodePty.spawn(file, args, options), process.platform),
	stderr: line => process.stderr.write(`${line}\n`),
});
