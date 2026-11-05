// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
    makeError,
  permissionTierSchema,
  type AxisError,
  type ChallengeReference,
  type ErrorCode,
  type JsonValue,
  type MethodSpec,
  type RequestEnvelope,
} from "@axis/protocol";
import { z } from "zod";
import { Auditor } from "./audit.js";
import { payloadHash, withoutApproval } from "./digest.js";
import { runApproval } from "./approval.js";
import { Aborted, runAction } from "./execute.js";
import {
  type ApprovalContentHook,
  type ApprovalGate,
  type ConfirmedAction,
  type ContractRegistry,
  type DaemonAuditSink,
  type Handler,
  type IdempotencyKey,
  type IdempotencyStore,
  type Identity,
  type Policy,
} from "./types.js";

export const CANCELLED = Symbol("cancelled");
export const TIMED_OUT = Symbol("timed-out");
export const CLOSED = Symbol("closed");

export type Outcome = { ok: true; result: JsonValue } | { ok: false; error: AxisError };

export interface PipelineDeps {
  readonly registry: ContractRegistry;
  readonly handlers: ReadonlyMap<string, Handler>;
  /** Optional per-method approval content hooks, by `handlerKey`. */
  readonly contentHooks: ReadonlyMap<string, ApprovalContentHook>;
  readonly policy: Policy | undefined;
  readonly approvals: ApprovalGate | undefined;
  readonly idempotency: IdempotencyStore;
  readonly audit: DaemonAuditSink;
  /** Local diagnostics for unexpected failures. Receives the raw error: the sink must keep it local. */
  readonly onInternalError: ((correlationId: string, error: unknown) => void) | undefined;
  /** Graceful shutdown has begun: a request that has not reached its handler or its approval spend is refused. */
  readonly draining?: () => boolean;
}

/** Thrown inside the approval step when shutdown began before the approval was spent. */
export class ShuttingDown extends Error {}

export interface PipelineInput {
  readonly deps: PipelineDeps;
  readonly identity: Identity;
  readonly req: RequestEnvelope;
  readonly spec: MethodSpec;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  /** The negotiated protocol version, for the wire-shape check of handler errors. */
  readonly version: number;
}

export interface PipelineState {
  key?: IdempotencyKey;
  /** The approval a retry carried, once the pipeline went to spend it. */
  approval?: ChallengeReference;
  /** The approval was spent (the action started). */
  spent?: boolean;
  withdrawn?: boolean;
  /** A side-effecting handler started and did not fail on its own: it returned, or it was aborted mid-call. */
  effectPossible?: boolean;
}

export const handlerKey = (contract: string, version: number, method: string): string =>
  `${contract}/${version}#${method}`;

/** What a policy may answer. Anything else is a deny (a malformed tier must never skip the gate). */
const policyDecisionSchema = z.discriminatedUnion("effect", [
  z.strictObject({ effect: z.literal("allow"), tier: permissionTierSchema.optional() }),
  z.strictObject({ effect: z.literal("deny") }),
]);



function pathsOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> }): string[] {
  const out = new Set<string>();
  for (const i of error.issues) out.add(i.path.map(String).join(".").slice(0, 64) || "(root)");
  return [...out].slice(0, 8);
}

const abortCode = (reason: unknown): ErrorCode => (reason === TIMED_OUT ? "E_TIMEOUT" : "E_CANCELLED");

/**
 * Runs one request through schema, policy, idempotency, approval and the
 * handler. It resolves only when the handler (if it started) has settled, and
 * it never rejects: the caller may stop waiting on timeout or cancel, but this
 * promise is what holds the in-flight slot and the idempotency key.
 *
 * The key is finalised after the body, whatever happened: stored on success,
 * freed on error, cancel or timeout, except after a side-effecting handler started and returned or was aborted: that stays unknown.
 */
