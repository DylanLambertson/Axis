// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shapes of the secret scanner (PSH-1). They are structurally the same as `SecretScanner`, `ScanMeta` and `SecretFinding`
// of @axis/git-ops, which this package does not import: the host passes `scan` as `GitOpsDeps.scanner`.

/** `refuse`: a finding, or a scan that could not finish, refuses the push. `warn`: both need the user's confirmation. */
export type ScanMode = "refuse" | "warn";
export const SCAN_MODES: readonly ScanMode[] = Object.freeze(["refuse", "warn"] as const);
export const DEFAULT_SCAN_MODE: ScanMode = "refuse";

/** Where a match is and which rule matched. Never the matched text. */
export interface Finding {
  /** `[A-Za-z0-9._-]{1,64}`, from the closed set in `RULE_NAMES` (plus `base64-` and `hex-` prefixed forms). */
  readonly rule: string;
  /** The file as the diff names it (not escaped for display: the host does that). */
  readonly path?: string;
  /** The line in the new file (patch) or the text (message), counted from 1. Absent for a file-level finding. */
  readonly line?: number;
  /** The outgoing commit, when the caller said which. */
  readonly commit?: string;
}

/** What the caller knows about the text. A superset (git-ops `ScanMeta`) is accepted. */
export interface ScanContext {
  /** `patch`: a unified diff, only added lines and file names are scanned. `message`: plain text, every line. Default `patch`. */
  readonly part?: "patch" | "message";
  readonly commit?: string;
  /** Paths git treats as binary. Their content is scanned only below `maxBinaryBytes`. */
  readonly binaryPaths?: readonly string[];
  /** Binary paths the user allowed for this push (exact match; the first 50 are used). Not scanned beyond the budget and not reported as `binary-unscanned`. */
  readonly allowedBinaryPaths?: readonly string[];
  /** The caller cut the text at its own limit. Not an error here: the caller fails closed on it. */
  readonly truncated?: boolean;
}

export interface ScanLimits {
  /** Most characters of one scan. More is not scanned (incomplete). Default 16 MiB. */
  readonly maxBytes: number;
  /** Longest stretch matched as one piece. A longer line is scanned in overlapping windows of this size. Default 16384. */
  readonly maxLineLength: number;
  /** The scan stops here (the result is then marked capped). Default 100,000. */
  readonly maxFindings: number;
  /** Added bytes of one binary file that are scanned. A larger one is `binary-unscanned`. Default 262,144. */
  readonly maxBinaryBytes: number;
  /** Wall time of one scan in milliseconds, checked between lines and between windows. Default 5000. */
  readonly deadlineMs: number;
  /** Matches a rule looked at and rejected (a decoy), summed over the scan. At the limit the scan is incomplete. Default 2,000,000. */
  readonly maxRejectedMatches: number;
}

export interface ScannerOptions extends Partial<ScanLimits> {
  /** Default `refuse`. An unknown value is refused by `parseScanMode`, not guessed. */
  readonly mode?: ScanMode;
  /** Test seam: milliseconds, monotonic. Default `performance.now`. */
  readonly now?: () => number;
}

/** No pattern match is longer than this, so consecutive windows of a long line share this many characters. */
export const WINDOW_OVERLAP = 4096;
/** The smallest window: it must hold the longest match twice over, or a token could straddle two windows unseen. */
export const MIN_LINE_LENGTH = 2 * WINDOW_OVERLAP;

export const DEFAULT_LIMITS: ScanLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxLineLength: 16 * 1024,
  maxFindings: 100_000,
  maxBinaryBytes: 256 * 1024,
  deadlineMs: 5000,
  maxRejectedMatches: 2_000_000,
});

/** Why a scan did not look at everything. The text never appears in the reason. */
export type IncompleteReason = "too_large" | "deadline" | "budget" | "findings_capped";

export interface ScanOutcome {
  readonly findings: readonly Finding[];
  readonly incomplete: readonly IncompleteReason[];
}

/** Fixed messages only: an error from the scanner never carries, wraps or points at the text it was reading. */
export class SecretScanError extends Error {
  readonly code: "too_large" | "deadline" | "budget" | "internal";
  constructor(code: "too_large" | "deadline" | "budget" | "internal") {
    super(
      code === "too_large"
        ? "the secret scan could not cover all of the text"
        : code === "deadline"
          ? "the secret scan ran out of time"
          : code === "budget"
            ? "the secret scan ran out of work"
            : "the secret scan failed",
    );
    this.name = "SecretScanError";
    this.code = code;
  }
}
