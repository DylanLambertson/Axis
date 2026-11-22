// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MAX_TAINT_HOP, senderSchema, type MessageWire, type MessagesRequest } from "@axis/protocol";
import { WITHHELD_BODY, frameNonce, framed, senderLabel, untrustedNote } from "./delivery.js";
import type { MessageCaller, MessagingDirectory } from "./policy.js";
import type { MessageService } from "./service.js";

/**
 * A composer run's side of messaging (ticket PV-M4; docs/design/inter-agent-communication.md sections 6.1, 6.6 and 7.3;
 * docs/design/messages-contract.md section 10): what `send_message` and `read_messages` (`bindings/agent-messages.ts`) call.
 * No broker here; the binding registers the tools and holds the run's taint and received hop.
 *
 * - **Attested, never from the model.** The caller is built from the run: its agent (`agentOf`, which the directory must
 *   know), its id, `verified: true` (a composer run is the daemon's own), and the highest hop the run has received. The
 *   tools' argument schemas are strict, so a model field naming a sender, an agent, a project or a hop is refused.
 * - **Inert unless messaging is enabled.** A run started for an agent records it (PV-G4), but the host's `agentOf` reads
 *   it only with `ComposeOptions.messaging.enabled` (default off); off, `agentOf` answers undefined and neither tool is
 *   offered to any run in production.
 * - **Reads are framed and checked.** A `read_messages` result is framed like a delivery (a nonce drawn for it, every body
 *   line prefixed `| `), every body escaped by the service (`toMessageText`); a body whose stored raw text or escaped text
 *   the host redactor would change (a secret) is withheld, never shown (the service checks the raw text and returns ids only). Each shown message from an agent, a plugin or a CLI sender is a taint receipt
 *   (source 2); the binding takes each receipt (raising the run's received hop to its hop) BEFORE the result is returned.
 */

/** The run's attested identity for one call. */
export interface RunParticipant {
  readonly agentId: string;
  readonly runId: string;
  /** The highest hop this run has received through any taint source (delivery, reads), from the binding's run state. */
  readonly receivedHop: number;
}

export interface SendArgs {
  readonly recipients: MessagesRequest<"send">["recipients"];
  readonly body: string;
  readonly threadId?: string | undefined;
  readonly inReplyTo?: string | undefined;
}
export interface ReadArgs {
  readonly threadId?: string | undefined;
  readonly afterSeq?: number | undefined;
  readonly limit?: number | undefined;
}

/** What a read gives the binding: the framed text and the taint receipts to take BEFORE it is returned (each raises the run's hop). */
export interface ReadOutcome {
  readonly text: string;
  readonly receipts: readonly { readonly source: "read_messages"; readonly senderKind: "agent" | "plugin" | "cli"; readonly sender: string; readonly hop: number; readonly ref: string }[];
}

export interface ComposerMessaging {
  /** The agent a run acts for, when the directory knows it; undefined: neither tool is offered (every run while messaging is off). */
  agentOf(runId: string): string | undefined;
  send(who: RunParticipant, args: SendArgs): Promise<string>;
  read(who: RunParticipant, args: ReadArgs): ReadOutcome;
}

export interface ComposerMessagingDeps {
  readonly service: Pick<MessageService, "send" | "readWithheld">;
  readonly directory: MessagingDirectory;
  readonly agentOf: (runId: string) => string | undefined;
  readonly random: { bytes(n: number): Uint8Array };
  /**
   * True when the host redactor would change the text (a secret). The service applies it to each shown message's stored raw
   * body and to its escaped body and returns only the ids that match (section 11): the raw text never reaches this module.
   */
  readonly holdsSecret: (text: string) => boolean;
}

/** The caller the service sees: always from the run, never from the model's arguments. */
export function runCaller(who: RunParticipant): MessageCaller {
  return { kind: "agent", agentId: who.agentId, runId: who.runId, verified: true, receivedHop: who.receivedHop };
}

/** The highest of a run's received hop and a hop it now receives; a value out of range raises it to the cap (refusing every later send). */
export function raisedHop(current: number, received: unknown): number {
  if (typeof received !== "number" || !Number.isSafeInteger(received) || received < 0 || received > MAX_TAINT_HOP) return MAX_TAINT_HOP;
  return Math.max(current, received);
}

function header(m: MessageWire, directory: MessagingDirectory): { readonly line: string; readonly who: ReturnType<typeof senderLabel> } {
  const who = senderLabel(senderSchema.parse(m.sender), directory);
  const reply = m.inReplyTo === null ? "" : ` | in reply to ${m.inReplyTo}`;
  return { who, line: `from ${who.name} (${who.kind}, ${who.verified ? "verified" : "unverified"}) | thread ${m.threadId} | message ${m.messageId} | seq ${m.seq} | hop ${m.hop}${reply}` };
}

export function createComposerMessaging(deps: ComposerMessagingDeps): ComposerMessaging {
  return {
    agentOf(runId) {
      const id = deps.agentOf(runId);
      return id !== undefined && deps.directory.agent(id) !== undefined ? id : undefined;
    },

    async send(who, a) {
      const req = {
        recipients: a.recipients,
        body: { format: "text" as const, text: a.body },
        ...(a.threadId === undefined ? {} : { threadId: a.threadId }),
        ...(a.inReplyTo === undefined ? {} : { inReplyTo: a.inReplyTo }),
      };
      const { message } = await deps.service.send(runCaller(who), req);
      return `Sent message ${message.messageId} in thread ${message.threadId} (seq ${message.seq}, hop ${message.hop}, ${message.expanded.length} recipient(s)).`;
    },

    read(who, a) {
      const req = {
        ...(a.threadId === undefined ? {} : { threadId: a.threadId }),
        ...(a.afterSeq === undefined ? {} : { afterSeq: a.afterSeq }),
        ...(a.limit === undefined ? {} : { limit: a.limit }),
      };
      const { messages, more, withheld } = deps.service.readWithheld(runCaller(who), req, deps.holdsSecret);
      const receipts: ReadOutcome["receipts"][number][] = [];
      const parts = messages.map((m) => {
        const h = header(m, deps.directory);
        if (h.who.taintKind !== undefined) receipts.push({ source: "read_messages", senderKind: h.who.taintKind, sender: h.who.name, hop: m.hop, ref: m.messageId });
        return { header: h.line, body: withheld.has(m.messageId) ? WITHHELD_BODY : m.body.text };
      });
      // A message from the user or from Axis is hop 0 and no source: only receipts raise the run's hop.
      if (parts.length === 0) return { text: "No messages to read.", receipts };
      const nonce = frameNonce(deps.random);
      const page = more ? " More messages follow: read again (in a thread, with afterSeq set to the last seq shown)." : "";
      const text = framed("axis-read", nonce, `Axis returns ${parts.length} message(s).${page} ${untrustedNote(nonce)}`, parts);
      return { text, receipts };
    },
  };
}
