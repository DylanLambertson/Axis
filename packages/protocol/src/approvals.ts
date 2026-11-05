// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import {
  challengeSchema,
  resolveChallengeRequestSchema,
  resolveChallengeResponseSchema,
} from "./challenge.js";
import { displayTextSchema, emptyRequestSchema, guarded } from "./guard.js";
import type { MethodSpec } from "./worktrees.js";

/**
 * `axis.approvals/1` (docs/design/daemon-host.md section 4.2, ADR 0003 D4).
 *
 * `resolve` is the user's answer to a challenge the daemon issued. It is tier
 * 2 on purpose: at tier 3 or above resolving would itself need a challenge.
 * It is for `user` actors only; that is a policy row (the registry has no
 * actor field), so an `agent:*` caller is refused by policy with
 * E_POLICY_DENIED, never by this schema. The caller cannot name who approved
 * and cannot create a challenge: identity comes from the port.
 */

export const APPROVALS_CONTRACT = "axis.approvals" as const;
export const APPROVALS_VERSION = 1 as const;

/**
 * Most open challenges one listing can carry: the challenge manager's per-window
 * quota can be configured up to 1024. 1024 challenges are nine values each
 * (9,217 of the 10,000 the message walk allows) and, with the text bounds below
 * at their worst (three UTF-8 bytes per character), about 960 KB of the 1 MiB
 * message limit, so a full listing always fits.
 */
export const MAX_PENDING_CHALLENGES = 1024;

/**
 * Longest `targetSummary` a listing carries. `@axis/challenge` allows 512, which
 * would not fit 1024 challenges in one message; the handler that builds the
 * listing must shorten a longer summary (the full text stays in the
 * E_APPROVAL_REQUIRED details). The listing fails as a whole otherwise.
 */
export const MAX_LISTED_SUMMARY = 192;

/** A challenge as `pending` lists it: the issued shape, with the text fields held to display rules. */
export const listedChallengeSchema = z.strictObject({
  ...challengeSchema.shape,
  contract: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
  method: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  targetSummary: displayTextSchema(MAX_LISTED_SUMMARY),
});

// resolve (write, tier 2, user only)
export const approvalsResolveRequestSchema = guarded(resolveChallengeRequestSchema);
/**
 * `nativeRequired` is true while a native confirmation is still outstanding
 * (`ChallengeManager.resolve` reports it), so the UI can tell "approved" from
 * "approved, waiting for the native dialog" without re-reading `pending`.
 */
export const approvalsResolveResponseSchema = guarded(
  z.strictObject({ ...resolveChallengeResponseSchema.shape, nativeRequired: z.boolean() }),
);

// pending (read, tier 0): the caller's own window, so no parameters
export const approvalsPendingRequestSchema = emptyRequestSchema;
export const approvalsPendingResponseSchema = guarded(
  z.strictObject({
    challenges: z
      .array(listedChallengeSchema)
      .max(MAX_PENDING_CHALLENGES)
      .refine((cs) => new Set(cs.map((c) => c.challengeId)).size === cs.length, "duplicate challenge id"),
  }),
);

export const approvalsMethods = {
  resolve: {
    request: approvalsResolveRequestSchema,
    response: approvalsResolveResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "none",
    timeoutMs: 10_000,
  },
  pending: {
    request: approvalsPendingRequestSchema,
    response: approvalsPendingResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type ApprovalsMethod = keyof typeof approvalsMethods;
export type ApprovalsRequest<M extends ApprovalsMethod> = z.infer<(typeof approvalsMethods)[M]["request"]>;
export type ApprovalsResponse<M extends ApprovalsMethod> = z.infer<(typeof approvalsMethods)[M]["response"]>;
