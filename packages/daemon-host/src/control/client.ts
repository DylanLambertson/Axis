// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { ChainHead, JsonValue } from "@axis/protocol";
import type { Logger } from "../log/logger.js";
import type { Unsubscribe } from "../ports/common.js";
import type { ChannelMux } from "../transport/mux.js";
import {
  inboundMessageSchema,
  outboundMessageSchema,
  type Attestation,
  type InboundMessage,
  type OutboundMessage,
  type SettingKey,
} from "./messages.js";

/**
 * The typed side of the control plane: parses every inbound control message with the strict schemas, delivers events
 * to handlers, and runs the request/response pairs of design section 6.3 with a timeout, cancellation and a bound on
 * what is waiting. Answers are matched by the id they carry; one with no pending request is ignored and counted. A
 * request settles exactly once, and its timer and abort listener are gone when it does. Error text is fixed: it never
 * carries a challenge id, a proof or anything the supervisor sent.
 */

export const DEFAULT_TIMEOUTS_MS = Object.freeze({ anchor: 5_000, native: 60_000, trust: 2_000, settings: 2_000 });
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_PENDING = 64;

export interface RequestOptions {
  /** Overrides the request's default timeout (1 to 600000). */
  readonly timeoutMs?: number;
  /** Abort to cancel: the request settles with `E_CANCELLED` and a late answer is ignored. */
  readonly signal?: AbortSignal;
}

export interface NativeConfirmRequest {
  readonly challengeId: string;
  readonly proof: string;
  readonly windowId: string;
  readonly summary: string;
}
/** The supervisor's answer; handed to `ChallengeManager.confirmNative`, which checks the proof itself. */
export interface NativeConfirmResult {
  readonly confirmed: boolean;
  readonly proof: string;
  readonly windowId: string;
}

export interface TrustCheckRequest {
  readonly windowId: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export interface ControlStats {
  readonly pending: number;
  readonly invalidMessages: number;
  readonly ignoredAnswers: number;
  readonly duplicateInits: number;
}

type Kind = "anchor" | "native" | "trust" | "settings";

interface Pending {
  readonly accept: (message: InboundMessage) => unknown | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AxisError) => void;
  readonly cleanup: () => void;
}

export interface ControlClientOptions {
  readonly mux: ChannelMux;
  readonly logger?: Logger;
  /** Requests waiting for an answer at once (default 64); more is `E_BACKPRESSURE`. */
  readonly maxPending?: number;
}

type Handlers<T> = Array<(value: T) => void>;

export class ControlClient {
  readonly #mux: ChannelMux;
  readonly #logger: Logger | undefined;
  readonly #maxPending: number;
  readonly #pending = new Map<string, Pending>();
  readonly #unsubscribe: Unsubscribe[] = [];
  readonly #onConnect: Handlers<{ cid?: string; attestation: Attestation }> = [];
  readonly #onTrustSet: Handlers<Extract<InboundMessage, { type: "trust.set" }>> = [];
  readonly #onProjects: Handlers<Extract<InboundMessage, { type: "projects.register" }>> = [];
  readonly #onShutdown: Handlers<void> = [];
  readonly #onInit: Handlers<Record<string, unknown>> = [];
  readonly #onAck: Handlers<number> = [];
  #nextId = 1;
  #initSeen = false;
  #disposed = false;
  #invalid = 0;
  #ignored = 0;
  #duplicateInits = 0;

