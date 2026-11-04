// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { computeDigest } from "./digest.js";
import { diffSnapshots, type SnapshotDiff } from "./diff.js";
import { denied, invalid } from "./errors.js";
import type { Snapshot } from "./types.js";

/** The user's statement "I reviewed this exact state". It binds a digest, so any later change invalidates it. */
export interface Acknowledgement {
  readonly digest: string;
  readonly acknowledgedAtMs: number;
}

export type DriftVerdict =
  /** The digests are equal: nothing to flag. */
  | { readonly status: "clean"; readonly allowed: true; readonly digest: string; readonly diff: SnapshotDiff }
  /** It differs from the baseline, but the user acknowledged exactly this state. */
  | { readonly status: "acknowledged"; readonly allowed: true; readonly digest: string; readonly diff: SnapshotDiff }
  /** It differs and nobody acknowledged this state. Commit and push refuse. */
  | { readonly status: "unacknowledged"; readonly allowed: false; readonly digest: string; readonly diff: SnapshotDiff }
  /** It cannot be judged, and it cannot be acknowledged: an unread item, a link mismatch, a bad snapshot. */
  | {
      readonly status: "refused";
      readonly allowed: false;
      readonly digest: string;
      readonly diff: SnapshotDiff;
      readonly reasons: readonly string[];
    };

export interface JudgeInput {
  /** The last state the user accepted (taken at worktree creation, or re-baselined after an acknowledgement). */
  readonly baseline: Snapshot;
  /** A snapshot re-taken just now. */
  readonly current: Snapshot;
  readonly acknowledgement?: Acknowledgement | undefined;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Reasons a snapshot cannot be trusted or acknowledged, in fixed text. */
function problems(label: string, s: Snapshot): string[] {
  const out: string[] = [];
  if (computeDigest(s.entries, s.link, s.incomplete) !== s.digest) out.push(`${label} digest does not match its entries`);
  if (s.link.mismatch) out.push(`${label} worktree .git does not match the recorded git dir`);
  if (s.incomplete.some((i) => i.blocking)) out.push(`${label} could not be read in full`);
  return out;
}

/**
 * The verdict Axis commit and push consult. Fails closed: a snapshot with an unread item, a link mismatch, a
 * different repository or a digest that does not match its entries is `refused`, whatever was acknowledged.
 */
export function judgeDrift(input: JudgeInput): DriftVerdict {
  const { baseline, current } = input;
  const diff = diffSnapshots(baseline, current);
  const reasons = [...problems("baseline", baseline), ...problems("current", current)];
  if (baseline.commonDir !== current.commonDir || baseline.worktreePath !== current.worktreePath) {
    reasons.push("the snapshots are of different directories");
  }
  if (reasons.length > 0) return { status: "refused", allowed: false, digest: current.digest, diff, reasons };
  if (baseline.digest === current.digest) return { status: "clean", allowed: true, digest: current.digest, diff };
  const ack = input.acknowledgement;
  if (ack !== undefined && typeof ack.digest === "string" && HEX64.test(ack.digest) && ack.digest === current.digest) {
    return { status: "acknowledged", allowed: true, digest: current.digest, diff };
  }
  return { status: "unacknowledged", allowed: false, digest: current.digest, diff };
}

/** Records that the user reviewed `current`. Refuses a snapshot that cannot be judged. */
export function acknowledgeDrift(current: Snapshot, now: () => number = Date.now): Acknowledgement {
  if (problems("current", current).length > 0) throw denied("this state cannot be acknowledged");
  return { digest: current.digest, acknowledgedAtMs: now() };
}

/**
 * Throws `E_POLICY_DENIED` unless the verdict allows the action. The message names the flags (redacted text) so the
 * caller can show why; it never carries file content.
 */
export function assertDriftAllowed(verdict: DriftVerdict, action: "commit" | "push"): void {
  if (verdict.allowed) return;
  if (verdict.status !== "unacknowledged" && verdict.status !== "refused") throw invalid("unknown verdict");
  const why = verdict.status === "refused" ? verdict.reasons.join("; ") : verdict.diff.flags.slice(0, 5).join("; ");
  throw denied(`${action} refused: the git directory changed and the change was not acknowledged${why === "" ? "" : ` (${why})`}`);
}
