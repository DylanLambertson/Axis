# Integrations and net: the contracts (PV-N1a)

- **Status:** Planned contracts: the schemas and planned policy rows exist, nothing serves them. Served by PV-N1f (`axis.integrations/1`) and PV-N1f with PV-K1 (`axis.net/1`).
- **Date:** 2026-11-22.
- **Inputs:** ADR 0009 decisions 1 to 4 (`docs/adr/0009-integrations-and-credential-proxy.md`), ADR 0008 decision 6, `docs/design/product-vision-v2-tickets.md` section 5.1 (PV-N1a).
- **Code:** `packages/protocol/src/integrations.ts` and `integrations-wire.ts`; planned rows in `packages/daemon-host/src/policy/planned.ts`. Tests: `packages/protocol/test/contracts-integrations.test.ts` (with `samples-integrations.ts`), `packages/daemon-host/test/policy/integrations-policy.test.ts`.

## 1. Methods

| Contract | Method | Side effect | Tier | Idempotency | What it does |
|---|---|---|---|---|---|
| `axis.integrations/1` | `list`, `status` | read | 0 | none | The project's integrations (id, label, punycode origins, operations with a `write` flag, declared and granted scopes, state) |
| | `connect` | credential | 3 | none | Start the device-code flow, user only. Replies at once with `connecting`; the code and verification host are shown by main (ADR 0009 decision 6), never returned |
| | `disconnect` | write | 1 | none | Delete the vault entry, drop the memory token, cancel in-flight requests; only lowers privilege |
| | `read` | read | 0 | none | One read operation (a `GET` or `HEAD` of the connector) of the integration's closed set with typed arguments; a write operation here is `operation_kind_mismatch` |
| | `write` | network | 3 | **required** | One write operation with typed arguments: its own permission and a tier-3 challenge showing the integration, the operation and the exact values (D-10); the retry carries `approval`; a read operation here is `operation_kind_mismatch` |
| `axis.net/1` | `read` | read | 0 | none | A plugin's `GET` or `HEAD` to a granted `net:<origin>`: origin and composed path; subject to the per-plugin request and byte budget |
| | `send` | network | 3 | **required** | A plugin's `POST` (no method field) with an optional JSON object body, tier 3 with an optional `approval` |

**The split (review of PV-N1a, decided 2026-11-22).** ADR 0009 decision 1 lists one `request` method. The tier of a request that sends caller data to an external host and changes something there must be a fact of the policy table, not a promise that a handler raises it: `specProblem` forces a `network` method to tier 3 and an optional `approval`, and the contract requires the idempotency key, so no handler can forget either. `request` is therefore two methods per contract, a read at tier 0 and a `network` method at tier 3 (an amendment note on ADR 0009 decision 1 and ADR 0008's rows). A plugin's row may raise a tier, never lower it (ADR 0008 decision 6).

## 2. What no request can carry

No request has a URL, header, cookie, redirect, proxy, method override or credential field, and no reply carries a header, `Location`, cookie or credential (ADR 0003 D7).

- Every object is strict. The arguments of `read` and `write` are a record of typed values (text without NUL, a safe integer, a boolean; no null, array or nesting) with at most 32 keys. A key is a camelCase name and never a reserved one (below). This is defence in depth: the connector's own typed argument set is the authority and refuses any key it does not declare.
- `axis.net/1`: the origin is a punycode HTTPS host (no port, userinfo, trailing dot, bracket or path; the last label has a letter, so `127.0.0.1`, `2130706433`, `0x7f.1`, `127.1` and `[::1]` cannot be written). The path with its query uses only unreserved, sub-delimiter and `:@%/?` characters, at most 2,048; it refuses a malformed escape, `%2f`, `%5c`, an escaped control character, a double-encoded dot, slash or backslash (`%252e`) and an overlong UTF-8 lead byte (`%c0`, `%c1`, `%e0%80`, `%f0%80`) anywhere, `//` in the path part (a protocol-relative path), a dot segment in any spelling in the path part (`..;` and `.;x` included), and a second `?`. `read` takes `GET` or `HEAD`; `send` is a `POST` with an optional JSON object body at most six levels deep.
- Internal-looking names (`foo.local`, `metadata.google.internal`, `127.0.0.1.nip.io`, a hex host such as `0x7f.0x0.0x0.a`) pass the contract by design: the daemon's address check and pinning refuse them (ADR 0009 decision 4), not this schema.
- A key `__proto__`, `constructor` or `prototype` in arguments, a body or a result is refused (zod's record would skip an own `__proto__` silently, so it is checked first), and an argument key is refused when any camelCase word of it is `token`, `secret`, `auth`, `cookie`, `url`, `uri`, `proxy`, `redirect`, `header` and the like, or two adjacent words form `apiKey`, `privateKey` or `sessionId` (`author`, `sortKey` and `filePath` stay legal).
- A text argument may hold CR, LF and other controls (a comment body has newlines); the daemon refuses them in a value that goes into a path segment or a query parameter, which PV-N1f's composition test proves.
- No payload says who is calling: the daemon takes the actor from the connection.

## 3. Replies and limits

A reply is a status in 200 to 299 and one typed value (`result`, or `body` for net): the connector's response schema produced it, at most 12 levels deep, 1,000 array items, 256 object keys and 65,536 characters per text, inside the envelope's own walk (1 MiB, 16 levels). Any other status is a closed error, never a body.

The egress caps of ADR 0009 decision 4 are exported as constants for the egress client (PV-N1d): request body 1 MiB, response 4 MiB, JSON depth 64, response headers 16 KiB. They bound the service's bytes, not the reply: a response the connector reduces to a typed value is relayed within the protocol's bounds, so a 4 MiB response does not become a 4 MiB message. **Open question for review:** whether a connector may produce a result larger than one message (a paged result would need a contract change).

## 4. Refusals

Every refusal is `details: { reason }` with one fixed message, so no argument, host, body or `Location` reaches an error. `E_NOT_FOUND`: `not_found`. `E_INVALID_ARGUMENT`: `argument_refused`, `origin_refused`, `path_refused`, `request_too_large`, `operation_kind_mismatch`. `E_CONFLICT`: `not_connected`, `needs_reconnect`, `already_connecting`, `scope_refused`, `busy`, `audit_unavailable`. `E_UNAVAILABLE`: `network_unavailable`, `address_refused`, `redirect_refused`, `response_too_large`, `response_depth_exceeded`, `headers_too_large`, `encoding_refused`, `response_invalid`, `upstream_status`, `credential_echoed`, `rate_limited`. `E_TIMEOUT`: `timeout`. Permission and actor refusals stay `E_POLICY_DENIED` from the pipeline.

## 5. Policy rows and open points

The planned rows are user rows at the contract tiers, because `RuleActor` has no other actor yet. `connect` is user-only for good. `axis.net/1.read` and `.send` are plugin methods: when PV-K1 adds the plugin allow-list rows (ADR 0008), the user row is replaced and a user caller is refused. Open for review: (1) settled: the split of section 1; (2) `connect` at tier 3 beside main's native dialog; (3) the checks beyond ADR 0009's list (escaped control characters in a path, the reserved argument keys).
