// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  challengeReferenceSchema,
  makeError,
  negotiateVersion,
  parseClientMessage,
  responseEnvelopeSchema,
  type AxisError,
  type ChallengeReference,
  type ErrorCode,
  type Hello,
  type JsonValue,
  type RequestEnvelope,
  inspectMessage,
} from "@axis/protocol";
import { RateLimiter, newCorrelationId, payloadHash } from "./support.js";
import {
  DaemonError,
  type ApprovalGate,
  type Connection,
  type ContractRegistry,
  type DaemonAuditSink,
  type Handler,
  type IdempotencyKey,
  type IdempotencyStore,
  type Identity,
  type Policy,
} from "./types.js";

export interface SessionLimits {
  readonly maxInFlight: number;
  readonly maxMessagesPerSecond: number;
  readonly burst: number;
  readonly maxViolations: number;
  readonly handshakeTimeoutMs: number;
}

export interface SessionDeps {
  readonly registry: ContractRegistry;
  readonly handlers: ReadonlyMap<string, Handler>;
  readonly policy: Policy | undefined;
  readonly approvals: ApprovalGate | undefined;
  readonly idempotency: IdempotencyStore;
  readonly audit: DaemonAuditSink;
  readonly limits: SessionLimits;
  readonly now: () => number;
  /** Local diagnostics for unexpected failures. Receives the raw error: the sink must keep it local. */
  readonly onInternalError: ((correlationId: string, error: unknown) => void) | undefined;
  readonly onClosed: (session: Session) => void;
}

const CANCELLED = Symbol("cancelled");
const TIMED_OUT = Symbol("timed-out");
const CLOSED = Symbol("closed");

interface InFlight {
  readonly controller: AbortController;
  settled: boolean;
  timer: NodeJS.Timeout | undefined;
}

type Outcome = { ok: true; result: JsonValue } | { ok: false; error: AxisError };

const handlerKey = (contract: string, version: number, method: string): string => `${contract}/${version}#${method}`;

/** Only plain-data ids can be echoed in an error response; anything else gets no response. */
function extractId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.length >= 1 && id.length <= 64 ? id : undefined;
}

function pathsOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> }): string[] {
  const out = new Set<string>();
  for (const i of error.issues) out.add(i.path.map(String).join(".").slice(0, 64) || "(root)");
  return [...out].slice(0, 8);
}

/** One connection's state machine: handshake, then dispatch. */
export class Session {
  readonly #conn: Connection;
  readonly #identity: Identity;
  readonly #d: SessionDeps;
  readonly #limiter: RateLimiter;
  readonly #inFlight = new Map<string, InFlight>();
  #negotiated: ReadonlySet<string> | undefined;
  #version: number = PROTOCOL_VERSION;
  #violations = 0;
  #closed = false;
  #handshakeTimer: NodeJS.Timeout | undefined;

