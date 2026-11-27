// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { helloRejectedSchema, responseEnvelopeSchema, welcomeSchema, MAX_TIMEOUT_MS, type Welcome } from "./envelope.js";
import { lookupMethod } from "./contracts.js";
import type { ErrorCode } from "./errors.js";

/**
 * The renderer's client of the daemon (ticket X1b, `docs/design/main-answers.md` section 2): `hello`/`welcome`, then request
 * envelopes over the port main brokered. It runs in the renderer, so it imports no `node:*` module; the overlay wraps the DOM
 * `MessagePort` it got from `acquirePort('vscode:axisConnect', 'vscode:axisConnectResult')` as a `ClientPort`.
 *
 * - Only a `welcome` that parses is accepted; `hello-rejected`, anything else first, or a close is `rejected` and the port is
 *   closed.
 * - Every answer is parsed with `responseEnvelopeSchema`, and an `ok` result again with the method's response schema; an answer
 *   that breaks either fails the call with `E_INTERNAL` (`bad_answer`). An error answer is handed over as the daemon sent it
 *   (the schema bounds it); the client never makes an error message from received text.
 * - Requests waiting at once are bounded (`maxPending`, default 64): more is `E_BACKPRESSURE`. An abort sends `cancel` and fails
 *   the call `E_CANCELLED`; a call with no answer within its timeout plus a margin fails `E_TIMEOUT`; a close fails every call
 *   `E_UNAVAILABLE` (the window then reconnects: after a daemon restart every old port is closed).
 */

export interface ClientPort {
  postMessage(message: unknown): void;
  onMessage(handler: (data: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
}

export interface ClientTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export class ClientError extends Error {
  readonly code: ErrorCode;
  readonly reason: string;
  constructor(code: ErrorCode, reason: string) {
    super(`${code} ${reason}`);
    this.name = "ClientError";
    this.code = code;
    this.reason = reason;
  }
}

export type CallResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string; readonly retryable: boolean; readonly details?: Readonly<Record<string, unknown>> | undefined } };

export interface CallOptions {
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ClientOptions {
  /** The contracts to ask for, each with the versions this client speaks. */
  readonly contracts: ReadonlyArray<{ readonly id: string; readonly versions: readonly number[] }>;
  readonly timers?: ClientTimers;
  readonly maxPending?: number;
  /** How long to wait for `welcome` (default 10 s). */
  readonly helloTimeoutMs?: number;
}

const realTimers: ClientTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]) };
const ANSWER_MARGIN_MS = 5_000;
const DEFAULT_MAX_PENDING = 64;

interface Pending {
  readonly settle: (r: CallResult | ClientError) => void;
}

export class AxisPortClient {
  readonly welcome: Welcome;
  readonly #port: ClientPort;
  readonly #timers: ClientTimers;
  readonly #maxPending: number;
  readonly #pending = new Map<string, Pending>();
  readonly #offs: Array<() => void> = [];
  #n = 0;
  #closed = false;

  private constructor(port: ClientPort, welcome: Welcome, options: ClientOptions) {
    this.#port = port;
    this.welcome = welcome;
    this.#timers = options.timers ?? realTimers;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#offs.push(port.onMessage((m) => this.#receive(m)));
    this.#offs.push(port.onClose(() => this.#shut()));
  }

