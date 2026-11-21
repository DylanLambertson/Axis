# C7-F3: an outgoing secret scan that yields (design note, built)

Status: built on `feat/async-secret-scan`, on top of the windowed outgoing scan and its kept "no secret" verdicts
(`packages/daemon-host/src/bindings/provider-redactor.ts`, #509; composer-runtime.md section 4.2). What the build changed from
the proposal below (review c7-f3-design r2 nits):

- **N1, fresh errors.** `preflight`'s scan (`scanRequest` in guard.ts) never forwards the hook's error object: it checks
  `signal.aborted` first (any rejection after an abort ends `cancelled`), then builds a NEW `ProviderError` for the hook's
  `scan_budget` or `cancelled` code, and `secret_in_request` for anything else. The signal is checked again after the last
  string, so a hook that answers clean after an abort still ends `cancelled`.
- **N2, budget and wording.** `SCAN_BUDGET_CHARS` is 192 Mi characters, not 64 M: a run's history at its caps (about 14 M
  characters with 24 turns of model text) read at the window factor plus two windows of rounding per long string, TWICE (a
  key registered during a scan costs one more scan). A host test derives that minimum from the caps. The fixed text is "The
  request could not be checked for credentials and was not sent." (it also covers the second-registration refusal).
- **N3.** `count_tokens` goes through `preflight`, so the same scan and refusals apply (tested).
- **Tests.** The existing synchronous tests stay; the asynchronous path has its own file
  (`test/provider-redactor-async.test.ts`) with an equivalence test over a corpus of the synchronous cases, instead of
  running every synchronous test twice.

## Problem

`guardProvider` (packages/providers/src/guard.ts, `preflight`) checks every string of every request with the synchronous
`Redactor.containsSecret(text): boolean` hook. A long string costs about 4.6 reads of each character through the host
redactor (16,384-character windows, step 3,582). With the kept verdicts only NEW long strings are scanned per request, but
one reply can bring about 3 MiB of new text (2 MiB of tool inputs and 1 MiB of results by the per-reply caps, plus model
text), and right after a key is registered every kept verdict is stale and a request scans its run's whole history (about
12.5 MiB at today's per-run caps). Review secret-scan-windows r1 N5 measured about 1.3 s for 3 MiB of prose and about
4.4 s for adversarial base64 on a loaded host (not re-measured for this note). All of it runs on the daemon's one event
loop: approvals, other runs' events, the control channel and anchors stall meanwhile.

## Proposal

1. **Interface (providers, additive).** `Redactor` (packages/providers/src/redaction.ts) gains an OPTIONAL method:
   `containsSecretAsync?(text: string, scan: ScanContext): Promise<boolean>` with
   `ScanContext = { readonly signal: AbortSignal; readonly budget: { remaining: number } }`. Same answer contract as
   `containsSecret` (true when the text holds a secret; never false for a text it could not judge). Adapters and test
   doubles without it are unchanged. Every other use of `containsSecret` (error reasons in errors.ts, the model id) stays
   synchronous: those strings are short (one window).
2. **Who carries the budget (review c7-f3-design r1 B1).** The GUARD owns it: `preflight` creates one `ScanContext` per
   request with `budget.remaining = SCAN_BUDGET_CHARS` and passes the same object for every string of that request. The
   HOOK charges it: before it scans a window it subtracts the window's length (only windows actually scanned are charged:
   a kept verdict costs nothing, which is how "fresh" is defined), and when the remaining budget would go below zero it
   throws `new ProviderError("scan_budget")` without scanning that window. On abort it throws `new ProviderError("cancelled")`.
   `preflight` awaits the hook inside a catch that RETHROWS a `ProviderError` whose code is `scan_budget` or `cancelled`
   UNCHANGED, and turns any other rejection into `secret_in_request` (fail closed). A budget stop can therefore never be
   reported as `secret_in_request`, and never as clean.
3. **Budget size.** `SCAN_BUDGET_CHARS` must be at least the characters of a whole run history at the per-run caps scanned
   at the window factor (a request right after a key registration scans everything again): with today's caps, 12.5 MiB of
   text times 4.6 is about 60 M characters of window reads; proposed 64 M, with a test that derives the minimum from the cap
   constants and the window step, so tightening a cap cannot silently fail every live run after a key rotation.
4. **What the user and the logs see (D1, S5).** `scan_budget` joins `PROVIDER_ERROR_CODES` and the per-code table in
   errors.ts with a fixed text ("The request was too large to check for credentials and was not sent."), is added to
   `GUARD_ONLY` in guard-billing.ts (an adapter cannot raise it; a test fails if it is removed), and reaches the run as
   `PROVIDER_SCAN_BUDGET` through the loop's existing `PROVIDER_${code}` mapping (loop.ts). The thrown error has no `cause`
   and no message beyond the fixed text; the log line carries the code only (no length, no content). No protocol change:
   the run reason is already a closed upper-case code.
