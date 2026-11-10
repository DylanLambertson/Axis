// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { requestDigestSchema } from "./challenge.js";
import { CF_RANGES, rangesToClass } from "./display.js";
import { countSchema, displayTextSchema, guarded, reasonCodeSchema, timestampSchema } from "./guard.js";
import { runIdSchema, workspaceIdSchema, type MethodSpec } from "./worktrees.js";
import { runStateSchema } from "./cliRuns.js";
import { connectionNameSchema, destinationTextSchema } from "./providers.js";

/**
 * `axis.runs/1`: composer runs (docs/design/composer-runtime.md section 3; docs/design/daemon-host.md section 4.2).
 *
 * A composer run is one Ask, Edit or Agent request in a workspace, driven by the daemon against a provider, with
 * every tool call going through the tool broker. No payload carries a path, a command, a credential or a tool
 * definition (DMN-2, PRV-2): a run is named by journal ids and the daemon resolves the rest. There is no server push
 * (design 4.1), so the activity stream is the `events` read with a cursor. `start` needs a trusted project (a policy
 * row, not a registry field). Unknown runs and workspaces answer E_NOT_FOUND, a run in the wrong state E_CONFLICT.
 */

export const COMPOSER_RUNS_CONTRACT = "axis.runs" as const;
export const COMPOSER_RUNS_VERSION = 1 as const;

export const COMPOSER_MODES = ["ask", "edit", "agent"] as const;
export const composerModeSchema = z.enum(COMPOSER_MODES);
export type ComposerMode = z.infer<typeof composerModeSchema>;

/** Longest prompt in UTF-16 units. */
export const MAX_PROMPT_CHARS = 32_768;
/** Most runs one `list` reply holds, and most events one `events` reply holds. */
export const MAX_COMPOSER_RUNS_LIST = 200;
export const MAX_RUN_EVENTS = 200;
/** Longest text of one activity event; longer model output is split over several events. */
export const MAX_ACTIVITY_TEXT = 4096;
/** Most paths one approval event lists (the broker declares at most 32 targets per call). */
export const MAX_APPROVAL_PATHS = 32;

/** Provider id as `@axis/providers` and `axis.providers/1` define it. */
export const composerProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
/** Model id: printable ASCII without spaces, as `@axis/providers` `modelIdSchema`. */
export const composerModelIdSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
/** A broker tool name (`@axis/broker` `TOOL_NAME`). */
export const composerToolNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

/**
 * What activity text refuses: every control character except tab and line feed, surrogates, the line and paragraph
 * separators, and every format character (bidi, zero-width). The daemon escapes them before it sends; the schema is the check.
 */
export const REFUSED_ACTIVITY = new RegExp(
  `[${rangesToClass([[0x0, 0x8], [0xb, 0x1f], [0x7f, 0x9f], [0xd800, 0xdfff], 0x2028, 0x2029, ...CF_RANGES])}]`,
  "u",
);
export const activityTextSchema = z
  .string()
  .min(1)
  .max(MAX_ACTIVITY_TEXT)
  .refine((t) => !REFUSED_ACTIVITY.test(t), { message: "no control or invisible characters" });

const TERMINAL: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export const composerUsageSchema = z.strictObject({
  inputTokens: countSchema,
  outputTokens: countSchema,
  requests: countSchema,
});

export const composerRunSchema = z
  .strictObject({
    runId: runIdSchema,
    workspaceId: workspaceIdSchema,
    /** From the journal after a restart (ticket J2); null only for a run recorded before the journal kept it. */
    mode: composerModeSchema.nullable(),
    providerId: composerProviderIdSchema.nullable(),
    modelId: composerModelIdSchema.nullable(),
    state: runStateSchema,
    /** Short upper-case code such as `BUDGET_TOKENS` or `INTERRUPTED_BY_RESTART`; never free text. */
    reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
    /** The daemon is driving the run now. */
    live: z.boolean(),
    /** A tool call of the run waits for the user's answer in `axis.approvals/1`. */
    awaitingApproval: z.boolean(),
    usage: composerUsageSchema.nullable(),
  })
  .refine((r) => (r.endedAt !== null) === TERMINAL.has(r.state), "endedAt is set exactly when the run is terminal")
  .refine((r) => r.startedAt !== null || r.state === "QUEUED" || r.state === "CANCELLED", "only a queued or cancelled run can have never started")
  .refine((r) => !r.awaitingApproval || r.live, "only a live run can wait for an approval");
