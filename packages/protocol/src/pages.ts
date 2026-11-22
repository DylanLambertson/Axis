// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { AGENT_NAME_SPACES } from "./agents.js";
import { challengeReferenceSchema } from "./challenge.js";
import { guarded, safeTextSchema, timestampSchema } from "./guard.js";
import { agentIdSchema, pageIdSchema, pluginIdSchema } from "./messages-wire.js";
import { projectIdSchema, type MethodSpec } from "./worktrees.js";

/*
 * `axis.pages/1` (ticket PV-Q1 slice 1, ADR 0010, `docs/design/pages-store.md`, journal schema version 14).
 * A planned contract: the agreed schemas, served by a later slice. The rows are the user's only; the composer tools
 * `read_page` and `write_page` (taint source 4) and plugin access (ADR 0008 `pages.read`, `pages.write`) come with their
 * own tickets and reach the store through the broker or the plugin rows, never through these user rows.
 * Attachments are stored by the journal but have no method yet: their transfer and content sniffing are PV-Q2's.
 * No request names an author, a hop or a trust flag: the daemon takes the author from the attested caller and the store
 * derives the rest, so no caller can write a page as more trusted than it is.
 */
export const PAGES_CONTRACT = "axis.pages" as const;
export const PAGES_VERSION = 1 as const;

/** ADR 0010 decision 1, the same numbers as the journal's `PAGE_LIMITS`. */
export const MAX_PAGES_PER_PROJECT = 500;
export const MAX_PAGE_VERSIONS = 100;
export const MAX_PAGE_BODY_BYTES = 262_144;
export const PAGE_TITLE_CHARS = 200;

/** A title: 1 to 200 characters, the agent-name rule (no edge space, control, format, line separator or invisible space). */
export const pageTitleSchema = safeTextSchema(PAGE_TITLE_CHARS).refine((t) => !AGENT_NAME_SPACES.test(t), { message: "no invisible spaces" });

const utf8 = new TextEncoder();
/** Markdown text: at most 256 KiB of UTF-8, well-formed (no lone surrogate), no NUL. Rendered only in the isolated page view. */
export const pageBodySchema = z
  .string()
  .max(MAX_PAGE_BODY_BYTES)
  .refine((t) => !/[\u0000\ud800-\udfff]/u.test(t), { message: "no NUL, well-formed" })
  .refine((t) => utf8.encode(t).length <= MAX_PAGE_BODY_BYTES, { message: "at most 256 KiB" });

const seqSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const hopSchema = z.number().int().min(0).max(8);
/** A plugin id as ADR 0008 caps it at install: at most 64 characters. */
const pagePluginIdSchema = pluginIdSchema.max(64);

export const pageAuthorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("agent"), agentId: agentIdSchema }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: pagePluginIdSchema }),
  z.strictObject({ kind: z.literal("system") }),
]);

/** A version without its body. `untrusted`: it may hold text the user did not write and is not reviewed (IAC-T source 4). */
export const pageVersionMetaSchema = z
  .strictObject({
    pageId: pageIdSchema,
    seq: seqSchema,
    title: pageTitleSchema,
    author: pageAuthorSchema,
    hop: hopSchema,
    untrusted: z.boolean(),
    reviewed: z.boolean(),
    restoredFrom: seqSchema.nullable(),
    createdAt: timestampSchema,
  })
  .refine((v) => v.untrusted || v.reviewed || v.hop === 0, "a trusted, unreviewed version has hop 0")
  .refine((v) => v.author.kind === "user" || v.untrusted || v.reviewed, "only the user writes trusted text")
  .refine((v) => v.restoredFrom === null || v.restoredFrom < v.seq, "a restore comes from an earlier version");
export const pageVersionSchema = z.strictObject({ meta: pageVersionMetaSchema, body: pageBodySchema });

