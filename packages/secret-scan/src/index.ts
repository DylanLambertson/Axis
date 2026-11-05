// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
export { createSecretScanner, parseScanMode, type SecretScanner } from "./scanner.js";
export { scanText } from "./scan.js";
export { PatchReader, unquotePath, type PatchEvent } from "./diff.js";
export { CONTENT_RULES, isDigestName, isLockFile, isSensitiveFilename, looksRandom } from "./rules.js";
export { shannonEntropy } from "./entropy.js";
export {
  DEFAULT_LIMITS,
  MIN_LINE_LENGTH,
  WINDOW_OVERLAP,
  DEFAULT_SCAN_MODE,
  SCAN_MODES,
  SecretScanError,
  type Finding,
  type IncompleteReason,
  type ScanContext,
  type ScanLimits,
  type ScanMode,
  type ScanOutcome,
  type ScannerOptions,
} from "./types.js";

/** Rule names this package reports (the encoded forms add a `base64-` or `hex-` prefix to a fixed-format rule). */
export const RULE_NAMES: readonly string[] = Object.freeze([
  "private-key-block", "aws-access-key-id", "gcp-api-key", "github-token", "gitlab-token", "slack-token", "slack-webhook",
  "stripe-key", "npm-token", "ai-api-key", "jwt", "azure-shared-key", "url-credentials", "url-embedded-token",
  "connection-string-password", "bearer-token", "basic-auth-header", "generic-secret-assignment", "sensitive-filename",
  "binary-unscanned", "scan-incomplete", "scanner-error",
]);
