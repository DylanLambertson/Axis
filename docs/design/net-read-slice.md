# The integrations read slice (PV-N1f, read path)

- **Status:** design, for review before any code.
- **Date:** 2026-11-27.
- **Inputs:**
  - ADR 0009 decisions 1, 2, 3, 4 and 8.
  - `docs/design/integrations-contract.md`, `request-composition.md`, `egress-client.md`, `net-tier-decision.md` (§5 RESPONSE-ECHO, §6).
  - The vault (`packages/vault`, PV-N1c purposes).

## 1. Scope

This slice serves `axis.integrations/1.list`, `.status` and `.read` for ONE built-in connector, GitHub read-only. It is tested against a local fake server, with a fake vault backend holding a canary token.

**Not in this slice:**
- `write`, `connect` and `disconnect`, which stay planned rows. Connect is PV-N2.
- Any plugin access, and `axis.net/1`.
- The tier raise of the decision note.
- The real secret backend (PV-N0c).
- Token acquisition, refresh and scope recording (PV-N2).

## 2. The connector registry

- **Where:** `packages/daemon-host/src/integrations/registry.ts`, a frozen, daemon-only constant. Declared origins, scopes and operations live ONLY here, in daemon source. No request, reply, setting or renderer value can add or change them. Plugin-contributed connectors are PV-K, with their own design.
- **Shape:** `Connector { id, label, origins, declaredScopes, auth: "bearer", operations }`.
  - Each operation is `{ kind: "read", template: OperationTemplate, result: schema }`.
  - The template is PV-N1e's (method `GET` or `HEAD`, path template, declared query keys, typed placeholders).
  - The result schema reduces the service's JSON to a bounded typed value inside the contract's result bounds (`resultValueSchema`). Fields the schema does not name are dropped, never passed through.
- **GitHub:**
  - Origin `https://api.github.com`; `auth: "bearer"`.
  - The declared scopes are named in PV-N3's review. The slice uses the read-only set and checks none of them (scope recording is PV-N2).
  - Two example operations:
    - `pulls_list`: `GET /repos/{owner:id}/{repo:id}/pulls` with optional `state` (enum `open`, `closed`, `all`) and `per_page` (int 1 to 100);
    - `issue_get`: `GET /repos/{owner:id}/{repo:id}/issues/{number:int ≥ 1}`.
  - Each result keeps only a few named fields: number, title (bounded text), state, html URL host check, author login.
- **A registry test** checks every template with `templateProblem`, every origin with `originSchema`, and that every operation in the slice is `kind: "read"`.

## 3. Where the state lives

- **Credential:** the vault entry `integration:github` (Space scope, one entry per integration, as PV-N1c named it).
- **`connected`:** the vault reports the entry and it is not weak.
- **`available`:** there is no entry.
- `grantedScopes` stays empty until PV-N2 records them. No journal change in this slice.

## 4. The read flow, in order

Every step that fails is a closed error with a fixed text (no argument, URL, header, body or credential), and nothing later runs.

1. **Check:** the contract schema, the policy row (tier 0, user) and project trust.
2. **Resolve the connector and the operation:** unknown is `not_found`, and a write operation here is `operation_kind_mismatch`.
3. **Compose and match:**
   - `composeRequest(template, "github", origin, args)`;
   - `egressTarget(url, declaredOrigins(connector.origins))`;
   - `matchTarget(composed, target)`.
   - Any refusal is `argument_refused` or `origin_refused`.
4. **Reveal:** `vault.reveal("integration:github", "integration_request")`. No entry is `not_connected`; a weak or failed backend is `unavailable`.
5. **Register with the redactor at once,** before anything else uses the value:
   - the exact header value (`Bearer <token>`) and the token alone;
   - the integrations redactor scrubs both from every log line, error text and audit field, and the vault's `knownSecrets()` feeds it after a restart.
6. **Audit `integration.credential`** (§5). If the row cannot be written, the request is refused (`unavailable`) and nothing is sent.
7. **Attach and send:**
   - `new Credential(header, { integration: "github", origin })`, then `authorize(matched, credential)`, then `client.sendAuthorized(request)`;
   - the client takes the credential once and attaches it to exactly the matched URL.
8. **RESPONSE-ECHO** (§4.2): two scans, both before any reply, event or log.
   - First, every response header name and value and the whole body (raw bytes, before any parse) are scanned for every encoded form of the header value and of the token.
   - Then, after step 9, every string in the parsed JSON and in the reduced result is scanned the same way.
   - A match in either scan is `echo_refused`.
   - The response is discarded, nothing of it is returned, logged or audited beyond the closed reason, and the integration is marked for review (`needs_reconnect` is NOT set: the token is not known to be bad).
   - The first scan runs BEFORE any parse.
