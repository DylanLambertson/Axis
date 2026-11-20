// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { CF_RANGES, INVISIBLE_RANGES, rangesToClass } from "./display.js";
import { objectIdSchema } from "./git.js";
import { countSchema, displayTextSchema, timestampSchema } from "./guard.js";
import { projectIdSchema, relativePathSchema, runIdSchema, workspaceIdSchema } from "./worktrees.js";

/*
 * The records of `axis.messages/1` (docs/design/inter-agent-communication.md section 2; docs/design/messages-contract.md).
 * Split from `messages.ts`, which holds the methods. Nothing here can carry an approval, a challenge, a grant, a token, a
 * capability, a command or a path to execute: a message is data, and no rule reads it (section 5.3).
 */

/** Bytes of randomness in every thread and message id: 128 bits from the daemon's CSPRNG, never a counter. */
export const MESSAGING_ID_BYTES = 16;

/*
 * `<prefix><22 base64url characters>`: exactly 16 bytes, canonical (the last character carries 2 bits, so its low 4 bits
 * are zero: one of `A`, `Q`, `g`, `w`). The prefix only keeps the two kinds apart (a message id is never a thread id); the
 * rest says nothing about order, time, project or sender. Ids are opaque: no client may derive anything from one.
 */
const opaqueId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{21}[AQgw]$`));
export const threadIdSchema = opaqueId("thr_");
export const messageIdSchema = opaqueId("msg_");

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The one encoding of a thread or message id: `thr_` or `msg_` and the 16 bytes as unpadded base64url. The caller passes
 * exactly `MESSAGING_ID_BYTES` bytes from a CSPRNG (the daemon: `randomBytes(16)` from `node:crypto`); anything else throws,
 * so a short or sequential source cannot be encoded by accident. Pure, so the protocol keeps no Node import.
 */
export function encodeMessagingId(kind: "thread" | "message", bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== MESSAGING_ID_BYTES) throw new RangeError(`an id is exactly ${MESSAGING_ID_BYTES} random bytes`);
  let bits = 0;
  let acc = 0;
  let out = kind === "thread" ? "thr_" : "msg_";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64URL[(acc >> bits) & 63];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B64URL[(acc << (6 - bits)) & 63];
  return out;
}

/** Journal ids of agents, groups, tasks and pages: the `axis.worktrees/1` id rule (no leading `-` or `_`). PV-G2 owns agents and groups. */
const journalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const agentIdSchema = journalId;
export const agentGroupIdSchema = journalId;
export const taskIdSchema = journalId;
export const pageIdSchema = journalId;
/** A plugin id (`plugin:<id>` principal, docs/design/extensibility.md section 3): lower case, dot-separated words. */
export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63}){0,3}$/);

/** Limits (section 7.1). Characters are UTF-16 units. */
export const MAX_BODY_CHARS = 16_384;
export const MAX_RECIPIENTS = 16;
export const MAX_REFS = 16;
export const MAX_EXCERPTS = 4;
/** Lines one excerpt may ask for; the daemon also caps the copy at 64 KiB. */
export const MAX_EXCERPT_LINES = 2_000;
export const MAX_HOP = 8;
/** Members of a thread's participant set: it only grows (section 4.2), so it is bounded; a send past it is `too_many_recipients`. */
export const MAX_THREAD_PARTICIPANTS = 64;
/** Most messages one `thread` or `read` reply holds, and most threads one `threads` reply holds. */
export const MAX_READ_MESSAGES = 50;
export const MAX_THREADS_LIST = 100;
/**
 * Escaping writes one UTF-16 unit as at most 8 (`\u{dfff}`; a 2-unit `\u{e007f}` is 9), so an escaped body is at most
 * 8 times the cap and is never cut. An excerpt's escaped text is cut at `MAX_EXCERPT_DISPLAY` (with `truncated`).
 */
export const MAX_BODY_DISPLAY = MAX_BODY_CHARS * 8;
export const MAX_EXCERPT_DISPLAY = 65_536;
/**
 * All body, excerpt and display-path text one reply carries (UTF-16 units; at most 3 UTF-8 bytes each, so a reply at
 * every cap stays inside the 1 MiB message walk). One message at its largest (`MAX_MESSAGE_TEXT`) always fits, so a
 * reader always makes progress.
 */
export const MAX_READ_TEXT = 262_144;

/**
 * What message text refuses, and what `toMessageText` escapes: every control character except tab and line feed (so CR,
 * ESC and C1 are out: no OSC 52, OSC 8, title or cursor sequence reaches a terminal), surrogates, the line and paragraph
 * separators, every format character (bidi, zero-width) and the invisible set (`INVISIBLE_RANGES`, section 8.3).
 */
export const REFUSED_MESSAGE_TEXT = new RegExp(
  `[${rangesToClass([[0x0, 0x8], [0xb, 0x1f], [0x7f, 0x9f], [0xd800, 0xdfff], 0x2028, 0x2029, ...CF_RANGES, ...INVISIBLE_RANGES])}]`,
  "u",
);

const messageText = (min: number, max: number) =>
  z.string().min(min).max(max).refine((t) => !REFUSED_MESSAGE_TEXT.test(t), { message: "no control or invisible characters" });
/** A body as the daemon returns it: escaped by `toMessageText`, never cut. */
export const messageBodyTextSchema = messageText(1, MAX_BODY_DISPLAY);
/** An excerpt as the daemon returns it: escaped by `toMessageText`, cut at `MAX_EXCERPT_DISPLAY`. May be empty. */
export const excerptTextSchema = messageText(0, MAX_EXCERPT_DISPLAY);

const escapeToken = (ch: string): string =>
  ch === "\\" ? "\\\\" : REFUSED_MESSAGE_TEXT.test(ch) ? `\\u{${(ch.codePointAt(0) as number).toString(16)}}` : ch;

/**
 * Message text that is safe to show in the thread view, a composer delivery block and a terminal: every code point
 * `REFUSED_MESSAGE_TEXT` names, and the backslash (so an escape cannot be forged), is written as `\u{hex}` (`\\`), and
 * the result is cut at the end, on a code point or escape boundary, to at most `max` units. Pure and total. The daemon
 * applies it to every body and excerpt it returns, on every read path (bridge, broker, CLI endpoint).
 */
export function toMessageText(raw: string, max: number): { readonly text: string; readonly truncated: boolean } {
  if (typeof raw !== "string") throw new TypeError("toMessageText takes a string");
  if (!Number.isInteger(max) || max < 10) throw new RangeError("the limit must be an integer of at least 10");
  let text = "";
  for (const ch of raw) {
    const t = escapeToken(ch);
    if (text.length + t.length > max) return { text, truncated: true };
    text += t;
  }
  return { text, truncated: false };
}

/** A body as a client sends it: plain text, 1 to 16,384 units, well-formed (no lone surrogate). Never rendered as markup. */
export const messageBodyRequestSchema = z.strictObject({
  format: z.literal("text"),
  text: z.string().min(1).max(MAX_BODY_CHARS).refine((t) => !/[\ud800-\udfff]/u.test(t), { message: "not well-formed text" }),
});
export const messageBodySchema = z.strictObject({ format: z.literal("text"), text: messageBodyTextSchema });

/** A principal of a thread's participant set (section 4.2). The user is one principal; there is no user id on the wire. */
export const principalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("agent"), agentId: agentIdSchema }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: pluginIdSchema }),
]);
export type Principal = z.infer<typeof principalSchema>;
export const principalKey = (p: Principal): string =>
  p.kind === "user" ? "user" : p.kind === "agent" ? `agent:${p.agentId}` : `plugin:${p.pluginId}`;

/** A recipient as named in `send`: an agent, a group (expanded by the daemon at accept) or the user. */
export const recipientSchema = z.union([
  z.strictObject({ agent: agentIdSchema }),
  z.strictObject({ group: agentGroupIdSchema }),
  z.strictObject({ user: z.literal(true) }),
]);
const recipientKey = (r: z.infer<typeof recipientSchema>): string =>
  "agent" in r ? `agent:${r.agent}` : "group" in r ? `group:${r.group}` : "user";
export const recipientsSchema = z
  .array(recipientSchema)
  .min(1)
  .max(MAX_RECIPIENTS)
  .refine((rs) => new Set(rs.map(recipientKey)).size === rs.length, "duplicate recipient");

/**
 * Who sent a message: filled by the daemon from the attested connection (the H12 pattern), never from a payload.
 * `verified` is false exactly for a CLI endpoint sender (docs/design/inter-agent-cli-endpoint.md section 4: the token
 * proves only that the sender held it); every other sender is attested.
 */
export const senderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), verified: z.literal(true) }),
  z.strictObject({ kind: z.literal("agent"), agentId: agentIdSchema, runId: runIdSchema.nullable(), verified: z.boolean() }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: pluginIdSchema, verified: z.literal(true) }),
  z.strictObject({ kind: z.literal("system"), verified: z.literal(true) }),
]);

const lineRange = { startLine: z.number().int().min(1), endLine: z.number().int().min(1) };
const rangeOk = (r: { startLine: number; endLine: number }): boolean => r.endLine >= r.startLine && r.endLine - r.startLine < MAX_EXCERPT_LINES;
const prNumber = z.number().int().min(1).max(2_147_483_647);
/** Longest display path of a `file` or `excerpt` ref (`toDisplayPath(path, MAX_REF_PATH)`). */
export const MAX_REF_PATH = 512;
const displayPath = displayTextSchema(MAX_REF_PATH).pipe(z.string().min(1));

/**
 * A reference as sent. References are display data, never access grants (section 5.3 rule 3). An `excerpt` names a file
 * of the SENDER's own worktree; the daemon reads and copies it at send time (path refusals, containment, secret scan).
 */
export const refRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), workspaceId: workspaceIdSchema, path: relativePathSchema }),
  z.strictObject({ type: z.literal("commit"), sha: objectIdSchema }),
  z.strictObject({ type: z.literal("run"), runId: runIdSchema }),
  z.strictObject({ type: z.literal("task"), taskId: taskIdSchema }),
  z.strictObject({ type: z.literal("pr"), number: prNumber }),
  z.strictObject({ type: z.literal("page"), pageId: pageIdSchema }),
  z.strictObject({ type: z.literal("excerpt"), workspaceId: workspaceIdSchema, path: relativePathSchema, ...lineRange }).refine(rangeOk, "bad line range"),
]);
const excerptsOk = (refs: readonly { type: string }[]): boolean => refs.filter((r) => r.type === "excerpt").length <= MAX_EXCERPTS;
export const refsRequestSchema = z.array(refRequestSchema).max(MAX_REFS).refine(excerptsOk, "too many excerpts");

/** A reference as returned: a raw path is never echoed, only its escaped display form; an excerpt carries its copied, escaped text. */
export const refSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), workspaceId: workspaceIdSchema, displayPath }),
  z.strictObject({ type: z.literal("commit"), sha: objectIdSchema }),
  z.strictObject({ type: z.literal("run"), runId: runIdSchema }),
  z.strictObject({ type: z.literal("task"), taskId: taskIdSchema }),
  z.strictObject({ type: z.literal("pr"), number: prNumber }),
  z.strictObject({ type: z.literal("page"), pageId: pageIdSchema }),
  z
    .strictObject({ type: z.literal("excerpt"), workspaceId: workspaceIdSchema, displayPath, ...lineRange, text: excerptTextSchema, truncated: z.boolean() })
    .refine(rangeOk, "bad line range"),
]);

/** Body, excerpt and display-path text a message carries, in UTF-16 units (what `MAX_READ_TEXT` counts). */
export const messageTextUnits = (m: { body: { text: string }; refs: readonly object[] }): number =>
  m.refs.reduce((n: number, r) => n + unitsOf(r, "text") + unitsOf(r, "displayPath"), m.body.text.length);
function unitsOf(r: object, key: string): number {
  const v = (r as Record<string, unknown>)[key];
  return typeof v === "string" ? v.length : 0;
}
/** The most text one message can carry: an uncut body, the excerpts' cap and every ref's display path at its cap. */
export const MAX_MESSAGE_TEXT = MAX_BODY_DISPLAY + MAX_EXCERPT_DISPLAY + MAX_REFS * MAX_REF_PATH;

export const messageSchema = z
  .strictObject({
    messageId: messageIdSchema,
    threadId: threadIdSchema,
    /** From the thread or the recipients, never from renderer state (A10). */
    projectId: projectIdSchema,
    /** Per thread, monotonic; a reader sees gaps where messages are not addressed to it. */
    seq: z.number().int().min(1),
    sender: senderSchema,
    /** As the sender named them. */
    recipients: recipientsSchema,
    /** Who the daemon delivered to after expanding groups at accept time (recorded, section 2). */
    expanded: z
      .array(principalSchema)
      .min(1)
      .max(MAX_RECIPIENTS)
      .refine((ps) => new Set(ps.map(principalKey)).size === ps.length, "duplicate principal"),
    body: messageBodySchema,
    refs: z.array(refSchema).max(MAX_REFS).refine(excerptsOk, "too many excerpts"),
    inReplyTo: messageIdSchema.nullable(),
    /** 0 for a user message; otherwise from what the sending run received through a taint source (section 7.3). */
    hop: z.number().int().min(0).max(MAX_HOP),
    createdAt: timestampSchema,
  })
  .refine((m) => m.sender.kind !== "user" || m.hop === 0, "a user message has hop 0")
  .refine((m) => m.inReplyTo !== m.messageId, "a message cannot reply to itself")
  .refine((m) => m.refs.reduce((n, r) => n + (r.type === "excerpt" ? r.text.length : 0), 0) <= MAX_EXCERPT_DISPLAY, "excerpts over the cap");
export type MessageWire = z.infer<typeof messageSchema>;

/** A thread as its reader sees it. Only threads the caller participates in are ever returned (section 4.2). */
export const threadSummarySchema = z.strictObject({
  threadId: threadIdSchema,
  projectId: projectIdSchema,
  createdAt: timestampSchema,
  lastSeq: z.number().int().min(1),
  lastAt: timestampSchema,
  /** Messages addressed to the caller that it has not marked read. */
  unread: countSchema,
  participants: z
    .array(principalSchema)
    .min(1)
    .max(MAX_THREAD_PARTICIPANTS)
    .refine((ps) => new Set(ps.map(principalKey)).size === ps.length, "duplicate participant"),
});

/**
 * Refusal reasons, by error code: `details` of a refusal is exactly `{ reason }` with one of these, and nothing else (no
 * id, count or text from the journal, the recipient or the scanner). Closed set, never free text.
 *
 * `not_found` is the ONLY answer for a thread or message the caller cannot see, whether it exists or not: the same code,
 * the same fixed message, the same details and the same timing class (no existence oracle, section 4.2). A recipient the
 * sender may not address answers `recipient_refused` whether it exists or not, and an agent naming another project's
 * agent gets `recipient_refused`, never `cross_project` (which only the user, who can see every project, receives).
 */
export const MESSAGES_REFUSALS = {
  E_NOT_FOUND: ["not_found"],
  E_INVALID_ARGUMENT: ["too_large", "too_many_recipients"],
  E_POLICY_DENIED: ["recipient_refused", "cross_project", "paused", "hop_limit", "secret_found", "excerpt_path_refused", "bypass_entry"],
  E_BACKPRESSURE: ["rate_limited", "queue_full"],
} as const;
export type MessagesRefusalCode = keyof typeof MESSAGES_REFUSALS;
export const MESSAGES_REASONS = Object.values(MESSAGES_REFUSALS).flat();
export const messagesRefusalDetailsSchema = z.strictObject({ reason: z.enum(MESSAGES_REASONS as [string, ...string[]]) });
/** The one message text of each refusal; fixed, so nothing input-derived reaches the caller. */
export const MESSAGES_REFUSAL_MESSAGE = "message request refused";
/** True when `reason` is a refusal reason of `code` (a reason under another code is a handler bug). */
export function isMessagesRefusal(code: string, reason: string): boolean {
  return Object.hasOwn(MESSAGES_REFUSALS, code) && (MESSAGES_REFUSALS[code as MessagesRefusalCode] as readonly string[]).includes(reason);
}
