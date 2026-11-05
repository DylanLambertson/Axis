// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ChallengeError } from "@axis/challenge";
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { approvalsPendingResponseSchema, approvalsResolveResponseSchema, resolveChallengeRequestSchema } from "@axis/protocol";
import type { ApprovalsPort } from "../gate/approvals.js";

/**
 * `axis.approvals/1` (design section 4.2): `resolve` (the user's answer to a challenge, tier 2) and `pending` (the
 * open challenges of the caller's own window, tier 0).
 *
 * Who is calling comes from `ctx.identity` only; the payload names a challenge, a decision and the digest the user
 * saw, never an actor or a window. The policy table already allows `user` alone; the handler refuses any other actor
 * too, so an agent can never resolve even if a policy row were wrong. Every refusal of the manager for "not yours"
 * (an unknown id, another window, a non-user actor) is one answer, `E_NOT_FOUND`, so nothing shows which ids exist.
 * Errors are `DaemonError` with fixed text: never the manager's message, a challenge id, a digest or a proof. (A
 * handler cannot raise `E_POLICY_DENIED`: only the daemon decides that.)
 */
export interface ApprovalsHandlerDeps {
  readonly approvals: ApprovalsPort;
}

const NOT_AVAILABLE = "This confirmation is not available.";

function fail(code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT" | "E_BACKPRESSURE", message: string): never {
  throw new DaemonError(code, message, code === "E_CONFLICT" ? { reason: "not_resolvable" } : undefined);
}

function mapManagerError(error: unknown): never {
  if (error instanceof ChallengeError) {
    switch (error.code) {
      case "E_POLICY_DENIED":
        return fail("E_NOT_FOUND", NOT_AVAILABLE);
      case "E_CONFLICT":
        return fail("E_CONFLICT", "This confirmation was already used or has ended.");
      case "E_INVALID_ARGUMENT":
        return fail("E_INVALID_ARGUMENT", "The confirmation request is invalid.");
      case "E_BACKPRESSURE":
        return fail("E_BACKPRESSURE", "Too many confirmations are waiting.");
      default:
        break;
    }
  }
  return fail("E_INTERNAL", "The confirmation could not be processed.");
}

export function createApprovalsResolveHandler(deps: ApprovalsHandlerDeps): Handler {
  return (context: HandlerContext, payload: never) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    const { identity } = context;
    // Defence in depth behind the policy row: only the user's own attested connection resolves.
    if (identity.actor !== "user") return fail("E_NOT_FOUND", NOT_AVAILABLE);
    // The daemon validated the payload against the contract; the picked fields are re-read from the parsed copy.
    const request = resolveChallengeRequestSchema.safeParse(payload);
    if (!request.success) return fail("E_INVALID_ARGUMENT", "The confirmation request is invalid.");
    let result;
    try {
      result = deps.approvals.resolve({ actor: identity.actor, windowId: identity.windowId }, request.data);
    } catch (e) {
      return mapManagerError(e);
    }
    const answer = approvalsResolveResponseSchema.safeParse({
      challengeId: result.challengeId,
      state: result.state,
      nativeRequired: result.nativeRequired,
    });
    if (!answer.success) return fail("E_INTERNAL", "The confirmation could not be processed.");
    return answer.data;
  };
}

export function createApprovalsPendingHandler(deps: ApprovalsHandlerDeps): Handler {
  return (context: HandlerContext) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    if (context.identity.actor !== "user") return fail("E_NOT_FOUND", NOT_AVAILABLE);
    let challenges;
    try {
      challenges = deps.approvals.pending(context.identity.windowId);
    } catch {
      return fail("E_INTERNAL", "The confirmation list is unavailable.");
    }
    const answer = approvalsPendingResponseSchema.safeParse({ challenges });
    if (!answer.success) return fail("E_INTERNAL", "The confirmation list is unavailable.");
    return answer.data;
  };
}

/** The handlers of this contract by method name, as the registry assembly (design section 4) expects them. */
export function createApprovalsHandlers(deps: ApprovalsHandlerDeps): { readonly resolve: Handler; readonly pending: Handler } {
  return { resolve: createApprovalsResolveHandler(deps), pending: createApprovalsPendingHandler(deps) };
}