export async function runPipeline(p: PipelineInput): Promise<Outcome> {
  const state: PipelineState = {};
  let outcome: Outcome;
  try {
    outcome = await steps(p, state);
  } catch (error) {
    // Handler errors were already mapped inside `steps`; whatever reaches here is the daemon's own failure
    // (a throwing policy, gate or store, a failed audit write) and is never shown to the peer.
    if (!p.signal.aborted) p.deps.onInternalError?.(p.correlationId, error);
    outcome = {
      ok: false,
      error: makeError(
        p.signal.aborted ? abortCode(p.signal.reason) : "E_INTERNAL",
        p.signal.aborted ? "The request did not complete" : "Internal error",
        p.correlationId,
      ),
    };
  }
  await finaliseKey(p, state.key, outcome, state.effectPossible === true);
  return outcome;
}

/**
 * A cancel or timeout before the approval was spent withdraws it, once. This
 * runs from the abort event, not after the pipeline settles: the gate may be
 * the very thing that is stuck. A close is covered by `withdrawConnection`.
 */
export async function withdrawIfUnspent(p: PipelineInput, state: PipelineState): Promise<void> {
  const gate = p.deps.approvals;
  if (!gate?.withdraw || !state.approval || state.spent || state.withdrawn) return;
  if (!p.signal.aborted || p.signal.reason === CLOSED) return;
  state.withdrawn = true;
  await withdrawChallenge(p, state.approval.challengeId);
}

/** Best effort: drop a challenge (once per call site) and report a failure locally. */
export async function withdrawChallenge(p: PipelineInput, challengeId: unknown): Promise<void> {
  const gate = p.deps.approvals;
  if (!gate?.withdraw || typeof challengeId !== "string") return;
  try {
    await gate.withdraw(challengeId, { actor: p.identity.actor, connectionId: p.identity.connectionId });
  } catch (e) {
    p.deps.onInternalError?.(p.correlationId, e);
  }
}

async function finaliseKey(p: PipelineInput, key: IdempotencyKey | undefined, outcome: Outcome, effected: boolean): Promise<void> {
  if (!key) return;
  const store = p.deps.idempotency;
  if (outcome.ok) {
    try {
      await store.complete(key, outcome.result, p.identity.connectionId);
      return;
    } catch (e) {
      p.deps.onInternalError?.(p.correlationId, e);
    }
  }
  try {
    if (!effected) await store.abandon(key);
    // Fail closed: a store without markUnknown leaves the key in progress (unknown after a restart), never freed.
    else if (typeof store.markUnknown === "function") await store.markUnknown(key);
  } catch (e) {
    p.deps.onInternalError?.(p.correlationId, e);
  }
}

