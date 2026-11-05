// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

// Daemon utility-process entry (ADR 0003 D1, ADR 0005 D3). This is a stub that
// proves the staged @axis/protocol package bundles and runs; the RPC server,
// the policy pipeline and the main-process handshake come later.
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, ZOD_VERSION, contracts } from '../../packages/protocol/index.js';

export function describeDaemonContracts(): { protocolVersion: number; supported: readonly number[]; contracts: string[]; zod: string } {
	return {
		protocolVersion: PROTOCOL_VERSION,
		supported: SUPPORTED_PROTOCOL_VERSIONS,
		contracts: Object.keys(contracts).sort(),
		zod: ZOD_VERSION,
	};
}

if (process.env['AXIS_DAEMON_PRINT_CONTRACTS'] === '1') {
	console.log(JSON.stringify(describeDaemonContracts()));
}
