// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { challengeReferenceSchema } from "./challenge.js";
import { guarded } from "./guard.js";

/**
 * `axis.worktrees/1` (docs/design/axis-agent-shell.md section 5.3).
 *
 * No payload carries a filesystem path to operate on: projects and workspaces
 * are named by journal ids, and the daemon resolves paths itself (ADR 0004
 * security 2). Paths in `restoreFromRunBase` are repository-relative.
 */

export const WORKTREES_CONTRACT = "axis.worktrees" as const;
export const WORKTREES_VERSION = 1 as const;

/** Journal id. Starts with a letter or digit: a leading `-` or `_` is how an option reaches a command line. */
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const projectIdSchema = idSchema;
export const workspaceIdSchema = idSchema;
export const runIdSchema = idSchema;

/** Control, format (bidi, zero-width) and line-separator characters. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** True for `.git` in any spelling a case-insensitive or Windows filesystem treats the same. */
function isGitDirSegment(segment: string): boolean {
  const s = segment.replace(/[. ]+$/, "").toLowerCase();
  return s === ".git" || /^git~\d+$/.test(s);
}

/**
 * Repository-relative path for `restoreFromRunBase`. The daemon still passes
 * `--` and `:(literal)` to git; this schema is the first layer, not the only one.
 * Rejected: absolute and drive paths, a leading `:` (pathspec magic) or `-`
 * (option), backslashes, empty, `.` and `..` segments, any `.git` segment in
 * any case, and control, bidi and zero-width characters.
 */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith(":") &&
      !p.startsWith("-") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.includes("\\") &&
      !UNSAFE_CHARS.test(p) &&
      !p.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || isGitDirSegment(seg)),
    { message: "must be a normalised repository-relative path outside .git" },
  );

/**
 * Ref or revision typed by a user, following `git check-ref-format`: no
 * leading `-` or `/`, no empty, dot-leading or `.lock`-ending component, no
 * `..`, `@{`, lone `@`, trailing `/` or `.`, and none of space, `~^:?*[\`,
 * control, bidi or zero-width characters. The daemon still runs
 * `check-ref-format`; this is defence in depth.
 */
export const refNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (r) =>
      r !== "@" &&
      !r.startsWith("-") &&
      !r.endsWith(".") &&
      !r.includes("..") &&
      !r.includes("@{") &&
      !/[ ~^:?*[\\]/.test(r) &&
      !UNSAFE_CHARS.test(r) &&
      r.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock")),
    { message: "not a valid ref name" },
  );

/** Short human name, shown in approval text; the daemon derives the slug and branch from it. */
export const workspaceNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((n) => n === n.trim() && !UNSAFE_CHARS.test(n), {
    message: "no leading or trailing whitespace, no control or invisible characters",
  });

export const workspaceStateSchema = z.enum(["READY", "FINALISED", "CLEANED"]);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export const finaliseOutcomeSchema = z.enum(["merged", "archived", "abandoned"]);

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);

export const worktreeInfoSchema = z.strictObject({
  /** Journal id; absent for worktrees Axis did not create. */
  id: workspaceIdSchema.optional(),
  origin: z.enum(["axis", "external"]),
  projectId: projectIdSchema,
  state: workspaceStateSchema.optional(),
  branch: z.string().max(256).nullable(),
  baseRef: z.string().max(256).optional(),
  /** Recorded at creation and never rewritten. */
  baseSha: sha.optional(),
  head: sha.nullable(),
  /** Absolute path, for display and opening only. Never accepted back as input. */
  path: z.string().max(4096),
  locked: z.boolean(),
  present: z.boolean(),
  dirty: z
    .strictObject({
      staged: z.number().int().min(0),
      unstaged: z.number().int().min(0),
      untracked: z.number().int().min(0),
    })
    .optional(),
  ahead: z.number().int().min(0).optional(),
  behind: z.number().int().min(0).optional(),
});
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>;

export const MAX_STATUS_IDS = 100;
export const MAX_RESTORE_PATHS = 500;
export const MAX_DISCARD_PATHS = 500;
export const MAX_USER_EDITING_PATHS = 200;

// list (read, tier 0)
export const listRequestSchema = z.strictObject({ projectId: projectIdSchema });
export const listResponseSchema = z.strictObject({
  worktrees: z.array(worktreeInfoSchema).max(1000),
});

// status (read, tier 0)
export const statusRequestSchema = z.strictObject({
  ids: z.array(workspaceIdSchema).min(1).max(MAX_STATUS_IDS),
});
export const statusResponseSchema = z.strictObject({
  worktrees: z.array(worktreeInfoSchema).max(MAX_STATUS_IDS),
});

// create (write, tier 2, idempotency required)
export const createRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  name: workspaceNameSchema,
  baseRef: refNameSchema.optional(),
});
export const createResponseSchema = z.strictObject({
  id: workspaceIdSchema,
  worktree: worktreeInfoSchema,
});

