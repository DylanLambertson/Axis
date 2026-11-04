// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DMN-5, DMN-6: tool decisions and results go to an injected sink, redacted first, and a failed write stops the call.
import { Redactor, type AuditActor, type AuditOutcome, type AuditSink } from "@axis/audit";
import { BrokerError } from "./errors.js";

export const BROKER_ACTIONS = { decision: "broker.decision", result: "broker.result" } as const;

/**
 * Payload keys for `AuditLog`'s `payloadAllowlist` option. Everything else in a broker event is dropped by the log
 * (ADR 0003 D5). Paths appear only as worktree-relative text; output only as a length and a hash.
 */
export const BROKER_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "broker.decision": ["tool", "tier", "decision", "reason", "reasons", "digest", "paths", "approvedBy", "approvalId", "expiresAt", "protected"],
  "broker.result": ["tool", "digest", "ok", "code", "durationMs", "effects", "bytesRead", "bytesWritten", "endedBy", "exitCode", "outputBytes", "outputSha256"],
};

export interface AuditRecord {
  readonly actor: AuditActor;
  readonly action: (typeof BROKER_ACTIONS)[keyof typeof BROKER_ACTIONS];
  readonly target: string;
  readonly outcome: AuditOutcome;
  readonly payload: Record<string, string | number | boolean | null>;
}

export class BrokerAudit {
  readonly #sink: AuditSink;
  readonly #redactor: Redactor;
  constructor(sink: AuditSink, redactor: Redactor = new Redactor()) {
    this.#sink = sink;
    this.#redactor = redactor;
  }

  /** Redacts, then appends. Throws E_INTERNAL when the sink fails or answers asynchronously (a promise is a failed write). */
  record(r: AuditRecord): void {
    try {
      const out: unknown = this.#sink.append({
        actor: r.actor,
        action: r.action,
        target: this.#redactor.redactString(r.target),
        outcome: r.outcome,
        payload: this.#redactor.redactValue(r.payload),
      });
      if (typeof (out as { then?: unknown } | null)?.then === "function") {
        (out as Promise<unknown>).then(undefined, () => undefined);
        throw new Error("async sink");
      }
    } catch {
      throw new BrokerError("E_INTERNAL", "audit-failed", "the audit event could not be written");
    }
  }
}
