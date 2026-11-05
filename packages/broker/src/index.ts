// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
export * from "./errors.js";
export * from "./types.js";
export { lexicalSegments, relText, foldName, MAX_PATH_CHARS } from "./lexical.js";
export { matchProtected, foldSegment, DEFAULT_PROTECTED, type ProtectedMatch } from "./protectedPaths.js";
export { nodeBrokerFs, type BrokerFs, type BrokerFile, type FileStat, type OpenMode, type FileKind } from "./fs.js";
export {
  isUnder, resolveRoot, resolveTarget, openContained, readContained, writeContained,
  type ContainDeps, type ResolveMode, type ResolvedRoot, type ResolvedTarget, type OpenFile, type ReadOptions, type WriteOptions,
} from "./contain.js";
export { buildToolEnv, sanitizePath, assertEnv, BASE_NAMES, type EnvGrant, type EnvGrantSource, type ToolEnvSpec, type ToolEnvOptions, type BuiltToolEnv, type EnvRemovalReason } from "./env.js";
export { createCommandRunner, type CommandRunner, type CommandSpec, type RunRecord, type RunnerOptions, type EndReason, type SpawnFn } from "./runner.js";
export { createBrokerGit, checkGitCall, gitCallTier, GIT_COMMANDS, type BrokerGit, type BrokerGitDeps, type GitCall, type GitCommand } from "./git.js";
export {
  ToolPolicy, ApprovalLedger, verifyApproval, isLauncher, approvalGrantSchema,
  type ApprovalHook, type ApprovalRequest, type Decision, type PolicyInput, type PolicyOptions, type VerifiedApproval,
} from "./policy.js";
export { BrokerAudit, BROKER_ACTIONS, BROKER_PAYLOAD_ALLOWLIST, type AuditRecord } from "./audit.js";
export { ToolBroker, type BrokerDeps, type ToolCall, type ToolContext, type ToolDefinition } from "./broker.js";
