// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { FORGE_HOST, vetOwnerRepo } from "./forge-wire.js";
import { countSchema, displayTextSchema, guarded } from "./guard.js";
import { projectIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.forge/1` (ticket PV-D2, docs/design/forge-pr-list.md): your open pull requests on `axis/*` branches of this
 * project's confirmed GitHub repository, read through the user's `gh` in the pty process, and the user's confirmation of
 * that repository. Every value a reply carries is closed or display-escaped by the daemon; no text from `gh` other than the
 * escaped row fields, and no URL from `gh`, is ever in a reply.
 */
export const FORGE_CONTRACT = "axis.forge" as const;
export const FORGE_VERSION = 1 as const;

/** The closed states of §7. */
export const FORGE_STATES = [
  "ok", "repository_unconfirmed", "remote_changed", "no_remote", "remote_invalid", "other_forge", "unsupported_host",
  "gh_missing", "gh_too_old", "not_logged_in", "keyring_unavailable", "auth_unsupported", "repo_not_found",
  "network_unavailable", "gh_failed", "timeout", "output_too_large", "output_invalid", "busy", "unsupported_platform",
  "unavailable",
] as const;
export type ForgeState = (typeof FORGE_STATES)[number];

export const FORGE_MAX_ROWS = 50;
export const FORGE_TITLE_CHARS = 200;
export const FORGE_BRANCH_CHARS = 120;
export const FORGE_LOGIN_CHARS = 64;

/** A vetted GitHub repository (§2). */
export const forgeRepositorySchema = z
  .strictObject({ host: z.literal(FORGE_HOST), owner: z.string().max(39), repo: z.string().max(100) })
  .refine((r) => vetOwnerRepo(r.owner, r.repo), "owner or repository refused");
export type ForgeRepository = z.infer<typeof forgeRepositorySchema>;

export const FORGE_CHECKS = ["passing", "failing", "pending", "none", "unknown"] as const;
export const FORGE_REVIEWS = ["approved", "changes_requested", "review_required", "none", "unknown"] as const;

/** The daemon-built link of a row, and nothing else: `https://github.com/<owner>/<repo>/pull/<number>`. */
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/;

export const forgePullRequestSchema = z.strictObject({
  number: z.number().int().min(1).max(2 ** 31),
  /** Display text (§5): escaped, cut with an ellipsis; plain text only. */
  title: displayTextSchema(FORGE_TITLE_CHARS + 1),
  branch: displayTextSchema(FORGE_BRANCH_CHARS + 1),
  author: displayTextSchema(FORGE_LOGIN_CHARS + 1),
  draft: z.boolean(),
  checks: z.enum(FORGE_CHECKS),
  review: z.enum(FORGE_REVIEWS),
  url: z.string().regex(PR_URL),
});
export type ForgePullRequest = z.infer<typeof forgePullRequestSchema>;

export const forgeTriggerSchema = z.enum(["view", "user"]);

export const forgePullRequestsRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema, trigger: forgeTriggerSchema }));
export const forgePullRequestsResponseSchema = guarded(
  z
    .strictObject({
      state: z.enum(FORGE_STATES),
      /** The pinned repository the list is from (always shown next to the list). */
      repository: forgeRepositorySchema.optional(),
      /** What the user is asked to confirm (`repository_unconfirmed`, `remote_changed`). */
      candidate: forgeRepositorySchema.optional(),
      rows: z.array(forgePullRequestSchema).max(FORGE_MAX_ROWS).optional(),
      /** The 50-row window was full: the list may be partial. */
      incomplete: z.boolean().optional(),
      /** Kept rows that failed the strict per-row check and were dropped. */
      invalidRows: countSchema.max(FORGE_MAX_ROWS).optional(),
      /** Age of the answer, from the daemon's monotonic clock. */
      ageMs: countSchema.optional(),
      stale: z.boolean().optional(),
      retryAfterMs: countSchema.optional(),
    })
    .refine((r) => (r.state === "ok") === (r.rows !== undefined), "rows exactly when ok")
    .refine((r) => (r.state === "repository_unconfirmed" || r.state === "remote_changed") === (r.candidate !== undefined), "a candidate exactly when one is asked for"),
);

export const forgePinRepositoryRequestSchema = guarded(
  z
    .strictObject({ projectId: projectIdSchema, host: z.literal(FORGE_HOST), owner: z.string().max(39), repo: z.string().max(100) })
    .refine((r) => vetOwnerRepo(r.owner, r.repo), "owner or repository refused"),
);
export const forgePinRepositoryResponseSchema = guarded(z.strictObject({ repository: forgeRepositorySchema }));

/**
 * The closed refusals of `axis.forge/1` (review S1a SF-3): every error a forge handler returns other than `E_INTERNAL` and
 * `E_CANCELLED` is one of these, with `details: { reason }` and the fixed message, so nothing from a remote, a pull request
 * or `gh` can reach an error.
 */
export const FORGE_REFUSALS = {
  E_NOT_FOUND: ["not_found"],
  E_CONFLICT: ["candidate_changed"],
} as const;
export type ForgeRefusalCode = keyof typeof FORGE_REFUSALS;
export type ForgeRefusalReason = (typeof FORGE_REFUSALS)[ForgeRefusalCode][number];
export const FORGE_REASONS = Object.values(FORGE_REFUSALS).flat();
export const forgeRefusalDetailsSchema = z.strictObject({ reason: z.enum(FORGE_REASONS as [string, ...string[]]) });
/** The one message text of every forge refusal. */
export const FORGE_REFUSAL_MESSAGE = "The forge request was refused.";

export function isForgeRefusal(code: string, reason: string): boolean {
  return Object.hasOwn(FORGE_REFUSALS, code) && (FORGE_REFUSALS[code as ForgeRefusalCode] as readonly string[]).includes(reason);
}

export const forgeMethods = {
  pullRequests: {
    request: forgePullRequestsRequestSchema,
    response: forgePullRequestsResponseSchema,
    // A read: it starts the user's own `gh` to read pull requests and sends nothing of the caller's (a "network" method is a
    // tier 3 send). The bounds of §6 (no timer, 15 s minimum, single flight) hold whatever the caller does.
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 30_000,
  },
  pinRepository: {
    request: forgePinRepositoryRequestSchema,
    response: forgePinRepositoryResponseSchema,
    sideEffect: "write",
    tier: 1,
    idempotency: "none",
    timeoutMs: 10_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type ForgeMethod = keyof typeof forgeMethods;
export type ForgeRequest<M extends ForgeMethod> = z.infer<(typeof forgeMethods)[M]["request"]>;
export type ForgeResponse<M extends ForgeMethod> = z.infer<(typeof forgeMethods)[M]["response"]>;
