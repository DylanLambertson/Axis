// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { chainHeadSchema, countSchema, emptyRequestSchema, guarded, reasonCodeSchema, timestampSchema } from "./guard.js";
import { inspectMessage, type JsonValue } from "./limits.js";
import type { MethodSpec } from "./worktrees.js";

/**
 * `axis.audit/1` (docs/design/daemon-host.md on branch docs/daemon-host-design, sections 4.2, 5.4 and 5.5).
 *
 * Read only. Events are redacted when they are written, and these methods only
 * read them back; nothing here writes, repairs or re-anchors the chain. All
 * three methods stay served in degraded mode (section 5.5).
 */

export const AUDIT_CONTRACT = "axis.audit" as const;
export const AUDIT_VERSION = 1 as const;

/** Most events one `list` call returns (design: `limit` at most 200). */
export const MAX_AUDIT_LIST = 200;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const AUDIT_OUTCOMES = ["success", "failure", "denied", "error"] as const;
export const VERIFY_FAILURE_REASONS = [
  "malformed_row",
  "seq_gap",
  "unsupported_version",
  "hash_mismatch",
  "prev_hash_mismatch",
  "truncated",
] as const;

/**
 * A stored payload: already redacted and reduced to allow-listed scalars or
 * content summaries (at most 8192 characters), so a small walk bound is enough.
 */
const AUDIT_PAYLOAD_LIMITS = { maxDepth: 4, maxNodes: 512, maxBytes: 32_768, maxStringBytes: 2048 } as const;
const auditPayloadSchema = z.custom<JsonValue>(
  (v) => {
    try {
      return inspectMessage(v, AUDIT_PAYLOAD_LIMITS).ok;
    } catch {
      return false;
    }
  },
  { message: "not a bounded audit payload" },
);

/** One stored event, as `AuditLog.list` returns it. */
export const auditEventSchema = z.strictObject({
  seq: z.number().int().min(1),
  ts: timestampSchema,
  actor: z.string().regex(/^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/),
  action: z.string().max(96).regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/),
  /** Redacted when stored; a canonical id such as `workspace:<id>`. */
  target: z.string().min(1).max(1024),
  outcome: z.enum(AUDIT_OUTCOMES),
  payload: auditPayloadSchema,
  prevHash: sha256Hex,
  hash: sha256Hex,
});
export type AuditEventWire = z.infer<typeof auditEventSchema>;

// status (read, tier 0)
export const auditStatusRequestSchema = emptyRequestSchema;
export const auditStatusResponseSchema = guarded(
  z.strictObject({
    /** Newest event in the database, or null when the log is empty. */
    head: chainHeadSchema.nullable(),
    /** Newest anchor the supervisor acknowledged as durable, or null before the first. */
    anchor: chainHeadSchema.nullable(),
    /** Events written but not yet covered by an acknowledged anchor. */
    lag: countSchema,
    /** Age in milliseconds of the oldest un-acknowledged anchor, or null when none is waiting. */
    oldestUnackedAgeMs: countSchema.nullable(),
    /** True while tier 3 and above are refused for lack of anchor acknowledgements. */
    stalled: z.boolean(),
    /** Set in degraded mode (integrity failure); the daemon never clears it itself. */
    degraded: z.strictObject({ reason: reasonCodeSchema }).nullable(),
  }),
);

// list (read, tier 1): events with seq > afterSeq, oldest first. A reply may hold
// fewer events than `limit` (it is trimmed to fit one message); continue from the last seq.
export const auditListRequestSchema = guarded(
  z.strictObject({
    afterSeq: countSchema.optional(),
    limit: z.number().int().min(1).max(MAX_AUDIT_LIST).optional(),
  }),
);
export const auditListResponseSchema = guarded(
  z.strictObject({
    events: z
      .array(auditEventSchema)
      .max(MAX_AUDIT_LIST)
      .refine((es) => es.every((e, i) => i === 0 || e.seq > (es[i - 1] as { seq: number }).seq), "events must be in ascending seq order"),
  }),
);

// verify (read, tier 1): recompute the chain; the host runs one at a time, bounded and cancellable.
export const auditVerifyRequestSchema = emptyRequestSchema;
export const auditVerifyResponseSchema = guarded(
  z.discriminatedUnion("ok", [
    z
      .strictObject({
        ok: z.literal(true),
        count: countSchema,
        head: chainHeadSchema.nullable(),
      })
      .refine((r) => r.count === (r.head?.seq ?? 0), "count must equal the head sequence"),
    z.strictObject({
      ok: z.literal(false),
      /** The first sequence number at which the chain stops being valid. */
      firstBadSeq: z.number().int().min(1),
      reason: z.enum(VERIFY_FAILURE_REASONS),
      checked: countSchema,
    }),
  ]),
);

export const auditMethods = {
  status: {
    request: auditStatusRequestSchema,
    response: auditStatusResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
  list: {
    request: auditListRequestSchema,
    response: auditListResponseSchema,
    sideEffect: "read",
    tier: 1,
    idempotency: "none",
    timeoutMs: 10_000,
  },
  verify: {
    request: auditVerifyRequestSchema,
    response: auditVerifyResponseSchema,
    sideEffect: "read",
    tier: 1,
    idempotency: "none",
    timeoutMs: 30_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type AuditMethod = keyof typeof auditMethods;
export type AuditRequest<M extends AuditMethod> = z.infer<(typeof auditMethods)[M]["request"]>;
export type AuditResponse<M extends AuditMethod> = z.infer<(typeof auditMethods)[M]["response"]>;
