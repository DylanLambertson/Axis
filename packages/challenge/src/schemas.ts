// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { boundedJsonSchema, challengeIdSchema, requestDigestSchema } from "@axis/protocol";
import { z } from "zod";
import { canonicalJson } from "./crypto.js";
import { ChallengeError } from "./errors.js";

const ACTOR = /^(?:user|daemon|agent:[A-Za-z0-9._/-]{1,96})$/;
export const OP = /^[a-z][a-z0-9_.-]{0,63}$/;
const WINDOW = /^[A-Za-z0-9._:-]{1,64}$/;
/**
 * Text a native dialog may show. Refuses control characters (C0, DEL, C1,
 * newlines), format characters (bidi overrides and isolates, zero-width
 * characters, BOM), line and paragraph separators and lone surrogates: any of
 * them can reorder, hide or fake what the user thinks they approve (APR-2).
 */
export const displaySafe = (s: string): boolean => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(s);

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

const CONTRACT = /^[a-z][a-z0-9_.-]*\/[0-9]+$/;
export const MAX_ARGS_BYTES = 16_384;
const isPlainObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The request params the user approved, without the `approval` reference: a
 * bounded plain object. The daemon passes the same params at issue and at
 * consume; their canonical form is bound into the digest.
 */
export const argsSchema = boundedJsonSchema
  .refine(isPlainObject, "args must be an object")
  .refine((v) => canonicalJson(v).length <= MAX_ARGS_BYTES, "args too large");

const actorSchema = z.string().regex(ACTOR);
const windowSchema = z.string().regex(WINDOW);

export const issueSchema = z
  .object({
    op: z.string().regex(OP),
    /**
     * A canonical daemon id (for example `workspace:<id>`), never a path or an
     * alias. It is compared as an opaque exact string, so two spellings of one
     * thing never match: the user approves what actually gets acted on.
     */
    target: z.string().min(1).max(1024).refine(displaySafe),
    /** SHA-256 hex of what the operation will destroy (for example dirty file content). */
    contentDigest: requestDigestSchema,
    actor: actorSchema,
    windowId: windowSchema,
    tier: z.number().int().min(3).max(5).default(4),
    /** The contract of the request being approved, for example `axis.worktrees/1`. Bound into the digest. */
    contract: z.string().max(64).regex(CONTRACT),
    /** The request params, minus `approval`. Bound into the digest. */
    args: argsSchema,
    /**
     * One line the user sees. The daemon must build it from fields it knows are
     * safe to show (annotated `path` or `public`), never from requester input
     * (APR-2). Defaults to the whole target, or, for a target over 512
     * characters, its first 255 and last 256 around an ellipsis; the tail is
     * never hidden.
     */
    targetSummary: z.string().max(512).refine(displaySafe).optional(),
  })
  .strict();

export const resolveSchema = z
  .object({
    challengeId: challengeIdSchema,
    decision: z.enum(["approve", "deny"]),
    digest: requestDigestSchema,
    actor: actorSchema,
    windowId: windowSchema,
  })
  .strict();

export const nativeSchema = z
  .object({
    challengeId: challengeIdSchema,
    proof: z.string().min(1).max(128),
    confirmed: z.boolean(),
    windowId: windowSchema,
  })
  .strict();

export const executeContextSchema = z
  .object({
    contract: z.string().max(64).regex(CONTRACT),
    op: z.string().regex(OP),
    target: z.string().min(1).max(1024).refine(displaySafe),
    /** The params of the request being executed now, minus `approval`; must equal what was approved. */
    args: argsSchema,
    /** Digest of the same content, recomputed from the current state just now. */
    currentContentDigest: requestDigestSchema,
  })
  .strict();

/**
 * The whole target when it fits the schema's 512 characters; otherwise the head
 * and the tail around a visible ellipsis. The tail is where `/../../home` hides,
 * so it is never the part that gets cut.
 */
export function defaultSummary(target: string): string {
  if (target.length <= 512) return target;
  let head = target.slice(0, 255);
  let tail = target.slice(-256);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head}\u2026${tail}`;
}

export function invalid(error: z.ZodError, what: string): ChallengeError {
  // Field paths only: zod messages can echo the offending value.
  const fields = [...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
  return new ChallengeError("E_INVALID_ARGUMENT", `Invalid ${what}: ${fields}`);
}
