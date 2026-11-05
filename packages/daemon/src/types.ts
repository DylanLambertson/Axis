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
  /** The bare contract id of the envelope ("axis.worktrees"). */
  readonly contract: string;
  /** The integer contract version. */
  readonly contractVersion: number;
  readonly method: string;
  readonly tier: number;
  /** The request payload minus its top-level `approval` field. */
  readonly args: JsonValue;
  /**
   * `requestDigest()` of exactly (contract, contractVersion, method, args).
   * A gate that computes its own digest from those fields must get this
   * value; it is a cross-check, not a second source of truth.
   */
  readonly digest: string;
  readonly idempotencyKey?: string;
  /** Fires on cancel, timeout and connection close: stop waiting and withdraw any pending prompt. */
  readonly signal: AbortSignal;
}

/** What the approval is bound to besides the request: the thing that will be acted on and its content right now. */
export interface ApprovalContent {
  /** A canonical daemon id such as `workspace:<id>`, or `request:<digest>` for methods without a content hook. */
  readonly target: string;
  /** SHA-256 hex of what the operation will change or destroy, taken under the lock that covers the action. */
  readonly contentDigest: string;
}

/** What a spent approval tells the action that runs under it. Read-only facts, never a credential. */
export interface ConfirmedAction {
  readonly method: string;
  readonly target: string;
  readonly requester: string;
  /**
   * Opaque, single-use capability for the destructive library call, minted by
   * the integration adapter INSIDE the approval action, after the spend and
   * bound to `content.target` and `content.contentDigest` (for worktrees:
   * `markDiscardConfirmed` from `@axis/worktrees/daemon-confirm`). The daemon
   * hands it to the handler as `ctx.approved.capability` and never serialises
   * or logs it (it is non-enumerable on the object the handler sees).
   * Handlers must never mint one themselves.
   */
  readonly capability?: unknown;
}

/**
 * Per-method content hook for tier >= 3: names the target and runs a function
 * under the lock that protects the content, handing it the content digest
 * computed under that lock. The pipeline runs the approval check and the
 * handler inside `withLock`, so "the content is unchanged right now" and the
 * action are covered by the same lock. A hook is reviewed with its
 * destructive call. Methods without a hook use `request:<digest>` and the
 * digest itself as the content digest.
 */
export interface ApprovalContentHook {
  (
    context: { readonly identity: Identity; readonly requestId: string; readonly correlationId: string; readonly signal: AbortSignal },
    payload: never,
  ): ApprovalContentLock | Promise<ApprovalContentLock>;
}
export interface ApprovalContentLock {
  readonly target: string;
  withLock<T>(fn: (contentDigest: string) => Promise<T>): Promise<T>;
}

/**
 * Thrown by `ApprovalGate.execute` when the approval does not cover the
 * request. `E_POLICY_DENIED`: unknown, wrong caller, wrong request or target.
 * `E_CONFLICT`: already used, expired, or the content changed since the
 * user confirmed. `E_BACKPRESSURE`: too many confirmations are waiting (from
 * `issue` or `execute`). `E_INVALID_ARGUMENT`: the request cannot be approved
 * (for example arguments the approval manager refuses). `executed: true` means the approval was spent and the
 * action then failed (or could not be audited): the daemon answers
 * E_INTERNAL and frees the idempotency key, and the user confirms again.
 * A `DaemonError` with code `E_UNAVAILABLE` thrown before anything was spent (by `issue`, or by `execute` before it ran
 * the action) is answered as that closed error, with its constrained message and `details.reason`: a gate that cannot
 * serve a tier now (a stalled audit anchor) refuses without issuing a challenge or burning an approval.
 * Any other error from the gate is E_INTERNAL.
 */
export class ApprovalError extends Error {
  constructor(
    readonly code: "E_POLICY_DENIED" | "E_CONFLICT" | "E_BACKPRESSURE" | "E_INVALID_ARGUMENT",
    readonly executed: boolean = false,
  ) {
    super(code);
    this.name = "ApprovalError";
  }
}

/**
 * The approval gate for tier 3 and above; `@axis/challenge` sits behind it.
 * The pipeline owns the whole sequence, so a handler never sees a challenge
 * id and the gate cannot say "confirmed" without spending a live challenge.
 *
 * - `issue` is called when the request carries no `approval`. It issues a
 *   challenge bound to `input.digest`, the actor, the connection, the target
 *   and the content digest, and the pipeline answers E_APPROVAL_REQUIRED.
 * - `execute` is called when it does. It MUST: check that the challenge was
 *   issued to this `actor` on this `connectionId` for exactly this request
 *   (digest, target) and that `content.contentDigest` still equals the one
 *   the user confirmed; burn the challenge before running `action`
 *   (single use, also when `action` fails); and run `action` exactly once.
 *   It throws `ApprovalError` for a refusal. It returns what `action` returns.
 * - `withdraw` is called when a request is cancelled or times out before its
 *   approval was spent; `withdrawConnection` when a connection closes. Both
 *   are best effort and called at most once per challenge / connection. The
 *   daemon awaits and ignores whatever they return (the challenge manager
 *   returns a count or a result object), and reports a throw locally.
 */
export interface ApprovalGate {
  issue(input: ApprovalInput, content: ApprovalContent): Challenge | Promise<Challenge>;
  execute<T>(
    input: ApprovalInput,
    approval: ChallengeReference,
    content: ApprovalContent,
    action: (confirmed: ConfirmedAction) => Promise<T>,
  ): Promise<T>;
  withdraw?(challengeId: string, caller: { readonly actor: ActorId; readonly connectionId: string }): unknown;
  withdrawConnection?(connectionId: string): unknown;
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
  /**
   * The call began but its outcome was never recorded (the daemon died, or the result could not be stored
   * or must not be). The side effect may have happened: never run it again under this key.
   */
  | { readonly state: "unknown"; readonly reason: "interrupted" | "result-not-stored" | "failed-after-start" }
  /** Still running (until the handler settles, whatever the caller was told). */
  | { readonly state: "in-progress" }
  /** The store has no room for this actor's live keys: answer E_BACKPRESSURE. */
  | { readonly state: "exhausted" };
/**
 * The real store is `JournalIdempotencyStore` in `@axis/journal` (24 h, ADR 0003 D3). `MemoryIdempotencyStore`
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
  /**
   * A side-effecting handler started and the call ended without a recorded success: it returned and then the
   * approval gate or the response check failed, or it was cancelled or timed out. Keep the key as outcome-unknown instead of freeing it, so a retry
   * is refused rather than run again. Also used when the handler started and was cancelled or timed out.
   * Required: a store that cannot do this must not be wired in (the pipeline never falls back to `abandon`).
   */
  markUnknown(key: IdempotencyKey): void | Promise<void>;
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
  /** For tier >= 3: what the spent approval covers. Read-only; check `target` before acting on anything else. */
  readonly approved?: ConfirmedAction;
}
/**
 * Throw only when nothing was changed: a handler that throws on its own frees its idempotency key, so a retry
 * runs it again. Once a side effect may have happened, return, or let the abort (`signal`) propagate: then the
 * key is kept as outcome-unknown and the retry is refused rather than run twice.
 */
export type Handler = (context: HandlerContext, payload: never) => unknown;

export interface ContractRegistry {
  lookup(contract: string, version: number, method: string): MethodSpec | undefined;
  /** Versions served for a contract id, ascending; empty if unknown. */
  versions(contract: string): readonly number[];
}
