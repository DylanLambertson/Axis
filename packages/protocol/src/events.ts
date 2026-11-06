// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { runStateSchema } from "./cliRuns.js";
import { guarded } from "./guard.js";
import { protocolVersionSchema } from "./version.js";
import { runIdSchema, workspaceIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.events/1` (docs/design/events.md): server-pushed invalidation hints.
 *
 * An event names what changed (an id, and a closed-enum state where one exists) and never carries the thing itself:
 * no path, name, message, challenge id, digest or audit payload. The client answers an event with the read method it
 * already uses. `subscribe` and `unsubscribe` are ordinary tier 0 calls; the daemon then sends `event`, `resync` and
 * `end` frames on the same port, and the client grants credit with `ack` messages.
 */

export const EVENTS_CONTRACT = "axis.events" as const;
export const EVENTS_VERSION = 1 as const;

/** Unacknowledged frames one subscription may have outstanding. */
export const EVENT_WINDOW = 32;
/** Queued (unsent) frames one subscription may hold before it is dropped to a resync. */
export const EVENT_QUEUE_MAX = 64;
/** Events kept for `resumeFrom`. */
export const EVENT_RING_SIZE = 256;
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 4;
export const MAX_SUBSCRIPTIONS_TOTAL = 256;

export const EVENT_TOPICS = ["workspaces", "runs", "approvals", "anchor", "audit"] as const;
export const eventTopicSchema = z.enum(EVENT_TOPICS);
export type EventTopic = z.infer<typeof eventTopicSchema>;

/** 128 random bits or more, base64url: the daemon's epoch and every subscription id. */
export const eventTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,43}$/);
export const subscriptionIdSchema = eventTokenSchema;
export const eventEpochSchema = eventTokenSchema;
/** Daemon-wide event sequence; 0 means "nothing published yet". */
export const eventSeqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The closed set of event bodies. Strict: an unknown field (a path, a name) makes the body invalid, and it is not sent. */
export const eventBodySchema = z.discriminatedUnion("topic", [
  z.strictObject({ topic: z.literal("workspaces"), workspaceId: workspaceIdSchema }),
  z.strictObject({ topic: z.literal("runs"), runId: runIdSchema, state: runStateSchema.optional() }),
  z.strictObject({ topic: z.literal("approvals") }),
  z.strictObject({ topic: z.literal("anchor"), stalled: z.boolean() }),
  z.strictObject({ topic: z.literal("audit"), headSeq: eventSeqSchema }),
]);
export type EventBody = z.infer<typeof eventBodySchema>;

export const RESYNC_REASONS = ["overflow"] as const;
export const END_REASONS = ["shutdown"] as const;

const topicsSchema = z
  .array(eventTopicSchema)
  .min(1)
  .max(EVENT_TOPICS.length)
  .refine((t) => new Set(t).size === t.length, "duplicate topic");

// subscribe (read, tier 0)
export const eventsSubscribeRequestSchema = z.strictObject({
  topics: topicsSchema,
  /** The last `{ epoch, seq }` the client saw; absent for a fresh start. */
  resumeFrom: z.strictObject({ epoch: eventEpochSchema, seq: eventSeqSchema }).optional(),
});
export const eventsSubscribeResponseSchema = z.strictObject({
  subscriptionId: subscriptionIdSchema,
  epoch: eventEpochSchema,
  /** The head when the subscription was made: frames that follow carry larger numbers (replayed ones excepted). */
  seq: eventSeqSchema,
  /** False when `resumeFrom` was given and could not be honoured: re-read everything shown. */
  resumed: z.boolean(),
  window: z.number().int().min(1).max(1024),
});

// unsubscribe (read, tier 0)
export const eventsUnsubscribeRequestSchema = z.strictObject({ subscriptionId: subscriptionIdSchema });
export const eventsUnsubscribeResponseSchema = z.strictObject({ subscriptionId: subscriptionIdSchema });

export const eventsMethods = {
  subscribe: {
    request: guarded(eventsSubscribeRequestSchema),
    response: guarded(eventsSubscribeResponseSchema),
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
  unsubscribe: {
    request: guarded(eventsUnsubscribeRequestSchema),
    response: guarded(eventsUnsubscribeResponseSchema),
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type EventsMethod = keyof typeof eventsMethods;

/** Daemon to client: one event of a subscription. */
export const eventFrameSchema = z.strictObject({
  v: protocolVersionSchema,
  sub: subscriptionIdSchema,
  seq: eventSeqSchema,
  event: eventBodySchema,
});
/** Daemon to client: events were dropped; re-read everything, then continue. `seq` is the head when it was sent. */
export const resyncFrameSchema = z.strictObject({
  v: protocolVersionSchema,
  sub: subscriptionIdSchema,
  seq: eventSeqSchema,
  resync: z.strictObject({ reason: z.enum(RESYNC_REASONS) }),
});
/** Daemon to client: the subscription is over (no further frame of it follows). */
export const endFrameSchema = z.strictObject({
  v: protocolVersionSchema,
  sub: subscriptionIdSchema,
  end: z.strictObject({ reason: z.enum(END_REASONS) }),
});
export const serverFrameSchema = z.union([eventFrameSchema, resyncFrameSchema, endFrameSchema]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

/** Client to daemon: credit. Acknowledges every frame of `ack` up to and including `seq`. Not a request: no reply. */
export const ackEnvelopeSchema = z.strictObject({
  v: protocolVersionSchema,
  ack: subscriptionIdSchema,
  seq: eventSeqSchema,
});
export type AckEnvelope = z.infer<typeof ackEnvelopeSchema>;
