// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { CF_RANGES, rangesToClass } from "./display.js";
import { countSchema } from "./guard.js";

/**
 * The taint rule IAC-T (docs/design/inter-agent-communication.md sections 6.5 and 6.6, ticket PV-M0). A composer run that
 * has received content from anyone but the user is tainted for the rest of its life, and every side-effecting call it
 * makes needs the user's approval. These are the wire shapes: the closed list of sources, and what an approval card
 * lists about the sources a run received.
 */

/**
 * The closed source list (section 6.6, items 1 to 8, in that order). A new source is added here, with a gate line, before it
 * can reach a model; the daemon refuses any other value.
 */
export const TAINT_SOURCES = [
  /** 1. A delivered message from an agent, a plugin or a CLI endpoint sender. */
  "message",
  /** 2. A `read_messages` result that contains such a message. */
  "read_messages",
  /** 3. An excerpt received in such a message. */
  "excerpt",
  /** 4. `read_page` of a page whose current content has text from a non-user revision the user has not marked reviewed. */
  "page",
  /** 5. A run started from a task whose title or body has a non-user revision, or whose `source` is not `user`. */
  "task_start",
  /** 6. Plugin output of any kind delivered to the run. */
  "plugin_output",
  /** 7. Integration data (issue bodies, pull request comments, chat text) delivered to the run. */
  "integration_data",
  /** 8. A task read result that includes a task with a non-user revision or a non-`user` source. */
  "task_read",
] as const;
export const taintSourceSchema = z.enum(TAINT_SOURCES);
export type TaintSource = z.infer<typeof taintSourceSchema>;

/** Who sent or wrote the content. The user is never a taint source, so it is not a kind. */
export const TAINT_SENDER_KINDS = ["agent", "plugin", "cli", "integration"] as const;

/** Highest hop a received content can carry (the messaging hop limit, section 7.1). */
export const MAX_TAINT_HOP = 8;
/** Most sources one approval card lists (the most recent ones; `total` counts all of them). */
export const MAX_CARD_TAINT_SOURCES = 16;

/** Control, separator and format characters (bidi, zero-width), tab and line feed included: a name is one plain line. */
const REFUSED_NAME = new RegExp(`[${rangesToClass([[0x0, 0x1f], [0x7f, 0x9f], [0xd800, 0xdfff], 0x2028, 0x2029, ...CF_RANGES])}]`, "u");

/** One source as a run received it: the type, who sent or wrote it, when the daemon handed it to the run, its hop and a link. */
export const taintReceiptSchema = z.strictObject({
  source: taintSourceSchema,
  senderKind: z.enum(TAINT_SENDER_KINDS),
  /** The sender's or author's display name. Untrusted display text: shown as text, never as markup. */
  sender: z
    .string()
    .min(1)
    .max(128)
    .refine((t) => !REFUSED_NAME.test(t), { message: "no control or invisible characters" }),
  /** Milliseconds since the epoch, on the daemon's clock, when the content was handed to the run. */
  at: countSchema,
  hop: z.number().int().min(0).max(MAX_TAINT_HOP),
  /** The opaque id of what was received (a message, a page version, a task), for a link. Never a path. */
  ref: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
});
export type TaintReceipt = z.infer<typeof taintReceiptSchema>;

/**
 * What an approval card shows about a tainted run: the most recent sources this daemon handed to it, how many in all, and
 * whether the run was already tainted when this daemon took it up (after a restart or a resume; its earlier sources are in
 * the audit log as `message.taint` rows, not on the card). A card always says something: a source, a count or `earlier`.
 */
export const approvalTaintSchema = z
  .strictObject({
    sources: z.array(taintReceiptSchema).max(MAX_CARD_TAINT_SOURCES),
    total: countSchema,
    earlier: z.boolean(),
  })
  .refine((t) => t.total >= t.sources.length, "the total counts every listed source")
  .refine((t) => t.total > 0 || t.earlier, "a card names why the run is tainted");
export type ApprovalTaint = z.infer<typeof approvalTaintSchema>;
