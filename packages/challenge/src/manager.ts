// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { challengeIdSchema, challengeSchema, type Challenge } from "@axis/protocol";
import { z } from "zod";
import { actionFailure, safeName } from "./action-error.js";
import { challengeDigest, randomToken, safeEqual, sha256Hex } from "./crypto.js";
import { ChallengeError } from "./errors.js";
import {
  defaultSummary,
  digestOf,
  callerSchema,
  executeContextSchema,
  invalid,
  issueSchema,
  nativeCallerSchema,
  nativeSchema,
  resolveSchema,
  resolverSchema,
  type ActorId,
  type ChallengeAuditEvent,
  type ChallengeAuditSink,
} from "./schemas.js";
import { Tombstones } from "./tombstones.js";
import { limit, MAX_TTL, OPEN, type ChallengeManagerOptions, type ConfirmedAction, type Record_, type ResolveResult, type State, type WithdrawResult } from "./types.js";

export type { ActorId, ChallengeAuditEvent, ChallengeAuditSink } from "./schemas.js";
export type { ChallengeManagerOptions, ConfirmedAction, ResolveResult, WithdrawResult } from "./types.js";

/** What an audit event names: a record, or for an unknown id just the id's own hash, so refusing an unknown id costs the same as refusing a wrong caller. */
interface Subject {
  readonly target: string;
  readonly method: string;
  readonly ref: string;
}

