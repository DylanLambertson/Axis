# The integrations read slice (PV-N1f, read path)

- **Status:** Built on main as the PV-N1f read slice. `packages/daemon-host/test/integrations/handlers.test.ts`, `test/integrations/service.test.ts` and `test/slice/integrations-canary.test.ts` cover the served path; production still has no vault backend (§7).
- **Date:** 2026-11-27.
- **Inputs:**
  - ADR 0009 decisions 1, 2, 3, 4 and 8.
  - `docs/design/integrations-contract.md`, `request-composition.md`, `egress-client.md`, `net-tier-decision.md` (§5 RESPONSE-ECHO, §6), `secret-broker.md` (§3.3, §3.5).
  - The vault (`packages/vault`, PV-N1c purposes).

## 1. Scope

This slice serves `axis.integrations/1.list`, `.status` and `.read` for ONE built-in connector, GitHub read-only. It is tested against a local fake server, with a fake vault backend holding a canary token. In production it has no backend until PV-N0c (§7), so a production read answers `not_connected`.

**Not in this slice:**
- `write`, `connect` and `disconnect`, which stay planned methods. Connect is PV-N2.
- Any plugin access, and `axis.net/1`.
- The tier raise of the decision note.
- The real secret backend (PV-N0c).
- Token acquisition, refresh and scope recording (PV-N2).

## 2. The connector registry

- **Where:** `packages/daemon-host/src/integrations/registry.ts`, a frozen, daemon-only constant. Declared origins, scopes and operations live ONLY here, in daemon source. No request, reply, setting or renderer value can add or change them. Plugin-contributed connectors are PV-K, with their own design.
- **Shape:** `Connector { id, label, origins, declaredScopes, auth: "bearer", tokenShape, operations }`.
  - `tokenShape` is the credential's shape, checked on every reveal before use (§4 step 4).
  - Each operation is `{ kind: "read", template: OperationTemplate, result: schema }`.
  - The template is PV-N1e's (method `GET` or `HEAD`, path template, declared query keys, typed placeholders).
  - The result schema reduces the service's JSON to a bounded typed value inside the contract's result bounds (`resultValueSchema`). Fields the schema does not name are dropped, never passed through. The reply is the reduced value, never the upstream object.
- **GitHub:**
  - Origin `https://api.github.com`; `auth: "bearer"`.
  - `tokenShape`: 20 to 255 visible ASCII characters (`\x21` to `\x7e`), so a header value can never carry a space, a control or a line break.
  - The declared scopes are named in PV-N3's review. The slice uses the read-only set and checks none of them (scope recording is PV-N2).
  - Two example operations:
    - `pulls_list`: `GET /repos/{owner:id}/{repo:id}/pulls` with optional `state` (enum `open`, `closed`, `all`) and `per_page` (int 1 to 100);
    - `issue_get`: `GET /repos/{owner:id}/{repo:id}/issues/{number:int ≥ 1}`.
  - Each result keeps only a few named fields: number, title (bounded text), state and author login. No URL is kept (§4 step 11).
- **A registry test** checks every template with `templateProblem`, every origin with `originSchema`, every `tokenShape` against good and bad samples, and that every operation in the slice is `kind: "read"`.

## 3. Where the state lives

- **Credential:** the vault entry `integration:github` (Space scope, one entry per integration, as PV-N1c named it).
- **State,** from `vault.info("integration:github")` (metadata only, no decryption):
  - no backend in the composition, or no entry: `available` (the contract has no `not_connected` state);
  - an entry whose `protection` is `none`, whose `backend` is weak (`basic_text`, `unknown`), or whose `backendChanged` is true: `needs_reconnect`;
  - otherwise: `connected`.
- A backend that fails during `info` is `E_INTERNAL` with a fixed text, for `list` and `status` alike: a failure is not a state.
- `grantedScopes` stays empty until PV-N2 records them. No journal change in this slice.
- The state is a label for the UI. It is NOT what stops a weak credential being used: the reveal gate of §4 step 4 is.

## 4. The read flow, in order

Each failure answers a closed error with `INTEGRATIONS_REFUSAL_MESSAGE` and `details: { reason }` from the contract's `INTEGRATIONS_REFUSALS`, or `E_CANCELLED` or `E_INTERNAL` with a fixed text. No argument, URL, header, body or credential is in any of them. A failure stops the flow, except for the epilogue (step 10), which always runs once step 6 has written its row.

