// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { countSchema, guarded } from "./guard.js";
import {
  MAX_READ_MESSAGES,
  MAX_READ_TEXT,
  MAX_THREADS_LIST,
  agentGroupIdSchema,
  agentIdSchema,
  messageBodyRequestSchema,
  messageIdSchema,
  messageSchema,
  messageTextUnits,
  recipientsSchema,
  refsRequestSchema,
  threadIdSchema,
  threadSummarySchema,
  type MessageWire,
} from "./messages-wire.js";
import { projectIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.messages/1` (docs/design/inter-agent-communication.md; docs/design/messages-contract.md). Served since PV-M3 by
 * the daemon host's message service (`packages/daemon-host/src/messages/`), to the user's own connection only.
 *
 * A message never grants anything. No request or response field can carry an approval, a challenge, a digest, a grant, a
 * token, a capability, a credential, a command or a path to execute, and no method is above tier 2, so none takes an
 * `approval`. Every field the daemon fills (`messageId` of a new message, `projectId`, `seq`, `sender`, `hop`,
 * `createdAt`, the expanded recipients) is absent from every request: a strict schema refuses it if a client sends it.
 *
 * THREAD VISIBILITY (section 4.2, review B1). Each thread has a daemon-held participant set, fixed at creation from the
 * sender and the policy-checked, expanded recipients; it grows only by a user action or by a send whose new recipient the
 * send policy allows. `thread`, `threads`, `read` and `markRead` answer only for threads where the caller is a
 * participant, and within them only messages addressed to the caller or sent after it joined. The user (actor `user`)
 * reads every thread of the project. A thread or message the caller cannot see answers exactly like one that does not
 * exist: `E_NOT_FOUND`, details `{ reason: "not_found" }`, the fixed message, the same structural path. `threads` never lists
 * another thread's id. `send` with a `threadId` needs the sender to be a participant, and EVERY recipient, participant or
 * not, passes the send policy (section 4.1, including `accepts from`) at accept and again at delivery (review 2, NS1).
 * `inReplyTo` names a message of the same thread that the sender can read, or the send answers `not_found`.
 *
 * Display rules: every body and excerpt is escaped by the daemon with `toMessageText` (tab and newline kept; controls,
 * bidi, zero-width and invisible characters written as `\u{hex}`), every path and name with `toDisplayPath`; the response
 * schemas refuse anything unescaped. Bodies are plain text and never rendered as markup in the privileged renderer.
 */

export const MESSAGES_CONTRACT = "axis.messages" as const;
export const MESSAGES_VERSION = 1 as const;

const seqSchema = z.number().int().min(1);
const limitSchema = (max: number) => z.number().int().min(1).max(max).optional();

/** Messages in sequence order within each thread, unique ids, and text within the reply cap. */
function messagesOk(ms: readonly MessageWire[]): boolean {
  const last = new Map<string, number>();
  for (const m of ms) {
    if ((last.get(m.threadId) ?? 0) >= m.seq) return false;
    last.set(m.threadId, m.seq);
  }
  return new Set(ms.map((m) => m.messageId)).size === ms.length && ms.reduce((n, m) => n + messageTextUnits(m), 0) <= MAX_READ_TEXT;
}
const messageListSchema = z.array(messageSchema).max(MAX_READ_MESSAGES).refine(messagesOk, "messages out of order, repeated or over the text cap");

// send (write, tier 2, idempotency required): a new thread when `threadId` is absent, a post into it otherwise.
export const messagesSendRequestSchema = z.strictObject({
  threadId: threadIdSchema.optional(),
  recipients: recipientsSchema,
  body: messageBodyRequestSchema,
  refs: refsRequestSchema.optional(),
  inReplyTo: messageIdSchema.optional(),
});
export const messagesSendResponseSchema = z.strictObject({ message: messageSchema, replayed: z.boolean() });

// thread (read, tier 1): one thread's messages visible to the caller after `afterSeq` (default 0), oldest first.
export const messagesThreadRequestSchema = z.strictObject({
  threadId: threadIdSchema,
  afterSeq: countSchema.optional(),
  limit: limitSchema(MAX_READ_MESSAGES),
});
export const messagesThreadResponseSchema = z
  .strictObject({
    thread: threadSummarySchema,
    messages: messageListSchema,
    /** The cursor for the next call: the last returned message's `seq`, or `min(afterSeq, thread.lastSeq)` when none. */
    nextSeq: countSchema,
    /** No visible message after `nextSeq` when the reply was built. */
    complete: z.boolean(),
  })
  .refine((r) => r.messages.every((m) => m.threadId === r.thread.threadId && m.projectId === r.thread.projectId), "a message of another thread")
  .refine((r) => r.messages.length === 0 || (r.messages[r.messages.length - 1] as MessageWire).seq === r.nextSeq, "nextSeq is the last message's")
  .refine((r) => r.nextSeq <= r.thread.lastSeq, "cursor past the thread");

// threads (read, tier 0): the caller's threads, most recent activity first. `projectId` filters; it is never authority.
export const messagesThreadsRequestSchema = z.strictObject({
  projectId: projectIdSchema.optional(),
  limit: limitSchema(MAX_THREADS_LIST),
});
export const messagesThreadsResponseSchema = z.strictObject({
  threads: z
    .array(threadSummarySchema)
    .max(MAX_THREADS_LIST)
    .refine((ts) => new Set(ts.map((t) => t.threadId)).size === ts.length, "duplicate thread")
    .refine((ts) => ts.every((t, i) => i === 0 || (ts[i - 1] as { lastAt: string }).lastAt >= t.lastAt), "not most recent first"),
});

/**
 * read (read, tier 1): the caller's inbox, the read of the composer tool `read_messages` and of the CLI endpoint.
 * Messages addressed to the caller and not marked read, oldest first per thread; in one thread when `threadId` is given
 * (then `afterSeq` may narrow it). It does not change read state (`markRead` does); each message returned is a delivery.
 */
export const messagesReadRequestSchema = z
  .strictObject({
    threadId: threadIdSchema.optional(),
    afterSeq: countSchema.optional(),
    limit: limitSchema(MAX_READ_MESSAGES),
  })
  .refine((r) => r.afterSeq === undefined || r.threadId !== undefined, "afterSeq needs a thread");
export const messagesReadResponseSchema = z.strictObject({
  messages: messageListSchema,
  /** More unread messages remain than this reply holds. */
  more: z.boolean(),
});

// markRead (write, tier 1): the caller's own read cursor of one thread; it never moves back.
export const messagesMarkReadRequestSchema = z.strictObject({ threadId: threadIdSchema, throughSeq: seqSchema });
export const messagesMarkReadResponseSchema = z.strictObject({ threadId: threadIdSchema, readThrough: countSchema, unread: countSchema });

/** What Pause and Resume act on (section 10): a whole project, one group or one agent. */
export const pauseScopeSchema = z.union([
  z.strictObject({ project: projectIdSchema }),
  z.strictObject({ group: agentGroupIdSchema }),
  z.strictObject({ agent: agentIdSchema }),
]);
// pause and resume (write, tier 2, user only): the kill switch. Pause stops new sends and deliveries in scope, never recalls.
export const messagesPauseRequestSchema = z.strictObject({ scope: pauseScopeSchema });
export const messagesPauseResponseSchema = z.strictObject({ scope: pauseScopeSchema, paused: z.literal(true), changed: z.boolean() });
export const messagesResumeRequestSchema = messagesPauseRequestSchema;
export const messagesResumeResponseSchema = z.strictObject({ scope: pauseScopeSchema, paused: z.literal(false), changed: z.boolean() });

export const ACCEPTS_FROM = ["none", "group", "project"] as const;
export const MAX_SETTINGS_AGENTS = 256;
export const MAX_CROSS_GROUP_PAIRS = 64;
export const MAX_RETENTION_DAYS = 365;
const uniqueIds = (max: number, id: z.ZodType<string>) =>
  z.array(id).max(max).refine((a) => new Set(a).size === a.length, "duplicate id");
const groupPairSchema = z.tuple([agentGroupIdSchema, agentGroupIdSchema]).refine(([a, b]) => a !== b, "a pair is two groups");
const pairKey = ([a, b]: readonly [string, string]): string => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

/** A project's messaging settings, held by the daemon (never repository settings, the CFG-1 rule). */
export const messagingSettingsSchema = z.strictObject({
  projectId: projectIdSchema,
  /** Agents may message agents of every other group of the project (M-1, default off). */
  crossGroup: z.boolean(),
  /** Group pairs allowed to message each other while `crossGroup` is off; unordered, unique. */
  crossGroupPairs: z
    .array(groupPairSchema)
    .max(MAX_CROSS_GROUP_PAIRS)
    .refine((ps) => new Set(ps.map(pairKey)).size === ps.length, "duplicate pair"),
  /** M-6: `warn` applies only when every recipient is a composer agent or the user. */
  secretScan: z.enum(["refuse", "warn"]),
  retentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS),
  paused: z.strictObject({ project: z.boolean(), groups: uniqueIds(MAX_SETTINGS_AGENTS, agentGroupIdSchema), agents: uniqueIds(MAX_SETTINGS_AGENTS, agentIdSchema) }),
  agents: z
    .array(
      z
        .strictObject({
          agentId: agentIdSchema,
          kind: z.enum(["composer", "cli"]),
          acceptsFrom: z.enum(ACCEPTS_FROM),
          /** A CLI agent's endpoint is enabled (docs/design/inter-agent-cli-endpoint.md section 6); always false for a composer. */
          cliMessaging: z.boolean(),
          /** Hidden from the attention block; delivery unchanged. */
          muted: z.boolean(),
        })
        .refine((a) => !a.cliMessaging || a.kind === "cli", "only a CLI agent has an endpoint"),
    )
    .max(MAX_SETTINGS_AGENTS)
    .refine((as) => new Set(as.map((a) => a.agentId)).size === as.length, "duplicate agent"),
});

// settings (read, tier 0)
export const messagesSettingsRequestSchema = z.strictObject({ projectId: projectIdSchema });
export const messagesSettingsResponseSchema = z.strictObject({ settings: messagingSettingsSchema });

/**
 * updateSettings (write, tier 2, user only): one setting per call, so the audit row (`message.settings`) names exactly
 * one change with its before and after. Enabling a CLI agent is refused for a bypass entry (`bypass_entry`).
 */
export const messagesUpdateSettingsRequestSchema = z.discriminatedUnion("setting", [
  z.strictObject({ setting: z.literal("crossGroup"), projectId: projectIdSchema, value: z.boolean() }),
  z.strictObject({ setting: z.literal("crossGroupPair"), projectId: projectIdSchema, groups: groupPairSchema, value: z.boolean() }),
  z.strictObject({ setting: z.literal("secretScan"), projectId: projectIdSchema, value: z.enum(["refuse", "warn"]) }),
  z.strictObject({ setting: z.literal("retentionDays"), projectId: projectIdSchema, value: z.number().int().min(1).max(MAX_RETENTION_DAYS) }),
  z.strictObject({ setting: z.literal("acceptsFrom"), agentId: agentIdSchema, value: z.enum(ACCEPTS_FROM) }),
  z.strictObject({ setting: z.literal("cliMessaging"), agentId: agentIdSchema, value: z.boolean() }),
  z.strictObject({ setting: z.literal("muted"), agentId: agentIdSchema, value: z.boolean() }),
]);
/**
 * Enabling a CLI worker's messaging (PV-M7 slice 1) may carry structured warnings: a CLI project-configuration file found in
 * the worker's workspace that can make the CLI act without asking (endpoint design section 6). Codes, never prose: the
 * dialog's words are the shell's.
 */
export const messagesEnableWarningSchema = z.strictObject({ code: z.literal("repo_config"), path: z.string().min(1).max(64).regex(/^[a-z0-9._/-]+$/), cli: z.string().min(1).max(16).regex(/^[a-z0-9-]+$/) });
export const messagesUpdateSettingsResponseSchema = z.strictObject({ settings: messagingSettingsSchema, changed: z.boolean(), warnings: z.array(messagesEnableWarningSchema).max(8).optional() });

const spec = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
  sideEffect: "read" | "write",
  tier: 0 | 1 | 2,
  idempotency: "none" | "required",
  timeoutMs: number,
) => ({ request: guarded(request), response: guarded(response), sideEffect, tier, idempotency, timeoutMs }) as const;

export const messagesMethods = {
  send: spec(messagesSendRequestSchema, messagesSendResponseSchema, "write", 2, "required", 15_000),
  thread: spec(messagesThreadRequestSchema, messagesThreadResponseSchema, "read", 1, "none", 10_000),
  threads: spec(messagesThreadsRequestSchema, messagesThreadsResponseSchema, "read", 0, "none", 10_000),
  read: spec(messagesReadRequestSchema, messagesReadResponseSchema, "read", 1, "none", 10_000),
  markRead: spec(messagesMarkReadRequestSchema, messagesMarkReadResponseSchema, "write", 1, "none", 5_000),
  pause: spec(messagesPauseRequestSchema, messagesPauseResponseSchema, "write", 2, "none", 5_000),
  resume: spec(messagesResumeRequestSchema, messagesResumeResponseSchema, "write", 2, "none", 5_000),
  settings: spec(messagesSettingsRequestSchema, messagesSettingsResponseSchema, "read", 0, "none", 5_000),
  updateSettings: spec(messagesUpdateSettingsRequestSchema, messagesUpdateSettingsResponseSchema, "write", 2, "none", 10_000),
} as const satisfies Record<string, MethodSpec>;

export type MessagesMethod = keyof typeof messagesMethods;
export type MessagesRequest<M extends MessagesMethod> = z.infer<(typeof messagesMethods)[M]["request"]>;
export type MessagesResponse<M extends MessagesMethod> = z.infer<(typeof messagesMethods)[M]["response"]>;
