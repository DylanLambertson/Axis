// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { inspectMessage, permissionTierSchema } from "@axis/protocol";
import { parseIdentity } from "./identity.js";
import { OrphanTracker } from "./orphans.js";
import { handlerKey, type PipelineDeps } from "./pipeline.js";
import { Session, type SessionLimits } from "./session.js";
import { protocolRegistry } from "./support.js";
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
  /** Required: the daemon never falls back to the dev-only memory store on its own. */
  readonly idempotency: IdempotencyStore;
  readonly registry?: ContractRegistry;
  readonly now?: () => number;
  readonly onInternalError?: (correlationId: string, error: unknown) => void;
  readonly limits?: Partial<SessionLimits>;
  /** Connections that may be open at once. Default 64. */
  readonly maxConnections?: number;
  /** Messages accepted before the attestation has been verified. Default 16. */
  readonly maxPendingBeforeIdentity?: number;
  /**
   * Total bytes accepted before the attestation has been verified (default 1 MiB).
   * Each queued message may use `maxPendingBytesBeforeIdentity / maxPendingBeforeIdentity`
   * of it, measured by the bounded walk of `inspectMessage`; untrusted input is never serialised.
   */
  readonly maxPendingBytesBeforeIdentity?: number;
  /** Handlers still running after their caller got a timeout, cancel or close, per window. Default: `maxInFlight`. */
  readonly maxOrphanedPerWindow?: number;
  /** The same, daemon-wide backstop. Default: four windows' worth. */
  readonly maxOrphanedHandlers?: number;
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
  readonly #sessions = new Map<string, Session>();
  readonly #orphans: OrphanTracker;
  readonly #pipeline: PipelineDeps;
  /** Connections accepted but not yet verified: they count against `maxConnections`. */
  #pending = 0;
  readonly #idempotency: IdempotencyStore;
  readonly #limits: SessionLimits;
  #stopped = false;

  constructor(options: DaemonOptions) {
    this.#opts = options;
    this.#registry = options.registry ?? protocolRegistry;
    this.#idempotency = options.idempotency;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    const perWindow = options.maxOrphanedPerWindow ?? this.#limits.maxInFlight;
    this.#orphans = new OrphanTracker(options.maxOrphanedHandlers ?? perWindow * 4, perWindow);
    this.#pipeline = {
      registry: this.#registry,
      handlers: this.#handlers,
      policy: options.policy,
      approvals: options.approvals,
      idempotency: this.#idempotency,
      audit: options.audit,
      onInternalError: options.onInternalError,
    };
  }

  /** Verified sessions. */
  get connectionCount(): number {
    return this.#sessions.size;
  }

  /** Handlers still running after their caller was answered with a timeout, cancel or close. */
  get orphanedHandlers(): number {
    return this.#orphans.count;
  }

  /** Register the handlers for one contract version. Every key must name a method the registry knows. */
  register(contract: string, version: number, handlers: Readonly<Record<string, Handler>>): void {
    for (const [method, handler] of Object.entries(handlers)) {
      const spec = this.#registry.lookup(contract, version, method);
      if (!spec) throw new Error(`No such method ${contract}/${version}.${method}`);
      if (!permissionTierSchema.safeParse(spec.tier).success) {
        throw new Error(`Invalid tier on ${contract}/${version}.${method}`);
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
    if (this.#stopped || this.#sessions.size + this.#pending >= max) {
      connection.close();
      return;
    }
    this.#pending++;
    const maxPending = this.#opts.maxPendingBeforeIdentity ?? 16;
    const maxBytes = this.#opts.maxPendingBytesBeforeIdentity ?? 1_048_576;
    const pending: unknown[] = [];
    const perMessageBytes = Math.max(1, Math.floor(maxBytes / maxPending));
    const acceptedAt = performance.now();
    let session: Session | undefined;
    let dead = false;
    let counted = true;
    const uncount = (): void => {
      if (counted) {
        counted = false;
        this.#pending--;
      }
    };
    connection.onMessage((raw) => {
      if (dead) return;
      if (session) return session.handle(raw);
      // The walk refuses shared references, so a tiny DAG cannot expand here, and stops at the byte and node limits.
      if (pending.length < maxPending && inspectMessage(raw, { maxBytes: perMessageBytes }).ok) pending.push(raw);
      else {
        dead = true;
        uncount();
        connection.close();
      }
    });
    connection.onClose(() => {
      dead = true;
      uncount();
      session?.onPeerClosed();
    });

    const refuse = (): void => {
      dead = true;
      uncount();
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
      let timer: NodeJS.Timeout | undefined;
      try {
        const expired = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.#limits.handshakeTimeoutMs);
          timer.unref();
        });
        identity = parseIdentity(await Promise.race([Promise.resolve(this.#opts.identity.verify(attestation)), expired]));
      } catch (e) {
        this.#opts.onInternalError?.("identity", e);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // One live session per connection id: a verifier cannot bind an attestation to a port, so the daemon refuses reuse.
      if (!identity || dead || this.#stopped || this.#sessions.has(identity.connectionId)) return refuse();
      const s = new Session(connection, identity, {
        pipeline: this.#pipeline,
        limits: this.#limits,
        now: this.#opts.now ?? Date.now,
        orphans: this.#orphans,
        onClosed: (x) => {
          if (this.#sessions.get(x.identity.connectionId) === x) this.#sessions.delete(x.identity.connectionId);
        },
      }, this.#limits.handshakeTimeoutMs - (performance.now() - acceptedAt));
      session = s;
      uncount();
      this.#sessions.set(identity.connectionId, s);
      for (const raw of pending.splice(0)) s.handle(raw);
    })();
  }

  /** Close every connection (in-flight calls are cancelled, runs owned by services continue). */
  stop(): void {
    this.#stopped = true;
    for (const s of [...this.#sessions.values()]) s.close();
  }
}
