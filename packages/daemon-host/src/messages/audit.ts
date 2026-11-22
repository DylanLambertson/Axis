// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditActor, AuditEventInput, AuditOutcome } from "@axis/audit";
import type { MessageCaller } from "./policy.js";

/**
 * Audit rows of the message service (docs/design/inter-agent-communication.md section 8.1). Ids, kinds, counts and
 * closed reasons only: never a body, an excerpt, a path or any text a sender wrote. Each action's keys are allow-listed
 * in the host's `AuditLog` (`MESSAGES_PAYLOAD_ALLOWLIST`); anything else a row carried would be dropped there.
 *
 * Not yet recorded: `bodyMac` (an HMAC under a per-install key, section 8.1 N2). The key's storage is not decided, so no
 * hash of a body is written at all (gate line 17 holds trivially); `bodyLength` is the only fact about a body.
 */
export const MESSAGE_AUDIT = {
  send: "message.send",
  sendRefused: "message.send.refused",
  readRefused: "message.read.refused",
  settings: "message.settings",
  pause: "message.pause",
  resume: "message.resume",
  deliver: "message.deliver",
  deliverFailed: "message.deliver.failed",
} as const;

const WHO = ["callerKind", "callerId", "runId", "verified"] as const;
export const MESSAGES_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [MESSAGE_AUDIT.send]: Object.freeze([...WHO, "messageId", "threadId", "projectId", "newThread", "recipientCount", "expandedCount", "bodyLength", "refsCount", "hop"]),
  [MESSAGE_AUDIT.sendRefused]: Object.freeze([...WHO, "threadId", "projectId", "reason"]),
  [MESSAGE_AUDIT.readRefused]: Object.freeze([...WHO, "threadId", "method", "reason"]),
  [MESSAGE_AUDIT.settings]: Object.freeze(["projectId", "agentId", "setting", "groups", "before", "after"]),
  [MESSAGE_AUDIT.pause]: Object.freeze(["scopeKind", "scopeId", "changed"]),
  [MESSAGE_AUDIT.resume]: Object.freeze(["scopeKind", "scopeId", "changed"]),
  [MESSAGE_AUDIT.deliver]: Object.freeze(["messageId", "threadId", "runId", "agentId", "channel", "senderKind", "hop", "withheld"]),
  [MESSAGE_AUDIT.deliverFailed]: Object.freeze(["messageId", "threadId", "runId", "agentId", "failures"]),
});

export interface MessageAuditSink {
  append(input: AuditEventInput): unknown;
}

/** The audit actor of a caller. A plugin has no actor kind of its own yet: it is recorded as `daemon` with its id in the payload. */
export function actorOf(c: MessageCaller): AuditActor {
  return c.kind === "user" ? "user" : c.kind === "agent" ? `agent:${c.agentId}` : "daemon";
}

/** Who asked, as payload fields. */
export function who(c: MessageCaller): Record<string, string | boolean> {
  if (c.kind === "user") return { callerKind: "user" };
  if (c.kind === "plugin") return { callerKind: "plugin", callerId: c.pluginId };
  return { callerKind: "agent", callerId: c.agentId, verified: c.verified, ...(c.runId === null ? {} : { runId: c.runId }) };
}

export function row(caller: MessageCaller | "user", action: string, target: string, outcome: AuditOutcome, payload: Record<string, unknown>): AuditEventInput {
  return { actor: caller === "user" ? "user" : actorOf(caller), action, target, outcome, payload };
}