  /** Send `hello` and wait for `welcome`. Rejects with `ClientError` `E_UNAUTHENTICATED` (`rejected`) and closes the port otherwise. */
  static open(port: ClientPort, options: ClientOptions): Promise<AxisPortClient> {
    const timers = options.timers ?? realTimers;
    return new Promise<AxisPortClient>((resolve, reject) => {
      const offs: Array<() => void> = [];
      let done = false;
      const finish = (outcome: Welcome | ClientError): void => {
        if (done) return;
        done = true;
        timers.clear(timer);
        for (const off of offs.splice(0)) off();
        if (outcome instanceof ClientError) {
          try {
            port.close();
          } catch {
            // already closed
          }
          reject(outcome);
        } else resolve(new AxisPortClient(port, outcome, options));
      };
      const timer = timers.set(() => finish(new ClientError("E_TIMEOUT", "no_welcome")), options.helloTimeoutMs ?? 10_000);
      offs.push(
        port.onMessage((m) => {
          const w = welcomeSchema.safeParse(m);
          if (w.success) return finish(w.data);
          finish(new ClientError("E_UNAUTHENTICATED", helloRejectedSchema.safeParse(m).success ? "rejected" : "bad_first_message"));
        }),
      );
      offs.push(port.onClose(() => finish(new ClientError("E_UNAUTHENTICATED", "rejected"))));
      try {
        port.postMessage({ type: "hello", protocolVersions: [1], contracts: options.contracts.map((c) => ({ id: c.id, versions: [...c.versions] })) });
      } catch {
        finish(new ClientError("E_UNAVAILABLE", "closed"));
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** One request. Resolves with the daemon's answer; rejects with `ClientError` only for what happened on this side. */
  call(contract: string, method: string, payload: unknown, options: CallOptions = {}): Promise<CallResult> {
    if (this.#closed) return Promise.reject(new ClientError("E_UNAVAILABLE", "closed"));
    const selected = this.welcome.contracts.find((c) => c.id === contract);
    const spec = selected === undefined ? undefined : lookupMethod(contract, selected.version, method);
    if (selected === undefined || spec === undefined) return Promise.reject(new ClientError("E_METHOD_NOT_FOUND", "not_served"));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(new ClientError("E_BACKPRESSURE", "too_many_pending"));
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) {
      return Promise.reject(new ClientError("E_INVALID_ARGUMENT", "timeout_range"));
    }
    const { signal } = options;
    if (signal?.aborted === true) return Promise.reject(new ClientError("E_CANCELLED", "aborted"));
    const id = `c${++this.#n}`;
    return new Promise<CallResult>((resolve, reject) => {
      const onAbort = (): void => {
        try {
          this.#port.postMessage({ v: 1, cancel: id });
        } catch {
          // closed: the close fails it anyway
        }
        settle(new ClientError("E_CANCELLED", "aborted"));
      };
      const timer = this.#timers.set(() => settle(new ClientError("E_TIMEOUT", "no_answer")), (timeoutMs ?? this.welcome.limits.maxTimeoutMs) + ANSWER_MARGIN_MS);
      const settle = (r: CallResult | ClientError): void => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        this.#timers.clear(timer);
        signal?.removeEventListener("abort", onAbort);
        if (r instanceof ClientError) return reject(r);
        if (r.ok) {
          const checked = spec.response.safeParse(r.result);
          if (!checked.success) return reject(new ClientError("E_INTERNAL", "bad_answer"));
        }
        resolve(r);
      };
      this.#pending.set(id, { settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#port.postMessage({
          v: 1,
          id,
          contract,
          contractVersion: selected.version,
          method,
          payload,
          ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      } catch {
        settle(new ClientError("E_UNAVAILABLE", "closed"));
      }
    });
  }

  close(): void {
    try {
      this.#port.close();
    } catch {
      // already closed
    }
    this.#shut();
  }

  #receive(raw: unknown): void {
    const parsed = responseEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      // A frame that is not a response: if it names a waiting call, that call fails; otherwise it is ignored.
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === "string") this.#pending.get(id)?.settle(new ClientError("E_INTERNAL", "bad_answer"));
      return;
    }
    const p = this.#pending.get(parsed.data.id);
    if (p === undefined) return;
    p.settle(parsed.data.ok ? { ok: true, result: parsed.data.result } : { ok: false, error: parsed.data.error });
  }

  #shut(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#offs.splice(0)) off();
    for (const p of [...this.#pending.values()]) p.settle(new ClientError("E_UNAVAILABLE", "closed"));
  }
}
