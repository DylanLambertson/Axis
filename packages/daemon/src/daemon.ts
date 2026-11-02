// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { Session, handlerKey, type SessionLimits } from "./session.js";
import { MemoryIdempotencyStore, protocolRegistry } from "./support.js";
import type {
  ApprovalGate,
  Connection,
  ContractRegistry,
  DaemonAuditSink,
  Handler,
  IdempotencyStore,
  IdentityVerifier,
  Policy,
} from "./types.js";

export interface DaemonOptions {
  readonly identity: IdentityVerifier;
  readonly audit: DaemonAuditSink;
  /** Absent policy denies everything (I2). */
  readonly policy?: Policy;
  /** Absent gate refuses every request of tier 3 and above. */
  readonly approvals?: ApprovalGate;
  readonly idempotency?: IdempotencyStore;
  readonly registry?: ContractRegistry;
  readonly now?: () => number;
  readonly onInternalError?: (correlationId: string, error: unknown) => void;
  readonly limits?: Partial<SessionLimits>;
  /** Connections that may be open at once. Default 64. */
  readonly maxConnections?: number;
  /** Messages accepted before the attestation has been verified. Default 16. */
  readonly maxPendingBeforeIdentity?: number;
}

const DEFAULT_LIMITS: SessionLimits = {
  maxInFlight: 16,
  maxMessagesPerSecond: 100,
  burst: 200,
  maxViolations: 50,
  handshakeTimeoutMs: 10_000,
};

/**
 * The transport-agnostic daemon core. It owns connections, the handshake and
 * dispatch; every service (identity, policy, approvals, idempotency, audit,
 * handlers) is injected. Nothing here touches Electron, a socket, a file or a
 * process.
 */
export class Daemon {
  readonly #opts: DaemonOptions;
  readonly #registry: ContractRegistry;
  readonly #handlers = new Map<string, Handler>();
  readonly #sessions = new Set<Session>();
  readonly #idempotency: IdempotencyStore;
  readonly #limits: SessionLimits;
  #stopped = false;

  constructor(options: DaemonOptions) {
    this.#opts = options;
    this.#registry = options.registry ?? protocolRegistry;
    this.#idempotency = options.idempotency ?? new MemoryIdempotencyStore(options.now ?? Date.now);
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  get connectionCount(): number {
    return this.#sessions.size;
  }

  /** Register the handlers for one contract version. Every key must name a method the registry knows. */
  register(contract: string, version: number, handlers: Readonly<Record<string, Handler>>): void {
    for (const [method, handler] of Object.entries(handlers)) {
      if (!this.#registry.lookup(contract, version, method)) {
        throw new Error(`No such method ${contract}/${version}.${method}`);
      }
      const key = handlerKey(contract, version, method);
      if (this.#handlers.has(key)) throw new Error(`Handler already registered for ${key}`);
      this.#handlers.set(key, handler);
    }
  }

  /**
   * Take ownership of a connection. `attestation` is whatever main attached to
   * the port; the injected verifier decides what it means. A refused
   * attestation closes the connection after one `hello-rejected`.
   */
  accept(connection: Connection, attestation: unknown): void {
    const max = this.#opts.maxConnections ?? 64;
    if (this.#stopped || this.#sessions.size >= max) {
      connection.close();
      return;
    }
    const maxPending = this.#opts.maxPendingBeforeIdentity ?? 16;
    const pending: unknown[] = [];
    let session: Session | undefined;
    let dead = false;
    connection.onMessage((raw) => {
      if (dead) return;
      if (session) session.handle(raw);
      else if (pending.length < maxPending) pending.push(raw);
      else {
        dead = true;
        connection.close();
      }
    });
    connection.onClose(() => {
      dead = true;
      session?.onPeerClosed();
    });

    const refuse = (): void => {
      dead = true;
      try {
        connection.send({
          type: "hello-rejected",
          error: {
            code: "E_UNAUTHENTICATED",
            message: "Connection identity could not be verified",
            retryable: false,
            correlationId: randomBytes(8).toString("hex"),
          },
        });
      } catch {
        // peer already gone
      }
      connection.close();
    };

    void (async () => {
      let identity;
      try {
        identity = await this.#opts.identity.verify(attestation);
      } catch (e) {
        this.#opts.onInternalError?.("identity", e);
      }
      if (!identity || dead || this.#stopped) return refuse();
      const s = new Session(connection, identity, {
        registry: this.#registry,
        handlers: this.#handlers,
        policy: this.#opts.policy,
        approvals: this.#opts.approvals,
        idempotency: this.#idempotency,
        audit: this.#opts.audit,
        limits: this.#limits,
        now: this.#opts.now ?? Date.now,
        onInternalError: this.#opts.onInternalError,
        onClosed: (x) => void this.#sessions.delete(x),
      });
      session = s;
      this.#sessions.add(s);
      for (const raw of pending.splice(0)) s.handle(raw);
    })();
  }

  /** Close every connection (in-flight calls are cancelled, runs owned by services continue). */
  stop(): void {
    this.#stopped = true;
    for (const s of [...this.#sessions]) s.close();
  }
}
