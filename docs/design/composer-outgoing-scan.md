# C7-F3: an outgoing secret scan that yields (design note, not built)

Status: proposal, not built. Builds on the windowed outgoing scan and its kept "no secret" verdicts (`bindings/provider-redactor.ts`, composer-runtime.md section 4.2, ticket C7-F3 in section 5; both arrive with the branches that fix the windowed scan and withhold declined calls).

## Problem

`guardProvider` (packages/providers/src/guard.ts, `preflight`) checks every string of every request with the synchronous
`Redactor.containsSecret(text): boolean` hook. Since the windowed scan, a long string costs about 4.6 reads of each
character through the host redactor (16,384-character windows, step 3,582). With the kept verdicts only NEW long strings
are scanned per request, but one reply can still bring about 3 MiB of new text (2 MiB of tool inputs, 1 MiB of results,
model text): about 1.3 s of prose, about 4.4 s of adversarial base64 (review secret-scan-windows r1 N5), all of it on the
daemon's one event loop. While it runs, approvals, other runs' events, the control channel and anchors stall.

## Proposal

1. **Interface (providers, additive).** `Redactor` (packages/providers/src/redaction.ts) gains an OPTIONAL method:
   `containsSecretAsync?(text: string, signal: AbortSignal): Promise<boolean>`. Same contract as `containsSecret`
   (true when the text holds a secret; never false for a text it could not judge). `preflight` is already async: it calls
   `containsSecretAsync` when the hook has it, else `containsSecret` (adapters and tests without it are unchanged). A
   rejected promise or an aborted signal refuses the request (`cancelled` when aborted, else `secret_in_request`: fail
   closed). Every other use of `containsSecret` (error reasons in errors.ts, the model id) stays synchronous: those strings
   are short (<= 16,384, one window).
2. **Host hook (daemon-host).** `providerRedactor` implements `containsSecretAsync` over the same windows and the same kept
   verdicts: it yields to the event loop (`setImmediate`) after every `YIELD_WINDOWS` windows (proposed 8, about 128 K
   characters of redactor work, tens of ms) and checks `signal` at each yield. Short strings take the synchronous path.
3. **Kept verdicts under interleaving.** With awaits between the lookup, the scan and the insert, two requests can scan
   the same string at once: duplicate work, never a wrong verdict. The registered-forms count is read BEFORE the scan
   starts and stored with the verdict; a key registered mid-scan leaves the verdict stale at once (count mismatch), so it is
   judged again next time. A scan that ends early (secret, abort, error, budget) never stores a "no secret" verdict, and a
   verdict whose count no longer matches is never used. The LRU bound and the whole-string SHA-256 key are unchanged.
4. **Budget (fail closed).** A per-request bound on characters scanned fresh (e.g. 16 MiB). Past it the request is REFUSED
   (`secret_in_request` with the closed reason `scan_budget`), never treated as clean, and nothing scanned in that request is
   kept as a verdict beyond what was fully judged before the bound. The per-reply caps already bound fresh text to about
   3 MiB; the budget is a backstop against a future cap change.

## Tests (mutation-proof, no wall clock)

- The guard prefers the async hook (a sync hook that throws is never called when the async one exists).
- A 4 MiB scan yields: a `setImmediate` callback queued before the scan runs before it ends (counted, not timed), and an
  abort mid-scan ends it `cancelled` with no verdict stored.
- A key registered while a scan is suspended makes its verdict stale (the next call scans again and finds the key).
- An aborted scan and a scan stopped by the budget keep no "no secret" verdict: the same string is scanned again in full
  on the next call, and the budget refusal is a refusal (the request never reaches the adapter).
- Two concurrent scans of the same string: both false, both scanned, one verdict kept.
- All existing provider-redactor tests run against both the sync and async paths.

## Out of scope

Moving the scan to a worker thread (the redactor holds registered literals; copying them out widens where keys live).
