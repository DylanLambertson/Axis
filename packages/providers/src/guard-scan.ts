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
 * by every string of the request. The object scanned with is probed for `containsSecretAsync` (a snapshot carries its own);
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
export async function scanRequest(scanner: Redactor, valid: ValidRequest, signal: AbortSignal): Promise<void> {
  const scan: ScanContext = { signal, budget: { remaining: SCAN_BUDGET_CHARS } };
  const version = (): unknown => scanner.secretsVersion?.();
  let start = version();
  for (let pass = 0; ; pass++) {
    await scanOnce(scanner, valid, scan);
    if (signal.aborted) throw new ProviderError("cancelled");
    const now = version();
    if (now === start) return;
    if (pass === 1) throw new ProviderError("scan_budget");
    start = now;
  }
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
