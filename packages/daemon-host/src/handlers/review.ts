// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import { userPrincipal } from "@axis/journal/daemon-principal";
import {
  isAcknowledged,
  reviewCompleteRequestSchema,
  reviewCompleteResponseSchema,
  reviewDiffReasonSchema,
  reviewDiffRequestSchema,
  reviewDiffResponseSchema,
  type ReviewFileWire,
} from "@axis/protocol";
import type { PortContext } from "../ports/common.js";
import { ReviewRefusal, type ReviewRound, type ReviewService, type RoundFile } from "../ports/review.js";
import type { RunsService } from "../ports/runs.js";
import { ReviewedTrees } from "./review-store.js";
import { AckSessions, contentIdOf, fileIdOf, foldEqualPaths, hasReplacementChar, wireRow, wireSkipped } from "./review-wire.js";

/**
 * `axis.review/1` (design section 4.2): `diff` (read, tier 1) and `complete` (write, tier 2).
 *
 * Who is acting comes from `ctx.identity` only. Both handlers refuse any actor but `user` themselves, behind the policy
 * row, and only after that check is the `UserPrincipal` minted (it is never derived from a payload). A handler cannot
 * raise `E_POLICY_DENIED` (only the daemon decides it), so the refusal is the same `E_NOT_FOUND` the approvals handlers
 * use. Every error text here is fixed: never a path, a display path, an object id, an id from the request or git's output.
 *
 * `diff` follows docs/design/daemon-host.md section 4.2 (REV-1): the review is built once over the workspace, the
 * `contentId` of a truncated file comes from the snapshot entry the `treeHash` is built from, `acceptTruncated` goes to
 * the review only for a file `isAcknowledged` accepts, and the tree is recorded (journal, then the in-memory lookup the
 * commit handler uses) only after it is built.
 */
export interface ReviewAckEvent {
  readonly action: "review.acknowledge";
  readonly actor: "user";
  readonly workspaceId: string;
  readonly connectionId: string;
  /** The file's id only: no content id, no path, no content. */
  readonly fileId: string;
}

/** Synchronous; a throw fails the diff closed (no tree is returned for an acknowledgement that was not recorded). */
export interface ReviewAuditSink {
  append(event: ReviewAckEvent): void;
}

export interface ReviewHandlerDeps {
  readonly review: ReviewService;
  readonly journal: Pick<Journal, "recordReviewedTree" | "getRun" | "transitionRun">;
  readonly runs: Pick<RunsService, "get">;
  readonly audit: ReviewAuditSink;
  /** Shared with the git handler, which asks it for the binding of a reviewed tree. */
  readonly trees: ReviewedTrees;
  readonly acks?: AckSessions;
}

const CUT_CHECK_CONCURRENCY = 8;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const NOT_AVAILABLE = "This review is not available.";
type Code = "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT" | "E_UNAVAILABLE";

function fail(code: Code, message: string, reason?: string): never {
  throw new DaemonError(code, message, reason === undefined ? undefined : { reason });
}

/** The closed `reason` of a refusal, or undefined for anything outside the wire's set. */
function reasonOf(e: ReviewRefusal): string | undefined {
  const r = reviewDiffReasonSchema.safeParse(e.reason);
  return r.success ? r.data : undefined;
}

function mapRefusal(e: unknown): never {
  if (e instanceof DaemonError) throw e;
  if (e instanceof ReviewRefusal) {
    const reason = reasonOf(e);
    switch (e.code) {
      case "E_INVALID_ARGUMENT":
        return fail("E_INVALID_ARGUMENT", reason === "too_large" ? "There are too many changed files to review at once." : "The review request is invalid.", reason);
      case "E_NOT_FOUND":
        return fail("E_NOT_FOUND", "The workspace was not found.");
      case "E_CANCELLED":
        return fail("E_CANCELLED", "The request was cancelled.");
      // A handler cannot raise E_POLICY_DENIED: a review the package would not build is a conflict with the state.
      case "E_CONFLICT":
      case "E_POLICY_DENIED":
        return fail("E_CONFLICT", "The workspace cannot be reviewed in its current state.", reason);
      default:
        return fail("E_UNAVAILABLE", "The review could not be completed.");
    }
  }
  return fail("E_UNAVAILABLE", "The review could not be completed.");
}