9. **Parse and reduce:** `parseJsonBody` (caps, depth), the operation's result schema (`result_invalid` on a mismatch), then the bounded result.
10. **Audit `integration.request`** (§5). If the row cannot be written, the result is discarded and the caller gets `unavailable`.
11. **Reply:** `{ status, result }`. No header, no URL, no `Location`.

**Order invariant:**
- The redactor registration (5) comes before any use (7).
- The echo refusal (8) comes before any reply, event or log (9 to 11).
- Both audit rows bracket the send (6 and 10).

### 4.1 Cancel, disconnect and failure mid-flight

The handler passes its call's `context.signal` to `sendAuthorized` as `extra.signal`. That signal aborts when the caller cancels or when its connection drops. Every case below ends with no credential in a log and no registration left to go stale.

- **The redactor registration never goes stale, because it is never removed.**
  - The `Redactor` only grows: nothing unregisters a secret (`registeredForms`).
  - The vault's `knownSecrets()` keeps the value too, so a restart re-registers it.
  - A cancelled request therefore leaves the value registered, which is the safe direction: a later log line that held it would still be scrubbed.
  - Leaving it registered also keeps nothing usable alive: the redactor stores only the forms to scrub, and no request or credential object.
  - The registration happens at step 5, before the value is used anywhere. So no abort, between any two steps, can leave a window in which the value exists unregistered.
- **The credential in memory:**
  - *Abort before step 7:* no `Credential` or `AuthorizedRequest` exists yet, or the one that exists is dropped unsent. Its single-use slot in url-pattern.ts is a `WeakMap` entry, so it goes with the object.
  - *Abort during step 7:* the client has already spent the credential (`takeAuthorization`) and holds the header only inside the request snapshot. On abort, `finish` destroys the request, which releases the socket and the snapshot. The abort is reported as the closed error `aborted`.
  - *The connection drops* (socket error, `aborted`, a TLS failure): the client gives the closed `connect_failed`. Its text is fixed, and the socket's own error text is never passed on.
  - In every case, the slot is released (`IntegrationGate`), and a later request reveals the credential again. Nothing is retried with the old object.
  - JavaScript cannot zero a string. Copies of the token stay in the heap until garbage collection: RR-83, unchanged by this slice.
- **What is written:**
  - The `integration.credential` row is already written (step 6).
  - `integration.request` is still written, with `reason` set to `aborted` or `connect_failed`, `status` absent, and the byte counts so far.
  - If the caller is gone, nothing is replied. Nothing of the response is kept, because the body collector is dropped with the request.
  - If the audit write itself fails at that point, the failure is logged through the redactor, with no field from the request.
- **Tests:**
  - Abort before step 6: no row is written and nothing is sent.
  - Abort after step 6, before step 7: one `credential` row and an `aborted` `request` row, and the server sees nothing.
  - Abort mid-response, and the server dropping the socket mid-body.
  - Each test checks that no log line, error text, event or row holds the canary, and that the next `read` succeeds.

### 4.2 Why the first echo scan reads raw bytes, and why there is a second

The first scan runs on the exact bytes the client collected, because only they hold every way the service could repeat the credential. A parse would rewrite them: decode escapes, drop duplicates, drop unnamed fields, or fail. What reaches the scan:

- **Content encoding:**
  - The client sends no `Accept-Encoding`, and refuses any `Content-Encoding` other than `identity` (`encoding_refused`) before it reads a byte of the body.
  - So the collected bytes are never compressed. A gzip body, which could hide the token from a byte scan, never reaches the scan or the caller.
- **Chunked transfer:**
  - Node's HTTP parser removes the chunk framing before the `data` events. The collector sees only the payload.
  - Trailers are never read or returned.
- **Partial reads and a token split across chunks:**
  - The scan does not run on chunks. `BodyCollector` joins every chunk into one buffer, and the scan runs once, on the complete body, after `end`.
  - A body over the 4 MiB cap fails whole (`response_too_large`) and keeps nothing.
  - A connection that ends early is `connect_failed`, and nothing is returned.
  - So a credential split across two chunks, or across a chunk and a TCP segment, is always whole in the buffer that is scanned.
- **Headers:** the scan covers every header name and value of the response as the client returns it. That includes each value of a repeated header, `set-cookie` among them.
- **Encoded echoes:**
  - The scan looks for every form `secretForms` (audit `redact.ts`) gives for the header value and for the token: raw, NFC and NFD, JSON-escaped, URL-encoded in either case, hex in either case, and base64 or base64url, padded or not.
  - This is the same list the redactor scrubs, so what the scan refuses and what a log would scrub cannot drift apart.
  - The body is decoded as UTF-8 for the string search, and searched as bytes as well, so an invalid byte sequence cannot split a match.

