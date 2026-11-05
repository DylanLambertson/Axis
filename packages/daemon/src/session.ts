// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  makeError,
  negotiateVersion,
  parseClientMessage,
  responseEnvelopeSchema,
  type AxisError,
  type ErrorCode,
  type Hello,
  type RequestEnvelope,
} from "@axis/protocol";
import { newCorrelationId } from "./digest.js";
import type { DrainGate } from "./drain.js";
import type { OrphanTracker } from "./orphans.js";
import { CANCELLED, CLOSED, TIMED_OUT, runPipeline, type Outcome, type PipelineDeps } from "./pipeline.js";
import { RateLimiter } from "./support.js";
import type { Connection, Identity } from "./types.js";

export interface SessionLimits {
  readonly maxInFlight: number;
  readonly maxMessagesPerSecond: number;
  readonly burst: number;
  readonly maxViolations: number;
  readonly handshakeTimeoutMs: number;
}

export interface SessionDeps {
  readonly pipeline: PipelineDeps;
  readonly limits: SessionLimits;
  readonly now: () => number;
  readonly orphans: OrphanTracker;
  /** Graceful shutdown state (see drain.ts). */
  readonly drain: DrainGate;
  readonly onClosed: (session: Session) => void;
}

/**
 * One request. It holds its in-flight slot from admission until the pipeline
 * promise settles, however the caller was answered: an abort answers the
 * caller at once but the slot stays taken while the handler runs.
 */
interface InFlight {
  readonly controller: AbortController;
  /** The caller has been answered (or the session is closed). */
  answered: boolean;
  /** The pipeline promise has settled: nothing of this request is running. */
  settled: boolean;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Client note: use a new request id for every attempt. Re-sending an id after
 * E_TIMEOUT or E_CANCELLED while the abandoned handler still runs gets
 * E_CONFLICT (and counts as a violation); the id stays in flight until the
 * handler settles.
 */

/** Only plain-data ids can be echoed in an error response; anything else gets no response. */
function extractId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.length >= 1 && id.length <= 64 ? id : undefined;
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