**The wire mapping.** A table-driven test covers every row, including TLS failure and abort, so a new internal code cannot pass through unmapped.

| Where | Internal outcome | On the wire |
|---|---|---|
| §7 | no backend in the composition | `E_CONFLICT` `not_connected` |
| step 2 | unknown connector or operation | `E_NOT_FOUND` `not_found` |
| step 2 | a write operation | `E_INVALID_ARGUMENT` `operation_kind_mismatch` |
| step 3 | composition or match refusal | `E_INVALID_ARGUMENT` `argument_refused`, `path_refused` or `origin_refused` |
| step 4 | vault `not_found` | `E_CONFLICT` `not_connected` |
| step 4 | weak entry, `backend_changed`, or a token that fails `tokenShape` | `E_CONFLICT` `needs_reconnect` |
| step 4 | vault `backend_failed` | `E_INTERNAL` |
| steps 6, 10 | an audit row not written | `E_CONFLICT` `audit_unavailable` |
| step 8 | an echo | `E_UNAVAILABLE` `credential_echoed` |
| step 9 | result-schema mismatch | `E_UNAVAILABLE` `response_invalid` |
| egress | `aborted` | `E_CANCELLED` |
| egress | `connect_failed`, `tls_failed`, `unresolved` | `E_UNAVAILABLE` `network_unavailable` |
| egress | `first_byte_timeout`, `total_timeout` | `E_TIMEOUT` `timeout` |
| egress | `http_status` | `E_UNAVAILABLE` `upstream_status` |
| egress | `json_invalid` | `E_UNAVAILABLE` `response_invalid` |
| egress | `json_too_deep` | `E_UNAVAILABLE` `response_depth_exceeded` |
| egress | `response_headers_too_large` | `E_UNAVAILABLE` `headers_too_large` |
| egress | `address_refused`, `redirect_refused`, `encoding_refused`, `response_too_large`, `rate_limited` | `E_UNAVAILABLE`, the same name |
| egress | `busy` | `E_CONFLICT` `busy` |
| egress | `request_too_large` | `E_INVALID_ARGUMENT` `request_too_large` |
| egress | `request_refused`, `not_authorized`, `method_refused`, `target_refused`, `header_refused` | `E_INTERNAL`: the handler built the request, so one of these is a daemon bug |

**The steps:**