**The second scan.** A byte scan cannot see an echo that only becomes the credential after parsing. The case is a JSON string with arbitrary escapes, such as `"\u0042earer …"` or `"\/"` inside the token. So, after `parseJsonBody`, every string value and every key in the parsed tree is scanned for the same forms, and so is the reduced result, before the reply.

**What stays possible:**
- An echo transformed in a way neither scan names, such as a token split across two JSON fields, base64 at a byte offset that is not 0, or encrypted.
- This residual is bounded in two ways:
  - The result schema keeps only a few named fields, and only bounded text, so most of a response never reaches the caller.
  - The service sending the echo is the declared origin, which already holds the token. It can hand a transformed copy only to a caller of this read, never to a third party, and the decision note's tier and RESPONSE-ECHO rules still apply.
- The note records this as a residual, not as a property.

## 5. The audit rows (exact fields, allowlisted)

- **`integration.credential`:** written before attach. Fields:
  - `integrationId`, `operation`, `projectId`;
  - `actorKind` (`user` in this slice);
  - `purpose` (`integration_request`).
- **`integration.request`:** written after the response, or after a refusal from step 7 on. Fields:
  - `integrationId`, `operation`, `projectId`;
  - `status` (an HTTP status as an integer, or absent);
  - `bytesOut` (request path, query and body bytes, for the budget: RR-87), `bytesIn` (decoded response bytes);
  - `durationMs`;
  - `reason`: a closed refusal code or `ok`.
- **Never:** a token, an argument value, a URL, a header, a body, a `Location`, or a result value. The audit payload policy gains these two kinds with exactly these keys, and a test rejects any other key.

## 6. Policy rows

- `axis.integrations/1.list`, `.status` and `.read` move from `policy/planned.ts` to `policy/rules.ts` at their current tiers (0, 0, 0; user rules), because they are now served.
- `write` (3), `connect` (4), `disconnect` (1) and all of `axis.net/1` stay planned.
- Coverage is unchanged: equality holds for the moved rows.

## 7. The seam for tests, and only for tests

- The composition gets `integrations?: { client?: EgressClient; vaultBackend?: SecretBackend }`.
  - Production (the daemon entry) passes neither, and the composition builds `createEgressClient()` and the real backend. A test pins that `entry.ts` passes neither.
  - A test passes `createEgressClientForTest(...)` (the CA, the resolver and dial, and the port seam) and an in-memory backend seeded with the canary.
- The import pin stays: only the composition root imports the egress client, and only by its allowed names.

## 8. Acceptance test: the canary end to end (net-tier-decision §6 item 7)

The test runs through the REAL host composition (the `test/slice/` headless rig). There is one canary token in the fake vault, and a local HTTPS server answers as GitHub.

- **A `read` of `pulls_list`:**
  - The server receives exactly one request, to the composed path, with `authorization: Bearer <canary>`, SNI on the original host, and no other copy of the canary anywhere in the request.
  - The reply holds the reduced result and no canary.
  - Every event emitted, both audit rows, every log line captured and every error text hold no canary.
  - `bytesOut` and `bytesIn` are right.
- **Echo variants:** the server returns 200 with the authorization value, then the token alone, in each of these places:
  - a JSON field;
  - a response header;
  - base64 and URL-encoded;
  - split across two chunks;
  - JSON-escaped (`\u0042earer …`), which only the second scan catches.
  - The reply is `echo_refused`, and no part of the response reaches the caller.
  - Removing either scan must fail this test (one mutant each).
- **Cancel and disconnect:** the cases of §4.1.
- **Refusals:**
  - an unknown operation;
  - a write operation via `read`;
  - an argument with a separator;
  - no vault entry (`not_connected`);
  - an audit write that fails (nothing sent);
  - an answer over its caps;
  - a redirect.

  Each is closed and canary-free.
- **The renderer side:** the test connects as a `user` window through the composition's real connection path, so "the renderer never sees the credential" is shown for every message that crosses to a window. It cannot show what an own-shell renderer does with them (no renderer exists yet).

## 9. What this slice cannot prove yet

- **Without PV-N0c:** that a credential is stored and revealed through `safeStorage` in a built app, the weak-backend refusal there, and the startup reveal. The fake backend stands in, and RR-82 holds.
- **Without PV-N2:** real token acquisition, refresh, and the granted-scope check.
- **Without PV-N3:** that the GitHub templates and result schemas match the real API. The fake server follows the documented shapes.
- **Without the own shell and OS-21:** the packaged NET-GATE lines and a real renderer. The test's window is the composition's.

## 10. Order of work

1. Test-first: the registry test, the flow's unit tests (each refusal, each order invariant, each audit field), then the acceptance test.
2. The code.
3. The mutation run on the shared runner.
4. An independent security review.
5. The rows move in the same commit as the handlers.
