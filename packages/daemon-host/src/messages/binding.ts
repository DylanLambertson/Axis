// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import type { Journal } from "@axis/journal";
import type { Logger } from "../log/logger.js";
import { createMessageDelivery, type MessageDelivery } from "./delivery.js";
import { createMessageService, type MessageService } from "./service.js";
import { createMessagingSettings, type MessagingSettingsService } from "./settings.js";
import { journalDirectory, type MessagingDirectory } from "./policy.js";
import type { MessageAuditSink } from "./audit.js";
import type { MessagingLimits } from "./limits.js";
import type { ComposerMessagingDeps } from "./participation.js";

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
  /** The host redactor's check (a secret), for deliveries: required, so a host that leaves it out does not build. */
  readonly holdsSecret: (text: string) => boolean;
}

export interface MessagingBinding {
  readonly service: MessageService;
  readonly settings: MessagingSettingsService;
  readonly delivery: MessageDelivery;
  /** What a composer run's `send_message` and `read_messages` need (PV-M4), for `AgentBindingDeps.messaging`. */
  readonly participation: Omit<ComposerMessagingDeps, "holdsSecret">;
}

export function createMessagingBinding(deps: MessagingBindingDeps): MessagingBinding {
  const directory = deps.directory ?? journalDirectory(deps.journal);
  const store = deps.journal.messages;
  const common = { store, directory, audit: deps.audit, ...(deps.noteWrite === undefined ? {} : { noteWrite: deps.noteWrite }) };
  const service = createMessageService({ ...common, random: deps.random, monotonic: deps.monotonic, scan: deps.scan, ...(deps.limits === undefined ? {} : { limits: deps.limits }) });
  const delivery = createMessageDelivery({ ...common, service, random: deps.random, agentOf: deps.agentOf ?? (() => undefined), runLive: deps.runLive ?? (() => false), ...deps.deliveryLimits, ...(deps.onInternalError === undefined ? {} : { onInternalError: deps.onInternalError }), holdsSecret: deps.holdsSecret });
  // Inert until PV-G4: the same `agentOf` as the delivery (default none), so no run is offered the tools.
  const participation = { service, directory, random: deps.random, agentOf: deps.agentOf ?? (() => undefined) };
  return { service, settings: createMessagingSettings({ ...common, context: (id) => service.context(id) }), delivery, participation };
}

/** What the composition root has for messaging; `logger` is required (possibly undefined), so it cannot be left out. */
export interface HostMessaging {
  readonly journal: Pick<Journal, "messages" | "getProject" | "getRun">;
  readonly audit: MessageAuditSink;
  readonly monotonic: () => number;
  readonly scan: (text: string) => Promise<readonly unknown[]>;
  readonly logger: Pick<Logger, "warn"> | undefined;
  readonly holdsSecret: (text: string) => boolean;
}

/** The binding's dependencies in the host: the daemon's CSPRNG, live runs from the journal, swallowed failures logged by code. */
export function hostMessagingDeps(host: HostMessaging): MessagingBindingDeps {
  const { journal, logger } = host;
  return {
    journal,
    audit: host.audit,
    random: { bytes: (n) => randomBytes(n) },
    monotonic: host.monotonic,
    scan: host.scan,
    holdsSecret: host.holdsSecret,
    runLive: (id) => journal.getRun(id)?.state === "RUNNING",
    onInternalError: (code) => logger?.warn("request.failed", { reason: `delivery_${code}` }),
  };
}