// finalise (destructive, tier 4: challenge plus native confirmation, idempotency required). A finalise can discard
// uncommitted work, and a discard token is minted only for a challenge issued at tier 4 or above (a tier 3 approval has
// no native dialog), so the method floor is 4 and `approval` is the retry reference after the user confirmed.
export const finaliseRequestSchema = z.strictObject({
  id: workspaceIdSchema,
  outcome: finaliseOutcomeSchema,
  /** Present on the retry after the user approved the challenge. */
  approval: challengeReferenceSchema.optional(),
});
export const finaliseResponseSchema = z.strictObject({
  id: workspaceIdSchema,
  state: z.literal("FINALISED"),
  /** `refs/axis/archive/<id>` target: the rollback ref. */
  archiveRef: z.string().max(256),
});

// remove (destructive, tier 4: challenge plus native confirmation)
export const removeRequestSchema = z.strictObject({
  id: workspaceIdSchema,
  deleteBranch: z.boolean().optional(),
  /** Present on the retry after the user approved the challenge. */
  approval: challengeReferenceSchema.optional(),
});
export const removeResponseSchema = z.strictObject({
  id: workspaceIdSchema,
  state: z.literal("CLEANED"),
  backupRef: z.string().max(256).optional(),
});

// restoreFromRunBase (write, tier 2): policies section on diff review
export const restoreFromRunBaseRequestSchema = z.strictObject({
  runId: runIdSchema,
  /** Workspace the run belongs to. */
  id: workspaceIdSchema,
  paths: z.array(relativePathSchema).min(1).max(MAX_RESTORE_PATHS),
});
export const restoreFromRunBaseResponseSchema = z.strictObject({
  backupRef: z.string().max(256),
  restored: z.array(relativePathSchema).max(MAX_RESTORE_PATHS),
});

// discard (write, tier 2, idempotency required): reject, the reversible one. The daemon writes a backup commit of the
// worktree to `refs/axis/backup/<id>/<ts>` first, then restores exactly these paths; hunk-level discard is not in 1a.
export const discardRequestSchema = z.strictObject({
  id: workspaceIdSchema,
  paths: z.array(relativePathSchema).min(1).max(MAX_DISCARD_PATHS),
});
export const discardResponseSchema = z.strictObject({
  backupRef: z.string().max(256),
  discarded: z.array(relativePathSchema).max(MAX_DISCARD_PATHS),
});

// setUserEditing (write, tier 2, no idempotency key): the renderer reports, as the user, the paths with unsaved editors.
// The list REPLACES the previous one (an empty list clears it), so a repeat is harmless. Advisory only: it never blocks
// a user action and is never an authorisation.
export const setUserEditingRequestSchema = z.strictObject({
  id: workspaceIdSchema,
  paths: z.array(relativePathSchema).max(MAX_USER_EDITING_PATHS),
});
export const setUserEditingResponseSchema = z.strictObject({ id: workspaceIdSchema });

export type SideEffect = "none" | "read" | "write" | "network" | "destructive" | "credential";

export interface MethodSpec {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
  readonly sideEffect: SideEffect;
  /** Minimum permission tier; policy may raise it, never lower it. */
  readonly tier: 0 | 1 | 2 | 3 | 4 | 5;
  readonly idempotency: "none" | "optional" | "required";
  readonly timeoutMs: number;
}

export const worktreesMethods = {
  list: {
    request: guarded(listRequestSchema),
    response: guarded(listResponseSchema),
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 10_000,
  },
  status: {
    request: guarded(statusRequestSchema),
    response: guarded(statusResponseSchema),
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 15_000,
  },
  create: {
    request: guarded(createRequestSchema),
    response: guarded(createResponseSchema),
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  finalise: {
    request: guarded(finaliseRequestSchema),
    response: guarded(finaliseResponseSchema),
    sideEffect: "destructive",
    tier: 4,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  remove: {
    request: guarded(removeRequestSchema),
    response: guarded(removeResponseSchema),
    sideEffect: "destructive",
    tier: 4,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  restoreFromRunBase: {
    request: guarded(restoreFromRunBaseRequestSchema),
    response: guarded(restoreFromRunBaseResponseSchema),
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  discard: {
    request: guarded(discardRequestSchema),
    response: guarded(discardResponseSchema),
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  setUserEditing: {
    request: guarded(setUserEditingRequestSchema),
    response: guarded(setUserEditingResponseSchema),
    sideEffect: "write",
    tier: 2,
    idempotency: "none",
    timeoutMs: 10_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type WorktreesMethod = keyof typeof worktreesMethods;
export type WorktreesRequest<M extends WorktreesMethod> = z.infer<(typeof worktreesMethods)[M]["request"]>;
export type WorktreesResponse<M extends WorktreesMethod> = z.infer<(typeof worktreesMethods)[M]["response"]>;
