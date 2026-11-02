// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
  challengeIdSchema,
  challengeSchema,
  requestDigestSchema,
  type Challenge,
} from "@axis/protocol";
import { z } from "zod";
import { randomToken, requestDigest, safeEqual, sha256Hex } from "./crypto.js";
import { ChallengeError } from "./errors.js";

const ACTOR = /^(?:user|daemon|agent:[A-Za-z0-9._/-]{1,96})$/;
const OP = /^[a-z][a-z0-9_.-]{0,63}$/;
const WINDOW = /^[A-Za-z0-9._:-]{1,64}$/;
const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);

export type ActorId = "user" | "daemon" | `agent:${string}`;

/** Structurally compatible with `@axis/audit`'s `AuditSink`; not imported so the packages stay decoupled. */
export interface ChallengeAuditEvent {
  readonly actor: ActorId;
  readonly action: "tier4.challenge" | "tier4.execute";
  readonly target: string;
  readonly outcome: "success" | "failure" | "denied" | "error";
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}
export interface ChallengeAuditSink {
  append(event: ChallengeAuditEvent): unknown;
}

const actorSchema = z.string().regex(ACTOR);
const windowSchema = z.string().regex(WINDOW);

const issueSchema = z
  .object({
    op: z.string().regex(OP),
    target: z.string().min(1).max(1024).refine(noControl),
    /** SHA-256 hex of what the operation will destroy (for example dirty file content). */
    contentDigest: requestDigestSchema,
    actor: actorSchema,
    windowId: windowSchema,
    tier: z.number().int().min(3).max(5).default(4),
    contract: z.string().min(1).max(64).default("axis.approvals/1"),
    /** User-safe, already redacted. Defaults to the target. */
    targetSummary: z.string().max(512).optional(),
  })
  .strict();

const resolveSchema = z
  .object({
    challengeId: challengeIdSchema,
    decision: z.enum(["approve", "deny"]),
    digest: requestDigestSchema,
    actor: actorSchema,
    windowId: windowSchema,
  })
  .strict();

const nativeSchema = z
  .object({
    challengeId: challengeIdSchema,
    proof: z.string().min(1).max(128),
    confirmed: z.boolean(),
    windowId: windowSchema,
  })
  .strict();

const executeContextSchema = z
  .object({
    op: z.string().regex(OP),
    target: z.string().min(1).max(1024).refine(noControl),
    /** Digest of the same content, recomputed from the current state just now. */
    currentContentDigest: requestDigestSchema,
  })
  .strict();

declare const confirmationBrand: unique symbol;
/**
 * Opaque proof that a challenge was approved (and natively confirmed when
 * required). It is a frozen object recognised by identity in the issuing
 * manager only: a JSON round trip, a copy or a hand-built value is refused.
 */
export interface ConfirmationToken {
  readonly [confirmationBrand]: true;
}

export interface IssuedChallenge {
  /** Renderer-visible, matches `challengeSchema` in `@axis/protocol`. */
  readonly challenge: Challenge;
  /**
   * Secret for the privileged native-confirmation path (daemon to main). Never
   * send it to a renderer. Null when the tier needs no native confirmation.
   */
  readonly nativeProof: string | null;
}

export interface ResolveResult {
  readonly challengeId: string;
  readonly state: "approved" | "denied" | "expired";
  /** True while a native confirmation is still outstanding. */
  readonly nativeRequired: boolean;
  /** Present once the challenge is fully confirmed. */
  readonly token?: ConfirmationToken;
}

/** What `execute` hands to the action: the verified facts, nothing secret. */
export interface ConfirmedAction {
  readonly op: string;
  readonly target: string;
  readonly requester: ActorId;
}

export interface ChallengeManagerOptions {
  readonly audit: ChallengeAuditSink;
  /** Wall clock in epoch ms. Used only for the wire `expiresAt`; never for deadlines. */
  readonly now?: () => number;
  /** Monotonic clock in ms (default `performance.now`). Every internal TTL runs on this one, so a wall-clock step cannot extend a challenge or token. */
  readonly monotonic?: () => number;
  /** Challenge lifetime. Default 60 s, at most 5 min. */
  readonly challengeTtlMs?: number;
  /** How long a confirmed token stays usable. Default 30 s, at most 5 min. */
  readonly confirmationTtlMs?: number;
  /** Open challenges per requesting actor. Default 8. */
  readonly maxOutstandingPerActor?: number;
  /** Open challenges overall. Default 128. */
  readonly maxOutstandingTotal?: number;
}

