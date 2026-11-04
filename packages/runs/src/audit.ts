// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export const RUN_AUDIT_ACTIONS = {
  start: "cli_run.start",
  exit: "cli_run.exit",
  stop: "cli_run.stop",
  refused: "cli_run.refused",
  discard: "cli_run.discard",
} as const;

/**
 * Payload keys each run action may store. Merge it into `AuditLog`'s `payloadAllowlist`; without it the log keeps
 * only a length and hash for these actions. Every value is an id, a state name, a reason code, a count, a flag or
 * an executable base name: never output, an argument, an environment value or an error message.
 */
export const RUN_AUDIT_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  [RUN_AUDIT_ACTIONS.start]: ["runId", "workspaceId", "agentId", "executable", "argCount", "removedEnvCount", "disclosureVersion"],
  [RUN_AUDIT_ACTIONS.exit]: ["runId", "workspaceId", "state", "reason", "exitCode", "snapshotAfter", "drift"] /* drift is null when no snapshot answered */,
  [RUN_AUDIT_ACTIONS.stop]: ["runId", "workspaceId", "phase"],
  [RUN_AUDIT_ACTIONS.refused]: ["workspaceId", "code", "reason"],
  [RUN_AUDIT_ACTIONS.discard]: ["runId", "workspaceId", "from", "to", "reason"],
};
