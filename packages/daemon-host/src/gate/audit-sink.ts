// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ChallengeAuditEvent, ChallengeAuditSink } from "@axis/challenge";
import { AxisError } from "@axis/audit";

/** The part of `AuditLog` the challenge sink needs. `append` is synchronous and throws when the write fails. */
export interface SyncAuditWriter {
  append(event: ChallengeAuditEvent): unknown;
}

/**
 * The challenge manager's audit sink (design section 5.2): a direct, synchronous adapter over `AuditLog.append`. The
 * manager writes the event before it changes a challenge's state, so a throw here stops the change (fail closed). A
 * writer that answers with a promise is refused at once: the manager treats a promise as a failed write, so letting
 * one through would turn every `issue` into a refusal, and swallowing it would turn a failed write into a success.
 * The error is fixed text; whatever the writer threw is not carried.
 */
export function createChallengeAuditSink(writer: SyncAuditWriter): ChallengeAuditSink {
  return {
    append(event: ChallengeAuditEvent): void {
      let result: unknown;
      try {
        result = writer.append(event);
      } catch {
        throw new AxisError("E_INTERNAL", "The audit write failed", { reason: "audit_write_failed" });
      }
      if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
        throw new AxisError("E_INTERNAL", "The audit sink must be synchronous", { reason: "audit_sink_async" });
      }
    },
  };
}