type State = "PENDING" | "AWAITING_NATIVE" | "CONFIRMED" | "DENIED" | "EXPIRED" | "BURNED" | "CONSUMED";

interface Record_ {
  readonly ref: string;
  readonly requester: ActorId;
  readonly windowId: string;
  readonly op: string;
  readonly target: string;
  readonly digest: string;
  readonly tier: number;
  readonly native: boolean;
  /** Monotonic deadline. */
  readonly expiresAt: number;
  /** Wall-clock deadline, for display on the wire only. */
  readonly wallExpiresAt: number;
  nativeProof: string | null;
  state: State;
  tokenExpiresAt: number;
  endedAt: number;
}

const OPEN: ReadonlySet<State> = new Set<State>(["PENDING", "AWAITING_NATIVE"]);
const MAX_TTL = 300_000;

function limit(value: number | undefined, fallback: number, max: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 1 || v > max) {
    throw new ChallengeError("E_INVALID_ARGUMENT", `${name} must be an integer from 1 to ${max}`);
  }
  return v;
}

function invalid(error: z.ZodError, what: string): ChallengeError {
  // Field paths only: zod messages can echo the offending value.
  const fields = [...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
  return new ChallengeError("E_INVALID_ARGUMENT", `Invalid ${what}: ${fields}`);
}

/**
 * Daemon-side tier-4 challenges (task B4; APR-1, APR-2, G-24).
 *
 *   issue -> resolve(approve) -> [confirmNative] -> execute
 *
 * - Ids are 256 random bits; records are keyed by their SHA-256.
 * - A challenge is single-use, short-lived, and bound to operation, target and
 *   the digest of what will be destroyed.
 * - Only the `user` actor, from the window the challenge was issued to, can
 *   resolve it. Agents get E_POLICY_DENIED.
 * - `execute` re-checks the bound digest against the current state (TOCTOU) and
 *   burns the confirmation whether or not the action then succeeds.
 * - Every phase is audited before it takes effect (fail closed): if the sink
 *   throws, the state does not change.
 *
 * Memory is the store on purpose: a challenge must not survive a daemon
 * restart, so a crash can only ever lose approvals, never replay one.
 */
export class ChallengeManager {
  readonly #audit: ChallengeAuditSink;
  readonly #now: () => number;
  readonly #mono: () => number;
  readonly #ttl: number;
  readonly #confirmTtl: number;
  readonly #perActor: number;
  readonly #total: number;
  readonly #byRef = new Map<string, Record_>();
  readonly #tokens = new WeakMap<object, Record_>();

  constructor(options: ChallengeManagerOptions) {
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
    this.#mono = options.monotonic ?? (() => performance.now());
    this.#ttl = limit(options.challengeTtlMs, 60_000, MAX_TTL, "challengeTtlMs");
    this.#confirmTtl = limit(options.confirmationTtlMs, 30_000, MAX_TTL, "confirmationTtlMs");
    this.#perActor = limit(options.maxOutstandingPerActor, 8, 1024, "maxOutstandingPerActor");
    this.#total = limit(options.maxOutstandingTotal, 128, 65_536, "maxOutstandingTotal");
  }

  /** Open (unexpired, unresolved) challenges, optionally for one requester. */
  outstanding(actor?: string): number {
    this.#sweep();
    let n = 0;
    for (const r of this.#byRef.values()) if (OPEN.has(r.state) && (actor === undefined || r.requester === actor)) n++;
    return n;
  }

  issue(input: z.input<typeof issueSchema>): IssuedChallenge {
    const parsed = issueSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "challenge request");
    const p = parsed.data;
    this.#sweep();
    if (this.outstanding(p.actor) >= this.#perActor || this.outstanding() >= this.#total) {
      throw new ChallengeError("E_BACKPRESSURE", "Too many confirmations are waiting; resolve or wait for them to expire");
    }
    const id = randomToken();
    const ref = sha256Hex(id);
    const mono = this.#mono();
    const wall = this.#now();
    if (!Number.isFinite(mono) || !Number.isFinite(wall) || wall < 0 || wall + this.#ttl > Number.MAX_SAFE_INTEGER) {
      throw new ChallengeError("E_INTERNAL", "The daemon clock is not usable");
    }
    const native = p.tier >= 4;
    const record: Record_ = {
      ref,
      requester: p.actor as ActorId,
      windowId: p.windowId,
      op: p.op,
      target: p.target,
      digest: requestDigest(p.op, p.target, p.contentDigest),
      tier: p.tier,
      native,
      expiresAt: mono + this.#ttl,
      wallExpiresAt: Math.floor(wall + this.#ttl),
      nativeProof: native ? randomToken() : null,
      state: "PENDING",
      tokenExpiresAt: 0,
      endedAt: 0,
    };
    // Build and validate the wire shape before anything is stored or audited,
    // so a failure leaves no record behind.
    const built = challengeSchema.safeParse({
      challengeId: id,
      digest: record.digest,
      contract: p.contract,
      method: p.op,
      tier: p.tier,
      targetSummary: p.targetSummary ?? p.target.slice(0, 512),
      nativeConfirmationRequired: native,
      expiresAt: record.wallExpiresAt,
    });
    if (!built.success) throw new ChallengeError("E_INTERNAL", "The challenge could not be built");
    this.#emit(record.requester, "tier4.challenge", record, "success", { phase: "issued", tier: record.tier });
    this.#byRef.set(ref, record);
    return { challenge: built.data, nativeProof: record.nativeProof };
  }

  resolve(input: z.input<typeof resolveSchema>): ResolveResult {
    const parsed = resolveSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "resolve request");
    const p = parsed.data;
    const rec = this.#find(p.challengeId);
    // Authorisation first, and it does not burn the challenge: a bystander must not be able to kill a legitimate one.
    if (p.actor !== "user") {
      this.#emit(p.actor as ActorId, "tier4.challenge", rec, "denied", { phase: "resolve", reason: "actor_not_user" });
      throw new ChallengeError("E_POLICY_DENIED", "Only the user can resolve a confirmation");
    }
    if (p.windowId !== rec.windowId) {
      this.#emit("user", "tier4.challenge", rec, "denied", { phase: "resolve", reason: "wrong_window" });
      throw new ChallengeError("E_POLICY_DENIED", "This confirmation belongs to a different window");
    }
    if (this.#expireIfDue(rec)) {
      this.#emit("user", "tier4.challenge", rec, "failure", { phase: "resolve", reason: "expired" });
      return { challengeId: p.challengeId, state: "expired", nativeRequired: rec.native };
    }
    if (rec.state !== "PENDING") {
      this.#emit("user", "tier4.challenge", rec, "denied", { phase: "resolve", reason: "not_pending", state: rec.state });
      throw new ChallengeError("E_CONFLICT", "This confirmation was already used", { state: rec.state });
    }
    if (!safeEqual(p.digest, rec.digest)) {
      this.#end(rec, "BURNED", "user", "resolve", "digest_mismatch");
      throw new ChallengeError("E_CONFLICT", "The request no longer matches what was shown; start again");
    }
    if (p.decision === "deny") {
      this.#emit("user", "tier4.challenge", rec, "success", { phase: "resolve", decision: "deny" });
      this.#finish(rec, "DENIED");
      return { challengeId: p.challengeId, state: "denied", nativeRequired: rec.native };
    }
    if (rec.native) {
      this.#emit("user", "tier4.challenge", rec, "success", { phase: "resolve", decision: "approve", awaitingNative: true });
      rec.state = "AWAITING_NATIVE";
      return { challengeId: p.challengeId, state: "approved", nativeRequired: true };
    }
    this.#emit("user", "tier4.challenge", rec, "success", { phase: "resolve", decision: "approve" });
    return { challengeId: p.challengeId, state: "approved", nativeRequired: false, token: this.#mint(rec) };
  }

  /**
   * The native dialog's result, delivered over the privileged port. `proof` is
   * the `nativeProof` returned by `issue`; a wrong proof burns the challenge.
   */
  confirmNative(input: z.input<typeof nativeSchema>): ResolveResult {
    const parsed = nativeSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "native confirmation");
    const p = parsed.data;
    const rec = this.#find(p.challengeId);
    if (p.windowId !== rec.windowId) {
      this.#emit("user", "tier4.challenge", rec, "denied", { phase: "native", reason: "wrong_window" });
      throw new ChallengeError("E_POLICY_DENIED", "This confirmation belongs to a different window");
    }
    if (this.#expireIfDue(rec)) {
      this.#emit("user", "tier4.challenge", rec, "failure", { phase: "native", reason: "expired" });
      return { challengeId: p.challengeId, state: "expired", nativeRequired: true };
    }
    if (rec.state !== "AWAITING_NATIVE" || rec.nativeProof === null) {
      this.#emit("user", "tier4.challenge", rec, "denied", { phase: "native", reason: "not_awaiting", state: rec.state });
      throw new ChallengeError("E_CONFLICT", "This confirmation is not waiting for a native dialog", { state: rec.state });
    }
    if (!safeEqual(p.proof, rec.nativeProof)) {
      this.#end(rec, "BURNED", "user", "native", "bad_proof");
      throw new ChallengeError("E_POLICY_DENIED", "Native confirmation was not accepted");
    }
    if (!p.confirmed) {
      this.#emit("user", "tier4.challenge", rec, "success", { phase: "native", decision: "cancel" });
      this.#finish(rec, "DENIED");
      return { challengeId: p.challengeId, state: "denied", nativeRequired: true };
    }
    this.#emit("user", "tier4.challenge", rec, "success", { phase: "native", decision: "confirm" });
    return { challengeId: p.challengeId, state: "approved", nativeRequired: true, token: this.#mint(rec) };
  }

  /**
   * Run `action` only if `token` is a live confirmation for exactly this
   * operation and target, and the content digest recomputed now still equals
   * the one the user confirmed (G-24). The token is spent before `action`
   * starts, so two concurrent calls cannot both run and a failing action
   * cannot be retried on the same approval. Compute `currentContentDigest`
   * while holding whatever lock protects the content, and call this straight
   * after, so nothing can change in between.
   *
   * The daemon bridges to `@axis/worktrees` inside `action`, for example by
   * calling `markDiscardConfirmed()` there.
   */
  async execute<T>(
    token: ConfirmationToken,
    context: z.input<typeof executeContextSchema>,
    action: (confirmed: ConfirmedAction) => T | Promise<T>,
  ): Promise<T> {
    const rec = typeof token === "object" && token !== null ? this.#tokens.get(token) : undefined;
    if (!rec) throw new ChallengeError("E_POLICY_DENIED", "That is not a confirmation issued by this daemon");
    const parsed = executeContextSchema.safeParse(context);
    if (!parsed.success) throw invalid(parsed.error, "execute context");
    const c = parsed.data;
    if (rec.state !== "CONFIRMED") {
      this.#emit("daemon", "tier4.execute", rec, "denied", { phase: "execute", reason: "not_live", state: rec.state });
      throw new ChallengeError("E_CONFLICT", "This confirmation was already used or has ended", { state: rec.state });
    }
    if (this.#mono() >= rec.tokenExpiresAt) {
      this.#end(rec, "EXPIRED", "daemon", "execute", "token_expired", "tier4.execute");
      throw new ChallengeError("E_CONFLICT", "The confirmation expired; ask again");
    }
    if (c.op !== rec.op || c.target !== rec.target) {
      this.#end(rec, "BURNED", "daemon", "execute", "op_or_target_mismatch", "tier4.execute");
      throw new ChallengeError("E_POLICY_DENIED", "The confirmation does not cover this operation");
    }
    if (!safeEqual(requestDigest(c.op, c.target, c.currentContentDigest), rec.digest)) {
      this.#end(rec, "BURNED", "daemon", "execute", "content_changed", "tier4.execute");
      throw new ChallengeError("E_CONFLICT", "The content changed after it was confirmed; review and confirm again");
    }
    // Spend first (synchronously, before any await), then audit, then act.
    rec.state = "CONSUMED";
    rec.endedAt = this.#mono();
    this.#emit("daemon", "tier4.execute", rec, "success", { phase: "authorised", approvedBy: "user" });
    let result: T;
    try {
      result = await action({ op: rec.op, target: rec.target, requester: rec.requester });
    } catch (error) {
      // Nothing the action throws crosses this boundary: it may carry paths or secrets and is not a protocol code.
      const errorName = error instanceof Error ? error.name.slice(0, 64) : "unknown";
      try {
        this.#emit("daemon", "tier4.execute", rec, "error", { phase: "completed", errorName });
      } catch {
        // The audit failure must not hide that the action ran (and failed).
      }
      throw new ChallengeError("E_INTERNAL", "The action failed after the confirmation was spent", { executed: true });
    }
    try {
      this.#emit("daemon", "tier4.execute", rec, "success", { phase: "completed" });
    } catch {
      throw new ChallengeError("E_INTERNAL", "The action ran but its completion could not be audited", { executed: true });
    }
    return result;
  }

  // ---- internals ----

  #find(challengeId: string): Record_ {
    const rec = this.#byRef.get(sha256Hex(challengeId));
    if (!rec) throw new ChallengeError("E_NOT_FOUND", "Unknown or expired confirmation");
    return rec;
  }

  #mint(rec: Record_): ConfirmationToken {
    const token = Object.freeze({}) as ConfirmationToken;
    rec.state = "CONFIRMED";
    rec.nativeProof = null;
    rec.tokenExpiresAt = this.#mono() + this.#confirmTtl;
    this.#tokens.set(token, rec);
    return token;
  }

  #finish(rec: Record_, state: State): void {
    rec.state = state;
    rec.nativeProof = null;
    rec.endedAt = this.#mono();
  }

  #end(rec: Record_, state: State, actor: ActorId, phase: string, reason: string, action: ChallengeAuditEvent["action"] = "tier4.challenge"): void {
    try {
      this.#emit(actor, action, rec, "denied", { phase, reason });
    } finally {
      // Burn even if the sink failed: refusing is always safe.
      this.#finish(rec, state);
    }
  }

  /** Marks an open challenge expired. Returns true if it is (now) expired. */
  #expireIfDue(rec: Record_): boolean {
    if (rec.state === "EXPIRED") return true;
    if (OPEN.has(rec.state) && this.#mono() >= rec.expiresAt) {
      this.#finish(rec, "EXPIRED");
      return true;
    }
    return false;
  }

  #emit(
    actor: ActorId,
    action: ChallengeAuditEvent["action"],
    rec: Record_,
    outcome: ChallengeAuditEvent["outcome"],
    payload: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    // `ref` is a hash prefix of the id: enough to correlate, useless to resolve.
    try {
      this.#audit.append({ actor, action, target: rec.target, outcome, payload: { ...payload, op: rec.op, ref: rec.ref.slice(0, 12) } });
    } catch {
      // The sink's own error may name paths or hosts, and is not a protocol code.
      const detail = action === "tier4.execute" ? { executed: false } : {};
      throw new ChallengeError("E_INTERNAL", "The approval audit log is unavailable", detail);
    }
  }

  /** Drop finished records after a grace period and expire stale open ones, bounding memory. */
  #sweep(): void {
    const now = this.#mono();
    for (const [ref, r] of this.#byRef) {
      if (OPEN.has(r.state) && now >= r.expiresAt) this.#finish(r, "EXPIRED");
      else if (r.state === "CONFIRMED" && now >= r.tokenExpiresAt) this.#finish(r, "EXPIRED");
      if (!OPEN.has(r.state) && r.state !== "CONFIRMED" && now - r.endedAt > 2 * this.#ttl) this.#byRef.delete(ref);
    }
  }
}
