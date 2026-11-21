// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Journal } from "@axis/journal";
import { createMessageDelivery, type MessageDelivery } from "./delivery.js";
import { createMessageService, type MessageService } from "./service.js";
import { createMessagingSettings, type MessagingSettingsService } from "./settings.js";
import { journalDirectory, type MessagingDirectory } from "./policy.js";
import type { MessageAuditSink } from "./audit.js";
import type { MessagingLimits } from "./limits.js";

/**
 * The message service and its settings over the journal, as the composition root builds them. The directory defaults to
 * the journal's projects with no agents or groups (PV-G3 adds them), so until then no agent can be addressed.
 */
export interface MessagingBindingDeps {
  readonly journal: Pick<Journal, "messages" | "getProject">;
  readonly audit: MessageAuditSink;
  readonly noteWrite?: () => void;
  readonly random: { bytes(n: number): Uint8Array };
  readonly monotonic: () => number;
  readonly scan: (text: string) => Promise<readonly unknown[]>;
  readonly directory?: MessagingDirectory;
  readonly limits?: Partial<MessagingLimits>;
  /** The agent a live composer run acts for (PV-G4); default none, so nothing is delivered into runs yet. */
  readonly agentOf?: (runId: string) => string | undefined;
  /** True while a run is RUNNING (the journal's state); default: never. */
  readonly runLive?: (runId: string) => boolean;
  /** Bounds of one delivered block (defaults in `delivery.ts`). */
  readonly deliveryLimits?: { readonly maxMessages?: number; readonly maxText?: number };
  /** A delivery failure the pipeline swallows, as a fixed code (the host logs it). */
  readonly onInternalError?: (code: "notice_failed") => void;
}

export interface MessagingBinding {
  readonly service: MessageService;
  readonly settings: MessagingSettingsService;
  readonly delivery: MessageDelivery;
}

export function createMessagingBinding(deps: MessagingBindingDeps): MessagingBinding {
  const directory = deps.directory ?? journalDirectory(deps.journal);
  const store = deps.journal.messages;
  const common = { store, directory, audit: deps.audit, ...(deps.noteWrite === undefined ? {} : { noteWrite: deps.noteWrite }) };
  const service = createMessageService({ ...common, random: deps.random, monotonic: deps.monotonic, scan: deps.scan, ...(deps.limits === undefined ? {} : { limits: deps.limits }) });
  const delivery = createMessageDelivery({ ...common, service, random: deps.random, agentOf: deps.agentOf ?? (() => undefined), runLive: deps.runLive ?? (() => false), ...deps.deliveryLimits, ...(deps.onInternalError === undefined ? {} : { onInternalError: deps.onInternalError }) });
  return { service, settings: createMessagingSettings({ ...common, context: (id) => service.context(id) }), delivery };
}
