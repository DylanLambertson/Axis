// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ChallengeError } from "./errors.js";
import type { ActorId, ChallengeAuditSink } from "./schemas.js";

export interface ResolveResult {
  readonly challengeId: string;
  readonly state: "approved" | "denied" | "expired";
  /** True while a native confirmation is still outstanding. */
  readonly nativeRequired: boolean;
}

/** What `consume` hands to the action: the verified facts, nothing secret. */
export interface ConfirmedAction {
  readonly method: string;
  readonly target: string;
  readonly requester: ActorId;
}

export interface ChallengeManagerOptions {
  readonly audit: ChallengeAuditSink;
  /** Wall clock in epoch ms. Used only for the wire `expiresAt`; never for deadlines. */
  readonly now?: () => number;
  /** Monotonic clock in ms (default `performance.now`). Every internal TTL runs on this one, so a wall-clock step cannot extend a challenge or approval. */
  readonly monotonic?: () => number;
  /** Challenge lifetime. Default 60 s, at most 5 min. */
  readonly challengeTtlMs?: number;
  /** How long a fully confirmed approval stays usable. Default 30 s, at most 5 min. */
  readonly confirmationTtlMs?: number;
  /** Open challenges per requesting actor. Default 8. */
  readonly maxOutstandingPerActor?: number;
  /**
   * Open challenges shown in one window. Default 16. Keeps one window's backlog
   * from using every slot. Finished records linger for twice the challenge TTL
   * at whatever rate the user resolves them, so the per-window rate limit
   * (ADR 0003) is what bounds churn; this only bounds what is open at once.
   */
  readonly maxOutstandingPerWindow?: number;
  /** Open challenges overall. Default 128. */
  readonly maxOutstandingTotal?: number;
}

export type State = "PENDING" | "AWAITING_NATIVE" | "CONFIRMED" | "DENIED" | "EXPIRED" | "BURNED" | "CONSUMED";

export interface Record_ {
  readonly ref: string;
  readonly requester: ActorId;
  readonly connectionId: string;
  readonly windowId: string;
  readonly contract: string;
  readonly version: number;
  readonly method: string;
  readonly target: string;
  /** Digest of the approved request: contract, version, method and args. */
  readonly requestDigest: string;
  /** Digest shown on the challenge: request digest, target and content digest. */
  readonly digest: string;
  readonly tier: number;
  readonly native: boolean;
  /** Monotonic deadline. */
  readonly expiresAt: number;
  /** Wall-clock deadline, for display on the wire only. */
  readonly wallExpiresAt: number;
  nativeProof: string | null;
  proofTaken: boolean;
  state: State;
  tokenExpiresAt: number;
  endedAt: number;
}

export const OPEN: ReadonlySet<State> = new Set<State>(["PENDING", "AWAITING_NATIVE"]);
export const MAX_TTL = 300_000;

export function limit(value: number | undefined, fallback: number, max: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 1 || v > max) {
    throw new ChallengeError("E_INVALID_ARGUMENT", `${name} must be an integer from 1 to ${max}`);
  }
  return v;
}