export const pageSummarySchema = z.strictObject({
  pageId: pageIdSchema,
  projectId: projectIdSchema,
  current: pageVersionMetaSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const pagesListRequestSchema = z.strictObject({ projectId: projectIdSchema });
export const pagesListResponseSchema = z.strictObject({ pages: z.array(pageSummarySchema).max(MAX_PAGES_PER_PROJECT) });
/** The newest version, or version `seq`. */
export const pagesGetRequestSchema = z.strictObject({ pageId: pageIdSchema, seq: seqSchema.optional() });
export const pagesGetResponseSchema = z.strictObject({ version: pageVersionSchema });
export const pagesVersionsRequestSchema = z.strictObject({ pageId: pageIdSchema });
export const pagesVersionsResponseSchema = z.strictObject({ versions: z.array(pageVersionMetaSchema).max(MAX_PAGE_VERSIONS) });
export const pagesCreateRequestSchema = z.strictObject({ projectId: projectIdSchema, title: pageTitleSchema, body: pageBodySchema });
export const pagesCreateResponseSchema = z.strictObject({ version: pageVersionSchema });
/** A new version on top of `baseSeq`; refused `stale_version` when another came first. */
export const pagesUpdateRequestSchema = z.strictObject({ pageId: pageIdSchema, baseSeq: seqSchema, title: pageTitleSchema, body: pageBodySchema });
export const pagesUpdateResponseSchema = z.strictObject({ version: pageVersionSchema });
/** Version `seq` again, as a new version that keeps its author and trust (never the user's). */
export const pagesRestoreRequestSchema = z.strictObject({ pageId: pageIdSchema, seq: seqSchema, baseSeq: seqSchema });
export const pagesRestoreResponseSchema = z.strictObject({ version: pageVersionSchema });
/** Mark one version reviewed: it stops tainting readers. Tier 3: main's native confirmation (O-4 of the 2a threat model). */
export const pagesMarkReviewedRequestSchema = z.strictObject({ pageId: pageIdSchema, seq: seqSchema, approval: challengeReferenceSchema.optional() });
export const pagesMarkReviewedResponseSchema = z.strictObject({ version: pageVersionMetaSchema, changed: z.boolean() });
/** Delete a page with its versions and attachments. Destructive, tier 3. */
export const pagesDeleteRequestSchema = z.strictObject({ pageId: pageIdSchema, approval: challengeReferenceSchema.optional() });
export const pagesDeleteResponseSchema = z.strictObject({ deleted: z.literal(true) });

/**
 * The closed refusals: every error a handler returns other than `E_INTERNAL` and `E_CANCELLED` is one of these, with
 * `details: { reason }` and the one fixed message, so no stored title or body reaches an error.
 */
export const PAGES_REFUSALS = {
  E_NOT_FOUND: ["not_found"],
  E_INVALID_ARGUMENT: ["too_large"],
  E_CONFLICT: ["stale_version", "limit_reached"],
} as const;
export type PagesRefusalCode = keyof typeof PAGES_REFUSALS;
export const PAGES_REASONS = Object.values(PAGES_REFUSALS).flat();
export const pagesRefusalDetailsSchema = z.strictObject({ reason: z.enum(PAGES_REASONS as [string, ...string[]]) });
export const PAGES_REFUSAL_MESSAGE = "page request refused";

export function isPagesRefusal(code: string, reason: string): boolean {
  return Object.hasOwn(PAGES_REFUSALS, code) && (PAGES_REFUSALS[code as PagesRefusalCode] as readonly string[]).includes(reason);
}

const spec = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
  sideEffect: "read" | "write" | "destructive",
  tier: 0 | 1 | 3,
  idempotency: "none" | "required",
  timeoutMs: number,
) => ({ request: guarded(request), response: guarded(response), sideEffect, tier, idempotency, timeoutMs }) as const;

/**
 * Tiers: reads 0; a new page or version and a restore 1 (records only, nothing runs); marking a version reviewed 3, since
 * it lowers taint and needs main's native confirmation; delete 3 and destructive (versions and attachments are lost).
 */
export const pagesMethods = {
  list: spec(pagesListRequestSchema, pagesListResponseSchema, "read", 0, "none", 5_000),
  get: spec(pagesGetRequestSchema, pagesGetResponseSchema, "read", 0, "none", 5_000),
  versions: spec(pagesVersionsRequestSchema, pagesVersionsResponseSchema, "read", 0, "none", 5_000),
  create: spec(pagesCreateRequestSchema, pagesCreateResponseSchema, "write", 1, "required", 10_000),
  update: spec(pagesUpdateRequestSchema, pagesUpdateResponseSchema, "write", 1, "none", 10_000),
  restore: spec(pagesRestoreRequestSchema, pagesRestoreResponseSchema, "write", 1, "none", 10_000),
  markReviewed: spec(pagesMarkReviewedRequestSchema, pagesMarkReviewedResponseSchema, "write", 3, "none", 30_000),
  delete: spec(pagesDeleteRequestSchema, pagesDeleteResponseSchema, "destructive", 3, "none", 30_000),
} as const satisfies Record<string, MethodSpec>;

export type PagesMethod = keyof typeof pagesMethods;
export type PagesRequest<M extends PagesMethod> = z.infer<(typeof pagesMethods)[M]["request"]>;
export type PagesResponse<M extends PagesMethod> = z.infer<(typeof pagesMethods)[M]["response"]>;
