// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The scanner the host hands to `@axis/git-ops` (PSH-1, plan question 15). Fail closed: in `refuse` mode a scan that
// errors, runs out of time or cannot cover all of the text throws a fixed `SecretScanError`, and git-ops then refuses the push.
// In `warn` mode the same events become findings (`scanner-error`, `scan-incomplete`) so that the user must confirm them.
import { scanText } from "./scan.js";
import { DEFAULT_LIMITS, DEFAULT_SCAN_MODE, SCAN_MODES, SecretScanError, type Finding, type ScanContext, type ScanLimits, type ScanMode, type ScannerOptions } from "./types.js";

export interface SecretScanner {
  /** Pass as `GitOpsDeps.scanner`. */
  readonly scan: (diff: string, meta: ScanContext) => Promise<readonly Finding[]>;
  /** Pass as `GitOpsDeps.scanMode`: both must come from this one value. */
  readonly mode: ScanMode;
  readonly limits: Readonly<ScanLimits>;
}

/** A setting value to a mode. Anything but the two known words is `refuse`, never `warn`: a typo must not weaken the scan. */
export function parseScanMode(value: unknown): ScanMode {
  return typeof value === "string" && (SCAN_MODES as readonly string[]).includes(value) ? (value as ScanMode) : DEFAULT_SCAN_MODE;
}

const UPPER: ScanLimits = { maxBytes: 128 * 1024 * 1024, maxLineLength: 1024 * 1024, maxFindings: 1_000_000, maxBinaryBytes: 128 * 1024 * 1024, deadlineMs: 10 * 60 * 1000 };

function resolveLimits(o: ScannerOptions): ScanLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(UPPER) as (keyof ScanLimits)[]) {
    const v = o[k];
    if (v === undefined) continue;
    // A configuration error, not data: the message names the option, never a value.
    if (!Number.isSafeInteger(v) || v < 1 || v > UPPER[k]) throw new RangeError(`secret scanner option ${k} is out of range`);
    (out as Record<string, number>)[k] = v;
  }
  if (out.maxLineLength < 64) throw new RangeError("secret scanner option maxLineLength is out of range");
  return Object.freeze(out);
}

export function createSecretScanner(options: ScannerOptions = {}): SecretScanner {
  const mode = options.mode === undefined ? DEFAULT_SCAN_MODE : parseScanMode(options.mode);
  const limits = resolveLimits(options);
  const now = options.now ?? ((): number => performance.now());

  const scan = async (diff: string, meta: ScanContext): Promise<readonly Finding[]> => {
    let outcome;
    try {
      if (typeof diff !== "string") throw new SecretScanError("internal");
      outcome = scanText(diff, meta ?? {}, limits, now);
    } catch {
      // Whatever it was, it is not reported: it may hold a fragment of the text.
      if (mode === "refuse") throw new SecretScanError("internal");
      return [{ rule: "scanner-error", ...(typeof meta?.commit === "string" ? { commit: meta.commit } : {}) }];
    }
    const findings: Finding[] = [...outcome.findings];
    const gap = outcome.incomplete.find((r) => r === "deadline") ?? outcome.incomplete.find((r) => r === "too_large");
    if (gap !== undefined) {
      if (mode === "refuse") throw new SecretScanError(gap);
      findings.push({ rule: "scan-incomplete", ...(meta?.commit !== undefined ? { commit: meta.commit } : {}) });
    }
    return findings;
  };
  return Object.freeze({ scan, mode, limits });
}
