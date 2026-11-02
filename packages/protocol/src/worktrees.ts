// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { challengeReferenceSchema } from "./challenge.js";

/**
 * `axis.worktrees/1` (docs/design/axis-agent-shell.md section 5.3).
 *
 * No payload carries a filesystem path to operate on: projects and workspaces
 * are named by journal ids, and the daemon resolves paths itself (ADR 0004
 * security 2). Paths in `restoreFromRunBase` are repository-relative.
 */

export const WORKTREES_CONTRACT = "axis.worktrees" as const;
export const WORKTREES_VERSION = 1 as const;

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
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

// finalise (write, tier 2, idempotency required)
export const finaliseRequestSchema = z.strictObject({
  id: workspaceIdSchema,
  outcome: finaliseOutcomeSchema,
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
    request: listRequestSchema,
    response: listResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 10_000,
  },
  status: {
    request: statusRequestSchema,
    response: statusResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 15_000,
  },
  create: {
    request: createRequestSchema,
    response: createResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  finalise: {
    request: finaliseRequestSchema,
    response: finaliseResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  remove: {
    request: removeRequestSchema,
    response: removeResponseSchema,
    sideEffect: "destructive",
    tier: 4,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  restoreFromRunBase: {
    request: restoreFromRunBaseRequestSchema,
    response: restoreFromRunBaseResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type WorktreesMethod = keyof typeof worktreesMethods;
export type WorktreesRequest<M extends WorktreesMethod> = z.infer<(typeof worktreesMethods)[M]["request"]>;
export type WorktreesResponse<M extends WorktreesMethod> = z.infer<(typeof worktreesMethods)[M]["response"]>;