5. **The host hook.** `providerRedactor` implements `containsSecretAsync` over the same windows and kept verdicts, yielding
   to the event loop (`setImmediate`) after every `YIELD_WINDOWS` windows (proposed 8). Strings of one window take the
   synchronous path and are not charged. Its steps, with the RULES on which steps are synchronous (review r1 B2):
   - **Block A, one synchronous block:** abort check (an already-aborted signal throws `cancelled` before any work); the
     well-formedness check (not well-formed: true); the SHA-256 of the whole string; read the registered-forms count `c0`;
     look the verdict up; on a hit whose stored count equals `c0`, refresh it in the LRU (delete and set) and return false.
     No `await` anywhere in this block.
   - **Scan:** for each window, charge the budget, scan, and every `YIELD_WINDOWS` windows `await` a `setImmediate` and
     check the signal again (abort: throw `cancelled`). A window with a change returns true at once (nothing is stored).
   - **Block B, one synchronous block, after the last window:** check the signal again (abort: `cancelled`, nothing stored);
     re-read the count `c1`; if `c1 === c0`, store the verdict under `c0` (delete, set, evict the oldest past the bound) and
     return false. No `await` between the re-read, the compare and the insert.
   - **One restart (D2, S3):** if `c1 !== c0` a key was registered during the scan, so the windows scanned before it used an
     older set. The hook scans the string once more from Block A with `c0 := c1` (charged to the same budget, abort checked
     again). If the count changes again during that second scan, it throws `scan_budget` (refused; never answered clean).
   - Why storing the START count is safe: a verdict stored under `c0` is used only while the count is still `c0`, and the
     scan that produced it read every window under that exact set (Block B proved no registration happened in between).
     Two concurrent scans of the same string only duplicate work; each stores the verdict of a complete scan under its own
     start count.
6. **Which object is probed (D3, S4).** The guard scans with `redactor.snapshot?.() ?? redactor` and probes THAT object for
   `containsSecretAsync`. A snapshot holds a fixed set of needles, so a snapshot scanner has no restart (its count cannot
   change); a `snapshot()` implementation whose hook has the async method must carry it too. The host hook has no
   `snapshot` today, so this is a contract for future hooks, with a test hook that has both.
7. **The guard's invariant (D4).** guard.ts documents "the secret scan over that snapshot, before any `await`". Awaiting
   inside the scan is safe because the request it scans is a fresh validated clone that nothing else holds; that comment,
   and any guard test that relies on the scan ending before the first `await`, change with it. `preflight` re-checks
   `signal.aborted` after the scan loop returns (an abort between the last check and the return still ends `cancelled`).
8. **Egress (S6).** No new network use, file use or timer other than `setImmediate`; `test/packages/egress*.test.mjs` are
   unaffected (their lint refuses `fetch`, `WebSocket` and `EventSource` outside the providers binding, not `setImmediate`).

## Blast radius (S1)

- `@axis/providers`: `Redactor` and `ScanContext` (redaction.ts, additive); `preflight` (guard.ts: the catch and rethrow
  rule, the post-scan abort check, the invariant comment); `PROVIDER_ERROR_CODES` and the per-code table (errors.ts);
  `GUARD_ONLY` (guard-billing.ts); the providers contract suite.
- `@axis/daemon-host`: the host hook and its tests (provider-redactor.ts); the mock's guard shares the hook (agent.ts); the
  run reason `PROVIDER_SCAN_BUDGET` arrives through loop.ts without a code change.
- Unchanged and still synchronous per request: the well-formedness check and SHA-256 of every long string (about 33 ms per
  12 MiB when every verdict is kept).

## Tests (mutation-proof, no wall clock)

- The guard prefers the async hook (a sync method that throws is never called when the async one exists), on the object it
  scans with (a hook with both `snapshot` and the async method is scanned asynchronously).
- A 4 MiB scan yields: a `setImmediate` callback queued before the scan runs before it ends (counted, not timed).
- Aborts: a signal aborted before the scan, between windows, and after the last window each end the request `cancelled`
  and keep no verdict; the same string is scanned in full on the next call.
- Budget: a request past the budget is refused `scan_budget` (not `secret_in_request`, never clean) and reaches the run as
  `PROVIDER_SCAN_BUDGET`; kept verdicts cost nothing; the minimum budget is derived from the run caps; `scan_budget` is in
  `GUARD_ONLY`; the error has no `cause` and its text is the fixed one.
- Restart: a key registered between two windows is found in the same request; a second registration during the restart is
  refused `scan_budget`.
- Two concurrent scans of one string: both false, both scanned, one verdict kept.
- All existing provider-redactor tests run against both the synchronous and the asynchronous paths.

## Mutants the tests must kill (S7)

| # | Mutant | Killed by |
|---|---|---|
| 1 | no yield between windows | the queued-callback test |
| 2 | signal not checked at a yield | abort between windows |
| 3 | signal not checked in Block B | abort after the last window |
| 4 | count read after the scan instead of before | key registered mid-scan |
| 5 | verdict stored on abort | abort, then the next call's window count |
| 6 | verdict stored on a budget stop | budget stop, then the next call's window count |
| 7 | budget stop answered clean (false) | budget refusal test |
| 8 | `scan_budget` remapped to `secret_in_request` by preflight | budget refusal test (reason) |
| 9 | budget below the run-caps minimum | the derived-minimum test |
| 10 | restart dropped (answer under the old set) | key registered mid-scan |
| 11 | a second change during the restart answered clean | double registration test |
| 12 | the live redactor probed instead of the snapshot | the snapshot-hook test |
| 13 | well-formedness check skipped on the async path | lone surrogate on both paths |
| 14 | `scan_budget` removed from `GUARD_ONLY` | the GUARD_ONLY test |

## Out of scope

Moving the scan to a worker thread (the redactor holds registered literals; copying them out widens where keys live). The
response-side checks stay synchronous: the providers binding's `holdsRegisteredSecret` over streamed text and tool inputs
(windows of `MAX_KEY_FORM_CHARS`) and the withheld stream text; they read at most one reply.
