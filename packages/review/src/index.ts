// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
export type {
  ChangeKind,
  ChangeStatus,
  ProtectedHit,
  ProtectedPathMatcher,
  ReviewDeps,
  ReviewFile,
  ReviewInput,
  ReviewLimits,
  TempIndex,
  TempIndexProvider,
} from "./types.js";
export { ReviewError } from "./errors.js";
export { DEFAULT_LIMITS, resolveLimits } from "./limits.js";
export { escapeForDisplay, pathProblem, symlinkEscapes, type EscapeOptions } from "./display.js";
export { ReviewSession, type FileDecisionState, type FileHunks } from "./session.js";
export type { HunkView, HunkViewLine, Preview } from "./preview.js";
export { ReviewBinding, checkFresh, prepareCommit, type AcceptedFile, type Freshness, type PreparedCommit } from "./binding.js";
export { computeOutsideAgent, type OutsideAgentInput, type OutsideAgentReport, type OutsidePath } from "./outside.js";
export { secretWarnings, type SecretWarning, type SecretWarnings } from "./secrets.js";