export type ComposerRun = z.infer<typeof composerRunSchema>;

const eventBase = { seq: z.number().int().min(1), at: timestampSchema };
const displayPath = displayTextSchema(512).pipe(z.string().min(1));

export const APPROVAL_EVENT_STATES = ["requested", "approved", "denied", "expired", "withdrawn"] as const;

/** Longest head of written content one approval preview shows, in UTF-16 units after escaping. */
export const MAX_PREVIEW_HEAD = 2048;
/** Most secret-scan rule names one preview lists. */
export const MAX_PREVIEW_FINDINGS = 8;
/** The broker tiers, lowest first (`@axis/broker` `Tier`). */
export const BROKER_TIERS = ["read", "write", "network", "destructive", "privileged"] as const;

/** A head of content: activity text rules (control and invisible characters escaped by the daemon), and it may be empty. */
const previewHeadSchema = z
  .string()
  .max(MAX_PREVIEW_HEAD)
  .refine((t) => !REFUSED_ACTIVITY.test(t), { message: "no control or invisible characters" });

/**
 * What a tool call will do, as the user answers its approval (review r1 S2, ticket C8). The daemon builds it from the
 * exact arguments the broker's digest covers (it recomputes the digest from them and shows nothing when they differ), so
 * the content the user judges is the content that runs. `content` is null for a call that writes no content.
 */
export const approvalPreviewSchema = z
  .strictObject({
    /** The broker tier the challenge was issued for (recorded at issue; the digest covers it). */
    tier: z.enum(BROKER_TIERS),
    /** A protected path (WT-3: `.envrc`, `.vscode/`, `Makefile`, ...) is among the targets. */
    protected: z.boolean(),
    content: z
      .strictObject({
        /** UTF-8 bytes the call writes. */
        bytes: countSchema,
        /** SHA-256 of exactly those bytes. */
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        /** The start of the content, escaped; redacted when the scan found a secret, empty when it could not be shown safely. */
        head: previewHeadSchema,
        /** The head is not the whole content. */
        truncated: z.boolean(),
        /** Rule names of the secret scan over the whole content (`@axis/secret-scan`), empty when it found nothing. */
        findings: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).max(MAX_PREVIEW_FINDINGS),
      })
      .refine((c) => c.truncated || c.findings.length > 0 || c.bytes === 0 || c.head.length > 0, "a whole, clean, non-empty content shows a head")
      .nullable(),
  });
export type ApprovalPreview = z.infer<typeof approvalPreviewSchema>;

export const runEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type: z.literal("state"), state: runStateSchema, reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable() }),
  /** Model output. Untrusted text: the renderer shows it as text, never as markup. */
  z.strictObject({ ...eventBase, type: z.literal("text"), text: activityTextSchema }),
  z.strictObject({ ...eventBase, type: z.literal("tool"), tool: composerToolNameSchema, outcome: z.enum(["ok", "error"]), reason: reasonCodeSchema.nullable() }),
  z.strictObject({
    ...eventBase,
    type: z.literal("approval"),
    tool: composerToolNameSchema,
    state: z.enum(APPROVAL_EVENT_STATES),
    /** The challenge digest `axis.approvals/1.pending` lists, so the UI can show this event's detail next to it. */
    digest: requestDigestSchema,
    /** Why the broker asked (`tier:network`, `protected:github`, ...), closed broker labels. */
    reasons: z.array(z.string().regex(/^[a-z][a-z0-9:._-]{0,63}$/)).max(16),
    /** The worktree-relative paths the call reads or writes, as display text (never an identity). */
    paths: z.array(z.strictObject({ access: z.enum(["read", "write"]), path: displayPath })).max(MAX_APPROVAL_PATHS),
    /** What the call will do (C8). Set on `requested` (a challenge is never issued without it), null on the later states. */
    preview: approvalPreviewSchema.nullable(),
  }),
  z.strictObject({ ...eventBase, type: z.literal("usage"), usage: composerUsageSchema }),
  /**
   * PRV-4: a provider request is about to be sent (the budget allowed it), and where it goes. `destination` is the
   * adapter's https origin, or its own description when it makes no network request; display text with any URL's userinfo,
   * query and fragment removed. The run uses the provider and connection it started with; a request never goes anywhere else.
   */
  z.strictObject({
    ...eventBase,
    type: z.literal("request"),
    /** 1 for the first request of the run. */
    request: z.number().int().min(1),
    providerId: composerProviderIdSchema,
    connectionId: connectionNameSchema,
    /** The model the run asked for; the provider cannot change it here. */
    modelId: composerModelIdSchema,
    destination: destinationTextSchema,
  }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;

const runResponse = guarded(z.strictObject({ run: composerRunSchema }));
const runIdRequest = guarded(z.strictObject({ runId: runIdSchema }));

// start (write, tier 2, idempotency required, trusted project)
export const composerStartRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    mode: composerModeSchema,
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
    providerId: composerProviderIdSchema,
    modelId: composerModelIdSchema,
  }),
);
export const composerStartResponseSchema = guarded(z.strictObject({ run: composerRunSchema, replayed: z.boolean() }));

