/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The Axis daemon, started by the Axis main seam as an Electron utility process (ADR 0003 D1, ADR 0005 D3, ticket X1,
// docs/design/daemon-host-entry.md). This file only hands the real process objects to the entry logic, which lives in
// packages/daemon-host/src/entry.ts and is tested without Electron. It opens no socket and no port: the only way in is
// `process.parentPort`, which only the main process can write.
import { runDaemonEntry } from '../../packages/daemon-host/entry.js';

// PLACEHOLDERS, deliberately absent: the Axis pty process (ticket B9: the pty port and the pty git runner) does not exist yet.
// No fake is wired here, so `composeDaemonHost` refuses to build (`pty_required`) and this process exits with code 78 after
// `init`. Pass the real ports in `ports` when they exist. The run snapshotter is wired inside the entry (ticket H13), not here.
runDaemonEntry({
	parentPort: (process as unknown as { parentPort?: Parameters<typeof runDaemonEntry>[0]['parentPort'] }).parentPort,
	process: process as unknown as Parameters<typeof runDaemonEntry>[0]['process'],
	env: { ...process.env },
	cwd: process.cwd(),
	platform: process.platform,
	execArgv: process.execArgv,
	stderr: line => process.stderr.write(`${line}\n`),
});
