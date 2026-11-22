// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `@axis/pty-process/client` (PV-X1a): what the daemon host needs to reach the pty process over a transferred port, and nothing that
// starts a program. The daemon host imports only this subpath (test/packages/imports.test.mjs), so its graph never reaches the exec
// function (`exec-node.ts`), the service or the native spawn adapter.
export { createPtyProcessPort, PtySpawnError, type PtyProcessHandle, type PtyProcessPort, type PtyProcessPortOptions, type PtyPushCall, type PtySpawnFailure } from "./client.js";
export { PtyExecError, type PtyExecCall, type PtyExecFailure, type PtyExecOutcome } from "./exec-client.js";
export { FORGE_CALL_TIMEOUT_MS, PtyForgeError, type PtyForgeFailure } from "./forge-client.js";
export { adaptMessagePort, type MessagePortLike, type PortAdapterOptions } from "./port-adapter.js";
export type { Channel, Disposable } from "./ports.js";