1. **Check:** the contract schema, the policy row (tier 0, user, trust `project`: §6) and project trust.
2. **Resolve the connector and the operation.**
3. **Compose and match:** `composeRequest(template, "github", origin, args)`, then `egressTarget(url, declaredOrigins(connector.origins))`, then `matchTarget(composed, target)`.
4. **Reveal, behind a real gate.**
   - `vault.reveal("integration:github", "integration_request")`.
   - Today `reveal` reads the secret and ignores the returned entry's metadata, and `weakPolicy` governs stores only. So this slice changes the vault:
     - For every `integration_request` reveal, the vault checks the metadata of the SAME `backend.get` result that carries the secret. It refuses when `protection` is `none`, the backend is weak, or the entry's backend differs from the current one. That makes the check race-safe: a separate `meta` or `info` read beforehand is never taken as validating the entry actually revealed.
     - The new closed vault code is `weak_entry`, mapped to `needs_reconnect`. The existing quarantine check (SF-3) stays and maps the same way.
     - Provider reveals are unchanged.
   - The handler then checks the token against the connector's `tokenShape` before step 5, and refuses with `needs_reconnect` on a mismatch.
   - The vault's `onAccess` events are not the audit: their exceptions are ignored by design, so the service writes its own rows.
   - **Every reveal attempt is audited** (audit C L1, as the providers binding audits every read, DMN-5). A vault refusal, a token that fails `tokenShape` (the vault accepts 8 characters, GitHub's shape needs 20), or a failed registration (step 5) writes one `integration.credential` row with outcome `failure` and the closed reason. The call keeps that reason, even if the row cannot be written, and nothing is sent.
5. **Register with the redactor at once,** before anything else uses the value: the exact header value (`Bearer <token>`) and the token alone.
6. **Audit `integration.credential`** with outcome `success` and reason `ok` (§5). If the row cannot be written, the call answers `audit_unavailable` and nothing is sent.
7. **Attach and send:**
   - `new Credential(header, { integration: "github", origin })`, then `authorize(matched, credential)`, then `client.sendAuthorized(request, { signal: context.signal })`.
   - The client takes the credential once and attaches it to exactly the matched URL.
8. **RESPONSE-ECHO** (§4.2): two scans, both before any reply, event or log.
   - First, every response header name and value and the whole body (raw bytes, before any parse) are scanned for every encoded form of the header value and of the token.
   - Then, after the parse of step 9, every key and string value in the parsed tree, and every string in the reduced result, are scanned the same way.
   - A match in either scan answers `credential_echoed`. The response is discarded: nothing of it is returned, logged or audited beyond the closed reason. `needs_reconnect` is not set, because the token is not known to be bad.
9. **Parse and reduce:** `parseJsonBody` (caps, depth), then the operation's result schema, which gives the bounded result.
10. **Epilogue: audit `integration.request`.**
    - This step runs whenever step 6 wrote its row, on EVERY exit path that follows: success, any refusal, an echo, a parse failure, cancellation, or an internal error. The handler holds steps 7 to 9 in a `try` with this step in its `finally`.
    - If the row cannot be written, any result is discarded and the call answers `audit_unavailable`. A cancelled call still answers `E_CANCELLED`.
    - A refusal before the reveal (step 4) writes no integration row of either kind, because nothing was revealed. A refused reveal writes only its `failure` credential row (step 4) and no request row, because nothing was sent.
11. **Reply:** `{ status, result }`. No header, no URL, no `Location`.

**Order invariant:**
- The redactor registration (5) comes before any use (7).
- The first echo scan (8) comes before any parse (9), and both scans come before any reply, event or log.
- A written `success` credential row (6) is always followed by exactly one request row (10), unless the process dies between the two.
- **A crash between the two rows** (a crash or `SIGKILL` after step 6 and before the epilogue) leaves a credential row with no request row. Such an orphan row means the send's outcome is unknown: a request may or may not have gone out. The audit chain stays valid, and nothing reconciles the orphan at the next start.

### 4.1 Cancel, disconnect and failure mid-flight

The handler passes its call's `context.signal` to `sendAuthorized`. The daemon session aborts that signal when the caller cancels or its connection closes.

- **The redactor registration never goes stale, because it is never removed.**
  - The `Redactor` only grows: nothing unregisters a secret (`registeredForms`). A cancelled request leaves the value registered for the rest of the process, which is the safe direction: a later log line that held it is still scrubbed.
  - It is registered at step 5, before any use, so no abort between two steps leaves the value in use unregistered.
  - **After a restart** the new process starts with an empty redactor and an empty `knownSecrets()`, which holds only what `reveal` has returned since. No integration entry is revealed at startup (`secret-broker.md` §3.5 reveals provider entries only). An integration token is registered again by its next reveal, at step 5, before use.
- **What stays in memory:**
  - The redactor keeps the token and its encoded forms as plaintext strings for the life of the process, after a cancel too. So do the vault's live and known collections. These are usable secrets held by strong references, not unreachable copies awaiting collection.
  - No request object is kept. If a call is aborted before step 7, the `Credential` and `AuthorizedRequest` are dropped unsent, and the single-use slot in url-pattern.ts is a `WeakMap` entry that goes with its object. A `Credential` that is still reachable holds its secret until it is not.
  - If a call is aborted during step 7, the client has already spent the authorization (`takeAuthorization`). `finish` destroys the request, releasing the socket and the snapshot.
  - The integration slot (`IntegrationGate`) is released on every path. A later request reveals again: nothing is retried with an old object.
  - JavaScript cannot zero a string: RR-83, unchanged by this slice.
- **What is answered:** a TLS failure is the client's `tls_failed`, and a dropped socket is `connect_failed`; both are `network_unavailable` on the wire. An abort is `E_CANCELLED`. The socket's own error text is never passed on. If the caller is gone, nothing is replied, and the body collector is dropped with the request.
- **What is written:** the epilogue (step 10), with the byte counts of §5.
- **Tests** (each checks every sink of §8 for the canary, and that the next `read` succeeds):
  - an abort before step 6: no `integration.credential` or `integration.request` row, and nothing sent;
  - an abort after step 6, before the send: one credential row, a request row with reason `cancelled` and `bytesOut` 0, and the server sees nothing;
  - an abort mid-response;
  - the server dropping the socket after part of a 200 body;
  - a TLS failure.

### 4.2 Why the first echo scan reads raw bytes, and why there is a second

The first scan runs on the exact bytes the client collected, because only they hold every way the service could repeat the credential. A parse would rewrite them: decode escapes, drop duplicates, drop unnamed fields, or fail. What reaches the scan:

- **Content encoding:** the client sends no `Accept-Encoding`, and refuses any `Content-Encoding` other than `identity` (`encoding_refused`) before it reads the body. So the collected bytes are never compressed.
- **Chunked transfer:** Node's HTTP parser removes the chunk framing before the `data` events. Trailers are never read or returned.
- **Partial reads and a token split across chunks:**
  - `BodyCollector` joins every chunk into one buffer, and the scan runs once, on the complete body, after `end`. So a credential split across chunks is whole in the buffer that is scanned.
  - A body over the 4 MiB cap fails whole (`response_too_large`), and a connection that ends early is `network_unavailable`. In both cases nothing is returned.
- **Headers:** the scan covers every header name and value as the client returns them, including each value of a repeated header such as `set-cookie`.
  - Node's HTTP parser lowercases header names, and drops the repeated values of some headers (for example `server` and `location`), before the scan sees them. The scan is case-sensitive.
  - So a token with upper-case letters, echoed in a header NAME, is not flagged.
  - This loses only the `credential_echoed` signal, never the token: headers never reach the reply, an event, a log line or an audit row.
- **Non-2xx answers and redirects never reach the scan:**
  - The client refuses a redirect, a 429 or 503, and any other non-2xx status before it returns headers or a body. A redirect's `Location` is never read and never followed.
  - So their content is discarded by the lower layer, not by the scan. §8 tests those refusals end to end.
- **Encoded echoes:**
  - The scan looks for every form `secretForms` (audit `redact.ts`) gives for the header value and for the token: raw, NFC and NFD, JSON-escaped, URL-encoded in either case, hex in either case, and base64 or base64url, padded or not. So base64 and URL encodings of the token alone are covered.
  - The redactor uses the same list, plus pattern rules and base64 decoding at offsets that the scan does not use. So sharing `secretForms` keeps the listed forms in step, but it does not make the scan and the redactor identical.
  - The body is searched as UTF-8 text and as bytes, so an invalid byte sequence cannot split a match.

**The second scan.** A byte scan cannot see an echo that only becomes the credential after parsing: a JSON string whose token characters are written as `\uXXXX` escapes. Escaping only the scheme (`Bearer <token>`) is NOT such a case, because the raw token is still there and the first scan finds it. So, after `parseJsonBody`, every key and string value in the parsed tree, and the reduced result, are scanned for the same forms.

**What stays possible:**
- An echo transformed in a way neither scan names, such as a token split across two JSON fields, base64 at a byte offset that is not 0, or encrypted.
- This residual is bounded in two ways:
  - The result schema keeps only a few named fields, and only bounded text.
  - The sender is the declared origin, which already holds the token.
- The note records this as a residual, not as a property.

## 5. The audit rows (exact fields, allowlisted)

- **`integration.credential`:** one row per reveal attempt. It is `success` at step 6, before attach, or `failure` for a reveal refused at step 4 or 5. Fields: `integrationId`, `operation`, `projectId`, `actorKind` (`user` in this slice), `purpose` (`integration_request`), and `reason` (`ok`, or the refusal's closed reason).
- **`integration.request`:** written by the epilogue (step 10). Fields:
  - `integrationId`, `operation`, `projectId`;
  - `status`: the HTTP status as an integer, when one was received;
  - `bytesOut`: the UTF-8 byte length of the composed request target (path and `?query`, exactly as on the request line) plus the request body's length (0 for `GET` and `HEAD`). It is computed once from the composed, already-encoded URL, so an encoded argument is never counted twice. It is charged when step 7 starts, and is 0 for an exit before the send.
  - `bytesIn`: the length of the body the client returned, also when a later step refuses it (an echo, a parse failure, a schema mismatch). It is 0 when the client failed, including after a partial body. It counts what reached the handler, not bytes on the wire: the client's errors carry no counters, and wire counters would change the pinned client. They are left to the budget work (RR-87).
  - `durationMs`;
  - `reason`, from a closed audit set that is separate from the wire reasons: `ok`, `cancelled`, `internal`, or the wire reason of the exit.
- Every counter is a finite non-negative integer.
- **Never:** a token, an argument value, a URL, a header, a body, a `Location`, or a result value. The audit payload policy gains these two kinds with exactly these keys, and a test rejects any other key.

## 6. Contracts, policy rows and trust

- **The protocol registry splits by method.** In `packages/protocol/src/contracts.ts`, `axis.integrations/1` gets an entry in `contracts` holding `list`, `status` and `read` only, and keeps an entry in `plannedContracts` holding `connect`, `disconnect` and `write`. `axis.net/1` stays wholly planned.
  - The comment's rule "a key is never in both tables" becomes "a method is never in both tables", and its test follows.
  - Tests: `lookupMethod` finds the three served methods and returns `undefined` for each deferred one; the daemon refuses each deferred method with `E_METHOD_NOT_FOUND`; the real host starts; and `coverageProblems` is empty.
- **Policy rows:** `list`, `status` and `read` move from `policy/planned.ts` to `policy/rules.ts` at their tiers (0, 0, 0). `write` (3), `connect` (4) and `disconnect` (1) stay planned.
- **Trust:**
  - `read` is `userRule(0, "project")` and its handler is marked `projectGated`, so the project-trust check of step 1 is the coverage-checked one.
  - `list` and `status` are `userRule(0)` (trust `none`): they reveal nothing and send nothing.
- **Tier equality** holds for the moved rows. No tier is raised, so no relaxation is needed. Native confirmation starts at tier 4, so this read asks for none.
- **Plugins and web clients** stay unable to call these methods: they are absent from the plugin allow-list and from `WEB_ALLOWED`. Tests pin both refusals.

## 7. The test seam, and no backend in production until PV-N0c

- The composition gets `integrations?: { client?: EgressClient; vaultBackend?: SecretBackend }`.
  - Production (the daemon entry) passes neither. A test pins that `entry.ts` passes neither.
  - With no `client`, the composition builds `createEgressClient()`.
  - A test passes `createEgressClientForTest(...)` (the CA, the resolver and dial, and the port seam) and an in-memory backend seeded with the canary.
- **No secret backend until PV-N0c:**
  - Production has no integrations `SecretBackend` until PV-N0c lands. The composition does NOT build, borrow or fall back to one: no memory backend, and not the providers' vault in `bindings/providers.ts`.
  - With no backend in the composition, no vault call is made, no credential exists, no egress request is issued, and no `integration.credential` or `integration.request` row is written. The daemon's own `policy.decision` row is still written for every admitted call, as for any method. Then:
    - `list` and `status` are state queries. They answer a NORMAL reply showing GitHub with `state: "available"` and `grantedScopes: []`.
    - `read` is an action. It answers `E_CONFLICT` `not_connected`.
  - The served read runs only when BOTH hold: a backend is present in the composition, and the connector's entry exists (§3).
  - **Tests:** each runs twice, once with no `integrations` option at all (as production does) and once with only a counting egress client, whose count stays 0. In each run:
    - the host starts healthily;
    - the `list` and `status` replies are checked against the contract's response schemas, field by field;
    - `read` answers `E_CONFLICT` `not_connected`;
    - no request is issued, and the audit log, filtered to the two integration row kinds, is empty.
  - Removing the no-backend check must fail them (a mutant).
- The import pin stays: only the composition root imports the egress client, and only by its allowed names.

## 8. Acceptance test: the canary end to end (net-tier-decision §5, §6 item 3)

The test runs through the REAL host composition (the `test/slice/` headless rig). A local HTTPS server answers as GitHub.

**The canary.** One plainly synthetic token sits in the fake vault, for example `canary"T0k3n\x+y/z=Q9w-synthetic-0001`. Its quote and backslash need JSON escaping, and its `"`, `\`, `+`, `/` and `=` need URL encoding. So its JSON-escaped, URL-encoded and base64 forms each differ from the raw token, and the test asserts that, using `secretForms` itself, before any case runs. It still fits GitHub's `tokenShape` (visible ASCII).

**Every sink.** For every case below (success, each echo, each refusal, and the no-backend hosts), one shared assertion checks every sink for the token and for every registered form:
- the reply or error, and its text;
- every event emitted;
- the pending-approvals listing and approval detail, which must show no challenge at tier 0;
- both audit rows;
- every captured log line.

**The cases:**
- **A `read` of `pulls_list`:**
  - The server receives exactly one request: to the composed path, with `authorization: Bearer <canary>`, SNI on the original host, and no other copy of the canary.
  - The reply holds the reduced result.
  - `bytesOut` and `bytesIn` match §5.
- **First-scan echoes** (200 answers): the header value, then the token alone, in a JSON field, in a response header, base64-encoded, URL-encoded, and split across two chunks. Each answers `credential_echoed`, and no part of the response reaches the caller.
- **The second-scan echo:**
  - A 200 body where every character of the token is written as a JSON `\uXXXX` escape.
  - The test asserts both preconditions: no listed form of the token or header is in the raw body, and the parsed string holds the whole token.
  - It answers `credential_echoed`.
- **Mutants:** removing the first scan, and removing the second scan, must each fail a behavioural assertion: the first-scan cases for the one, the second-scan case for the other.
- **Echoes the client refuses:** a 401 whose body and headers hold the token, and a 302 whose `Location` holds it. Each answers its closed reason (`upstream_status`, `redirect_refused`), the redirect is not followed, and no sink holds the canary.
- **Other refusals:**
  - an unknown operation;
  - an argument with a separator;
  - an answer over its caps;
  - a socket dropped mid-body;
  - a schema mismatch;
  - a TLS failure.

**Proven in unit tests with fakes, not by the acceptance test.** The child-process host cannot inject these conditions, so the canary test does not claim them. They run over the real vault code, the real redactor and the real read flow, with a fake sender and a hand-built backend (`test/integrations/service.test.ts`, `handlers.test.ts`, `packages/vault/test/integration-reveal.test.ts`):
- **Audit failures, at both boundaries:**
  - The credential row fails: `audit_unavailable`, and nothing is sent.
  - The request row fails after a successful send: `audit_unavailable`, and the result is discarded.
- **The weak gate:**
  - A seeded entry whose metadata is weak answers `needs_reconnect`, with zero sends.
  - So does an entry whose metadata changes to a weak backend between `info` and `reveal`.
  - So does a token that fails `tokenShape`.
  - `status` shows `needs_reconnect` for the weak entry.
- **Cancel and disconnect:** the cases of §4.1. An abort before the reveal, after the credential row, and during the send (the client's `aborted`).
- **A write operation via `read`** (`operation_kind_mismatch`), with a test registry, since the built-in one has no write operation.
- **No vault entry** (`not_connected`).
- **The renderer side:** the test connects as a `user` window through the composition's real connection path, so every message that crosses to a window is checked. It cannot show what an own-shell renderer does with them (no renderer exists yet).

## 9. What this slice cannot prove yet

- **Without PV-N0c:** that a credential is stored and revealed through `safeStorage` in a built app, and the weak-backend refusal on a real backend. The fake backend stands in, and RR-82 holds.
- **Without PV-N2:** real token acquisition, refresh, the granted-scope check, and disconnect.
- **Without PV-N3:** that the GitHub templates, `tokenShape` and result schemas match the real API. The fake server follows the documented shapes.
- **Without the own shell and OS-21:** approvals in the own shell, the packaged NET-GATE lines, and a real renderer. The test's window is the composition's.
- This slice authorizes neither a production credential nor plugin exposure. Every gate of `net-tier-decision.md` §6 and §7 still applies.

## 10. Order of work

1. Test-first:
   - the registry test;
   - the vault reveal-gate tests;
   - the flow's unit tests (each wire mapping, each order invariant, each audit field, the epilogue on every exit);
   - the contract-split and coverage tests;
   - then the acceptance test.
2. The code: the vault change, then the handlers. The method split and the rows move in the same commit as the handlers.
3. The mutation run on the shared runner.
4. An independent security review.
