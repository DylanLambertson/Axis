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
  readonly identity: Identity;
  readonly contract: string;
  readonly method: string;
  readonly tier: number;
  readonly payload: JsonValue;
  /** SHA-256 of the canonical payload without its `approval` field: bind challenges to this. */
  readonly payloadHash: string;
  readonly approval?: ChallengeReference;
  readonly idempotencyKey?: string;
}
export type ApprovalOutcome =
  | { readonly status: "confirmed"; readonly confirmation: unknown }
  | { readonly status: "required"; readonly challenge: Challenge }
  | { readonly status: "denied" };
/** Challenge-like gate for tier 3 and above; `@axis/challenge` sits behind it in the daemon wiring. */
export interface ApprovalGate {
  check(input: ApprovalInput): ApprovalOutcome | Promise<ApprovalOutcome>;
}

export interface IdempotencyKey {
  readonly actorId: string;
  readonly contract: string;
  readonly version: number;
  readonly method: string;
  readonly key: string;
}
export type IdempotencyBegin =
  | { readonly state: "new" }
  | { readonly state: "replay"; readonly result: JsonValue }
  | { readonly state: "conflict" }
  | { readonly state: "in-progress" };
/** The real store lives in the journal (24 h, ADR 0003 D3); a memory one ships for tests and early wiring. */
export interface IdempotencyStore {
  begin(key: IdempotencyKey, payloadHash: string): IdempotencyBegin | Promise<IdempotencyBegin>;
  complete(key: IdempotencyKey, result: JsonValue): void | Promise<void>;
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
export interface DaemonAuditSink {
  append(event: DaemonAuditEvent): unknown;
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

/** Thrown by handlers to return a specific wire error. The message must be user-safe. */
export class DaemonError extends Error {
  constructor(
    readonly code: import("@axis/protocol").ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export interface ContractRegistry {
  lookup(contract: string, version: number, method: string): MethodSpec | undefined;
  /** Versions served for a contract id, ascending; empty if unknown. */
  versions(contract: string): readonly number[];
}
