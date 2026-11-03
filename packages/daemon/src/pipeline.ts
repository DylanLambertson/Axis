// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
  inspectMessage,
  makeError,
  permissionTierSchema,
  challengeReferenceSchema,
  type AxisError,
  type ChallengeReference,
  type ErrorCode,
  type JsonValue,
  type MethodSpec,
  type RequestEnvelope,
} from "@axis/protocol";
import { z } from "zod";
import { Auditor } from "./audit.js";
import { payloadHash, requestDigest } from "./digest.js";
import { toWireError } from "./errors.js";
import type {
  ApprovalGate,
  ContractRegistry,
  DaemonAuditSink,
  Handler,
  IdempotencyKey,
  IdempotencyStore,
  Identity,
  Policy,
} from "./types.js";

export const CANCELLED = Symbol("cancelled");
export const TIMED_OUT = Symbol("timed-out");
export const CLOSED = Symbol("closed");

export type Outcome = { ok: true; result: JsonValue } | { ok: false; error: AxisError };

export interface PipelineDeps {
  readonly registry: ContractRegistry;
  readonly handlers: ReadonlyMap<string, Handler>;
  readonly policy: Policy | undefined;
  readonly approvals: ApprovalGate | undefined;
  readonly idempotency: IdempotencyStore;
  readonly audit: DaemonAuditSink;
  /** Local diagnostics for unexpected failures. Receives the raw error: the sink must keep it local. */
  readonly onInternalError: ((correlationId: string, error: unknown) => void) | undefined;
}

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

export const handlerKey = (contract: string, version: number, method: string): string =>
  `${contract}/${version}#${method}`;

/** What a policy may answer. Anything else is a deny (a malformed tier must never skip the gate). */
const policyDecisionSchema = z.discriminatedUnion("effect", [
  z.strictObject({ effect: z.literal("allow"), tier: permissionTierSchema.optional() }),
  z.strictObject({ effect: z.literal("deny") }),
]);

class Aborted extends Error {}

function pathsOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> }): string[] {
  const out = new Set<string>();
  for (const i of error.issues) out.add(i.path.map(String).join(".").slice(0, 64) || "(root)");
  return [...out].slice(0, 8);
}

function approvalOf(payload: JsonValue): ChallengeReference | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const parsed = challengeReferenceSchema.safeParse((payload as Record<string, JsonValue>)["approval"]);
  return parsed.success ? parsed.data : undefined;
}

const abortCode = (reason: unknown): ErrorCode => (reason === TIMED_OUT ? "E_TIMEOUT" : "E_CANCELLED");

/**
 * Runs one request through schema, policy, idempotency, approval and the
 * handler. It resolves only when the handler (if it started) has settled, and
 * it never rejects: the caller may stop waiting on timeout or cancel, but this
 * promise is what holds the in-flight slot and the idempotency key.
 *
 * The key is finalised after the body, whatever happened: stored on success,
 * freed on error, cancel or timeout.
 */
export async function runPipeline(p: PipelineInput): Promise<Outcome> {
  const state: { key?: IdempotencyKey } = {};
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
  await finaliseKey(p, state.key, outcome);
  return outcome;
}

async function finaliseKey(p: PipelineInput, key: IdempotencyKey | undefined, outcome: Outcome): Promise<void> {
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
    await store.abandon(key);
  } catch (e) {
    p.deps.onInternalError?.(p.correlationId, e);
  }
}

async function steps(p: PipelineInput, state: { key?: IdempotencyKey }): Promise<Outcome> {
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
      case "exhausted":
        await auditor.soft("denied", { decision: "allow", reason: "idempotency_exhausted" });
        return fail("E_BACKPRESSURE", "Too many idempotency keys in use");
      case "replay":
        if (tier < 3 || begun.origin === identity.connectionId) {
          await auditor.strict("success", { decision: "allow", replay: true });
          return { ok: true, result: begun.result };
        }
        replayed = begun.result;
        break;
      case "new":
        break;
    }
  }

  // 4. approval for tier >= 3 (fail closed when no gate is configured)
  let confirmation: unknown;
  if (tier >= 3) {
    if (!d.approvals) {
      await auditor.soft("denied", { decision: "allow", reason: "no_approval_gate" });
      return fail("E_POLICY_DENIED", "Not permitted");
    }
    const approval = approvalOf(req.payload);
    const answer = await d.approvals.check({
      identity,
      actor: identity.actor,
      connectionId: identity.connectionId,
      requestId: req.id,
      correlationId,
      contract: req.contract,
      contractVersion: req.contractVersion,
      method: req.method,
      tier,
      payload: req.payload,
      digest: requestDigest(req.contract, req.contractVersion, req.method, req.payload),
      ...(approval ? { approval } : {}),
      ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
      signal,
    });
    guard();
    if (answer.status === "required") {
      await auditor.soft("denied", { decision: "allow", reason: "approval_required" });
      return fail("E_APPROVAL_REQUIRED", "Confirmation required", { challenge: answer.challenge as unknown as JsonValue });
    }
    if (answer.status !== "confirmed") {
      await auditor.soft("denied", { decision: "allow", reason: "approval_denied" });
      return fail("E_POLICY_DENIED", "Not permitted");
    }
    confirmation = answer.confirmation;
  }
  await auditor.strict("success", replayed === undefined ? { decision: "allow" } : { decision: "allow", replay: true });
  guard();
  if (replayed !== undefined) return { ok: true, result: replayed };

  // 5. execute
  const handler = d.handlers.get(handlerKey(req.contract, req.contractVersion, req.method));
  if (!handler) return fail("E_UNAVAILABLE", "This method is not available right now");
  const sideEffecting = spec.sideEffect !== "none" && spec.sideEffect !== "read";
  let raw: unknown;
  try {
    raw = await (handler as (c: unknown, p: unknown) => unknown)(
      {
        identity,
        requestId: req.id,
        correlationId,
        ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
        signal,
        ...(confirmation !== undefined ? { confirmation } : {}),
      },
      payloadParsed.data,
    );
  } catch (error) {
    if (signal.aborted) {
      if (sideEffecting) await auditor.soft("failure", { phase: "completed", result: "aborted", code: abortCode(signal.reason) }, "rpc.execute");
      throw new Aborted();
    }
    const wire = toWireError(error, correlationId, p.version, d.onInternalError);
    if (sideEffecting) await auditor.soft("error", { phase: "completed", result: "failed", code: wire.code }, "rpc.execute");
    return { ok: false, error: wire };
  }

  // 6. the response must match the contract exactly: this is what stops a handler leaking extra fields
  const checked = spec.response.safeParse(raw ?? null);
  if (!checked.success || !inspectMessage(checked.data).ok) {
    d.onInternalError?.(correlationId, new Error("handler response violates its contract"));
    if (sideEffecting) await auditor.soft("error", { phase: "completed", result: "failed", code: "E_INTERNAL" }, "rpc.execute");
    return fail("E_INTERNAL", "Internal error");
  }
  if (sideEffecting) await auditor.soft("success", { phase: "completed", result: "done" }, "rpc.execute");
  return { ok: true, result: checked.data as JsonValue };
}
