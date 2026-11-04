// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { challengeReferenceSchema, challengeSchema, makeError, type ChallengeReference, type ErrorCode, type JsonValue } from "@axis/protocol";
import type { Auditor } from "./audit.js";
import { requestDigest, withoutApproval } from "./digest.js";
import { CONTROL_CHARS } from "./errors.js";
import { Aborted } from "./execute.js";
import { ShuttingDown, handlerKey, withdrawChallenge, withdrawIfUnspent, type Outcome, type PipelineInput, type PipelineState } from "./pipeline.js";
import {
  ApprovalError,
  type ApprovalContentLock,
  type ApprovalInput,
  type ConfirmedAction,
} from "./types.js";

export function approvalOf(payload: JsonValue): ChallengeReference | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const parsed = challengeReferenceSchema.safeParse((payload as Record<string, JsonValue>)["approval"]);
  return parsed.success ? parsed.data : undefined;
}

/** A content hook returned something the approval cannot be bound to: the integrator's bug, never the client's. */
class ContentHookError extends Error {}

const TARGET_MAX = 1024;
const checkTarget = (target: unknown): void => {
  if (typeof target !== "string" || target.length === 0 || target.length > TARGET_MAX || CONTROL_CHARS.test(target)) {
    throw new ContentHookError("a content hook returned a target that is not a non-empty display-safe string");
  }
};
const checkDigest = (digest: unknown): void => {
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ContentHookError("a content hook produced a content digest that is not 64 lowercase hex characters");
  }
};

/** Thrown out of the action so the approval manager records a failed handler as failed; the pipeline unwraps it. */
class HandlerFailed extends Error {}

export interface ApprovalStep {
  readonly p: PipelineInput;
  readonly state: PipelineState;
  readonly auditor: Auditor;
  readonly tier: number;
  /** The parsed payload without its `approval` field. */
  readonly data: JsonValue;
  /** Policy, replay and handler: runs only inside a spent approval. */
  readonly action: (confirmed: ConfirmedAction) => Promise<Outcome>;
}

/** Does the method's request schema accept an `approval` reference next to this payload? */
export function acceptsApproval(spec: PipelineInput["spec"], data: JsonValue): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  return spec.request.safeParse({ ...(data as Record<string, JsonValue>), approval: { challengeId: "A".repeat(43) } }).success;
}

/**
 * Tier >= 3: issue a challenge when the request has no approval; otherwise
 * spend it (the gate's `execute`) with the handler running inside the action,
 * under the method's content lock. What goes on the wire is the outcome the
 * action itself produced, never `execute`'s return value.
 */
