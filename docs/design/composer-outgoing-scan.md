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
- **Implementation review r1.**
  - SF-1: the restart is per REQUEST, not per string. The hook exposes `secretsVersion` (its registered-forms count) and keeps
    no verdict for a scan a registration crossed. The guard (`guard-scan.ts`) reads the version before the first string and
    after the last (no `await` in between that read and the return), scans the whole request once more when it moved, and
    refuses `scan_budget` on a second change. A key registered while a later string was scanned is found in a string judged
    before it (tested end to end with the real hook: nothing sent).
  - SF-2: the guard yields every `YIELD_CHARS` (131,072) characters of strings it scans, whatever their length, with or
    without the asynchronous method; one-window strings still keep no verdict (memory: the verdicts are for long strings),
    so their cost is unchanged but spread over loop turns. A test bounds the characters read in one loop turn.
  - N1: each hook call is raced against the signal, so a hook that never settles cannot hold a cancelled request.
  - N2: the composition refuses tool caps or a turn count whose history a request could not scan within the budget
    (`assertScanBudgetFits`, the same derivation as the test).
  - Cost, for the record (measured by the reviewer on one loaded host): about 2.8 s for 14 M characters of prose and 11 s of
    random base64 per full pass, at most about 40-77 ms between loop turns; the full budget is reached only with a
    registration per pass.
- **Implementation review r2.**
  - SF-1 (a test): a kept verdict is used only under the count it was kept with; a text kept clean before a key existed is
    judged again once the key is registered, and the same history sent again is refused (nothing sent).
  - After the scan: a key registered while the guard awaits `capabilities` or the run budget's `beforeRequest` was not
    checked (pre-existing: the same awaits followed the synchronous scan). Closed: the guard keeps one `RequestScan` per request
    (the object scanned with, one `ScanContext`, the version the last complete scan ended under) and calls `rescanIfMoved`
    after `capabilities` and again after the budget, its last `await` before the adapter call: a moved version scans the
    request again under the same budget. Between that check and the adapter call there are only microtasks.
  - **Residual (review c7-f3-impl r3), closed by C7-F4 below.** In production a provider key is registered with the host
    redactor in exactly one place (the host's attestation key is registered at start, `daemon-host/src/secrets.ts`; it is
    not a provider key): the providers binding's key read (`daemon-host/src/bindings/providers.ts`, the
    `registerSecret` after the vault read), which the Anthropic adapter calls INSIDE its send (`anthropic/src/adapter.ts`,
    the request function: `await getKey(...)`, then `fetch`), after every guard check. A request whose content holds a key
    the redactor does not know yet is therefore sent with it when that key is first read at the send. That happens when the
    key is new to this daemon process: after a daemon start before the first request on the connection, or after the key
    was rotated in the vault while the old one stays registered (the new value reaches the redactor only in the send that
    first reads it). What is sent: the whole request body, to that connection's own provider origin (the key's own provider),
    in the run that holds the key in its history (pasted by the user, read from a file, or printed by a command). The next
    request of the run is refused `secret_in_request` (the key is registered by then). The order is the same as before
    C7-F3 (the synchronous scan also ran before the adapter's vault read); narrow, but it contradicts "nothing goes out
    holding a stored credential".
  - N2: one budget for every pass of a request (a restart can no longer double it); N3: a cancel at the guard's yield stops a
    synchronous scan (tested); N4: `assertScanBudgetFits` refuses NaN and every value the comparison cannot order.
- **Tests.** The existing synchronous tests stay; the asynchronous path has its own file
  (`test/provider-redactor-async.test.ts`) with an equivalence test over a corpus of the synchronous cases, instead of
  running every synchronous test twice.

## C7-F4: the key is never sent inside its own request body (design delta; built on `fix/key-not-in-own-body`)

Facts (main after #553, which built C7-F3):
- The daemon never stores or rotates a provider key: storing over the wire is not built (C6 follow-up); the key is put in the OS
  keyring outside the daemon. A rotation is therefore invisible to the daemon until the next `vault.reveal`.
- The only provider-key registration is the providers binding's `apiKey` (bindings/providers.ts), called by the Anthropic
  adapter inside its send: `await getKey(purpose)` then `fetch`, with no await in between (adapter.ts).
- The host attestation key is registered at start (secrets.ts); it is not a provider key.

Chosen: **B, a send-time check in the adapter; A (register at start) not built.** (The ticket asked for "register at store,
rotation and start, and/or a check at the send": the daemon has no store or rotation path, so B is what closes it.)

B. The key is never sent inside its own request body.
1. `createAnthropicAdapter` gains an option `holdsKey?: (text: string, key: string) => boolean`, called synchronously after
   `getKey` and before `fetch` (no await between) on the request path and, when there is one, the body (the exact string
   that is sent; every request, count_tokens included, goes through the one send). True, or a check that throws: the request
   is refused `secret_in_request`, nothing sent, nothing charged (`NOT_BILLED`).
2. The binding implements it as a substring test, not a redactor scan: the forms `Redactor.registerSecret` adds (raw,
   JSON-escaped, URL-encoded in either case, hex in either case, base64 and base64url padded or not; a vault key is
   printable ASCII, so its NFC/NFD forms are itself), each also as it appears inside the JSON body (JSON-escaped once more:
   a `"` or `\` in a form doubles). One key, plain `includes`, about tens of ms for a 12 MiB body, on every request (no
   "new key" state to race on). The form list is built by one exported helper beside `Redactor.registerSecret` (or a test
   pins the two lists equal), so they cannot drift apart. The redactor also decodes base64 runs at any byte offset, so the
   check adds the key's base64 and base64url for byte offsets 1 and 2 without the partial groups at either end
   (`base64Middles`, review c7-f4 r1 SF). Not found, by the check and by the redactor alike: a key split across two strings,
   hex in mixed case, a key written with `\u00XX` escapes or with every character percent-encoded, a JSON escape nested
   deeper than once (only keys holding `"` or `\`; an Anthropic key holds neither). Rationale: the invariant "the body never holds the key used to
   send it" is checked at the one point the key and the body meet, after the vault read.
3. The refusal: `ProviderError("secret_in_request")`. Open question for review: `secret_in_request` is GUARD_ONLY (an adapter
   raising it becomes `internal`). Options: (a) drop it from GUARD_ONLY (an adapter can only use it to refuse; nothing is
   sent either way) so the run ends `PROVIDER_SECRET_IN_REQUEST`; (b) keep GUARD_ONLY and accept `PROVIDER_INTERNAL` as the
   run reason. Chosen: (a), with the GUARD_ONLY test updated to say why.
4. Tests (real redactor, guard, adapter, a fake fetch): the key in the history and new to the process (first read) → the
   body that reaches fetch never holds it; rotation (old key registered, new key read at the send, new key in the history)
   → refused, fetch not called; each form; a body without the key is sent unchanged; the check runs after the vault read
   (a vault that rotates between two requests). Mutants: check removed; check before getKey; one form dropped; refusal
   answered by sending.

A (not proposed): read and register each connection's key at daemon start. It would let the guard's own scan refuse first,
but it costs a keyring read (on some desktops a user prompt) at every daemon start for a key that may never be used, needs a
new vault purpose and audit value, and does not cover a rotation in the keyring after start. B covers start and rotation.

Doc: the residual bullet above now says "provider key" (review c7-f3-impl r4 nit) and points here.

Review plan: Opus review of the branch: the order in adapter.ts (no await between check and fetch), the forms set against
`Redactor.registerSecret`, the GUARD_ONLY decision, the rotation test with a fake fetch, the mutants above.

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