// cancel (write, tier 2, idempotency required): the run as it is after the request to stop
export const composerCancelRequestSchema = runIdRequest;
export const composerCancelResponseSchema = runResponse;

// get (read, tier 0)
export const composerGetRequestSchema = runIdRequest;
export const composerGetResponseSchema = runResponse;

// list (read, tier 0): the newest `limit` composer runs, oldest first, no cursor
export const composerListRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema.optional(),
    limit: z.number().int().min(1).max(MAX_COMPOSER_RUNS_LIST).optional(),
  }),
);
export const composerListResponseSchema = guarded(
  z.strictObject({
    runs: z
      .array(composerRunSchema)
      .max(MAX_COMPOSER_RUNS_LIST)
      .refine((rs) => new Set(rs.map((r) => r.runId)).size === rs.length, "duplicate run id"),
  }),
);

/**
 * events (read, tier 0): the activity after `afterSeq` (default 0), oldest first. `nextSeq` is the cursor for the next
 * call. `complete` is true once the run ended and every event was returned. `available` is false when the daemon no
 * longer holds the run's activity (after a restart or an eviction); the run itself is still in `get`.
 */
export const composerEventsRequestSchema = guarded(
  z.strictObject({
    runId: runIdSchema,
    afterSeq: countSchema.optional(),
    limit: z.number().int().min(1).max(MAX_RUN_EVENTS).optional(),
  }),
);
export const composerEventsResponseSchema = guarded(
  z
    .strictObject({
      events: z.array(runEventSchema).max(MAX_RUN_EVENTS),
      nextSeq: countSchema,
      complete: z.boolean(),
      available: z.boolean(),
    })
    .refine((r) => r.events.every((e, i) => i === 0 || e.seq > (r.events[i - 1] as RunEvent).seq), "events are in sequence order")
    .refine((r) => r.events.length === 0 || (r.events[r.events.length - 1] as RunEvent).seq === r.nextSeq, "nextSeq is the last event's")
    .refine((r) => r.available || (r.events.length === 0 && r.complete), "an unavailable stream is empty and complete")
    .refine((r) => r.events.every((e) => e.type !== "approval" || (e.state === "requested") === (e.preview !== null)), "a requested approval carries its preview"),
);

export const composerRunsMethods = {
  start: {
    request: composerStartRequestSchema,
    response: composerStartResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  cancel: {
    request: composerCancelRequestSchema,
    response: composerCancelResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 15_000,
  },
  get: {
    request: composerGetRequestSchema,
    response: composerGetResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
  list: {
    request: composerListRequestSchema,
    response: composerListResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 10_000,
  },
  events: {
    request: composerEventsRequestSchema,
    response: composerEventsResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type ComposerRunsMethod = keyof typeof composerRunsMethods;
export type ComposerRunsRequest<M extends ComposerRunsMethod> = z.infer<(typeof composerRunsMethods)[M]["request"]>;
export type ComposerRunsResponse<M extends ComposerRunsMethod> = z.infer<(typeof composerRunsMethods)[M]["response"]>;