async function steps(p: PipelineInput, state: PipelineState): Promise<Outcome> {
  const { deps: d, identity, req, spec, correlationId, signal } = p;
  const fail = (code: ErrorCode, message: string, details?: Record<string, JsonValue>): Outcome => ({
    ok: false,
    error: makeError(code, message, correlationId, details),
  });
  const guard = (): void => {
    if (signal.aborted) throw new Aborted();
  };

  if (!permissionTierSchema.safeParse(spec.tier).success) {
    d.onInternalError?.(correlationId, new Error("method spec has an invalid tier"));
    return fail("E_INTERNAL", "Internal error");
  }
  const auditor = new Auditor(
    d.audit,
    {
      actor: identity.actor,
      target: `${req.contract}/${req.contractVersion}.${req.method}`,
      sideEffect: spec.sideEffect,
      connectionId: identity.connectionId,
      correlationId,
      workspaceId: identity.workspaceId ?? null,
      contractVersion: req.contractVersion,
    },
    spec.tier,
    d.onInternalError,
  );

  // 1. payload schema (strict objects: unknown keys are refused)
  const payloadParsed = spec.request.safeParse(req.payload);
  if (!payloadParsed.success) {
    return fail("E_INVALID_ARGUMENT", "Invalid request", { fields: pathsOf(payloadParsed.error) });
  }
  if (spec.idempotency === "required" && req.idempotencyKey === undefined) {
    return fail("E_INVALID_ARGUMENT", "This method requires an idempotency key");
  }

  // 2. policy (default deny, validated) and tier
  let decision: z.infer<typeof policyDecisionSchema> = { effect: "deny" };
  let denyReason: string | undefined;
  if (d.policy) {
    let answer: unknown;
    try {
      answer = await d.policy.evaluate({
        identity,
        contract: req.contract,
        version: req.contractVersion,
        method: req.method,
        sideEffect: spec.sideEffect,
        tier: spec.tier,
      });
    } catch (e) {
      await auditor.soft("error", { decision: "error", reason: "policy_error" });
      throw e;
    }
    const checked = policyDecisionSchema.safeParse(answer);
    if (checked.success) decision = checked.data;
    else denyReason = "invalid_policy_decision";
  }
  guard();
  auditor.tier = decision.effect === "allow" ? Math.max(spec.tier, decision.tier ?? 0) : spec.tier;
  const tier = auditor.tier;
  if (decision.effect !== "allow") {
    await auditor.soft("denied", { decision: "deny", ...(denyReason ? { reason: denyReason } : {}) });
    return fail("E_POLICY_DENIED", "Not permitted");
  }

  // 3. idempotency: a replay returns the stored result; a tier >= 3 replay from another connection asks again
  let replayed: JsonValue | undefined;
  if (req.idempotencyKey !== undefined && spec.idempotency !== "none") {
    const key: IdempotencyKey = {
      actorId: identity.actorId,
      workspaceId: identity.workspaceId ?? "",
      contract: req.contract,
      version: req.contractVersion,
      method: req.method,
      key: req.idempotencyKey,
    };
    const begun = await d.idempotency.begin(key, payloadHash(req.payload));
    if (begun.state === "new") state.key = key;
    guard();
    switch (begun.state) {
      case "conflict":
        await auditor.soft("denied", { decision: "allow", reason: "idempotency_conflict" });
        return fail("E_IDEMPOTENCY_CONFLICT", "That idempotency key was used with a different request");
      case "in-progress":
        await auditor.soft("denied", { decision: "allow", reason: "in_progress" });
        return fail("E_CONFLICT", "A request with that key is still running", { reason: "in-progress" });
      case "unknown":
        await auditor.soft("denied", { decision: "allow", reason: "idempotency_unknown" });
        return fail("E_CONFLICT", "The outcome of an earlier request with that key is unknown; check the result, then use a new key", {
          reason: "outcome-unknown",
          cause: begun.reason,
        });
      case "exhausted":
        await auditor.soft("denied", { decision: "allow", reason: "idempotency_exhausted" });
        return fail("E_BACKPRESSURE", "Too many idempotency keys in use");
      case "replay":
        if (tier < 3 || begun.origin === identity.connectionId) {
          await auditor.strict("success", { decision: "allow", replay: true });
          return { ok: true, result: begun.result };
        }
        replayed = begun.result; // another connection: the approval gate runs again, and only then is the stored result returned
        break;
      case "new":
        break;
    }
  }
  // Shutdown began while this request was parked in policy, idempotency or audit: nothing has run or been spent yet.
  if (d.draining?.()) {
    await auditor.soft("denied", { decision: "allow", reason: "shutting_down" });
    return fail("E_UNAVAILABLE", "The daemon is shutting down");
  }
  const action = (confirmed: ConfirmedAction | undefined): Promise<Outcome> =>
    runAction({ p, state, auditor, tier, confirmed, replayed, data: withoutApprovalOf(payloadParsed.data) });
  if (tier < 3) return action(undefined);

  // 4. approval for tier >= 3 (fail closed when no gate is configured). The pipeline owns the whole sequence.
  return runApproval({ p, state, auditor, tier, data: withoutApprovalOf(payloadParsed.data), action });
}

function withoutApprovalOf(data: unknown): JsonValue {
  return withoutApproval(data as JsonValue);
}
