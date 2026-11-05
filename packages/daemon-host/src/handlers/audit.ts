// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import {
  auditListResponseSchema,
  auditStatusResponseSchema,
  auditVerifyResponseSchema,
  inspectMessage,
  MAX_AUDIT_LIST,
  type JsonValue,
} from "@axis/protocol";
import type { ChainHead } from "@axis/audit";
import type { AnchorGuard } from "../anchor/manager.js";
import type { AuditReader } from "../host.js";
import type { Clock } from "../ports/clock.js";
import type { DegradedReason } from "../storage/anchor-check.js";

/**
 * `axis.audit/1` (design sections 4.2, 5.4 and 5.5): status, list and verify. All three are reads served in every
 * mode, degraded included, from the frozen read facade: the handlers hold no writer.
 *
 * `status` evaluates the anchor state, which may append one `anchor.stalled` or `anchor.resumed` row (a transition,
 * audited once); nothing else here writes. `verify` uses the head this process put whose sequence the supervisor
 * acknowledged (the ack carries only a sequence), or else the anchor held at start.
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
  /** The monotonic clock: deadlines and the age of the verified-head cache. Never the wall clock. */
  readonly clock: Pick<Clock, "monotonic">;
  /** Events checked between two yields to the event loop (default 2000). */
  readonly sliceEvents?: number;
  /** A verification that runs longer than this ends with `E_TIMEOUT`, keeping its progress (default 25 s, under the 30 s contract timeout). */
  readonly deadlineMs?: number;
  /** A full re-scan from the first event happens at most this often; in between only new events are checked (default 10 min). */
  readonly fullRescanMs?: number;
  /** Largest `list` reply, in bytes of the bounded walk (default 900 000, under the 1 MiB message limit). */
  readonly maxReplyBytes?: number;
  /** Yields to the event loop between slices (default `setImmediate`). Tests replace it. */
  readonly yieldNow?: () => Promise<void>;
}

/** Events returned when `limit` is absent. */
export const DEFAULT_AUDIT_LIST = 100;
const UNAVAILABLE = "The audit log is unavailable.";

const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_BACKPRESSURE" | "E_TIMEOUT", message: string, details?: Record<string, JsonValue>): never => {
  throw new DaemonError(code, message, details);
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
function fitPrefix<E>(events: readonly E[], maxBytes: number): E[] {
  const fits = (n: number): boolean => inspectMessage({ events: events.slice(0, n) }, { maxBytes }).ok;
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
      const events = fitPrefix(rows, deps.maxReplyBytes ?? 900_000);
      if (events.length === 0 && rows.length > 0) return fail("E_INTERNAL", UNAVAILABLE);
      return checked(auditListResponseSchema.safeParse({ events }));
    });
  };

  // Verify (design 4.2: one at a time, bounded, cancellable). The scan runs in slices with a yield to the event loop
  // between them; the signal and the deadline are checked between slices. A second call while one runs is refused,
  // never queued. The verified head is cached: later calls check only the events after it, and a full re-scan from the
  // first event happens once per `fullRescanMs` or when the cached head is no longer on the chain. The cache is a
  // speed-up only: an edit at or before the cached head is found by the next full re-scan (and at the next start).
  const slice = deps.sliceEvents ?? 2000;
  const deadline = deps.deadlineMs ?? 25_000;
  const fullEvery = deps.fullRescanMs ?? 600_000;
  const yieldNow = deps.yieldNow ?? ((): Promise<void> => new Promise((resolve) => setImmediate(resolve)));
  let running = false;
  let cache: { head: ChainHead; fullAt: number } | undefined;

  const scan = async (context: HandlerContext): Promise<unknown> => {
    const started = deps.clock.monotonic();
    let anchor = read(() => deps.anchors.status().anchor);
    let fullAt = started;
    let from: ChainHead | undefined;
    if (cache !== undefined && started - cache.fullAt < fullEvery) ({ head: from, fullAt } = cache);
    let base = from?.seq ?? 0; // events before this call's first slice
    let done = 0; // events checked by this call's completed slices
    let restarted = from === undefined;
    for (;;) {
      if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
      if (deps.clock.monotonic() - started > deadline) return fail("E_TIMEOUT", "The verification took too long.", { retryAfterMs: 1000 });
      const r = read(() =>
        deps.audit.verify({ limit: slice, ...(from === undefined ? {} : { from }), ...(anchor === null ? {} : { expectedHead: anchor }) }),
      );
      if (!r.ok) {
        cache = undefined;
        // A failure at or before the cached head means the cache no longer matches the chain: start over once. Rows
        // are append-only, so a head this handler verified that has since vanished or changed is tampering: the full
        // scan is held to the HIGHER of the anchor and that head, and so reports a cut tail instead of an ok.
        if (!restarted && from !== undefined && r.firstBadSeq <= from.seq) {
          restarted = true;
          if (anchor === null || from.seq > anchor.seq) anchor = from;
          from = undefined;
          base = 0;
          done = 0;
          continue;
        }
        return checked(auditVerifyResponseSchema.safeParse({ ...r, checked: base + done + r.checked }));
      }
      if (r.head !== null) cache = { head: r.head, fullAt };
      if (r.more !== true) return checked(auditVerifyResponseSchema.safeParse({ ok: true, count: r.count, head: r.head }));
      done += slice;
      from = r.head as ChainHead;
      await yieldNow();
    }
  };

  const verify: Handler = (context) => {
    live(context);
    if (running) return fail("E_BACKPRESSURE", "A verification is already running.", { retryAfterMs: 1000 });
    running = true;
    return scan(context).finally(() => void (running = false));
  };

  return { status, list, verify };
}