export async function runApproval(a: ApprovalStep): Promise<Outcome> {
  const { p, state, auditor, tier, data, action } = a;
  const { deps: d, identity, req, correlationId, signal } = p;
  const fail = (code: ErrorCode, message: string, details?: Record<string, JsonValue>): Outcome => ({
    ok: false,
    error: makeError(code, message, correlationId, details),
  });
  const guard = (): void => {
    if (signal.aborted) throw new Aborted();
  };
  const gate = d.approvals;
  if (!gate) {
    await auditor.soft("denied", { decision: "allow", reason: "no_approval_gate" });
    return fail("E_POLICY_DENIED", "Not permitted");
  }
  const approval = approvalOf(req.payload);
  if (!approval && !acceptsApproval(p.spec, data)) {
    // The user must never be asked to approve something that can never pass the schema (a policy-raised tier).
    await auditor.soft("denied", { decision: "allow", reason: "not_approvable" });
    return fail("E_POLICY_DENIED", "Not permitted");
  }
  if (approval) {
    state.approval = approval;
    signal.addEventListener("abort", () => void withdrawIfUnspent(p, state), { once: true });
  }
  const input: ApprovalInput = {
    identity,
    actor: identity.actor,
    connectionId: identity.connectionId,
    requestId: req.id,
    correlationId,
    contract: req.contract,
    contractVersion: req.contractVersion,
    method: req.method,
    tier,
    args: withoutApproval(req.payload),
    digest: requestDigest(req.contract, req.contractVersion, req.method, req.payload),
    ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
    signal,
  };
  let lock: ApprovalContentLock;
  try {
    lock = await resolveContent(p, data, input.digest);
  } catch (e) {
    await auditor.soft("error", { decision: "allow", reason: "content_hook_error" });
    throw e;
  }
  guard();
  const hookBug = async (e: ContentHookError): Promise<Outcome> => {
    await auditor.soft("error", { decision: "allow", reason: "content_hook_error" });
    d.onInternalError?.(correlationId, e);
    return fail("E_INTERNAL", "Internal error");
  };

  if (!approval) {
    let contentDigest: string;
    try {
      contentDigest = await lock.withLock((cd) => {
        checkDigest(cd);
        return Promise.resolve(cd);
      });
    } catch (e) {
      if (e instanceof ContentHookError) return hookBug(e);
      throw e;
    }
    guard();
    let challenge;
    try {
      challenge = await gate.issue(input, { target: lock.target, contentDigest });
    } catch (e) {
      const refused = await refusal(e, auditor, fail);
      if (refused) return refused;
      throw e;
    }
    if (signal.aborted) {
      // The caller is gone (an async issue finished late, possibly after the connection's own withdrawal): drop the challenge.
      await withdrawChallenge(p, (challenge as { challengeId?: unknown } | undefined)?.challengeId);
      throw new Aborted();
    }
    // A malformed challenge is a gate bug: the audit row says so and the client gets a bare E_INTERNAL.
    if (!challengeSchema.safeParse(challenge).success) {
      await auditor.soft("error", { decision: "allow", reason: "approval_gate_error" });
      d.onInternalError?.(correlationId, new Error("the approval gate returned a malformed challenge"));
      return fail("E_INTERNAL", "Internal error");
    }
    await auditor.soft("denied", { decision: "allow", reason: "approval_required" });
    return fail("E_APPROVAL_REQUIRED", "Confirmation required", { challenge: challenge as unknown as JsonValue });
  }

  // Spend the approval and run the action inside it, under the content lock. The action runs at most once.
  let started = false;
  let completedAtReturn = false;
  let captured: Outcome | undefined;
  let pending: Promise<unknown> | undefined;
  const wrapped = (confirmed: ConfirmedAction): Promise<Outcome> => {
    if (started) return Promise.reject(new Error("the approval action may run only once"));
    started = true;
    state.spent = true;
    pending = (async () => {
      const outcome = await action(confirmed);
      captured = outcome;
      // A failed handler fails the action, so the approval manager audits it as failed; the pipeline unwraps this below.
      if (!outcome.ok) throw new HandlerFailed();
      return outcome;
    })();
    return pending as Promise<Outcome>;
  };
  const settle = async (): Promise<void> => {
    // Never answer, and so never free the slot, while the handler may still be running.
    if (pending) await pending.catch(() => undefined);
  };
  let refusedForShutdown = false;
  try {
    await lock.withLock((contentDigest) => {
      checkDigest(contentDigest);
      if (d.draining?.()) {
        refusedForShutdown = true; // a flag, not the error type: a content lock that wraps errors must not turn this into E_INTERNAL
        throw new ShuttingDown(); // shutdown began: refuse before the approval is spent
      }
      return gate.execute(input, approval, { target: lock.target, contentDigest }, wrapped);
    });
    completedAtReturn = captured !== undefined;
  } catch (e) {
    await settle();
    if (refusedForShutdown && !started) {
      await auditor.soft("denied", { decision: "allow", reason: "shutting_down" });
      return fail("E_UNAVAILABLE", "The daemon is shutting down");
    }
    if (e instanceof ContentHookError && !started) return hookBug(e);
    const done = captured as Outcome | undefined;
    if (done && !done.ok) return done;
    if (started) throw e; // the action ran (aborted, audit failure) or the gate failed after it
    const refused = await refusal(e, auditor, fail);
    if (refused) return refused;
    throw e;
  }
  await settle();
  const outcome = captured as Outcome | undefined;
  if (!started || outcome === undefined) {
    if (signal.aborted) throw new Aborted();
    await auditor.soft("error", { decision: "allow", reason: "approval_not_executed" });
    d.onInternalError?.(correlationId, new Error("the approval gate returned without running the action"));
    return fail("E_INTERNAL", "Internal error");
  }
  if (!completedAtReturn) {
    await auditor.soft("error", { decision: "allow", reason: "approval_action_unawaited" });
    d.onInternalError?.(correlationId, new Error("the approval gate returned before the action completed"));
    return fail("E_INTERNAL", "Internal error");
  }
  return outcome;
}

/** A gate refusal as an answer, or undefined for anything else. */
async function refusal(
  e: unknown,
  auditor: Auditor,
  fail: (code: ErrorCode, message: string) => Outcome,
): Promise<Outcome | undefined> {
  if (!(e instanceof ApprovalError) || e.executed) return undefined;
  switch (e.code) {
    case "E_CONFLICT":
      await auditor.soft("denied", { decision: "allow", reason: "approval_conflict" });
      return fail("E_CONFLICT", "The confirmation is no longer valid; confirm again");
    case "E_BACKPRESSURE":
      await auditor.soft("denied", { decision: "allow", reason: "approval_backpressure" });
      return fail("E_BACKPRESSURE", "Too many confirmations are waiting; resolve or wait for them to expire");
    case "E_INVALID_ARGUMENT":
      await auditor.soft("denied", { decision: "allow", reason: "approval_invalid" });
      return fail("E_INVALID_ARGUMENT", "This request cannot be approved");
    default:
      await auditor.soft("denied", { decision: "allow", reason: "approval_refused" });
      return fail("E_POLICY_DENIED", "Not permitted");
  }
}

/** The target and the lock of a method's content: its hook, or `request:<digest>` with the digest as content. */
async function resolveContent(p: PipelineInput, payload: JsonValue, digest: string): Promise<ApprovalContentLock> {
  const hook = p.deps.contentHooks.get(handlerKey(p.req.contract, p.req.contractVersion, p.req.method));
  if (!hook) return { target: `request:${digest}`, withLock: (fn) => fn(digest) };
  const lock = await (hook as (c: unknown, payload: unknown) => ApprovalContentLock | Promise<ApprovalContentLock>)(
    { identity: p.identity, requestId: p.req.id, correlationId: p.correlationId, signal: p.signal },
    payload,
  );
  if (typeof lock?.withLock !== "function") throw new ContentHookError("an approval content hook returned no lock");
  checkTarget(lock.target);
  return lock;
}
