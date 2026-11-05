// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import {
  challengeSchema,
  resolveChallengeRequestSchema,
  resolveChallengeResponseSchema,
} from "./challenge.js";
import { emptyRequestSchema, guarded } from "./guard.js";
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

/** Most open challenges one listing can carry (the challenge manager's overall default). */
export const MAX_PENDING_CHALLENGES = 128;

// resolve (write, tier 2, user only)
export const approvalsResolveRequestSchema = guarded(resolveChallengeRequestSchema);
export const approvalsResolveResponseSchema = guarded(resolveChallengeResponseSchema);

// pending (read, tier 0): the caller's own window, so no parameters
export const approvalsPendingRequestSchema = emptyRequestSchema;
export const approvalsPendingResponseSchema = guarded(
  z.strictObject({
    challenges: z
      .array(challengeSchema)
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
