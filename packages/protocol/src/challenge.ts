// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { requestIdSchema } from "./envelope.js";

/**
 * Challenge and confirmation shapes (ADR 0003 D4, task B4).
 *
 * Flow: the daemon answers a tier-4/5 request with E_APPROVAL_REQUIRED and a
 * `challenge` in the error details. The renderer shows it. A `user` actor then
 * calls `axis.approvals/1.resolve`; for tier 4-5 the daemon additionally asks
 * main for a native confirmation over the privileged port. Agent actors
 * calling `resolve` get E_POLICY_DENIED. Nothing here lets a caller mint a grant.
 */

export const challengeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
/** SHA-256 over the canonical request, hex. Binds the challenge to one request. */
export const requestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const permissionTierSchema = z.number().int().min(0).max(5);

/** Issued by the daemon. The renderer may display it but cannot create one. */
export const challengeSchema = z.strictObject({
  challengeId: challengeIdSchema,
  digest: requestDigestSchema,
  contract: z.string().max(64),
  method: z.string().max(64),
  tier: permissionTierSchema,
  /** User-safe, redacted one-line description of the target. */
  targetSummary: z.string().max(512),
  /** True when tier >= 4: the daemon also requires a native confirmation. */
  nativeConfirmationRequired: z.boolean(),
  /** Epoch milliseconds. A challenge is single-use and short-lived. */
  expiresAt: z.number().int().positive(),
});
export type Challenge = z.infer<typeof challengeSchema>;

export const challengeDecisionSchema = z.enum(["approve", "deny"]);

/** `axis.approvals/1.resolve` request. Identity is never taken from this payload. */
export const resolveChallengeRequestSchema = z.strictObject({
  challengeId: challengeIdSchema,
  decision: challengeDecisionSchema,
  /** The digest the UI displayed, echoed so a stale or swapped challenge is refused. */
  digest: requestDigestSchema,
});
export type ResolveChallengeRequest = z.infer<typeof resolveChallengeRequestSchema>;

export const resolveChallengeResponseSchema = z.strictObject({
  challengeId: challengeIdSchema,
  state: z.enum(["approved", "denied", "expired"]),
});

/**
 * Retry of the original request after approval. The daemon re-derives the
 * digest from the new request and refuses on any difference.
 */
export const challengeReferenceSchema = z.strictObject({
  challengeId: challengeIdSchema,
  /** The original request id, for correlation only. */
  originalRequestId: requestIdSchema.optional(),
});
export type ChallengeReference = z.infer<typeof challengeReferenceSchema>;

/** Details carried by an E_APPROVAL_REQUIRED error. */
export const approvalRequiredDetailsSchema = z.strictObject({
  challenge: challengeSchema,
});
