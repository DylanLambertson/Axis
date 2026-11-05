// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError } from "@axis/daemon";
import { GIT_COMMIT_REASONS, GIT_PUSH_REASONS } from "@axis/protocol";
import { GitRefusal } from "../ports/git.js";
import { ReviewRefusal } from "../ports/review.js";

/**
 * The closed error set of `axis.git/1` (design section 9). Every message is a constant: nothing git, the scanner, the
 * review package, the journal or a caught error said is forwarded, because those texts carry paths, ref names, remote
 * URLs and finding details. Only a code of the set and one `reason` of the contract's closed sets reach the wire.
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  head_moved: "HEAD or the branch moved since the review. Review the changes again.",
  stale: "The files changed since the review. Review the changes again.",
  index_changed: "The staged changes changed since the review. Review the changes again.",
  operation_in_progress: "A merge, rebase or similar operation is in progress. Finish or abort it first.",
  ref_update_failed: "The branch could not be updated. It was left as it was.",
  snapshot_failed: "The workspace could not be read for the check.",
  too_large: "There are too many changed files to review at once.",
  not_found: "A file of the review was not found.",
  detached_head: "HEAD is detached. Commit from an axis branch.",
  no_head: "The branch has no commit to build on.",
  plan_changed: "The outgoing changes are not the ones you confirmed. Review the new plan.",
  secrets_found: "The outgoing changes match a secret pattern, so they cannot be pushed. Review the plan.",
  scan_incomplete: "The outgoing changes are too large to scan completely, so they cannot be pushed.",
  binary_unscanned: "The outgoing changes include binary files that cannot be scanned. Review the plan.",
  message_unscannable: "A commit message in the outgoing changes cannot be scanned, so it cannot be pushed.",
  git_drift: "The repository's git configuration changed since it was recorded. Acknowledge the change first.",
};

const REASONS: ReadonlySet<string> = new Set<string>([...GIT_COMMIT_REASONS, ...GIT_PUSH_REASONS]);

export type GitFailureCode = "E_CANCELLED" | "E_CONFLICT" | "E_INTERNAL" | "E_INVALID_ARGUMENT" | "E_NOT_FOUND" | "E_UNAVAILABLE";

const CODE_TEXT: Readonly<Record<GitFailureCode, string>> = {
  E_CANCELLED: "The request was cancelled.",
  E_CONFLICT: "The workspace cannot do that right now.",
  E_INTERNAL: "The git operation failed.",
  E_INVALID_ARGUMENT: "The request is not valid for this workspace.",
  E_NOT_FOUND: "The workspace was not found.",
  E_UNAVAILABLE: "Git could not complete the request.",
};

/** A `DaemonError` with the fixed text of the code and, when `reason` is in the contract's closed sets, that reason and its text. */
export function gitFailure(code: GitFailureCode, reason?: string): DaemonError {
  if (reason !== undefined && REASONS.has(reason) && Object.hasOwn(REASON_TEXT, reason)) return new DaemonError(code, REASON_TEXT[reason] as string, { reason });
  return new DaemonError(code, CODE_TEXT[code]);
}

/**
 * What a git operation or the review binding refused, as the error the daemon answers. A handler cannot raise
 * `E_POLICY_DENIED` (only the daemon decides it), so a refusal of that code is a conflict with the state, like the
 * review handlers do. Anything that is not a refusal of ours (a bug, a spent signal) is `E_INTERNAL` or `E_CANCELLED`.
 */
export function toGitError(e: unknown, signal?: AbortSignal): DaemonError {
  if (e instanceof DaemonError) return e;
  if (e instanceof GitRefusal || e instanceof ReviewRefusal) {
    switch (e.code) {
      case "E_CONFLICT":
      case "E_POLICY_DENIED":
        return gitFailure("E_CONFLICT", e.reason);
      case "E_INVALID_ARGUMENT":
        return gitFailure("E_INVALID_ARGUMENT", e.reason);
      case "E_NOT_FOUND":
        return gitFailure("E_NOT_FOUND");
      case "E_CANCELLED":
        return gitFailure("E_CANCELLED");
      case "E_INTERNAL":
      case "E_APPROVAL_REQUIRED":
        return gitFailure("E_INTERNAL");
      default:
        return gitFailure("E_UNAVAILABLE");
    }
  }
  return signal?.aborted === true ? gitFailure("E_CANCELLED") : gitFailure("E_INTERNAL");
}
