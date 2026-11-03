// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Challenge, ChallengeReference, JsonValue, MethodSpec, SideEffect } from "@axis/protocol";

/**
 * A transport-agnostic duplex of decoded messages. The desktop wraps an
 * Electron MessagePort, the web wraps the tunnel channel, tests use an
 * in-memory worker_threads MessageChannel. The daemon trusts nothing that
 * arrives through `onMessage` and never reads identity from it.
 */
export interface Connection {
  send(message: unknown): void;
  onMessage(handler: (raw: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export type ActorId = "user" | "daemon" | `agent:${string}`;

/**
 * Who is on the other end, as established by main (desktop) or the
 * authenticated tunnel (web). Never derived from anything the peer sends.
 */
export interface Identity {
  readonly connectionId: string;
  readonly windowId: string;
  /** Stable id used to scope idempotency keys. */
  readonly actorId: string;
  readonly actor: ActorId;
  readonly workspaceId?: string;
  readonly trusted: boolean;
  readonly clientKind: "desktop" | "web";
}

/**
 * Turns the opaque attestation main hands over together with the port into an
 * `Identity`, or refuses it. The daemon treats the attestation as a verified
 * claim only because this injected verifier says so (for example by checking a
 * MAC main computed); it never inspects the contents itself.
 */
export interface IdentityVerifier {
  verify(attestation: unknown): Identity | undefined | Promise<Identity | undefined>;
}

export interface PolicyInput {
  readonly identity: Identity;
  readonly contract: string;
  readonly version: number;
  readonly method: string;
  readonly sideEffect: SideEffect;
  /** The method's declared minimum tier. */
  readonly tier: number;
}
/** A policy may raise the tier of a request, never lower it. */
export type PolicyDecision = { readonly effect: "allow"; readonly tier?: number } | { readonly effect: "deny" };
export interface Policy {
  evaluate(input: PolicyInput): PolicyDecision | Promise<PolicyDecision>;
}

export interface ApprovalInput {
  /** The attested identity of this connection (from the verifier, never the peer). */
  readonly identity: Identity;
  readonly actor: ActorId;
  readonly connectionId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly contract: string;
  readonly contractVersion: number;
  readonly method: string;
  readonly tier: number;
  readonly payload: JsonValue;
  /**
   * `requestDigest()` of this request (contract, version, method and the
   * payload without its `approval` field). The daemon computes it once;
   * the gate must not derive its own.
   */
  readonly digest: string;
  readonly approval?: ChallengeReference;
  readonly idempotencyKey?: string;
  /** Fires on cancel, timeout and connection close: withdraw any pending prompt. */
  readonly signal: AbortSignal;
}
export type ApprovalOutcome =
  | { readonly status: "confirmed"; readonly confirmation: unknown }
  | { readonly status: "required"; readonly challenge: Challenge }
  | { readonly status: "denied" };
/**
 * Challenge-like gate for tier 3 and above; `@axis/challenge` sits behind it
 * in the daemon wiring.
 *
 * Contract. To answer `confirmed` for `input.approval`, the gate MUST:
 * 1. check that the challenge was issued for exactly `input.digest` (an
 *    equality test against the digest it stored when it issued the
 *    challenge, never a recomputation from the payload);
 * 2. check that it was issued to the same `actor` and the same
 *    `connectionId` as this request. A challenge id is not a bearer credential;
 * 3. burn the challenge on first use (single use), also when the later
 *    handler fails;
 * 4. stop and withdraw any prompt when `input.signal` aborts.
 * Anything else is `required` (with a freshly issued challenge) or `denied`.
 * A gate that throws fails the request closed.
 */
export interface ApprovalGate {
  check(input: ApprovalInput): ApprovalOutcome | Promise<ApprovalOutcome>;
}

export interface IdempotencyKey {
  readonly actorId: string;
  /** `identity.workspaceId`, or the empty string when the connection has none. */
  readonly workspaceId: string;
  readonly contract: string;
  readonly version: number;
  readonly method: string;
  readonly key: string;
}
export type IdempotencyBegin =
  | { readonly state: "new" }
  /** `origin` is the connection id that completed the call. */
  | { readonly state: "replay"; readonly result: JsonValue; readonly origin: string }
  | { readonly state: "conflict" }
  /** Still running (until the handler settles, whatever the caller was told). */
  | { readonly state: "in-progress" }
  /** The store has no room for this actor's live keys: answer E_BACKPRESSURE. */
  | { readonly state: "exhausted" };
/**
 * The real store lives in the journal (24 h, ADR 0003 D3). `MemoryIdempotencyStore`
 * is for tests and dev wiring only.
 */
export interface IdempotencyStore {
  begin(key: IdempotencyKey, payloadHash: string): IdempotencyBegin | Promise<IdempotencyBegin>;
  /**
   * The handler succeeded. `origin` is the connection id, kept so a tier >= 3 replay can be bound to it.
   * If this throws, the daemon abandons the key, so a retry runs the side effect again: a durable
   * store must make `complete` durable before the reply is sent.
   */
  complete(key: IdempotencyKey, result: JsonValue, origin: string): void | Promise<void>;
  /** The call failed or was cancelled: free the key so a bounded retry can run. */
  abandon(key: IdempotencyKey): void | Promise<void>;
}

/** Structurally compatible with `@axis/audit`'s sink. Events carry decisions, never payloads. */
export interface DaemonAuditEvent {
  readonly actor: ActorId;
  readonly action: "policy.decision" | "rpc.execute";
  readonly target: string;
  readonly outcome: "success" | "failure" | "denied" | "error";
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}
/**
 * The daemon awaits `append`. A throw or a rejection fails the decision closed
 * (the handler does not run) and is reported locally after the fact.
 */
export interface DaemonAuditSink {
  append(event: DaemonAuditEvent): void | Promise<void>;
}

export interface HandlerContext {
  readonly identity: Identity;
  readonly requestId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  /** Fires on cancel, timeout and connection close. Handlers must stop promptly. */
  readonly signal: AbortSignal;
  /** Whatever the approval gate returned for tier >= 3 (for example a confirmation token). */
  readonly confirmation?: unknown;
}
export type Handler = (context: HandlerContext, payload: never) => unknown;

export interface ContractRegistry {
  lookup(contract: string, version: number, method: string): MethodSpec | undefined;
  /** Versions served for a contract id, ascending; empty if unknown. */
  versions(contract: string): readonly number[];
}
