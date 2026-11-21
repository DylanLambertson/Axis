// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import {
  MAX_BODY_DISPLAY,
  MAX_READ_TEXT,
  MAX_REF_PATH,
  messageSchema,
  messageTextUnits,
  messagesMethods,
  principalSchema,
  recipientsSchema,
  refRequestSchema,
  senderSchema,
  toDisplayPath,
  toMessageText,
  type MessageWire,
  type MessagesMethod,
  type MessagesRequest,
  type Principal,
} from "@axis/protocol";
import type { MessageRecord } from "@axis/journal";

/**
 * Stored records to the wire. The journal keeps the sender's raw text (messages-contract.md section 6: "the daemon
 * stores the text and escapes it on every way out"); every body leaves through `toMessageText` and every path through
 * `toDisplayPath`, here and nowhere else, so the bridge, the broker (PV-M4) and the endpoint (PV-M6) share one escaping.
 * A stored record that does not parse is an internal error, never passed through.
 */

const storedRefs = z.array(refRequestSchema);
const storedExpanded = z.array(principalSchema);

export class StoredRecordError extends Error {
  constructor() {
    super("a stored message record does not parse");
    this.name = "StoredRecordError";
  }
}

/** A request that fails the contract's own schema (the bridge already parsed it; a direct caller, PV-M4 or PV-M6, may not have). */
export class InvalidMessageRequest extends Error {
  constructor() {
    super("message request refused");
    this.name = "InvalidMessageRequest";
  }
}

/** Every service method parses its request with the contract's schema first: whatever the caller, nothing unchecked goes in. */
export function checked<M extends MessagesMethod>(method: M, req: unknown): MessagesRequest<M> {
  const r = messagesMethods[method].request.safeParse(req);
  if (!r.success) throw new InvalidMessageRequest();
  return r.data as MessagesRequest<M>;
}

function must<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new StoredRecordError();
  return r.data;
}

/** Display form of a ref: a raw path never leaves, only its escaped display text. Excerpts are never stored in this slice. */
function refOut(r: z.infer<typeof refRequestSchema>): unknown {
  if (r.type === "file") return { type: "file", workspaceId: r.workspaceId, displayPath: toDisplayPath(r.path, MAX_REF_PATH) };
  if (r.type === "excerpt") throw new StoredRecordError();
  return r;
}

export function toWire(m: MessageRecord, projectId: string): MessageWire {
  const out = {
    messageId: m.id,
    threadId: m.threadId,
    projectId,
    seq: m.seq,
    sender: must(senderSchema, m.sender),
    recipients: must(recipientsSchema, m.recipients),
    expanded: must(storedExpanded, m.expanded),
    body: { format: "text", text: toMessageText(m.body, MAX_BODY_DISPLAY).text },
    refs: must(storedRefs, m.refs).map(refOut),
    inReplyTo: m.inReplyTo,
    hop: m.hop,
    createdAt: m.createdAt,
  };
  return must(messageSchema, out);
}

/**
 * Take messages in order while the reply stays within `MAX_READ_TEXT` units; the first always fits (the cap is one
 * message at its largest), so a reader always makes progress. `cut` is true when a message was left out for the cap.
 */
export function pageByText(ms: readonly MessageWire[]): { readonly messages: MessageWire[]; readonly cut: boolean } {
  const out: MessageWire[] = [];
  let units = 0;
  for (const m of ms) {
    const n = messageTextUnits(m);
    if (out.length > 0 && units + n > MAX_READ_TEXT) return { messages: out, cut: true };
    out.push(m);
    units += n;
  }
  return { messages: out, cut: false };
}

/** A participant key (`user`, `agent:<id>`, `plugin:<id>`) back to its principal; undefined for anything else. */
export function principalOf(key: string): Principal | undefined {
  const p = key === "user" ? { kind: "user" } : key.startsWith("agent:") ? { kind: "agent", agentId: key.slice(6) } : key.startsWith("plugin:") ? { kind: "plugin", pluginId: key.slice(7) } : undefined;
  const r = principalSchema.safeParse(p);
  return r.success ? r.data : undefined;
}
