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
4. **Budget (fail closed).** A per-request bound on characters scanned fresh. Past it the request is REFUSED, never treated
   as clean, and nothing scanned in that request is kept as a verdict beyond what was fully judged before the bound. Sizing
   (review secret-scan-windows r2 D1): the fresh text of one request is normally only its new strings, but right after a key
   is registered every kept verdict is stale and the request scans the run's WHOLE history (inputs 8 MiB, results 4 MiB,
   model texts and the prompt: about 12.5 MiB at today's caps). The budget must therefore be at least the per-run caps
   (proposed 16 MiB, with a test that derives the minimum from the cap constants), or tightening it would fail every live run
   right after a key rotation. What the user sees: the run ends with its own closed reason, `PROVIDER_SCAN_BUDGET`, not
   `PROVIDER_SECRET_IN_REQUEST` (there is no secret); `scan_budget` joins the closed reason set of `@axis/providers`
   (errors.ts), and no value of the request is echoed.
5. **A key registered during the scan (D2).** Windows scanned before a `registerSecret` used the older set, so the current
   request could leave holding the new key in an early window. Today's synchronous order has the same property (the key is
   registered in the adapter's `apiKey`, after the scan), so this is not a regression, but the async check closes it: it
   reads `registeredForms` before and after the scan and, when the count changed, scans the string again under the new set
   before answering (and stores only that verdict).
6. **Which object is probed (D3).** The guard scans with `redactor.snapshot?.() ?? redactor`, and `snapshot()` returns a plain
   `Redactor` without the new method, so a hook with a snapshot would silently stay synchronous. The guard probes the object
   it scans with (the snapshot when there is one), and a `snapshot()` implementation must carry `containsSecretAsync` when its
   hook has it. Test: a hook with both `snapshot` and the async method is scanned asynchronously.
7. **The guard's invariant and the blast radius (D4).** guard.ts documents "the secret scan over that snapshot, before any
   `await`". Awaiting inside the scan is safe because the request it scans is a fresh validated clone that nothing else
   holds, but that comment, and any guard test that relies on the scan ending before the first `await`, change with it.
   Touched: the `Redactor` interface of `@axis/providers` (redaction.ts, additive), `preflight` (guard.ts), the providers'
   contract suite, the closed reason set (errors.ts), the daemon-host hook and its tests; the mock's guard shares the hook.
   The well-formedness check and the SHA-256 of every long string stay synchronous per request (about 33 ms per 12 MiB when
   every verdict is kept): acceptable, and stated.

## Tests (mutation-proof, no wall clock)

- The guard prefers the async hook (a sync hook that throws is never called when the async one exists).
- A 4 MiB scan yields: a `setImmediate` callback queued before the scan runs before it ends (counted, not timed), and an
  abort mid-scan ends it `cancelled` with no verdict stored.
- A key registered while a scan is suspended makes its verdict stale (the next call scans again and finds the key).
- A key registered between two windows of a suspended scan is found in the same request (the scan runs again under the
  new set), and the verdict kept is the second one.
- A budget refusal ends the run `PROVIDER_SCAN_BUDGET`; the minimum budget is derived from the run caps in the test.
- An aborted scan and a scan stopped by the budget keep no "no secret" verdict: the same string is scanned again in full
  on the next call, and the budget refusal is a refusal (the request never reaches the adapter).
- Two concurrent scans of the same string: both false, both scanned, one verdict kept.
- All existing provider-redactor tests run against both the sync and async paths.

## Out of scope

Moving the scan to a worker thread (the redactor holds registered literals; copying them out widens where keys live).
