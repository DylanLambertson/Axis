// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `@axis/daemon-host/main`: the narrow entry the own shell's Electron main imports (OS-3, docs/design/own-shell-main-seam.md §3).
// It holds the supervisor and the main-side modules only, never the composition root, the handlers, storage or `node:sqlite`, so
// main's bundle stays small; apps/desktop/test/bundle.test.mjs pins what it reaches. Add a module here only when main needs it.
export { DAEMON_ENV_ALLOW, DEFAULT_RESTART_POLICY, DaemonSupervisor, SUPERVISED_EXIT, axisDataRoots, daemonEnvironment, shouldStartDaemon } from "../supervisor.js";
export type { AxisDataRoots, DaemonChild, DaemonSupervisorOptions, FailureReason, RestartPolicy, SupervisedConfig, SupervisorEvent, SupervisorState, SupervisorTimers } from "../supervisor.js";
export * from "./anchor-file.js";
export * from "./anchor-store.js";
export * from "./answers.js";
export * from "./attest-sign.js";
export * from "./native-queue.js";
export * from "./pty-handover.js";
export * from "./pty-launch.js";
export * from "./pty-supervisor.js";
export * from "./settings-scope.js";