/**
 * Daemon-side tier-4 challenges (task B4; APR-1, APR-2, G-24).
 *
 *   issue -> resolve(approve) -> [confirmNative] -> consume
 *
 * - Ids are 256 random bits; records are keyed by their SHA-256.
 * - A challenge is single-use, short-lived, and bound to operation, target and
 *   the digest of what will be destroyed.
 * - Only the `user` actor, from the window the challenge was issued to, can
 *   resolve it. Agents get E_POLICY_DENIED.
 * - `consume` re-checks the bound digest against the current state (TOCTOU) and
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
  readonly #clock: () => number;
  /** Last finite monotonic reading, for record timestamps after the clock fails. */
  #last = 0;
  readonly #ttl: number;
  readonly #confirmTtl: number;
  readonly #perActor: number;
  readonly #perWindow: number;
  readonly #total: number;
  readonly #byRef = new Map<string, Record_>();
  readonly #tombs = new Tombstones();

  constructor(options: ChallengeManagerOptions) {
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
    this.#clock = options.monotonic ?? (() => performance.now());
    this.#ttl = limit(options.challengeTtlMs, 60_000, MAX_TTL, "challengeTtlMs");
    this.#confirmTtl = limit(options.confirmationTtlMs, 30_000, MAX_TTL, "confirmationTtlMs");
    this.#perActor = limit(options.maxOutstandingPerActor, 8, 1024, "maxOutstandingPerActor");
    this.#perWindow = limit(options.maxOutstandingPerWindow, 16, 1024, "maxOutstandingPerWindow");
    this.#total = limit(options.maxOutstandingTotal, 128, 65_536, "maxOutstandingTotal");
  }

  /** Open (unexpired, unresolved) challenges, optionally for one requester and/or one window. */
  outstanding(actor?: string, windowId?: string): number {
    this.#sweep();
    let n = 0;
    for (const r of this.#byRef.values()) {
      if (OPEN.has(r.state) && (actor === undefined || r.requester === actor) && (windowId === undefined || r.windowId === windowId)) n++;
    }
    return n;
  }

  /** Reads the monotonic clock. A reading that is not finite expires everything live and fails closed. */
  #mono(): number {
    const v = this.#clock();
    if (Number.isFinite(v)) {
      this.#last = v;
      return v;
    }
    for (const r of this.#byRef.values()) if (OPEN.has(r.state) || r.state === "CONFIRMED") this.#finish(r, "EXPIRED");
    throw new ChallengeError("E_INTERNAL", "The daemon clock is not usable");
  }

  /**
   * Returns the renderer-visible challenge and nothing else, so serialising the
   * result can never leak a secret. The native-confirmation proof is fetched
   * separately with `takeNativeProof`.
   */
  issue(input: z.input<typeof issueSchema>): Challenge {
    const parsed = issueSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "challenge request");
    const p = parsed.data;
    this.#sweep();
    let actorN = 0;
    let windowN = 0;
    let totalN = 0;
    for (const r of this.#byRef.values()) {
      if (!OPEN.has(r.state)) continue;
      totalN++;
      if (r.requester === p.actor) actorN++;
      if (r.windowId === p.windowId) windowN++;
    }
    const t = this.#tombs.count(p.actor, p.windowId);
    if (actorN + t.actor >= this.#perActor || windowN + t.window >= this.#perWindow || totalN + t.total >= this.#total) {
      throw new ChallengeError("E_BACKPRESSURE", "Too many confirmations are waiting; resolve or wait for them to expire");
    }
    const id = randomToken();
    const ref = sha256Hex(id);
    const mono = this.#mono();
    const wall = this.#now();
    if (!Number.isFinite(wall) || wall < 0 || wall + this.#ttl > Number.MAX_SAFE_INTEGER) {
      throw new ChallengeError("E_INTERNAL", "The daemon clock is not usable");
    }
    const native = p.tier >= 4;
    const reqDigest = digestOf(p) as string; // non-null: the schema refines it
    const record: Record_ = {
      ref,
      requester: p.actor as ActorId,
      connectionId: p.connectionId,
      windowId: p.windowId,
      contract: p.contract,
      version: p.version,
      method: p.method,
      target: p.target,
      requestDigest: reqDigest,
      digest: challengeDigest({ requestDigest: reqDigest, target: p.target, contentDigest: p.contentDigest }),
      tier: p.tier,
      native,
      expiresAt: mono + this.#ttl,
      wallExpiresAt: Math.floor(wall + this.#ttl),
      nativeProof: native ? randomToken() : null,
      proofTaken: false,
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
      method: p.method,
      tier: p.tier,
      targetSummary: p.targetSummary ?? defaultSummary(p.target),
      nativeConfirmationRequired: native,
      expiresAt: record.wallExpiresAt,
    });
    if (!built.success) throw new ChallengeError("E_INTERNAL", "The challenge could not be built");
    this.#emit(record.requester, "tier4.challenge", record, "success", { phase: "issued", tier: record.tier });
    this.#byRef.set(ref, record);
    return built.data;
  }

  /**
   * The secret for the privileged native-confirmation path (daemon to main).
   * Call it once, right after `issue` and before the challenge reaches any
   * other party; later calls, an unknown id and a tier with no native step all
   * return null. Never send it to a renderer or an agent.
   */
  takeNativeProof(challengeId: string): string | null {
    const rec = this.#byRef.get(sha256Hex(challengeId));
    if (!rec || rec.nativeProof === null || rec.proofTaken) return null;
    rec.proofTaken = true;
    return rec.nativeProof;
  }

  /**
   * `caller` is the identity the daemon attested for this connection and
   * `request` is the renderer's params, kept as two arguments so a payload can
   * never override who is calling. Unknown id, non-user actor and another
   * window all get the same E_POLICY_DENIED, so nothing reveals which ids exist.
   */
  resolve(caller: z.input<typeof resolverSchema>, request: z.input<typeof resolveSchema>): ResolveResult {
    const who = resolverSchema.safeParse(caller);
    if (!who.success) throw invalid(who.error, "caller");
    const parsed = resolveSchema.safeParse(request);
    if (!parsed.success) throw invalid(parsed.error, "resolve request");
    const p = parsed.data;
    const rec = this.#byRef.get(sha256Hex(p.challengeId));
    // Authorisation first, and it does not burn the challenge: a bystander must not be able to kill a legitimate one.
    if (who.data.actor !== "user") throw this.#refuse(who.data.actor as ActorId, rec, sha256Hex(p.challengeId), "tier4.challenge", "resolve", "actor_not_user");
    if (!rec || who.data.windowId !== rec.windowId) throw this.#refuse("user", rec, sha256Hex(p.challengeId), "tier4.challenge", "resolve", "wrong_window");
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
      this.#settle(rec, "DENIED", "user", "tier4.challenge", "success", { phase: "resolve", decision: "deny" });
      return { challengeId: p.challengeId, state: "denied", nativeRequired: rec.native };
    }
    if (rec.native) {
      this.#emit("user", "tier4.challenge", rec, "success", { phase: "resolve", decision: "approve", awaitingNative: true });
      rec.state = "AWAITING_NATIVE";
      return { challengeId: p.challengeId, state: "approved", nativeRequired: true };
    }
    this.#emit("user", "tier4.challenge", rec, "success", { phase: "resolve", decision: "approve" });
    this.#confirm(rec);
    return { challengeId: p.challengeId, state: "approved", nativeRequired: false };
  }

  /**
   * The native dialog's result, delivered over the privileged port. `proof` is
   * the `nativeProof` from `takeNativeProof`; a wrong proof burns the challenge.
   */
  confirmNative(caller: z.input<typeof nativeCallerSchema>, input: z.input<typeof nativeSchema>): ResolveResult {
    const who = nativeCallerSchema.safeParse(caller);
    if (!who.success) throw invalid(who.error, "caller");
    const parsed = nativeSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "native confirmation");
    const p = parsed.data;
    const rec = this.#byRef.get(sha256Hex(p.challengeId));
    if (!rec || who.data.windowId !== rec.windowId) throw this.#refuse("user", rec, sha256Hex(p.challengeId), "tier4.challenge", "native", "wrong_window");
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
      this.#settle(rec, "DENIED", "user", "tier4.challenge", "success", { phase: "native", decision: "cancel" });
      return { challengeId: p.challengeId, state: "denied", nativeRequired: true };
    }
    this.#emit("user", "tier4.challenge", rec, "success", { phase: "native", decision: "confirm" });
    this.#confirm(rec);
    return { challengeId: p.challengeId, state: "approved", nativeRequired: true };
  }

  /**
   * The only way to act on an approval. Called by the daemon when the original
   * request is retried with `approval: {challengeId}`:
   *
   *   manager.consume(request.approval.challengeId,
   *     { actor: conn.actor, connectionId: conn.id },   // from the transport, never the payload
   *     { contract, version, method, args: paramsWithoutApproval, target, currentContentDigest },
   *     (confirmed) => doTheDestructiveThing(confirmed));
   *
   * The challenge id is not a bearer credential: the manager looks the record
   * up by the id's hash and requires the same actor on the same connection that
   * the challenge was issued to (APR-1), so the daemon keeps no map from id to
   * grant and an id seen by the renderer or another agent is useless to them.
   *
   * `action` runs only if the challenge is a live, fully confirmed approval for
   * exactly this contract, operation, target and arguments, and the content
   * digest recomputed now still equals the one the user confirmed (G-24). The
   * approval is spent before `action` starts (synchronously, before any await),
   * so two concurrent calls cannot both run and a failing action cannot be
   * retried on the same approval. Compute `currentContentDigest` while holding
   * whatever lock protects the content, and call this straight after.
   *
   * The daemon bridges to `@axis/worktrees` inside `action`, for example by
   * calling `markDiscardConfirmed()` there.
   */
  async consume<T>(
    challengeId: string,
    caller: z.input<typeof callerSchema>,
    context: z.input<typeof executeContextSchema>,
    action: (confirmed: ConfirmedAction) => T | Promise<T>,
  ): Promise<T> {
    const id = challengeIdSchema.safeParse(challengeId);
    if (!id.success) throw invalid(id.error, "challenge id");
    const who = callerSchema.safeParse(caller);
    if (!who.success) throw invalid(who.error, "caller");
    const parsed = executeContextSchema.safeParse(context);
    if (!parsed.success) throw invalid(parsed.error, "execute context");
    if (typeof action !== "function") throw new ChallengeError("E_INVALID_ARGUMENT", "Invalid action");
    const c = parsed.data;
    const reqDigest = digestOf(c) as string; // non-null: the schema refines it
    const ref = sha256Hex(id.data);
    const rec = this.#byRef.get(ref);
    // Unknown id and wrong caller are the same refusal and the same work (one hash, one best-effort audit write), so a probing caller learns nothing about which ids exist.
    // A refusal here burns nothing: a bystander must not be able to kill someone else's approval.
    if (!rec || rec.requester !== who.data.actor || rec.connectionId !== who.data.connectionId) {
      throw this.#refuse(who.data.actor as ActorId, rec, ref, "tier4.execute", "execute", "wrong_caller");
    }
    if (rec.state !== "CONFIRMED") {
      this.#emit("daemon", "tier4.execute", rec, "denied", { phase: "execute", reason: "not_live", state: rec.state });
      throw new ChallengeError("E_CONFLICT", "This confirmation was already used or has ended", { state: rec.state });
    }
    if (this.#mono() >= rec.tokenExpiresAt) {
      this.#end(rec, "EXPIRED", "daemon", "execute", "token_expired", "tier4.execute");
      throw new ChallengeError("E_CONFLICT", "The confirmation expired; ask again");
    }
    if (c.target !== rec.target || c.contract !== rec.contract || c.version !== rec.version || c.method !== rec.method || reqDigest !== rec.requestDigest) {
      this.#end(rec, "BURNED", "daemon", "execute", "request_mismatch", "tier4.execute");
      throw new ChallengeError("E_POLICY_DENIED", "The confirmation does not cover this request");
    }
    const current = challengeDigest({ requestDigest: reqDigest, target: c.target, contentDigest: c.currentContentDigest });
    if (!safeEqual(current, rec.digest)) {
      this.#end(rec, "BURNED", "daemon", "execute", "content_changed", "tier4.execute");
      throw new ChallengeError("E_CONFLICT", "The content changed after it was confirmed; review and confirm again");
    }
    // Spend first (synchronously, before any await), then audit, then act.
    rec.state = "CONSUMED";
    rec.endedAt = this.#last;
    this.#emit("daemon", "tier4.execute", rec, "success", { phase: "authorised", approvedBy: "user" });
    let result: T;
    try {
      result = await action({ method: rec.method, target: rec.target, requester: rec.requester });
    } catch (error) {
      // Nothing the action throws crosses this boundary except a protocol-shaped code and its safe message: the rest may carry paths or secrets.
      const errorName = safeName(error);
      try {
        this.#emit("daemon", "tier4.execute", rec, "error", { phase: "completed", errorName });
      } catch {
        // The audit failure must not hide that the action ran (and failed).
      }
      throw actionFailure(error);
    }
    try {
      this.#emit("daemon", "tier4.execute", rec, "success", { phase: "completed" });
    } catch {
      throw new ChallengeError("E_INTERNAL", "The action ran but its completion could not be audited", { executed: true });
    }
    return result;
  }

  /**
   * Ends an open or approved challenge because its request was aborted. Only
   * the requester on the connection it was issued to can withdraw it; anyone
   * else, an unknown id and an already-withdrawn challenge get the uniform
   * E_POLICY_DENIED. The record is dropped, so resolve and consume refuse its
   * id the same way, but it keeps counting against the requester's per-actor,
   * per-window and total quotas until its original expiry, so withdrawing
   * cannot be used to put more prompts in front of the user. The audit is best
   * effort.
   *
   * Returns `{ withdrawn: false, reason: "spent" }` when the approval was
   * already consumed (the action ran or is running), and `reason: "ended"` when
   * it was already denied, expired or burned; nothing changes in either case.
   */
  withdraw(challengeId: string, caller: z.input<typeof callerSchema>): WithdrawResult {
    const id = challengeIdSchema.safeParse(challengeId);
    if (!id.success) throw invalid(id.error, "challenge id");
    const who = callerSchema.safeParse(caller);
    if (!who.success) throw invalid(who.error, "caller");
    const ref = sha256Hex(id.data);
    const rec = this.#byRef.get(ref);
    if (!rec || rec.requester !== who.data.actor || rec.connectionId !== who.data.connectionId) {
      throw this.#refuse(who.data.actor as ActorId, rec, ref, "tier4.challenge", "withdraw", "wrong_caller");
    }
    if (rec.state === "CONSUMED") return { withdrawn: false, reason: "spent" };
    if (!OPEN.has(rec.state) && rec.state !== "CONFIRMED") return { withdrawn: false, reason: "ended" };
    this.#drop(rec, who.data.actor as ActorId, this.#mono() < rec.expiresAt);
    return { withdrawn: true };
  }

  /** Ends every live challenge issued to a connection that has closed, and frees their quota (a closed connection cannot prompt). Returns how many it ended. */
  withdrawConnection(connectionId: string): number {
    const parsed = callerSchema.shape.connectionId.safeParse(connectionId);
    if (!parsed.success) throw invalid(parsed.error, "connection id");
    let n = 0;
    for (const rec of this.#byRef.values()) {
      if (rec.connectionId === parsed.data && (OPEN.has(rec.state) || rec.state === "CONFIRMED")) {
        this.#drop(rec, "daemon", false);
        n++;
      }
    }
    return n;
  }

  #drop(rec: Record_, actor: ActorId, tombstone: boolean): void {
    try {
      this.#emit(actor, "tier4.challenge", rec, "denied", { phase: "withdraw", reason: "request_aborted" });
    } catch {
      // Ending is what matters; the audit is best effort here.
    }
    this.#byRef.delete(rec.ref);
    if (tombstone) this.#tombs.add(rec.ref, rec.requester, rec.windowId, rec.expiresAt);
  }

  // ---- internals ----

  /**
   * The one refusal for "not yours or not there". It always audits, best effort
   * (a record, or for an unknown id its hash), so the answer and the work done
   * do not depend on the sink's health or on whether the id is real.
   */
  #refuse(actor: ActorId, rec: Record_ | undefined, ref: string, action: ChallengeAuditEvent["action"], phase: string, reason: string): ChallengeError {
    try {
      this.#emit(actor, action, rec ?? { target: "", method: "", ref }, "denied", { phase, reason: rec ? reason : "unknown_id" });
    } catch {
      // See above.
    }
    return new ChallengeError("E_POLICY_DENIED", "That confirmation is not available to this caller");
  }

  #confirm(rec: Record_): void {
    rec.state = "CONFIRMED";
    rec.nativeProof = null;
    rec.tokenExpiresAt = this.#mono() + this.#confirmTtl;
  }

  #finish(rec: Record_, state: State): void {
    rec.state = state;
    rec.nativeProof = null;
    rec.endedAt = this.#last;
  }

  #end(rec: Record_, state: State, actor: ActorId, phase: string, reason: string, action: ChallengeAuditEvent["action"] = "tier4.challenge"): void {
    this.#settle(rec, state, actor, action, "denied", { phase, reason });
  }

  /**
   * Ends a challenge, then audits it. Ending first means a
   * failing sink can never keep a challenge alive: refusing is always safe, so
   * a deny, a burn or an expiry takes effect whatever the sink does. The
   * caller still gets E_INTERNAL when the audit failed.
   */
  #settle(
    rec: Record_,
    state: State,
    actor: ActorId,
    action: ChallengeAuditEvent["action"],
    outcome: ChallengeAuditEvent["outcome"],
    payload: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    this.#finish(rec, state);
    this.#emit(actor, action, rec, outcome, payload);
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
    rec: Subject,
    outcome: ChallengeAuditEvent["outcome"],
    payload: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    try {
      // The target is audited as a hash (ADR 0003 D5): raw targets may become paths. The same target always hashes the same, so events still correlate.
      // `ref` is a hash prefix of the id: enough to correlate, useless to resolve.
      const result: unknown = this.#audit.append({ actor, action, target: `sha256:${sha256Hex(rec.target)}`, outcome, payload: { ...payload, method: rec.method, ref: rec.ref.slice(0, 12) } });
      if (typeof result === "object" && result !== null && typeof (result as { then?: unknown }).then === "function") {
        // An asynchronous sink cannot be waited for on this path: treat the write as failed, and swallow its rejection.
        Promise.resolve(result).catch(() => undefined);
        throw new Error("async audit sink");
      }
    } catch {
      // The sink's own error may name paths or hosts, and is not a protocol code.
      const detail = action === "tier4.execute" ? { executed: false } : {};
      throw new ChallengeError("E_INTERNAL", "The approval audit log is unavailable", detail);
    }
  }

  /** Drop finished records after a grace period and expire stale open ones, bounding memory. */
  #sweep(): void {
    const now = this.#mono();
    this.#tombs.sweep(now);
    for (const [ref, r] of this.#byRef) {
      if (OPEN.has(r.state) && now >= r.expiresAt) this.#finish(r, "EXPIRED");
      else if (r.state === "CONFIRMED" && now >= r.tokenExpiresAt) this.#finish(r, "EXPIRED");
      if (!OPEN.has(r.state) && r.state !== "CONFIRMED" && now - r.endedAt > 2 * this.#ttl) this.#byRef.delete(ref);
    }
  }
}