export function createReviewDiffHandler(deps: ReviewHandlerDeps): Handler {
  const acks = deps.acks ?? new AckSessions();
  return async (context: HandlerContext, payload: never) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    const { identity } = context;
    if (identity.actor !== "user") return fail("E_NOT_FOUND", NOT_AVAILABLE);
    const request = reviewDiffRequestSchema.safeParse(payload);
    if (!request.success) return fail("E_INVALID_ARGUMENT", "The review request is invalid.");
    const { workspaceId, acknowledged } = request.data;

    const portCtx: PortContext = { caller: { actor: identity.actor, connectionId: identity.connectionId, windowId: identity.windowId }, signal: context.signal };
    let round: ReviewRound;
    const rows: ReviewFileWire[] = [];
    const accepted: Array<{ path: string; acceptTruncated: boolean; ackFileId: string | undefined; contentId: string | null }> = [];
    let committable = true;
    try {
      round = await deps.review.open(workspaceId, portCtx);
      const files = foldEqualPaths(round.files);
      const usable = (f: RoundFile): boolean => !(f.unsafePath || hasReplacementChar(f.path)) && f.kind !== "filtered";
      // The cut check reads git objects per file: a few at a time, so 200 files stay well inside the method's timeout.
      const cut = await mapLimit(files, CUT_CHECK_CONCURRENCY, (f) => (usable(f) ? round.hasCutLines(f.path) : Promise.resolve(false)));
      for (const [i, f] of files.entries()) {
        const fileId = fileIdOf(f.path);
        const unsafe = f.unsafePath || hasReplacementChar(f.path);
        const filtered = f.kind === "filtered";
        let truncated = false;
        let contentId: string | null = null;
        let ack = false;
        if (!unsafe && !filtered) {
          // From the same entry (mode, object id) of the snapshot tree the tree hash is built from.
          truncated = cut[i] === true;
          contentId = truncated ? contentIdOf(f.newMode, f.newOid) : null;
          ack = isAcknowledged({ fileId, truncated, contentId }, acknowledged);
        }
        if (unsafe || filtered || (truncated && !ack)) committable = false;
        else accepted.push({ path: f.path, acceptTruncated: truncated && ack, ackFileId: truncated && ack ? fileId : undefined, contentId });
        rows.push(wireRow(f, { fileId, truncated, contentId, acknowledged: ack, unsafe }));
      }
      if (files.length === 0 || round.branch === null) committable = false;
    } catch (e) {
      return mapRefusal(e);
    }
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");

    let treeHash: string | null = null;
    if (committable && round.branch !== null) {
      try {
        const session = `${workspaceId}\u0000${identity.connectionId}\u0000${round.head}`;
        for (const a of accepted) {
          // acceptTruncated reaches the review for acknowledged files only (isAcknowledged above, nothing else).
          round.accept(a.path, { acceptTruncated: a.acceptTruncated });
        }
        // One audit event per first application of an acknowledgement in this review session, before any tree is released.
        for (const a of accepted) {
          if (a.ackFileId === undefined || a.contentId === null || !acks.isFirst(session, a.ackFileId, a.contentId)) continue;
          deps.audit.append({ action: "review.acknowledge", actor: "user", workspaceId, connectionId: identity.connectionId, fileId: a.ackFileId });
          acks.commit(session, a.ackFileId, a.contentId);
        }
        const built = await round.build();
        // Journal first (it needs the minted principal and a READY workspace); the lookup is filled only when it succeeded.
        deps.journal.recordReviewedTree(workspaceId, built.reviewedTree, userPrincipal());
        deps.trees.record({ workspaceId, treeHash: built.reviewedTree, parent: built.head, branch: built.branch, handle: built.handle });
        treeHash = built.reviewedTree;
      } catch (e) {
        if (e instanceof AxisError && e.code === "E_CONFLICT") return fail("E_CONFLICT", "The review could not be recorded for this workspace.");
        if (e instanceof AxisError || !(e instanceof DaemonError || e instanceof ReviewRefusal)) return fail("E_INTERNAL", "The review could not be recorded.");
        return mapRefusal(e);
      }
    }

    const answer = reviewDiffResponseSchema.safeParse({
      head: round.head,
      branch: round.branch,
      treeHash,
      files: rows,
      skipped: wireSkipped(round.skipped),
      skippedCount: round.skippedCount,
    });
    if (!answer.success) return fail("E_INTERNAL", "The review could not be completed.");
    return answer.data;
  };
}

export function createReviewCompleteHandler(deps: ReviewHandlerDeps): Handler {
  return async (context: HandlerContext, payload: never) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    // Only the person's own attested connection completes a review, whatever the policy table says.
    if (context.identity.actor !== "user") return fail("E_NOT_FOUND", NOT_AVAILABLE);
    const request = reviewCompleteRequestSchema.safeParse(payload);
    if (!request.success) return fail("E_INVALID_ARGUMENT", "The review request is invalid.");
    const { runId } = request.data;
    let state: string | undefined;
    try {
      state = deps.journal.getRun(runId)?.state;
    } catch {
      return fail("E_INTERNAL", "The review could not be completed.");
    }
    if (state === undefined) return fail("E_NOT_FOUND", "The run was not found.");
    if (state !== "REVIEWING") return fail("E_CONFLICT", "The run is not waiting for review.", "not_reviewing");
    try {
      deps.journal.transitionRun(runId, "COMPLETED", { actor: userPrincipal(), expectedFrom: "REVIEWING" });
    } catch (e) {
      if (e instanceof AxisError && e.code === "E_CONFLICT") return fail("E_CONFLICT", "The run is not waiting for review.", "not_reviewing");
      return fail("E_INTERNAL", "The review could not be completed.");
    }
    // The run is completed now. A failure to read it back is reported as unavailable; a retry then finds it completed.
    let summary;
    try {
      summary = deps.runs.get(runId);
    } catch {
      return fail("E_UNAVAILABLE", "The run was completed but could not be read back.");
    }
    const answer = reviewCompleteResponseSchema.safeParse({ run: { ...summary, agentId: null } });
    if (!answer.success) return fail("E_INTERNAL", "The review could not be completed.");
    return answer.data;
  };
}

/** The handlers of this contract by method name, as the registry assembly (design section 4) expects them. */
export function createReviewHandlers(deps: ReviewHandlerDeps): { readonly diff: Handler; readonly complete: Handler } {
  return { diff: createReviewDiffHandler(deps), complete: createReviewCompleteHandler(deps) };
}