  constructor(options: ControlClientOptions) {
    this.#mux = options.mux;
    this.#logger = options.logger;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 1 || this.#maxPending > 4096) {
      throw new AxisError("E_INVALID_ARGUMENT", "Invalid maxPending");
    }
    this.#unsubscribe.push(this.#mux.onControl((raw) => this.#receive(raw)));
    this.#unsubscribe.push(this.#mux.onChannelClose(() => this.#failAll("channel_closed")));
  }

  stats(): ControlStats {
    return Object.freeze({
      pending: this.#pending.size,
      invalidMessages: this.#invalid,
      ignoredAnswers: this.#ignored,
      duplicateInits: this.#duplicateInits,
    });
  }

  // ---- events from the supervisor -------------------------------------------------------------------------------

  /** The first `init` only. A second one is ignored and logged (design step 2). */
  onInit(handler: (config: Record<string, unknown>) => void): Unsubscribe {
    return this.#add(this.#onInit, handler);
  }
  onConnect(handler: (request: { cid?: string; attestation: Attestation }) => void): Unsubscribe {
    return this.#add(this.#onConnect, handler);
  }
  onTrustSet(handler: (message: Extract<InboundMessage, { type: "trust.set" }>) => void): Unsubscribe {
    return this.#add(this.#onTrustSet, handler);
  }
  onProjectsRegister(handler: (message: Extract<InboundMessage, { type: "projects.register" }>) => void): Unsubscribe {
    return this.#add(this.#onProjects, handler);
  }
  onShutdown(handler: () => void): Unsubscribe {
    return this.#add(this.#onShutdown, handler);
  }
  /** The supervisor made its stored anchor durable up to `seq`. */
  onAnchorAck(handler: (seq: number) => void): Unsubscribe {
    return this.#add(this.#onAck, handler);
  }

  // ---- one-way sends --------------------------------------------------------------------------------------------

  send(message: OutboundMessage): void {
    if (this.#disposed) throw new AxisError("E_UNAVAILABLE", "The control channel is closed", { reason: "client_closed" });
    const parsed = outboundMessageSchema.safeParse(message);
    // Never the zod message: it can quote the value.
    if (!parsed.success) throw new AxisError("E_INVALID_ARGUMENT", "Control message refused", { reason: "outbound_invalid" });
    this.#mux.sendControl(parsed.data);
  }

  anchorPut(head: ChainHead): void {
    this.send({ type: "anchor.put", seq: head.seq, hash: head.hash });
  }

  // ---- requests -------------------------------------------------------------------------------------------------

  /** The anchor the supervisor stores, or `null` when it has none. */
  anchorGet(options: RequestOptions = {}): Promise<ChainHead | null> {
    const requestId = this.#id();
    return this.#request<ChainHead | null>(
      "anchor",
      requestId,
      { type: "anchor.get", requestId },
      DEFAULT_TIMEOUTS_MS.anchor,
      options,
      (m) => (m.type === "anchor.result" ? { value: m.anchor } : undefined),
    );
  }

  /**
   * Ask the supervisor to show the native dialog. Settles with its answer, or `E_TIMEOUT` (the challenge expires on
   * its own at 60 s, so a supervisor that never answers needs no recovery).
   */
  nativeConfirm(request: NativeConfirmRequest, options: RequestOptions = {}): Promise<NativeConfirmResult> {
    return this.#request<NativeConfirmResult>(
      "native",
      request.challengeId,
      { type: "native.confirm", ...request },
      DEFAULT_TIMEOUTS_MS.native,
      options,
      (m) =>
        m.type === "native.result"
          ? { value: { confirmed: m.confirmed, proof: m.proof, windowId: m.windowId } }
          : undefined,
    );
  }

  /**
   * Is this workspace trusted right now (TRU-2)? Resolves when it is. `E_POLICY_DENIED` (`reason: "untrusted"`) when
   * main says no, or does not answer in time: no answer is a refusal.
   */
  async trustCheck(request: TrustCheckRequest, options: RequestOptions = {}): Promise<void> {
    const requestId = this.#id();
    let trusted = false;
    try {
      trusted = await this.#request<boolean>(
        "trust",
        requestId,
        { type: "trust.check", requestId, ...request },
        DEFAULT_TIMEOUTS_MS.trust,
        options,
        (m) => (m.type === "trust.result" ? { value: m.trusted } : undefined),
      );
    } catch (e) {
      if (e instanceof AxisError && (e.code === "E_TIMEOUT" || e.code === "E_UNAVAILABLE")) trusted = false;
      else throw e;
    }
    if (!trusted) throw new AxisError("E_POLICY_DENIED", "The workspace is not trusted", { reason: "untrusted" });
  }

  /** A setting from main, `null` when unset. `E_TIMEOUT` when main does not answer (a refusal for the caller). */
  settingsGet(key: SettingKey, options: RequestOptions = {}): Promise<JsonValue> {
    const requestId = this.#id();
    return this.#request<JsonValue>(
      "settings",
      requestId,
      { type: "settings.get", requestId, key },
      DEFAULT_TIMEOUTS_MS.settings,
      options,
      // An answer for another key is not this request's answer.
      (m) => (m.type === "settings.result" && m.key === key ? { value: m.value } : undefined),
    );
  }

  /** Reject everything waiting, remove every listener and refuse later use. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const u of this.#unsubscribe.splice(0)) u();
    this.#failAll("client_closed");
    for (const list of [this.#onConnect, this.#onTrustSet, this.#onProjects, this.#onShutdown, this.#onInit, this.#onAck]) {
      list.length = 0;
    }
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  #id(): string {
    return `r${this.#nextId++}`;
  }

  #add<T>(list: Handlers<T>, handler: (value: T) => void): Unsubscribe {
    if (this.#disposed) return () => undefined;
    list.push(handler);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  #request<T>(
    kind: Kind,
    id: string,
    message: OutboundMessage,
    defaultTimeout: number,
    options: RequestOptions,
    accept: (m: InboundMessage) => { value: T } | undefined,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? defaultTimeout;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return Promise.reject(new AxisError("E_INVALID_ARGUMENT", "Invalid timeout", { reason: "timeout_range" }));
    }
    if (this.#disposed) return Promise.reject(new AxisError("E_UNAVAILABLE", "The control channel is closed", { reason: "client_closed" }));
    const { signal } = options;
    if (signal?.aborted === true) return Promise.reject(new AxisError("E_CANCELLED", "The request was cancelled"));
    const key = `${kind}:${id}`;
    if (this.#pending.has(key)) return Promise.reject(new AxisError("E_CONFLICT", "A request for this is already waiting"));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(new AxisError("E_BACKPRESSURE", "Too many control requests waiting"));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new AxisError("E_TIMEOUT", "The supervisor did not answer in time"))), timeoutMs);
      timer.unref();
      const onAbort = (): void => settle(() => reject(new AxisError("E_CANCELLED", "The request was cancelled")));
      signal?.addEventListener("abort", onAbort, { once: true });
      let done = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(key);
      };
      const settle = (finish: () => void): void => {
        if (done) return;
        done = true;
        cleanup();
        finish();
      };
      this.#pending.set(key, {
        accept: (m) => accept(m),
        resolve: (v) => settle(() => resolve(v as T)),
        reject: (e) => settle(() => reject(e)),
        cleanup,
      });
      try {
        this.send(message);
      } catch (e) {
        settle(() => reject(e));
      }
    });
  }

  #failAll(reason: string): void {
    for (const p of [...this.#pending.values()]) {
      p.reject(new AxisError("E_UNAVAILABLE", "The control channel is closed", { reason }));
    }
  }

  #receive(raw: unknown): void {
    if (this.#disposed) return;
    const parsed = inboundMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#invalid++;
      this.#logger?.warn("control.invalid", { reason: "schema" });
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case "init":
        if (this.#initSeen) {
          this.#duplicateInits++;
          this.#logger?.warn("init.duplicate");
          return;
        }
        this.#initSeen = true;
        return this.#emit(this.#onInit, m.config);
      case "connect":
        return this.#emit(this.#onConnect, m.cid === undefined ? { attestation: m.attestation } : { cid: m.cid, attestation: m.attestation });
      case "trust.set":
        return this.#emit(this.#onTrustSet, m);
      case "projects.register":
        return this.#emit(this.#onProjects, m);
      case "shutdown":
        return this.#emit(this.#onShutdown, undefined);
      case "anchor.ack":
        return this.#emit(this.#onAck, m.seq);
      case "anchor.result":
        return this.#answer("anchor", m.requestId, m);
      case "native.result":
        return this.#answer("native", m.challengeId, m);
      case "trust.result":
        return this.#answer("trust", m.requestId, m);
      case "settings.result":
        return this.#answer("settings", m.requestId, m);
    }
  }

  #answer(kind: Kind, id: string, m: InboundMessage): void {
    const pending = this.#pending.get(`${kind}:${id}`);
    const accepted = pending?.accept(m) as { value: unknown } | undefined;
    if (pending === undefined || accepted === undefined) {
      this.#ignored++;
      return;
    }
    pending.resolve(accepted.value);
  }

  #emit<T>(list: Handlers<T>, value: T): void {
    for (const h of [...list]) {
      try {
        h(value);
      } catch {
        // A handler that throws must not stop the others or the channel; its owner logs with its own context.
      }
    }
  }
}
