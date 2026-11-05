// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import {
  auditListResponseSchema,
  auditStatusResponseSchema,
  auditVerifyResponseSchema,
  inspectMessage,
  MAX_AUDIT_LIST,
} from "@axis/protocol";
import type { AnchorGuard } from "../anchor/manager.js";
import type { AuditReader } from "../host.js";
import type { DegradedReason } from "../storage/anchor-check.js";

/**
 * `axis.audit/1` (design sections 4.2, 5.4 and 5.5): status, list and verify. All three are reads served in every
 * mode, degraded included, from the frozen read facade: no writer is reachable from here.
 *
 * Like every handler it validates nothing the daemon already validated (strict request schemas, design section 4.3),
 * and it checks its own answer against the protocol schema, so a result that fails the contract is an internal
 * error, never a partial answer. Every error is a `DaemonError` with a fixed message: nothing from the request, the
 * database or a caught error reaches the wire, and the status carries no path.
 */
export interface AuditHandlerDeps {
  readonly audit: AuditReader;
  readonly anchors: Pick<AnchorGuard, "status">;
  /** The reason the host started degraded, or `undefined`. */
  readonly degraded: () => DegradedReason | undefined;
}

/** Events returned when `limit` is absent. */
export const DEFAULT_AUDIT_LIST = 100;
const UNAVAILABLE = "The audit log is unavailable.";

const fail = (code: "E_CANCELLED" | "E_INTERNAL", message: string): never => {
  throw new DaemonError(code, message);
};
const live = (c: HandlerContext): void => {
  if (c.signal.aborted) fail("E_CANCELLED", "The request was cancelled.");
};

/** Run a read and answer from the closed set only: whatever it throws is `E_INTERNAL` with a fixed text. */
function read<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DaemonError) throw e;
    return fail("E_INTERNAL", UNAVAILABLE);
  }
}

function checked<T>(parsed: { success: true; data: T } | { success: false }): T {
  return parsed.success ? parsed.data : fail("E_INTERNAL", UNAVAILABLE);
}

/** The most events that fit one message: the longest prefix the bounded walk accepts (monotone, so a binary search). */
function fitPrefix<E>(events: readonly E[]): E[] {
  const fits = (n: number): boolean => inspectMessage({ events: events.slice(0, n) }, { maxBytes: 900_000 }).ok;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return events.slice(0, lo);
}

export function createAuditHandlers(deps: AuditHandlerDeps): { readonly status: Handler; readonly list: Handler; readonly verify: Handler } {
  const status: Handler = (context) => {
    live(context);
    return read(() => {
      const s = deps.anchors.status();
      const reason = deps.degraded();
      return checked(
        auditStatusResponseSchema.safeParse({
          head: s.head ?? null,
          anchor: s.anchor,
          lag: s.lag,
          oldestUnackedAgeMs: s.oldestUnackedAgeMs,
          stalled: s.stalled,
          degraded: reason === undefined ? null : { reason },
        }),
      );
    });
  };

  const list: Handler = (context, payload) => {
    live(context);
    const request = payload as { afterSeq?: number; limit?: number };
    return read(() => {
      const limit = Math.min(request.limit ?? DEFAULT_AUDIT_LIST, MAX_AUDIT_LIST);
      const rows = deps.audit.list({ afterSeq: request.afterSeq ?? 0, limit });
      const events = fitPrefix(rows);
      if (events.length === 0 && rows.length > 0) return fail("E_INTERNAL", UNAVAILABLE);
      return checked(auditListResponseSchema.safeParse({ events }));
    });
  };

  // The scan is synchronous (the audit log has no incremental form with an upper bound), so two calls cannot overlap.
  const verify: Handler = (context) => {
    live(context);
    return read(() => {
      const anchor = deps.anchors.status().anchor;
      const result = deps.audit.verify(anchor === null ? {} : { expectedHead: anchor });
      return checked(auditVerifyResponseSchema.safeParse(result));
    });
  };

  return { status, list, verify };
}