  constructor(conn: Connection, identity: Identity, deps: SessionDeps) {
    this.#conn = conn;
    this.#identity = Object.freeze({ ...identity });
    this.#d = deps;
    this.#limiter = new RateLimiter(deps.limits.maxMessagesPerSecond, deps.limits.burst, deps.now);
    this.#handshakeTimer = setTimeout(() => {
      if (!this.#negotiated) this.close();
    }, deps.limits.handshakeTimeoutMs);
    this.#handshakeTimer.unref();
  }

  get identity(): Identity {
    return this.#identity;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    for (const entry of this.#inFlight.values()) {
      if (!entry.settled) {
        entry.settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.controller.abort(CLOSED);
      }
    }
    this.#inFlight.clear();
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
    this.#d.onClosed(this);
  }

  /** The transport reported the peer is gone: cancel everything, send nothing. */
  onPeerClosed(): void {
    this.close();
  }

  // ---- inbound ----

  handle(raw: unknown): void {
    if (this.#closed) return;
    if (!this.#limiter.tryTake()) {
      this.#violation();
      const id = extractId(raw);
      if (id !== undefined && this.#negotiated) this.#reply(id, { ok: false, error: this.#err("E_BACKPRESSURE", "Too many messages; slow down") });
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.#violation();
      if (!this.#negotiated) return this.#rejectHello(this.#err("E_INVALID_ARGUMENT", "Malformed handshake", { reason: parsed.reason }), true);
      const id = extractId(raw);
      if (id !== undefined) this.#reply(id, { ok: false, error: this.#err("E_INVALID_ARGUMENT", "Malformed message", { reason: parsed.reason }) });
      return;
    }
    const msg = parsed.message;
    if ("type" in msg) {
      if (this.#negotiated) {
        this.#violation(); // a second hello is a protocol error
        return;
      }
      this.#hello(msg);
      return;
    }
    if (!this.#negotiated) {
      this.#violation();
      if (!("cancel" in msg)) {
        this.#send({ v: this.#version, id: msg.id, ok: false, error: this.#err("E_UNAUTHENTICATED", "Complete the handshake first") });
      }
      this.close();
      return;
    }
    if ("cancel" in msg) {
      this.#cancel(msg.cancel);
      return;
    }
    void this.#request(msg);
  }

  #violation(): void {
    if (++this.#violations > this.#d.limits.maxViolations) this.close();
  }

  // ---- handshake ----

  #hello(hello: Hello): void {
    const version = negotiateVersion(hello.protocolVersions);
    if (!version.ok) {
      this.#rejectHello(this.#err("E_VERSION_UNSUPPORTED", "No common protocol version"), true);
      return;
    }
    const chosen: Array<{ id: string; version: number }> = [];
    for (const offered of hello.contracts) {
      const served = this.#d.registry.versions(offered.id);
      const common = served.filter((v) => offered.versions.includes(v));
      const best = common.length > 0 ? Math.max(...common) : undefined;
      if (best !== undefined) chosen.push({ id: offered.id, version: best });
    }
    if (chosen.length === 0) {
      this.#rejectHello(this.#err("E_VERSION_UNSUPPORTED", "No offered contract is served"), true);
      return;
    }
    this.#version = version.version;
    this.#negotiated = new Set(chosen.map((c) => `${c.id}/${c.version}`));
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#send({
      type: "welcome",
      protocolVersion: version.version,
      contracts: chosen,
      limits: {
        maxMessageBytes: 1_048_576,
        maxInFlight: this.#d.limits.maxInFlight,
        maxTimeoutMs: MAX_TIMEOUT_MS,
      },
    });
  }

  #rejectHello(error: AxisError, closeAfter: boolean): void {
    this.#send({ type: "hello-rejected", error });
    if (closeAfter) this.close();
  }

  // ---- requests ----

  #cancel(id: string): void {
    const entry = this.#inFlight.get(id);
    if (entry && !entry.settled) entry.controller.abort(CANCELLED);
  }

  async #request(req: RequestEnvelope): Promise<void> {
    const d = this.#d;
    const id = req.id;
    if (this.#inFlight.has(id)) {
      this.#violation();
      this.#reply(id, { ok: false, error: this.#err("E_CONFLICT", "That request id is already in flight") });
      return;
    }
    if (this.#inFlight.size >= d.limits.maxInFlight) {
      this.#reply(id, { ok: false, error: this.#err("E_BACKPRESSURE", "Too many requests in flight") });
      return;
    }
    const contractKey = `${req.contract}/${req.contractVersion}`;
    if (!this.#negotiated?.has(contractKey)) {
      const known = d.registry.versions(req.contract).length > 0;
      this.#reply(id, {
        ok: false,
        error: known
          ? this.#err("E_VERSION_UNSUPPORTED", "That contract version was not negotiated")
          : this.#err("E_METHOD_NOT_FOUND", "Unknown contract"),
      });
      return;
    }
    const spec = d.registry.lookup(req.contract, req.contractVersion, req.method);
    if (!spec) {
      this.#reply(id, { ok: false, error: this.#err("E_METHOD_NOT_FOUND", "Unknown method") });
      return;
    }

    const controller = new AbortController();
    const entry: InFlight = { controller, settled: false, timer: undefined };
    this.#inFlight.set(id, entry);
    const timeoutMs = Math.min(spec.timeoutMs, req.timeoutMs ?? Infinity, MAX_TIMEOUT_MS);
    entry.timer = setTimeout(() => controller.abort(TIMED_OUT), timeoutMs);
    entry.timer.unref();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => undefined);
    controller.signal.addEventListener(
      "abort",
      () => {
        const reason: unknown = controller.signal.reason;
        if (reason === CLOSED) return;
        this.#finish(id, entry, {
          ok: false,
          error:
            reason === TIMED_OUT
              ? this.#err("E_TIMEOUT", "The request took too long")
              : this.#err("E_CANCELLED", "The request was cancelled"),
        });
      },
      { once: true },
    );

    const correlationId = newCorrelationId();
    let idemKey: IdempotencyKey | undefined;
    let idemDone = false;
    try {
      const outcome = await Promise.race([this.#pipeline(req, spec, correlationId, controller.signal, (k) => (idemKey = k), () => (idemDone = true)), aborted]);
      this.#finish(id, entry, outcome);
    } catch (error) {
      if (error === CANCELLED || error === TIMED_OUT || error === CLOSED) return; // already answered
      this.#finish(id, entry, { ok: false, error: this.#sanitise(error, correlationId) });
    } finally {
      if (idemKey && !idemDone) {
        try {
          await d.idempotency.abandon(idemKey);
        } catch (e) {
          d.onInternalError?.(correlationId, e);
        }
      }
    }
  }

  async #pipeline(
    req: RequestEnvelope,
    spec: NonNullable<ReturnType<ContractRegistry["lookup"]>>,
    correlationId: string,
    signal: AbortSignal,
    setKey: (k: IdempotencyKey) => void,
    markDone: () => void,
  ): Promise<Outcome> {
    const d = this.#d;
    const target = `${req.contract}/${req.method}`;

    // 1. payload schema (strict objects: unknown keys are refused)
    const payloadParsed = spec.request.safeParse(req.payload);
    if (!payloadParsed.success) {
      return { ok: false, error: this.#err("E_INVALID_ARGUMENT", "Invalid request", { fields: pathsOf(payloadParsed.error), correlationId }, correlationId) };
    }
    if (spec.idempotency === "required" && req.idempotencyKey === undefined) {
      return { ok: false, error: this.#err("E_INVALID_ARGUMENT", "This method requires an idempotency key", undefined, correlationId) };
    }

    // 2. policy (default deny) and tier
    const decision = d.policy
      ? await d.policy.evaluate({
          identity: this.#identity,
          contract: req.contract,
          version: req.contractVersion,
          method: req.method,
          sideEffect: spec.sideEffect,
          tier: spec.tier,
        })
      : ({ effect: "deny" } as const);
    const tier = decision.effect === "allow" ? Math.max(spec.tier, decision.tier ?? 0) : spec.tier;
    const audit = (outcome: "success" | "failure" | "denied" | "error", extra: Record<string, string | number | boolean | null>, action: "policy.decision" | "rpc.execute" = "policy.decision") =>
      d.audit.append({
        actor: this.#identity.actor,
        action,
        target,
        outcome,
        payload: { tier, sideEffect: spec.sideEffect, connectionId: this.#identity.connectionId, ...extra },
      });
    if (decision.effect !== "allow") {
      audit("denied", { decision: "deny" });
      return { ok: false, error: this.#err("E_POLICY_DENIED", "Not permitted", undefined, correlationId) };
    }

    // 3. idempotency: a replay returns the stored result without asking for approval again
    const hash = payloadHash(req.payload);
    let key: IdempotencyKey | undefined;
    if (req.idempotencyKey !== undefined && spec.idempotency !== "none") {
      key = {
        actorId: this.#identity.actorId,
        contract: req.contract,
        version: req.contractVersion,
        method: req.method,
        key: req.idempotencyKey,
      };
      const begun = await d.idempotency.begin(key, hash);
      if (begun.state === "replay") {
        audit("success", { decision: "allow", replay: true });
        return { ok: true, result: begun.result };
      }
      if (begun.state === "conflict") {
        audit("denied", { decision: "allow", reason: "idempotency_conflict" });
        return { ok: false, error: this.#err("E_IDEMPOTENCY_CONFLICT", "That idempotency key was used with a different request", undefined, correlationId) };
      }
      if (begun.state === "in-progress") {
        audit("denied", { decision: "allow", reason: "in_progress" });
        return { ok: false, error: this.#err("E_CONFLICT", "A request with that key is still running", undefined, correlationId) };
      }
      setKey(key);
    }

    // 4. approval for tier >= 3 (fail closed when no gate is configured)
    let confirmation: unknown;
    if (tier >= 3) {
      if (!d.approvals) {
        audit("denied", { decision: "allow", reason: "no_approval_gate" });
        return { ok: false, error: this.#err("E_POLICY_DENIED", "Not permitted", undefined, correlationId) };
      }
      const outcome = await d.approvals.check({
        identity: this.#identity,
        contract: req.contract,
        method: req.method,
        tier,
        payload: req.payload,
        payloadHash: hash,
        ...(approvalOf(req.payload) ? { approval: approvalOf(req.payload) as ChallengeReference } : {}),
        ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
      });
      if (outcome.status === "required") {
        audit("denied", { decision: "allow", reason: "approval_required" });
        return {
          ok: false,
          error: this.#err("E_APPROVAL_REQUIRED", "Confirmation required", { challenge: outcome.challenge as unknown as JsonValue }, correlationId),
        };
      }
      if (outcome.status === "denied") {
        audit("denied", { decision: "allow", reason: "approval_denied" });
        return { ok: false, error: this.#err("E_POLICY_DENIED", "Not permitted", undefined, correlationId) };
      }
      confirmation = outcome.confirmation;
    }
    audit("success", { decision: "allow" });
    if (signal.aborted) throw signal.reason;

    // 5. execute
    const handler = d.handlers.get(handlerKey(req.contract, req.contractVersion, req.method));
    if (!handler) return { ok: false, error: this.#err("E_UNAVAILABLE", "This method is not available right now", undefined, correlationId) };
    const sideEffecting = spec.sideEffect !== "none" && spec.sideEffect !== "read";
    let raw: unknown;
    try {
      raw = await (handler as (c: unknown, p: unknown) => unknown)(
        {
          identity: this.#identity,
          requestId: req.id,
          correlationId,
          ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
          signal,
          ...(confirmation !== undefined ? { confirmation } : {}),
        },
        payloadParsed.data,
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const wire = this.#sanitise(error, correlationId);
      if (sideEffecting) this.#auditCompletion(audit, "error", wire.code);
      return { ok: false, error: wire };
    }

    // 6. the response must match the contract exactly: this is what stops a handler leaking extra fields
    const checked = spec.response.safeParse(raw ?? null);
    if (!checked.success || !inspectMessage(checked.data).ok) {
      d.onInternalError?.(correlationId, new Error("handler response violates its contract"));
      if (sideEffecting) this.#auditCompletion(audit, "error", "E_INTERNAL");
      return { ok: false, error: this.#err("E_INTERNAL", "Internal error", undefined, correlationId) };
    }
    const result = checked.data as JsonValue;
    if (key) {
      try {
        await d.idempotency.complete(key, result);
        markDone();
      } catch (e) {
        d.onInternalError?.(correlationId, e);
      }
    }
    if (sideEffecting) this.#auditCompletion(audit, "success", null);
    return { ok: true, result };
  }

  /** The action already happened: an audit failure here is reported locally and must not change the answer. */
  #auditCompletion(
    audit: (o: "success" | "failure" | "denied" | "error", e: Record<string, string | number | boolean | null>, a?: "policy.decision" | "rpc.execute") => unknown,
    outcome: "success" | "error",
    code: string | null,
  ): void {
    try {
      audit(outcome, code === null ? { phase: "completed" } : { phase: "completed", code }, "rpc.execute");
    } catch (e) {
      this.#d.onInternalError?.("audit", e);
    }
  }

  // ---- outbound ----

  #err(code: ErrorCode, message: string, details?: Record<string, unknown>, correlationId: string = newCorrelationId()): AxisError {
    return makeError(code, message, correlationId, details as Record<string, JsonValue> | undefined);
  }

  /** Nothing but a deliberate DaemonError ever reaches the wire with its own text; everything else is an opaque E_INTERNAL. */
  #sanitise(error: unknown, correlationId: string): AxisError {
    if (error instanceof DaemonError) {
      const wire = makeError(error.code, error.message, correlationId, error.details === undefined ? undefined : { ...error.details });
      return responseEnvelopeSchema.safeParse({ v: this.#version, id: "x", ok: false, error: wire }).success
        ? wire
        : makeError("E_INTERNAL", "Internal error", correlationId);
    }
    this.#d.onInternalError?.(correlationId, error);
    return makeError("E_INTERNAL", "Internal error", correlationId);
  }

  #finish(id: string, entry: InFlight, outcome: Outcome): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.#inFlight.delete(id);
    this.#reply(id, outcome);
  }

  #reply(id: string, outcome: Outcome): void {
    const message = outcome.ok
      ? { v: this.#version, id, ok: true as const, result: outcome.result }
      : { v: this.#version, id, ok: false as const, error: outcome.error };
    const checked = responseEnvelopeSchema.safeParse(message);
    if (checked.success) {
      this.#send(checked.data);
    } else {
      this.#send({ v: this.#version, id, ok: false, error: makeError("E_INTERNAL", "Internal error", newCorrelationId()) });
    }
  }

  #send(message: unknown): void {
    if (this.#closed) return;
    try {
      this.#conn.send(message);
    } catch {
      this.close();
    }
  }
}

function approvalOf(payload: JsonValue): ChallengeReference | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const candidate = (payload as Record<string, JsonValue>)["approval"];
  const parsed = challengeReferenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export { handlerKey };
