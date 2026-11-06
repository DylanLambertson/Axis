// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Scaffold (ticket H1), policy (H6), control channel (H3), storage and startup (H2).
// Nothing in packages/* imports this package.
export * from "./config.js";
export * from "./disposables.js";
export * from "./exit-codes.js";
export * from "./lifecycle.js";
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
export * from "./handlers/review-audit.js";
export * from "./handlers/review-store.js";
export * from "./handlers/review-wire.js";
// Worktrees binding over the real @axis/worktrees (ticket H8).
export { createWorktreesBinding, type WorktreesBinding, type WorktreesBindingDeps } from "./bindings/worktrees.js";
// Only the factory is public: the capability minter is closed over inside it and never returned (see worktrees-gate-exports.test.ts).
export { createWorktreesApprovals, type WorktreesApprovals } from "./gate/worktrees-confirm.js";
export * from "./handlers/worktrees.js";
export * from "./worktrees/audit.js";
export * from "./worktrees/errors.js";
export * from "./worktrees/guards.js";
export * from "./worktrees/hooks.js";
export * from "./worktrees/info.js";
export * from "./worktrees/locator.js";
export * from "./worktrees/project-mutex.js";
export * from "./worktrees/reconcile.js";
export * from "./worktrees/service.js";
export * from "./worktrees/shapes.js";
export * from "./worktrees/finalise-recovery.js";
export * from "./worktrees/restore-paths.js";
export * from "./worktrees/slug.js";
// axis.cli-runs/1 over the real RunSupervisor (ticket H10).
export { createRunsBinding, MAX_TRACKED_GROUPS, RUN_PAYLOAD_ALLOWLIST, type RunsBinding, type RunsBindingDeps } from "./bindings/runs.js";
export { createRunSnapshotter, gitSnapshotRunSnapshotter, MAX_HELD_SNAPSHOTS, SNAPSHOT_ATTEMPTS, SNAPSHOT_TAKE_MS, SUPERVISOR_SNAPSHOT_MS, type RunSnapshotterDeps, type RunSnapshotterFactory } from "./bindings/snapshot.js";
export { createRunTrustMinter } from "./gate/run-trust.js";
export * from "./handlers/cli-runs.js";
export * from "./runs/errors.js";
// axis.git/1 handlers and the GitOpsDeps assembly (ticket H9).
export { createGitOperations, createGitPort, type GitBindingDeps, type GitOperationsDeps } from "./bindings/git.js";
export * from "./handlers/git.js";
export * from "./handlers/git-errors.js";
export * from "./handlers/git-wire.js";
export { PushedBases } from "./handlers/git-common.js";
// The composition root and its parts (ticket H12).
export { composeDaemonHost, type ComposeOptions, type ComposedHost } from "./compose.js";
export * from "./compose-parts.js";
export * from "./handlers/projects.js";
// axis.runs/1: composer runs on the mock provider through the broker (ticket C1, docs/design/composer-runtime.md).
export { AGENT_PAYLOAD_ALLOWLIST, createAgentBinding, COMPOSER_TOOLS, MAX_INFLIGHT_CALLS, MAX_READ_BYTES, shownWhole, MAX_WRITE_BYTES, type AgentBinding, type AgentBindingDeps } from "./bindings/agent.js";
export * from "./composer/activity.js";
export * from "./composer/errors.js";
export * from "./composer/loop.js";
export * from "./composer/preview.js";
export * from "./composer/service.js";
export * from "./gate/run-approvals.js";
export * from "./handlers/composer-runs.js";
// The parent side: spawn, restart policy, exit-code handling and shutdown (ticket X1; runs in Electron main).
export * from "./supervisor.js";
