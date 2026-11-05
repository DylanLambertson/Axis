// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditEventInput } from "@axis/audit";
import type { ReviewAckEvent, ReviewAuditSink } from "./review.js";

/**
 * The payload key of the acknowledgement row. Without an allow-list entry the audit log keeps only a length and a hash
 * of the payload, so the host adds this to the `AuditLog` options (`host.ts`). Only the file id: no path, no content id.
 */
export const REVIEW_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "review.acknowledge": Object.freeze(["fileId"]),
});

/** The part of `AuditLog` the sink needs. `append` is synchronous and throws when the write fails. */
export interface ReviewAuditWriter {
  append(event: AuditEventInput): unknown;
}

/** The acknowledgement sink over the host's audit log: one row per event, target `workspace:<id>`, payload `{ fileId }`. */
export function createReviewAuditSink(writer: ReviewAuditWriter): ReviewAuditSink {
  return {
    append(event: ReviewAckEvent): void {
      const result = writer.append({ actor: event.actor, action: event.action, target: `workspace:${event.workspaceId}`, outcome: "success", payload: { fileId: event.fileId } });
      // A promise would mean the write is not done when the tree is released: refuse it like the challenge sink does.
      if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") throw new Error("the audit sink must be synchronous");
    },
  };
}
