// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// @axis/shell-core: the renderer-safe logic of the own shell (daemon client, reconnect, events, models), ported by
// OS-5 from the legacy overlay's common/ modules over small replacements of the Code OSS primitives they used
// (src/base). It imports only @axis/protocol and the other renderer packages, never node:* (the leak check of the tests
// is test/testing.ts).

/** The package's API version: 1 once the OS-5 port landed. */
export const SHELL_CORE_API_VERSION = 1;

export * from "./base/cancellation.js";
export * from "./base/event.js";
export * from "./base/lifecycle.js";
export * from "./base/nls.js";
export * from "./approvals/axisApprovals.js";
export * from "./approvals/axisApprovalShortcut.js";
export * from "./approvals/axisApprovalText.js";
export * from "./changes/axisListFocus.js";
export * from "./changes/axisOrderedChildren.js";
export * from "./daemon/axisDaemonApi.js";
export * from "./daemon/axisDaemonClient.js";
export * from "./daemon/axisDaemonReconnect.js";
export * from "./daemon/axisDaemonReplies.js";
export * from "./daemon/axisEventFrames.js";
export * from "./daemon/axisEventSubscription.js";
export * from "./files/axisFileTreeText.js";
export * from "./projects/axisProjectActions.js";
export * from "./projects/axisProjectActionsService.js";
export * from "./view/axisView.js";
export * from "./view/axisViewState.js";
export * from "./workspaces/axisDaemonNotice.js";
export * from "./workspaces/axisEventDriver.js";
export * from "./workspaces/axisRefreshDriver.js";
export * from "./workspaces/axisSampleRuns.js";
export * from "./workspaces/axisSnapshotLoader.js";
export * from "./workspaces/axisWorkspaceData.js";
export * from "./workspaces/axisWorkspaceModel.js";
export * from "./workspaces/displayText.js";
