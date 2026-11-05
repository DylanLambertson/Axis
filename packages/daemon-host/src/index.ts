// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Scaffold (ticket H1), policy (H6), control channel (H3), storage and startup (H2).
// Nothing in packages/* imports this package.
export * from "./config.js";
export * from "./disposables.js";
export * from "./exit-codes.js";
export { registerHostSecrets } from "./secrets.js";
export * from "./log/index.js";
export * from "./policy/index.js";
export * from "./ports/index.js";
export * from "./control/attestation.js";
export * from "./control/messages.js";
export * from "./control/client.js";
export * from "./control/connect-limiter.js";
export * from "./control/connect-router.js";
export * from "./transport/electron-parent-port.js";
export * from "./transport/mux.js";
export * from "./transport/node-ipc.js";
export * from "./transport/node-port.js";
export * from "./handlers/providers.js";
// Storage and startup (ticket H2).
export * from "./host.js";
export * from "./storage/anchor-check.js";
export * from "./storage/git-path.js";
export * from "./storage/node-storage.js";
export * from "./storage/recovery.js";
export * from "./storage/uptime-clock.js";
// Anchor manager and audit handlers (ticket H4).
export * from "./anchor/manager.js";
export * from "./anchor/preflight.js";
export * from "./handlers/anchor-guard.js";
export * from "./handlers/audit.js";
// Challenge manager, gate adapter, native bridge and axis.approvals/1 (ticket H5).
export * from "./gate/approvals.js";
export * from "./gate/audit-sink.js";
export * from "./gate/native-bridge.js";
export * from "./gate/pending-registry.js";
export * from "./gate/summary.js";
export * from "./handlers/approvals.js";
// axis.review/1 (ticket H10b).
export * from "./bindings/review.js";
export * from "./bindings/review-tempindex.js";
export * from "./handlers/review.js";
export * from "./handlers/review-store.js";
export * from "./handlers/review-wire.js";
