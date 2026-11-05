// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { challengeReferenceSchema } from "./challenge.js";
import { CF_RANGES, INVISIBLE_RANGES, rangesToClass } from "./display.js";
import { displayTextSchema, guarded } from "./guard.js";
import { refNameSchema, relativePathSchema, workspaceIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.git/1` (docs/design/daemon-host.md section 4.2; decided in docs/design/daemon-host-plan.md question 1: a
 * contract of its own, not `axis.worktrees/1.commit` and `.push`). The request and result shapes line up with
 * `@axis/git-ops` (`CommitInput`, `CommitResult`, `PushInput`, `PushPlan`, `ConfirmedPlan`, `SecretFinding`,
 * `CompareInput`); `packages/git-ops/test/types/wire-shape.test.ts` checks the shared fields at compile time.
 *
 * What a request never carries (DMN-2, GIT-4): a path to operate on, the worktree, the git directory, the branch to
 * push, the base commit of a push or a remote URL. The host resolves all of them from the workspace id and the journal:
 * the branch from the workspace, `baseSha` from the last commit Axis pushed, the remote URL from the repository's own
 * configuration for the named remote. Identity of the caller never comes from a payload.
 *
 * Tiers (design 4.2 and the policy table): `pushPlan` is a read at tier 1, `compareUrl` a read at tier 0, `commit` a
 * write at tier 2 that is bound to the reviewed tree, parent and branch (a trusted project, an idempotency key), and
 * `push` is network at tier 4: always a challenge with native confirmation, with or without findings, bound to the plan
 * the user saw. Every method is for the `user` actor only; that is a policy row, not a field of the registry.
 */

export const GIT_CONTRACT = "axis.git" as const;
export const GIT_VERSION = 1 as const;

/** A full lower-case object id, SHA-1 or SHA-256 (`OBJECT_ID` in `@axis/git-ops`). */
export const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** A configured remote name, never a URL or an option (`REMOTE_NAME` in `@axis/git-ops`). */
export const remoteNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  // Stricter than `REMOTE_NAME`: git refuses a remote name that is not a valid ref component.
  .refine((n) => !n.includes("..") && !n.endsWith(".") && !n.endsWith(".lock"), "not a remote name");

/** The short name of an Axis branch: `axis/<slug>`, never `refs/heads/...` (`SLUG` in `@axis/git-ops`). */
export const axisBranchSchema = z.string().regex(/^axis\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

/** SHA-256 hex, as `planDigest` in `@axis/git-ops` writes it. */
export const planDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** `MAX_MESSAGE` in `@axis/git-ops`: the commit message, in UTF-16 code units. */
export const MAX_COMMIT_MESSAGE = 64 * 1024;
/** Most paths a push may allow although git treats them as binary. 50 paths of 4096 three-byte characters fit one message. */
export const MAX_ALLOWED_BINARY_PATHS = 50;
/**
 * Most findings one `pushPlan` reply lists. `@axis/git-ops` has no cap (a scan is limited by bytes and commits); the
 * host lists the first 500 and sets `findingsTruncated`. 500 findings are about 3,000 values and under 0.5 MB.
 */
export const MAX_PUSH_FINDINGS = 500;
/** Longest path or reason text on the wire. The host shortens a longer one; it never passes it unbounded. */
export const MAX_FINDING_PATH = 256;
export const MAX_PLAN_REASONS = 8;
export const MAX_PLAN_REASON_TEXT = 1024;
export const MAX_COMPARE_URL = 2048;
/** Most binary paths a blocked plan lists: what `allowedBinaryPaths` can hold, so every listed path can be allowed. */
export const MAX_BLOCKED_BINARY_PATHS = MAX_ALLOWED_BINARY_PATHS;

/**
 * `details.reason` values of a refusal, by error code: the ones `@axis/git-ops` and `@axis/review`'s `prepareCommit` raise
 * on the commit path (`test/packages/protocol-copies.test.mjs` compares both directions with their sources, codes
 * included). Closed sets; a client must treat another value as an unknown refusal. Never free text.
 */
export const GIT_COMMIT_REFUSALS = {
  /**
   * `head_moved`: HEAD, the checked-out branch or the parent is not the one reviewed. `stale`: `assertReviewFresh`, the
   * worktree no longer matches the reviewed tree. `index_changed`: the staged index changed since the review.
   * `operation_in_progress`: a merge, cherry-pick, revert, rebase or bisect is under way or the index has unmerged paths.
   * `ref_update_failed`: the branch could not be moved by compare-and-swap (a lock); it was left as it was. `snapshot_failed`: the worktree could not be read for the freshness check.
   * `git_drift`: the repository's git configuration changed since it was recorded (`commit` re-takes the drift check before it commits).
   */
  E_CONFLICT: ["head_moved", "stale", "index_changed", "operation_in_progress", "ref_update_failed", "snapshot_failed", "git_drift"],
  /** `too_large` and `not_found`: the freshness re-check reads the worktree and HEAD through `@axis/review`. */
  E_INVALID_ARGUMENT: ["too_large", "not_found"],
  /** HEAD is detached, or the branch has no commit: Axis commits on `axis/<slug>` only. */
  E_POLICY_DENIED: ["detached_head", "no_head"],
} as const;
export const GIT_COMMIT_REASONS = [
  ...GIT_COMMIT_REFUSALS.E_CONFLICT,
  ...GIT_COMMIT_REFUSALS.E_INVALID_ARGUMENT,
  ...GIT_COMMIT_REFUSALS.E_POLICY_DENIED,
] as const;
/**
 * Why a plan can never be pushed (`blocked` of `pushPlan`, and the `push` refusal of the same name), in the order the scan
 * decides (the first that applies): `message_unscannable` (a commit message nothing could read: NUL bytes, invalid text or an
 * unknown encoding; in either scan mode), `secrets_found` (`refuse` mode: the scan matched), `scan_incomplete` (`refuse` mode:
 * too large to scan completely), `binary_unscanned` (`refuse` mode: a binary path that is not in `allowedBinaryPaths`). In
 * `warn` mode only the first blocks; the others ask for confirmation instead.
 */
export const GIT_PUSH_BLOCKS = ["message_unscannable", "secrets_found", "scan_incomplete", "binary_unscanned"] as const;
export const GIT_PUSH_REFUSALS = {
  /**
   * `plan_changed`: the tip or the scan result differs from the plan the user confirmed: show the new plan. The four blocks:
   * the plan is refused before any challenge (the package raises them as `E_POLICY_DENIED` and the host answers `E_CONFLICT`).
   * `git_drift`: the repository's git configuration changed since it was recorded; the user must acknowledge the change first.
   */
  E_CONFLICT: ["plan_changed", ...GIT_PUSH_BLOCKS, "git_drift"],
} as const;
export const GIT_PUSH_REASONS = GIT_PUSH_REFUSALS.E_CONFLICT;
export const gitCommitReasonSchema = z.enum(GIT_COMMIT_REASONS);
export const gitPushReasonSchema = z.enum(GIT_PUSH_REASONS);
export const gitPushBlockSchema = z.enum(GIT_PUSH_BLOCKS);

/** No lone surrogate: it would be written to git as U+FFFD, so the message that is committed would not be the one that was shown. */
const wellFormed = (t: string): boolean => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t);

/**
 * Refused in a commit message: the C0 controls except tab, newline and carriage return (ESC starts a terminal sequence),
 * DEL and C1, line and paragraph separators, every format character (Cf: bidi controls, soft hyphen, zero-width space, word
 * joiner and invisible operators, BOM, the tag block that smuggles ASCII, the interlinear marks) EXCEPT the joiners U+200C and
 * U+200D that emoji and some scripts need, and the other invisible code points (variation selectors, the combining grapheme
 * joiner, Hangul fillers, blank braille). Explicit ranges (see `display.ts`), so every side agrees.
 */
/** `CF_RANGES` without U+200C and U+200D (written out: the set is data, not computed). */
const CF_EXCEPT_JOINERS = CF_RANGES.flatMap((r): Array<number | readonly [number, number]> => (typeof r !== "number" && r[0] === 0x200b ? [0x200b, [0x200e, 0x200f]] : [r]));
const UNSAFE_MESSAGE_CHARS = new RegExp(
  `[${rangesToClass([[0x0, 0x8], 0xb, 0xc, [0xe, 0x1f], [0x7f, 0x9f], 0x2028, 0x2029, ...CF_EXCEPT_JOINERS, ...INVISIBLE_RANGES])}]`,
  "u",
);

/** `check()` in commit: non-empty text, at most 64 KiB, no NUL. Newlines and tabs are fine. */
export const commitMessageSchema = z
  .string()
  .max(MAX_COMMIT_MESSAGE)
  .refine((m) => m.trim().length > 0 && wellFormed(m) && !UNSAFE_MESSAGE_CHARS.test(m), { message: "not a commit message" });

/** The identity the user expects. It is only compared with what the repository configuration yields; git never receives it. */
export const commitAuthorSchema = z.strictObject({
  name: displayTextSchema(256).refine((n) => n.length > 0 && !/[<>]/.test(n), "not a name"),
  email: displayTextSchema(320).refine((e) => e.length > 0 && !/[<>\s]/.test(e), "not an email"),
});

/** A path or rule shown to the user: bounded, with no control, bidi or zero-width characters. The host escapes it first (`escapeForDisplay`). */
const shownPathSchema = displayTextSchema(MAX_FINDING_PATH);

/**
 * One finding of the secret scan: the rule name, where, and the commit that carries it. Never the matched text
 * (`SecretFinding` in `@axis/git-ops`; PSH-1). `path` is the escaped display form.
 */
export const secretFindingSchema = z.strictObject({
  rule: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  path: shownPathSchema.optional(),
  line: z.number().int().min(0).optional(),
  commit: objectIdSchema.optional(),
});
export type SecretFindingWire = z.infer<typeof secretFindingSchema>;

/** What the user was shown and confirmed (`ConfirmedPlan` in `@axis/git-ops`). */
export const confirmedPlanSchema = z.strictObject({ tip: objectIdSchema, digest: planDigestSchema });

const allowedBinaryPaths = z.array(relativePathSchema).max(MAX_ALLOWED_BINARY_PATHS);

// pushPlan (read, tier 1): `planPush` for the workspace's own branch. It runs the scan; it pushes nothing.
export const gitPushPlanRequestSchema = guarded(
  z.strictObject({ workspaceId: workspaceIdSchema, remote: remoteNameSchema, allowedBinaryPaths: allowedBinaryPaths.optional() }),
);
export const gitPushPlanResponseSchema = guarded(
  z
    .strictObject({
      remote: remoteNameSchema,
      branch: axisBranchSchema,
      /** The scanned commit, which is what a push sends. */
      tip: objectIdSchema,
      requiresConfirmation: z.boolean(),
      /** Why confirmation is needed (rule names, counts, commit prefixes, display paths). Never matched text. */
      reasons: z.array(displayTextSchema(MAX_PLAN_REASON_TEXT)).max(MAX_PLAN_REASONS),
      findings: z.array(secretFindingSchema).max(MAX_PUSH_FINDINGS),
      /** The scan found more than `findings` lists. The digest covers all of them. */
      findingsTruncated: z.boolean(),
      /** `PushPlan.digest`: a confirmation is bound to it and `push` sends it back as `confirmedPlan`. */
      digest: planDigestSchema,
      /**
       * Present only when the scan blocks the push (`GIT_PUSH_BLOCKS`): the plan cannot be confirmed and `push` refuses it with the
       * same reason. `findings` says which rules matched and where. `binaryPaths` are the binary paths still to be listed in
       * `allowedBinaryPaths`, in the DISPLAY form: it equals the path only when the path is not shortened (over 256 units) and holds no
       * backslash, ellipsis, control or format character, so any other path cannot be copied from here. A name the host decoded
       * lossily (U+FFFD: invalid bytes, or a real U+FFFD) can never be allowed. `binaryPathsTruncated` says there were more than listed.
       */
      blocked: z
        .strictObject({
          reason: gitPushBlockSchema,
          binaryPaths: z.array(shownPathSchema).max(MAX_BLOCKED_BINARY_PATHS),
          binaryPathsTruncated: z.boolean(),
        })
        .refine((b) => !b.binaryPathsTruncated || b.binaryPaths.length === MAX_BLOCKED_BINARY_PATHS, "a truncated list is a full one")
        .optional(),
    })
    .refine((p) => p.blocked === undefined || (!p.requiresConfirmation && p.reasons.length === 0), "a blocked plan cannot be confirmed")
    .refine((p) => p.requiresConfirmation === (p.reasons.length > 0), "confirmation is required exactly when there are reasons")
    .refine((p) => !p.findingsTruncated || p.findings.length === MAX_PUSH_FINDINGS, "a truncated list is a full one"),
);

// commit (write, tier 2, idempotency required): the reviewed tree on the reviewed parent and branch, nothing else.
export const gitCommitRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    /** `treeHash` of `axis.review/1.diff`. */
    reviewedTreeHash: objectIdSchema,
    /** `head` of `axis.review/1.diff`: HEAD when the diff was reviewed. */
    expectedParent: objectIdSchema,
    /** `branch` of `axis.review/1.diff`, in the short form. */
    expectedBranch: axisBranchSchema,
    message: commitMessageSchema,
    author: commitAuthorSchema.optional(),
  }),
);
export const gitCommitResponseSchema = guarded(z.strictObject({ commit: objectIdSchema, tree: objectIdSchema }));

// push (network, tier 4, idempotency required): always a challenge with native confirmation, bound to the plan the user saw.
export const gitPushRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    remote: remoteNameSchema,
    /** Required, not only when the plan asks for confirmation: a push is always of the plan the user was shown. */
    confirmedPlan: confirmedPlanSchema,
    allowedBinaryPaths: allowedBinaryPaths.optional(),
    /** Present on the retry after the user approved the challenge. */
    approval: challengeReferenceSchema.optional(),
  }),
);
export const gitPushResponseSchema = guarded(z.strictObject({ remote: remoteNameSchema, branch: axisBranchSchema, tip: objectIdSchema }));

// compareUrl (read, tier 0): the GitHub compare URL for the workspace's branch; the remote's own URL, from the repository.
export const gitCompareUrlRequestSchema = guarded(
  z.strictObject({ workspaceId: workspaceIdSchema, remote: remoteNameSchema, base: refNameSchema.refine((b) => /^[\x21-\x7e]+$/.test(b), "ASCII only, so the URL fits").optional() }),
);
const URL_CHARS = "[A-Za-z0-9._~%!*'()-]";
export const compareUrlSchema = z
  .string()
  .max(MAX_COMPARE_URL)
  .refine((u) => !u.slice(u.indexOf("/compare/") + 9).split("/").some((seg) => seg.startsWith(".")), "a dot segment")
  .regex(
    new RegExp(
      `^https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}/compare/${URL_CHARS}+(?:/${URL_CHARS}+)*\\.\\.\\.${URL_CHARS}+(?:/${URL_CHARS}+)*$`,
    ),
  );
export const gitCompareUrlResponseSchema = guarded(z.strictObject({ url: compareUrlSchema }));

export const gitMethods = {
  pushPlan: {
    request: gitPushPlanRequestSchema,
    response: gitPushPlanResponseSchema,
    sideEffect: "read",
    tier: 1,
    idempotency: "none",
    timeoutMs: 30_000,
  },
  commit: {
    request: gitCommitRequestSchema,
    response: gitCommitResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  push: {
    request: gitPushRequestSchema,
    response: gitPushResponseSchema,
    sideEffect: "network",
    tier: 4,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  compareUrl: {
    request: gitCompareUrlRequestSchema,
    response: gitCompareUrlResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 10_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type GitMethod = keyof typeof gitMethods;
export type GitRequest<M extends GitMethod> = z.infer<(typeof gitMethods)[M]["request"]>;
export type GitResponse<M extends GitMethod> = z.infer<(typeof gitMethods)[M]["response"]>;
