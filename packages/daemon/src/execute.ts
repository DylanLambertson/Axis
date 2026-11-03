// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { inspectMessage, makeError, type ErrorCode, type JsonValue } from "@axis/protocol";
import type { Auditor } from "./audit.js";
import { toWireError } from "./errors.js";
import { TIMED_OUT, handlerKey, type Outcome, type PipelineInput } from "./pipeline.js";
import type { ConfirmedAction } from "./types.js";

export class Aborted extends Error {}

const abortCode = (reason: unknown): ErrorCode => (reason === TIMED_OUT ? "E_TIMEOUT" : "E_CANCELLED");

/** A frozen copy whose `capability` is non-enumerable: it never shows up in JSON, spreads or `inspect`. */
function readOnly(c: ConfirmedAction): ConfirmedAction {
  const copy: { method: string; target: string; requester: string } = { method: c.method, target: c.target, requester: c.requester };
  if (c.capability !== undefined) Object.defineProperty(copy, "capability", { value: c.capability, enumerable: false });
  return Object.freeze(copy);
}

export interface ActionInput {
  readonly p: PipelineInput;
  readonly auditor: Auditor;
  readonly tier: number;
  /** Set exactly when the approval gate ran this inside a spent approval (tier >= 3). */
  readonly confirmed: ConfirmedAction | undefined;
  /** A stored result to return instead of running the handler (a gated replay). */
  readonly replayed: JsonValue | undefined;
  /** The parsed payload without its `approval` field: handlers never see an approval reference. */
  readonly data: JsonValue;
}

/**
 * The part of a request that happens after policy, idempotency and approval:
 * the decision audit, the handler and the response check. For tier >= 3 it
 * runs inside the gate's `execute`, so it can only be reached with a spent
 * approval; the check below is an invariant, not the enforcement.
 */
export async function runAction(a: ActionInput): Promise<Outcome> {
  const { p, auditor, tier, confirmed, replayed, data } = a;
  const { deps: d, identity, req, spec, correlationId, signal } = p;
  const fail = (code: ErrorCode, message: string): Outcome => ({ ok: false, error: makeError(code, message, correlationId) });
  if (tier >= 3 && confirmed === undefined) {
    d.onInternalError?.(correlationId, new Error("invariant: a tier >= 3 action ran without a spent approval"));
    return fail("E_INTERNAL", "Internal error");
  }
  await auditor.strict("success", replayed === undefined ? { decision: "allow" } : { decision: "allow", replay: true });
  if (signal.aborted) throw new Aborted();
  if (replayed !== undefined) return { ok: true, result: replayed };

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
        ...(confirmed !== undefined ? { approved: readOnly(confirmed) } : {}),
      },
      data,
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

  // The response must match the contract exactly: this is what stops a handler leaking extra fields.
  const checked = spec.response.safeParse(raw ?? null);
  if (!checked.success || !inspectMessage(checked.data).ok) {
    d.onInternalError?.(correlationId, new Error("handler response violates its contract"));
    if (sideEffecting) await auditor.soft("error", { phase: "completed", result: "failed", code: "E_INTERNAL" }, "rpc.execute");
    return fail("E_INTERNAL", "Internal error");
  }
  if (sideEffecting) await auditor.soft("success", { phase: "completed", result: "done" }, "rpc.execute");
  return { ok: true, result: checked.data as JsonValue };
}
