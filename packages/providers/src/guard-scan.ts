// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError } from "./errors.js";
import { SCAN_BUDGET_CHARS, stringsIn, type Redactor, type ScanContext } from "./redaction.js";
import type { ValidRequest } from "./validate.js";

/**
 * Characters of request strings the guard scans between two yields to the event loop (review c7-f3-impl r1 SF-2): a request
 * of many strings of one window each (which a hook judges in one step and keeps no verdict for) would otherwise hold the loop
 * for its whole scan. Eight windows of the host redactor, as the host hook yields inside one long string.
 */
export const YIELD_CHARS = 8 * 16_384;

/**
 * The outgoing secret scan of one request (C7-F3). One `ScanContext` (the request's signal and `SCAN_BUDGET_CHARS`) is shared
 * by every string and every pass of the request (`RequestScan`). The object scanned with is probed for `containsSecretAsync` (a snapshot carries its own);
 * without it each string takes `containsSecret`.
 *
 * - **One secret set per request** (review c7-f3-impl r1 SF-1). The hook's `secretsVersion` is read before the first string
 *   and again after the last one, with no `await` between that read and the return: when it moved (a key registered during
 *   the scan), strings already judged clean were judged under the older set, so the WHOLE request is scanned once more under
 *   the new one; a second change is refused `scan_budget`, never answered clean.
 * - **Yields** every `YIELD_CHARS` characters of strings scanned, whatever their length, and checks the signal after each.
 * - **Errors are built fresh**, never forwarded (review c7-f3-design r2 N1): a signal aborted by the time the hook settles ends
 *   `cancelled`, whatever the hook threw; a hook's own `scan_budget` or `cancelled` keeps its code (a budget stop is never
 *   `secret_in_request` and never clean); any other rejection, and any answer other than `false`, is `secret_in_request`.
 *   A hook that never settles does not hold the request past a cancel: each call is raced against the signal.
 */
export async function scanRequest(rs: RequestScan, valid: ValidRequest): Promise<void> {
  const { scanner, scan } = rs;
  let start = versionOf(scanner);
  for (let pass = 0; ; pass++) {
    await scanOnce(scanner, valid, scan);
    if (scan.signal.aborted) throw new ProviderError("cancelled");
    const now = versionOf(scanner);
    if (now === start) {
      rs.version = now;
      return;
    }
    if (pass === 1) throw new ProviderError("scan_budget");
    start = now;
  }
}

/**
 * One request's scan state: the object scanned with, ONE `ScanContext` (one budget for every pass of the request, review
 * c7-f3-impl r2 N2), and the secrets version the last complete scan ended under.
 */
export interface RequestScan {
  readonly scanner: Redactor;
  readonly scan: ScanContext;
  version: unknown;
}

export function requestScan(scanner: Redactor, signal: AbortSignal): RequestScan {
  return { scanner, scan: { signal, budget: { remaining: SCAN_BUDGET_CHARS } }, version: undefined };
}

const versionOf = (scanner: Redactor): unknown => scanner.secretsVersion?.();

/**
 * After the guard's later awaits (capabilities, the run budget), before the request is sent (review c7-f3-impl r2): a key
 * registered since the scan ended means the request was judged under an older set, so it is scanned again (same budget). The
 * guard calls this after its last `await` before the adapter call, so only microtasks lie between it and the send.
 */
export async function rescanIfMoved(rs: RequestScan, valid: ValidRequest): Promise<void> {
  if (versionOf(rs.scanner) !== rs.version) await scanRequest(rs, valid);
}

async function scanOnce(scanner: Redactor, valid: ValidRequest, scan: ScanContext): Promise<void> {
  const { signal } = scan;
  const async = typeof scanner.containsSecretAsync === "function" ? scanner.containsSecretAsync.bind(scanner) : undefined;
  let sinceYield = 0;
  for (const s of stringsIn(valid)) {
    if (async === undefined) {
      if (scanner.containsSecret(s)) throw new ProviderError("secret_in_request");
    } else {
      let found: unknown;
      try {
        found = await raced(async(s, scan), signal);
      } catch (e) {
        if (signal.aborted) throw new ProviderError("cancelled");
        const code = e instanceof ProviderError ? e.code : undefined;
        if (code === "scan_budget" || code === "cancelled") throw new ProviderError(code);
        throw new ProviderError("secret_in_request");
      }
      if (found !== false) throw new ProviderError("secret_in_request");
    }
    sinceYield += s.length;
    if (sinceYield >= YIELD_CHARS) {
      sinceYield = 0;
      await new Promise<void>((res) => setImmediate(res));
      if (signal.aborted) throw new ProviderError("cancelled");
    }
  }
}

/**
 * `p`, or a rejection as soon as `signal` aborts (the listener is removed once either settles). `p` is always handled, so a
 * hook that rejects after the cancel won is not an unhandled rejection.
 */
function raced<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ProviderError("cancelled"));
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