  /**
   * `handshakeBudgetMs` is what is left of the handshake timeout after
   * verification, so verification and handshake together never take longer
   * than `limits.handshakeTimeoutMs`.
   */
  constructor(conn: Connection, identity: Identity, deps: SessionDeps, handshakeBudgetMs: number = deps.limits.handshakeTimeoutMs) {
    this.#conn = conn;
    this.#identity = Object.freeze({ ...identity });
    this.#d = deps;
    this.#limiter = new RateLimiter(deps.limits.maxMessagesPerSecond, deps.limits.burst, deps.now);
    this.#handshakeTimer = setTimeout(() => {
      if (!this.#negotiated) this.close();
    }, Math.max(1, handshakeBudgetMs)) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
    this.#handshakeTimer.unref();
  }

  get identity(): Identity {
    return this.#identity;
  }

  /** Requests whose handler (or pipeline) has not settled, answered or not. */
  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    // Slots are not freed here: a running handler keeps its entry (and the daemon-wide orphan count) until it settles.
    for (const entry of [...this.#inFlight.values()]) entry.controller.abort(CLOSED);
    // Challenges issued to this connection die with it (best effort, once).
    const gate = this.#d.pipeline.approvals;
    if (gate?.withdrawConnection) {
      const fail = (e: unknown): void => this.#d.pipeline.onInternalError?.("withdraw", e);
      try {
        void Promise.resolve(gate.withdrawConnection(this.#identity.connectionId)).catch(fail);
      } catch (e) {
        fail(e);
      }
    }
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
    this.#d.onClosed(this);
  }

  /**
   * Graceful shutdown (drain.ts): cancel every request whose caller has not been answered, through the
   * same path as a client `cancel`. Slots are untouched: they are released only when each pipeline settles.
   */
  cancelAll(): number {
    let n = 0;
    for (const [id, entry] of [...this.#inFlight]) {
      if (entry.answered) continue;
      this.#cancel(id);
      n++;
    }
    return n;
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
        // Not terminal: after a welcome, a hello-rejected only answers this extra hello and the session stays open.
        this.#rejectHello(this.#err("E_INVALID_ARGUMENT", "The handshake is already complete"), false);
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
    if (this.#d.drain.draining) {
      this.#rejectHello(this.#err("E_UNAVAILABLE", "The daemon is shutting down"), true);
      return;
    }
    const version = negotiateVersion(hello.protocolVersions);
    if (!version.ok) {
      this.#rejectHello(this.#err("E_VERSION_UNSUPPORTED", "No common protocol version"), true);
      return;
    }
    const chosen: Array<{ id: string; version: number }> = [];
    for (const offered of hello.contracts) {
      const served = this.#d.pipeline.registry.versions(offered.id);
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
    if (entry && !entry.answered) entry.controller.abort(CANCELLED);
  }

  async #request(req: RequestEnvelope): Promise<void> {
    const d = this.#d;
    const id = req.id;
    // Graceful shutdown: no handler starts once draining has begun.
    if (d.drain.draining) {
      this.#reply(id, { ok: false, error: this.#err("E_UNAVAILABLE", "The daemon is shutting down") });
      return;
    }
    if (this.#inFlight.has(id)) {
      this.#violation();
      this.#reply(id, { ok: false, error: this.#err("E_CONFLICT", "That request id is already in flight") });
      return;
    }
    if (this.#inFlight.size >= d.limits.maxInFlight) {
      this.#reply(id, { ok: false, error: this.#err("E_BACKPRESSURE", "Too many requests in flight") });
      return;
    }
    const refused = d.orphans.refusal(this.#identity.windowId);
    if (refused) {
      // Only this window pays for its own orphans; hammering on regardless ends in a close.
      if (refused === "window") this.#violation();
      this.#reply(id, { ok: false, error: this.#err("E_BACKPRESSURE", "Too many abandoned requests are still running") });
      return;
    }
    const contractKey = `${req.contract}/${req.contractVersion}`;
    if (!this.#negotiated?.has(contractKey)) {
      const known = d.pipeline.registry.versions(req.contract).length > 0;
      this.#reply(id, {
        ok: false,
        error: known
          ? this.#err("E_VERSION_UNSUPPORTED", "That contract version was not negotiated")
          : this.#err("E_METHOD_NOT_FOUND", "Unknown contract"),
      });
      return;
    }
    const spec = d.pipeline.registry.lookup(req.contract, req.contractVersion, req.method);
    if (!spec) {
      this.#reply(id, { ok: false, error: this.#err("E_METHOD_NOT_FOUND", "Unknown method") });
      return;
    }

    const controller = new AbortController();
    const entry: InFlight = { controller, answered: false, settled: false, timer: undefined };
    this.#inFlight.set(id, entry);
    d.drain.enter();
    const timeoutMs = Math.min(spec.timeoutMs, req.timeoutMs ?? Infinity, MAX_TIMEOUT_MS);
    entry.timer = setTimeout(() => controller.abort(TIMED_OUT), timeoutMs) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
    entry.timer.unref();

    const answer = (outcome: Outcome): void => {
      if (entry.answered) return;
      entry.answered = true;
      this.#reply(id, outcome);
    };
    controller.signal.addEventListener(
      "abort",
      () => {
        const reason: unknown = controller.signal.reason;
        if (!entry.settled && d.orphans.add(this.#identity.windowId)) {
          // A handler that ignores its signal is a bug someone has to find.
          d.pipeline.onInternalError?.("orphans", new Error(`window ${this.#identity.windowId} reached its orphan quota`));
        } // the caller is about to be told "done", the handler may still run
        if (reason === CLOSED) {
          entry.answered = true;
          return;
        }
        answer({
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
    const run = runPipeline({
      deps: d.pipeline,
      identity: this.#identity,
      req,
      spec,
      correlationId,
      signal: controller.signal,
      version: this.#version,
    });
    // `run` never rejects; the second handler is a backstop so a daemon bug cannot become an unhandled rejection.
    await run
      .then(answer, (error: unknown) => {
        d.pipeline.onInternalError?.(correlationId, error);
        answer({ ok: false, error: makeError("E_INTERNAL", "Internal error", correlationId) });
      })
      .finally(() => {
        entry.settled = true;
        d.drain.leave();
        if (entry.timer) clearTimeout(entry.timer);
        if (controller.signal.aborted) d.orphans.remove(this.#identity.windowId);
        this.#inFlight.delete(id);
      });
  }

  // ---- outbound ----

  #err(code: ErrorCode, message: string, details?: Record<string, string>): AxisError {
    return makeError(code, message, newCorrelationId(), details);
  }

  #reply(id: string, outcome: Outcome): void {
    const message = outcome.ok
      ? { v: this.#version, id, ok: true as const, result: outcome.result }
      : { v: this.#version, id, ok: false as const, error: outcome.error };
    const checked = responseEnvelopeSchema.safeParse(message);
    if (checked.success) {
      this.#send(checked.data);
      return;
    }
    // Keep the correlation id of the original answer so the replacement can still be joined to its audit rows.
    const correlationId = outcome.ok ? newCorrelationId() : outcome.error.correlationId;
    this.#d.pipeline.onInternalError?.(correlationId, new Error("outbound response failed schema validation"));
    this.#send({ v: this.#version, id, ok: false, error: makeError("E_INTERNAL", "Internal error", correlationId) });
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
