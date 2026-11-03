# Anthropic adapter and connection vault (design)

- **Status:** Proposed. Design only; the implementation follows in `packages/anthropic` and `packages/vault`.
- **Date:** 2026-11-03.
- **Roadmap:** Phase 1b ticket 9. Gate lines: ANT-1, PRV-1, PRV-2, PRV-4, PRV-6, DMN-6 (`docs/ROADMAP.md`, Phase 1b).
- **Builds on:** `@axis/providers` (adapter API v1, the guard, the mock provider and the contract suite), `docs/PROVIDERS.md`, `docs/security/threat-model-phase1.md` §4.5, ADR 0003 D1.6 (secret broker), ADR 0004 decision 14 (no SDK), ADR 0005 (packages layout).
- **Facts about the Anthropic API** were checked against the public API documentation on 2026-11-03 (Messages, streaming, errors, Models). Where the documentation does not say, this page says so and the adapter reports `unknown` rather than assuming.

## 1. Scope

In scope:

- `@axis/anthropic`: a `ProviderAdapter` (v1) for the Claude Messages API, using Node `fetch` (injected), a hand-written SSE parser and Zod. No SDK (ADR 0004 decision 14).
- `@axis/vault`: the key-storage interface, a backend-reporting API, the PRV-1 rule for weak backends, an in-memory test backend, and the seam where the real OS-backed backend plugs in later.

Out of scope here:

- Any real OS keychain or Electron `safeStorage` code. The vault defines the seam (§9.3); main-process wiring lands with the daemon work.
- The daemon wiring that builds the guard from the adapter, the vault and a budget (ticket 10).
- Custom base URLs (PRV-5). The origin is a constant; there is no option to change it.
- Batch, files, web search and other server tools, prompt caching, extended thinking controls, PDF input. The adapter reports these `unsupported` or `unknown` and sends none of them.

## 2. Packages and dependencies

| Package | Imports | Declares |
|---|---|---|
| `@axis/anthropic` | `node:*`, `zod`, `@axis/protocol`, `@axis/providers` | `zod` 4.6.6, `@axis/protocol`, `@axis/providers` (all `0.0.0` or exact) |
| `@axis/vault` | `node:*`, `@axis/protocol` | `@axis/protocol` |

Both follow `docs/packages.md`: `"type": "module"`, `private`, `UNLICENSED`, Node 24.22.1 in `engines`, sources in `src/`, `node:test` tests in `test/`, the copyright header on every file. Neither imports the other: the daemon composes them (§9.4). Test support that imports `node:test` (the fake transport) lives in `test/`, never in `src/`, so the ADR 0005 D3 staging hook does not stage it.

## 3. Everything goes through the guard

The adapter is never called directly by the daemon. The daemon builds `guardProvider(adapter, { redactor, log, limits })` and calls the guard. That is where, for every request:

- the model id is validated, the request is scanned for known secrets and refused if one is found (PRV-4), capabilities are checked, and the request schema is validated;
- the per-run budget is asked before the request and told the usage after it (PRV-6);
- timeouts, cancellation, the stream grammar and the response limits apply, and every error is rebuilt, redacted and bounded (PRV-2, DMN-6).

The adapter assumes that and is still defensive on its own: it validates its inputs, never trusts the response, and never puts anything but fixed text into an error. The adapter's tests run it both bare and behind the guard.

## 4. Wire format

### 4.1 Endpoints

The origin is the constant `https://api.anthropic.com`. The adapter builds every URL from constants and an encoded path segment; nothing from a request, a response or an option can change the origin.

| Adapter call | Method and path | Notes |
|---|---|---|
| `generate`, `stream` | `POST /v1/messages` | Always sent with `"stream": true` (§4.4). |
| `countTokens` | `POST /v1/messages/count_tokens` | Body is `model`, `messages`, `system`, `tools`, `tool_choice` only. |
| `getCapabilities` | `GET /v1/models/{id}` | `{id}` is `encodeURIComponent` of the validated model id. |
| `listModels` | `GET /v1/models?limit=1000` | Follows `has_more` and `last_id` through `after_id`, at most 5 pages and 1,000 models. |
| `validateConnection` | `GET /v1/models?limit=1` | A cheap authenticated call. |

### 4.2 Headers

Exactly these, and no header from any caller input:

```
x-api-key: <key>                  (§6)
anthropic-version: 2023-06-01
content-type: application/json    (POST only)
accept: text/event-stream         (POST /v1/messages) or application/json
```

`anthropic-version` is the constant `2023-06-01` and is reported as `providerApiVersion` in capability reports. No `anthropic-beta` header is ever sent.

### 4.3 Request mapping

| Normalized | Wire |
|---|---|
| `model` | `model` |
| `system` | `system` (string) |
| `maxOutputTokens` | `max_tokens` |
| `temperature`, `stopSequences` | `temperature`, `stop_sequences` |
| text block | `{type:"text", text}` |
| image block | `{type:"image", source:{type:"base64", media_type, data}}` |
| `tool_use` block | `{type:"tool_use", id, name, input}` |
| `tool_result` block | `{type:"tool_result", tool_use_id, content, is_error?}` |
| `tools[]` | `{name, description, input_schema}` |
| `toolChoice` `auto` / `any` / `none` / `{type:"tool",name}` | `{type:"auto"}` / `{type:"any"}` / `{type:"none"}` / `{type:"tool",name}` |

The request is first parsed by the shared `validateRequest` (bounded, cloned, capability-checked), then mapped field by field into a new object. Unknown fields are not copied, and the serialized body is capped at 32 MiB (`invalid_request`, reason `request_too_large`, nothing sent).

`providerOptions.anthropic` is parsed with a strict, empty schema in v1: any key is `invalid_request` and nothing is sent. Options for other providers are ignored. New options need a review that confirms they cannot change the origin, headers, auth or redirect handling (the contract suite checks this).

### 4.4 One parsing path

`generate()` sends `stream: true` and collects the result through the same parser and `StreamValidator` that `stream()` uses (`collectStream`). That makes `generate()` equal to what `collectStream(stream())` builds, as the contract requires, and leaves a single response parser to harden. The only non-streaming responses are the small JSON bodies of the models and token-count endpoints (§7.4).

### 4.5 Response mapping (SSE to normalized events)

| Anthropic event | Normalized |
|---|---|
| `message_start` (`message.id`, `message.model`, `message.usage`) | `message_start`, then at once a `usage` event with the input counters, so a cancelled request can be charged (review S5) |
| `content_block_start` `text` | `content_block_start` text (non-empty initial text becomes a delta) |
| `content_block_start` `tool_use` (`id`, `name`, `input:{}`) | `content_block_start` tool_use. A non-empty initial `input` is `invalid_response` |
| `content_block_delta` `text_delta` | text delta |
| `content_block_delta` `input_json_delta` | `tool_input` delta |
| `content_block_stop` | `content_block_stop` |
| `message_delta` (`delta.stop_reason`, cumulative `usage`) | remembered; a `usage` event when a counter rose |
| `message_stop` | `message_stop` with the mapped stop reason and the final usage |
| `ping`, unknown event types, unknown block or delta types | ignored and counted (§5) |
| `error` | thrown as a `ProviderError` (§8) |

Stop reasons: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use` and `refusal` map to the same names; `pause_turn`, `model_context_window_exceeded`, a missing or any unknown value map to `other`.

Usage is required: a `message_start` without `usage.input_tokens`, or a stream that reaches `message_stop` without any `message_delta` reporting `usage.output_tokens`, is `invalid_response` with reason `missing_usage` (never reported as zero, which would let the PRV-6 budget fail open); the guard then charges its conservative estimate. An explicit zero is refused too (reason `implausible_usage`) when it cannot be true: `input_tokens: 0` with nothing cached, or a final output count of zero after text or a tool call was streamed. A provider that lies with a plausible small number is not detected here; a floor from the observed output belongs in the guard. Usage: `input_tokens`, `output_tokens` map to `inputTokens`, `outputTokens`; `cache_read_input_tokens` and `cache_creation_input_tokens` map to `cacheReadTokens` and `cacheWriteTokens` and are not added to `inputTokens` (the API reports them separately). Usage is cumulative; the adapter takes the running maximum per counter, so a legitimate later event that omits or lowers a counter cannot make the guard see usage go down.

Block indices: the wire index counts every block, including ignored ones. The adapter remaps wire indices to the contiguous 0, 1, 2… that the normalized grammar requires, and drops deltas and stops for ignored blocks.

Deltas of an ignored block (thinking) are real progress, so while they stream the adapter emits a `usage` event with the counters unchanged, at most once per `keepAliveMs` (default 5,000 ms). It is a valid event in the normalized grammar and restarts the guard's idle timer. Consumers must expect a `usage` event that repeats unchanged counters (a UI or journal that logs every `usage` event will see them); the guard treats `usage` as "replace with the latest, monotonic", so repeats cannot double-count. A stream that thinks forever is now bounded by the request timeout (900 s by default), the raw-event cap and the byte cap rather than the idle timeout; a progress signal in adapter API v2 would replace this trick (open question 1), so a model that thinks for longer than the idle timeout is not cut off. Pings never do that.

**Known limitation (thinking blocks).** Some current models always think and return `thinking` blocks with signatures, and the API requires those blocks to be passed back unchanged on tool-use turns. The normalized content types have no such block, and `@axis/providers` is owned by another change. v1 ignores and counts thinking blocks, reports `reasoning: "unsupported"`, and does not send a `thinking` field. A multi-turn tool loop against a model that insists on the returned blocks can fail with `invalid_request` from the API. The fix is an opaque provider-state content block in a version 2 of the adapter API. See open question 1.

## 5. Streaming parser limits

The parser is a bounded incremental SSE reader over the response body. Every limit has a fixed reason word; violations are `invalid_response` and never echo content.

| Limit | Value | Reason |
|---|---|---|
| One SSE line | 1 MiB | `event_too_large` |
| Data of one event (all `data:` lines) | 1 MiB | `event_too_large` |
| Whole response body | 64 MiB | `response_too_large` |
| Raw events | 500,000 | `too_many_events` |
| Ignored events (ping, unknown) | 10,000 | `too_many_ignored_events` |
| JSON nesting inside one event | 12 | `event_too_deep` |
| Invalid UTF-8 | refused (TextDecoder `fatal`) | `bad_encoding` |
| Event JSON not an object or not matching the schema | refused | `malformed_event` |

Details:

- Lines end in LF, CRLF or CR; a BOM on the first line is dropped (and only there); lines starting with `:` are comments; only `event` and `data` fields are used. Every line that does not belong to a dispatched event counts as an ignored event: comments, blank lines with nothing pending, `id:`, `retry:` and unknown fields, a second `event:` line in one event (empty or not), and an event with no `data` (which is skipped, as the SSE rules say). No kind of line can be sent for free, and empty lines are not decoded or allocated. A line limit is checked as bytes arrive, before the line is complete, so a response with no newline cannot grow the buffer past it.
- JSON depth is checked by a linear scan of the event text (counting brackets outside strings) before `JSON.parse`, so a deeply nested event is refused without being parsed.
- Event shapes are parsed with Zod schemas that read only the fields the adapter uses and ignore the rest.
- Beyond these wire limits the guard's `StreamValidator` still applies its own caps per response and per tool input (events, text, tool input, total response size, tool input depth and size, duplicate tool ids, usage monotonic). A tool input that is deeply nested JSON is a string inside `partial_json`, so it passes the event depth check and is refused by the validator (`tool_input_unbounded`).
- Idle and request timeouts are the guard's. Pings do not reset them: the guard's idle timer restarts only when the adapter yields a normalized event, so an endless stream of pings ends in `timeout`, and the ignored-event cap ends it earlier.
- A line is held in one growable buffer, so a long line that arrives in tiny chunks costs one copy. A chunk is not kept alive after it is read: the abort promise a read races against is made per read and removed afterwards, because one that lived as long as the stream retained about 350 bytes per chunk until the stream ended (a test reads 300,000 one-byte chunks and bounds the heap growth).
- The adapter holds a reader on the body and always releases it: on normal end, on error, on early return and on abort (`reader.cancel()`), and a pending read is raced against the abort signal so cancellation does not wait for the next chunk.

## 6. Key handling

- The adapter never stores the key. It takes `apiKey: (purpose) => string | Promise<string>` and calls it immediately before building the headers of each request. `purpose` (`provider_request` or `validate_connection`) is the vault's `SecretPurpose`, so the audit event of `vault.reveal` says why the key was read. The daemon passes a function backed by the vault (`vault.reveal`, §9). A failing or empty supplier is `authentication`, reason `no_credential`.
- The key is checked for header safety: printable ASCII, no whitespace or control characters, 8 to 4,096 characters. Anything else is `authentication`, reason `bad_key_format`, and nothing is sent. This prevents header injection from a pasted key with a newline.
- The key is set only as `x-api-key`. It is never placed in a URL, a body, a log record, an error message, a thrown object or an event. Errors carry fixed text and the four detail keys of `ProviderError`; they have no `cause`.
- The key is sent only to the constant origin. The `fetch` seam (§7) is called only with URLs the adapter built from constants.
- Redaction (PRV-2): the daemon builds the guard's redactor from the vault's known secrets plus the Anthropic key pattern `sk-ant-[A-Za-z0-9_-]{8,}`, which `@axis/anthropic` exports (`ANTHROPIC_KEY_PATTERN`). The guard refuses a request containing the key (PRV-4) and redacts it from every message and log.
- No SDK, no environment variable, no config file read: the key arrives only through the supplier.

## 7. The transport seam and redirects

### 7.1 Injected fetch

```ts
type FetchLike = (url: string, init: {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  redirect: "manual";
  signal: AbortSignal;
}) => Promise<ResponseLike>;
```

`ResponseLike` is the structural subset of a `fetch` `Response` the adapter reads: `status`, `headers.get(name)`, optional `redirected`, optional `url`, optional `type`, and `body` with `getReader()`. Node's global `fetch` satisfies it. Tests inject a fake that serves recorded responses and counts calls, so the suite never touches the network.

### 7.2 Redirects are not followed (ANT-1)

- Every call passes `redirect: "manual"`. With Node's `fetch` a 3xx response is then returned as is and never re-requested, so the key cannot reach a `Location` target.
- The adapter treats any status 300 to 399, an `opaqueredirect` type, `redirected: true`, or a response `url` that differs from the request URL as a refused redirect: it cancels the body without reading it and throws `invalid_response`, reason `redirect`. It never reads or logs the `Location` header.
- This is detection, not prevention, for a fetch implementation that ignores `redirect: "manual"`: the request has already gone out, with the key, before the adapter sees the response. Such a fetch cannot be made safe from inside the adapter, so the daemon must pass Node's own global `fetch` and nothing else. `test/review.test.ts` runs the real `fetch` against local servers to show that a 302 and a 307 never reach their `Location`, and, as a control, that a fetch forced to follow would deliver `x-api-key` to the target. A per-request header-less probe was considered and rejected: it doubles the requests and still proves nothing about the next call. The first line of defence is that the adapter makes exactly one call per request and never retries.
- The response URL is compared after URL normalization, so an encoded query character is not mistaken for a redirect. Model ids `.` and `..` are refused: they survive URL encoding and would walk the path.
- A 200 whose `content-type` is present and is not `text/event-stream` (or `application/json` for the small endpoints) is `invalid_response`, reason `unexpected_content_type`, not a retryable network error.
- `redirect: "error"` was considered. It cannot be told apart from a network failure, and `manual` gives a precise error and a testable "exactly one request" property.

### 7.3 System proxy and trust store

The adapter uses whatever TLS roots and proxy the host `fetch` uses (threat model assumption A7). It does no pinning. Showing the destination origin per request (`descriptor.destination`) and the guard's `request_start` log are the PRV-4 disclosure.

### 7.4 Bounded JSON responses

Models, token-count and error bodies are read through a size-capped reader (4 MiB; error bodies 16 KiB), decoded as UTF-8, depth-scanned (limit 12) and parsed. Parse failure is `invalid_response`.

## 8. Error mapping

All failures are `ProviderError` (closed taxonomy in `@axis/providers`), whose `toAxisError` maps onto the closed `@axis/protocol` `ErrorCode` set. Messages are the fixed text of each code. Details carry only `status`, `retryAfterMs`, `reason` and `capability`.

| Situation | `ProviderErrorCode` | `ErrorCode` | Retryable |
|---|---|---|---|
| HTTP 400, 409, 422, other 4xx | `invalid_request` | `E_INVALID_ARGUMENT` | no |
| 400 whose error `type` is `invalid_request_error` and message says the prompt is too long | `context_length_exceeded` | `E_INVALID_ARGUMENT` | no |
| 413 and the stream `request_too_large` (the body exceeds the byte limit; reason `request_too_large`) | `invalid_request` | `E_INVALID_ARGUMENT` | no |
| 401 | `authentication` | `E_UNAUTHENTICATED` | no |
| 402, 403 | `permission_denied` | `E_UNAUTHENTICATED` | no |
| 404 | `not_found` | `E_NOT_FOUND` | no |
| 408, 504 | `timeout` | `E_TIMEOUT` | yes |
| 429 | `rate_limited` | `E_BACKPRESSURE` | yes |
| 529, 503, stream `overloaded_error` | `overloaded` | `E_UNAVAILABLE` | yes |
| 500 and other 5xx, stream `api_error`, unknown stream error type | `server_error` | `E_UNAVAILABLE` | yes |
| Connection failure, DNS, TLS, reset, stream closed before `message_stop` | `network` | `E_UNAVAILABLE` | yes |
| Caller abort | `cancelled` | `E_CANCELLED` | no |
| Guard idle or request timeout | `timeout` | `E_TIMEOUT` | yes |
| Redirect, 1xx or other 2xx than 200, malformed or oversized event, limit violation | `invalid_response` | `E_INTERNAL` | no |
| Feature not `supported` for the model | `unsupported_capability` | `E_INVALID_ARGUMENT` | no |
| Budget denied (guard) | `budget_exceeded` | `E_POLICY_DENIED` | no |
| Known secret in the request (guard) | `secret_in_request` | `E_POLICY_DENIED` | no |
| Anything else | `internal` | `E_INTERNAL` | no |

Rules:

- **No body ever reaches an error.** The status decides the code. For a 400 only, the adapter reads at most 16 KiB of the body, to see whether the error is `invalid_request_error` and the message contains the fixed phrase `prompt is too long`; that one boolean turns `invalid_request` into `context_length_exceeded`. For every other status the body is cancelled unread. Neither the text nor the `request_id` is surfaced. A body that echoes the key therefore cannot leak it, and the tests check that.
- `Retry-After`: only a non-negative integer number of seconds is honoured (capped at one day by `ProviderError`); an HTTP date or garbage is ignored.
- A stream `error` event maps from `error.type` through a fixed list (`overloaded_error`, `rate_limit_error`, `invalid_request_error`, `authentication_error`, `permission_error`, `billing_error`, `not_found_error`, `request_too_large` (mapped to `invalid_request`), `timeout_error`; anything else is `server_error`); the message is never used.
- `status` is the HTTP status when there was one.
- A 429 with no `retry-after` header is `rate_limited` with no `retryAfterMs` (the documentation notes that a spend-cap 429 has no header and keeps failing; the budget layer, not a retry loop, is what stops spend).

Adapters never retry. The gateway decides retries with bounded, jittered backoff, and the budget runs before every request.

## 9. Capabilities, cost, budget and redaction hooks

### 9.1 Capabilities

`getCapabilities` calls `GET /v1/models/{id}` and builds the report from the response, never from the model name:

- `limits.contextWindowTokens` from `max_input_tokens` and `limits.maxOutputTokens` from `max_tokens`, when they are positive integers.
- `imageInput` is `supported` when `capabilities.image_input.supported` is `true`, `unsupported` when it is `false`, `unknown` when the field is absent.
- `streaming`, `systemPrompt`, `toolUse`, `stopSequences`, `parallelToolUse` and `tokenCounting` are `supported`: they are part of the pinned wire protocol the adapter implements.
- `temperature` and `toolChoice` are `unknown`: the documentation says some current models reject forced tool use and does not report sampling or tool choice support per model. `unknown` makes the guard refuse a request that uses them (`auto` and no `toolChoice` are unaffected), as the capability rules require.
- `structuredOutput`, `reasoning` and `promptCaching` are `unsupported` because the adapter sends none of the fields that enable them.
- `costEstimation` is `supported` only when the connection was configured with pricing (§9.2).
- A 404 is `not_found`. A report is cached for 10 minutes per model (at most 64 entries) and failures are not cached, so the guard's per-request capability check costs one `GET` per model per ten minutes.

The adapter also uses this report for its own `validateRequest` call, so a feature the model does not support fails with `unsupported_capability` before anything is sent.

### 9.2 Cost (PRV-6)

No prices and no model names are hardcoded (`PROVIDERS.md`). The adapter takes an optional `pricing: (model) => Pricing | undefined`, supplied by the daemon from reviewed configuration, with integer micro-USD per million tokens for input, output, cache read and cache write. `estimateCost` is pure, uses `BigInt` for the product, rounds up, and returns `undefined` for an unpriced model or when the usage has cache tokens and no cache price. Without `pricing` every request is unpriced: token budgets still work and the guard denies a cost cap with `cost_unknown`, failing closed.

### 9.3 Budget hook

The adapter has no budget code. The guard calls `BudgetHook.beforeRequest` with the estimated input and the output cap (and the adapter's worst-case cost), clamps the output cap, and calls `recordUsage` exactly once. The adapter's part: it implements `countTokens` and `estimateCost`, and its stream sends a `usage` event with input tokens right after `message_start`, so a cancelled or timed-out request is charged for the input that was really sent (review S5).

### 9.4 Redaction hook

The adapter is built so the guard's redactor has nothing to miss: nothing in an event, error or result is derived from a response body except through the fixed mappings above. Events carry only ids, model names and text produced by the model. A model could be induced to echo text; that is model output, subject to the guard's scan on the next outgoing request and to the audit and log rules for content (logged as length and hash, DMN-6).

## 10. Vault

### 10.1 Model

The vault holds one secret per connection id and the non-secret metadata about it. It does not know about providers. It runs in the daemon (PRV-2, ADR 0003 D1.6): the plaintext exists only in the daemon, obtained from the main-process secret broker through `secrets.decrypt(handle, purpose)`; it is never in the renderer, an extension, a prompt, a log, a journal row or a CLI or broker child environment (PTY-2, PTY-5).

### 10.2 Interface

```ts
type BackendId =
  | "macos_keychain" | "windows_dpapi" | "gnome_libsecret"
  | "kwallet" | "kwallet5" | "kwallet6" | "basic_text" | "unknown" | "memory";
type Protection = "os_protected" | "none" | "ephemeral";

interface BackendInfo { id: BackendId; protection: Protection; label: string }

/** The seam: one implementation per OS, added with the main-process wiring. */
interface SecretBackend {
  info(): Promise<BackendInfo>;                     // asked on every store
  put(name: string, secret: string, meta: EntryMeta): Promise<{ id: BackendId; protection: Protection }>; // where it actually landed
  get(name: string): Promise<{ secret: string; meta: EntryMeta } | undefined>;
  remove(name: string): Promise<boolean>;
  list(): Promise<Array<{ name: string; meta: EntryMeta }>>;
}

interface ConnectionVault {
  backend(): Promise<BackendReport>;                // what the UI shows
  store(connectionId: string, secret: string, opts?: { label?: string; consent?: WeakStorageConsent }): Promise<ConnectionInfo>;
  reveal(connectionId: string, purpose: SecretPurpose): Promise<string>;   // daemon only
  info(connectionId: string): Promise<ConnectionInfo | undefined>;          // never the secret
  list(): Promise<ConnectionInfo[]>;
  remove(connectionId: string): Promise<boolean>;
  knownSecrets(): readonly string[];                // feeds the guard's redactor
}
```

- `ConnectionInfo` is `{ connectionId, label?, storedAt, backend: BackendId, protection, weakConsent: boolean, backendChanged: boolean }`, where `protection` is what the backend reported when the secret was stored, not a guess from its name: enough for the UI to show where the key lives and whether it was stored with consent. It never contains the secret, a prefix, a length or a hash of it.
- `BackendReport` is `{ id, protection, label, policy: "allowed" | "consent_required" | "refused" }`: the current backend and whether a store would be allowed now.
- `SecretPurpose` is a closed set (`provider_request`, `validate_connection`). `reveal` calls an optional `onAccess({ connectionId, purpose, outcome })` hook, and every store (refusals included) and removal calls `onChange({ action, connectionId, outcome, backend?, protection?, weakConsent? })`, so the daemon can write audit events (DMN-5) without the secret.
- Connection ids and names: `[a-z0-9][a-z0-9._-]{0,63}`. Secrets: printable ASCII, 8 to 4,096 characters, no whitespace.
- `knownSecrets()` returns every secret stored or revealed in this process, including rotated and removed ones, so a late echo of an old key is still redacted. Secrets that are no longer stored are forgotten oldest first beyond 1,024; a secret that is still stored is never forgotten. After a restart it holds only what `reveal` has returned since, so the daemon should reveal each connection at startup before it builds the redactor. It is for the redactor only; the same trust boundary as `reveal`.
- Everything a backend returns is untrusted: `info()` answers, entry metadata (`meta()`, `list()`) and the `put` result are validated field by field. Bad data, or an error thrown while reading it, becomes a fixed `backend_failed`; backend error text never escapes.
- Errors are `VaultError` with a closed code set (`consent_required`, `backend_refused`, `backend_failed`, `backend_changed`, `not_found`, `invalid_name`, `invalid_secret`). Messages are fixed text and never contain the secret or a backend's raw error text. `VaultError` maps to the bridge errors `E_POLICY_DENIED` (consent and refusal), `E_NOT_FOUND`, `E_INVALID_ARGUMENT`, `E_CONFLICT` (`backend_changed`) and `E_UNAVAILABLE`.
- The vault object keeps secrets nowhere but in the backend and the known-secret set (a closure, not a property), so `util.inspect` and `JSON.stringify` of the vault show no secret.

### 10.3 The Linux `basic_text` rule (PRV-1)

On Linux, Electron's `safeStorage` may fall back to a `basic_text` backend: a hardcoded key, so no protection against another process of the same user. macOS and Windows have no such mode.

- The backend is asked on **every** `store` (not cached), because it can change between calls (a keyring starting or stopping).
- `os_protected` backends (`macos_keychain`, `windows_dpapi`, `gnome_libsecret`, `kwallet`, and Electron's `kwallet5` and `kwallet6`): stored without consent. The backend's own report decides: a `gnome_libsecret` that reports no protection (a locked collection) needs consent like any weak backend.
- `basic_text`, `unknown` and any backend reporting `none`: `store` fails with `consent_required` unless a consent is supplied. `basic_text` and `unknown` never count as protected, whatever they claim. A backend reporting `ephemeral` is trusted only if its id is `memory`; for any other id the claim is treated as `none`.
- **Consent is a capability, not a value.** `createConsentAuthority({ ttlMs?, now? })` returns a `grantor` and a `verifier`. The grantor goes only to the approvals service, which calls `grant({ connectionId, backend })` after the user resolves a native confirmation that names both (DMN-3: an agent cannot resolve it). The verifier goes to the vault (`createVault({ consent })`). There is no free-standing factory: code that was not handed the grantor cannot mint a consent, and a plain object or another authority's consent is refused. A consent is bound to one connection id and one backend id, expires (five minutes by default), and is spent by `redeem`, which checks and marks it in one synchronous step, so concurrent stores cannot both use it and a second vault sharing the verifier refuses it. A wrong attempt (another connection or backend) does not spend it. A vault without a verifier accepts no consent. The vault records `weakConsent: true` and the backend id in the entry's metadata; the UI shows the backend and a warning for every connection stored this way. Keeping the grantor out of reach of other daemon code is a wiring rule (the approvals module owns it); the vault cannot enforce it from inside.
- **The check and the write are tied together.** `put` reports the backend that actually took the write. If that differs from the backend the policy decision was made on (the keyring went away in between), the vault removes the written copy and fails with `backend_changed`; it never records a weakly stored secret as protected. A backend that does not say where it wrote fails the same way.
- A vault can also be created with `weakPolicy: "refuse"`, in which case a weak backend is refused outright (`backend_refused`) and consent is not offered. The product default is `"consent"`.
- `memory` (the in-memory test backend) reports `protection: "ephemeral"`: allowed without consent, never persists, flagged `persistent: false`. It is exported for tests; production wiring must not select it.
- Metadata records the backend and its protection at store time. `info().backendChanged` is true when the current backend differs from the one the secret was stored under (for example the keyring was disabled later), so the UI can prompt a re-store.

### 10.4 Wiring (for ticket 10, recorded here)

```
vault.reveal(id, purpose) ──► adapter apiKey(purpose) supplier
vault.knownSecrets + ANTHROPIC_KEY_PATTERN ──► createSecretRedactor ──► guardProvider(adapter, { redactor, log, limits })
```

The vault, the supplier and the redactor stay in the daemon process. The daemon creates one consent authority: its grantor goes to the approvals service, its verifier to the vault.

## 11. Tests (ANT-1 and the contract suite)

All tests use `node:test`; the transport is a fake `fetch`, so no test touches the network.

1. **The shared contract suite** from `@axis/providers/contract` runs against the adapter through the fake transport, including the leak checks (canary and credential echoed into error bodies, headers and stream events) and the `providerOptions` check. The base branch is being tightened (credential-in-event and tool-id leak checks, negative tests with a leaky adapter); the adapter is expected to pass whatever the suite becomes.
2. **ANT-1, redirect:** a 301, 302, 307 and 308 response is refused as `invalid_response` / `redirect`; exactly one request was made; the init had `redirect: "manual"`; the key does not appear in the error, logs or the fake's recorded second request (there is none); a fake that follows `Location` when `redirect` is not `manual` is never given the chance; `redirected: true` and a mismatching `url` are refused.
3. **ANT-1, oversized stream event:** a single SSE event above 1 MiB, a line with no newline, a body above the total cap, and too many ignored events each fail with `invalid_response` and a fixed reason; nothing from the stream appears in the error.
4. **ANT-1, deeply nested JSON:** nested events (depth above 12) and a tool input nested far beyond the protocol depth (through the guard and `StreamValidator`) are refused quickly without a stack overflow.
5. **ANT-1, error body echoes the key:** 400, 401, 403, 429 and 529 bodies and a mid-stream `error` event containing the key, its URL-encoded form and a `sk-ant-` string never reach the thrown error, `String(err)`, `JSON.stringify`, `util.inspect(err, {showHidden:true})` or the guard's log records; the same through the guard with a vault-backed redactor.
6. **Key handling:** the key is read per request from the supplier, appears only in `x-api-key`, is rejected when it contains CR, LF or spaces, and is absent from every URL and body; every recorded URL starts with `https://api.anthropic.com/`.
7. **SSE parser units:** chunk boundaries inside a line, a multi-byte character and a CRLF; BOM; comments; multi-line data; invalid UTF-8; index remapping around ignored blocks; usage mapping; stop-reason mapping.
8. **Review regressions** (`test/review.test.ts`): missing usage through a token budget, line floods, redirects on the GET paths and with the real `fetch`, `.` model ids, content types, 413, thinking progress, key purposes.
9. **Error mapping:** the table in §8, `Retry-After` handling, `error` event types.
10. **Capabilities, cost, `countTokens`:** report built from a models response, unknown fields ignored, cache and expiry; pricing with `BigInt` and missing cache price; `countTokens` body.
11. **Vault:** the PRV-1 matrix (every backend id, with and without consent; consent bound to a connection and a backend, expiring, forged, foreign, spent once even under `Promise.all` and across vaults; `refuse` policy; backend change between stores and between the check and the write; reported protection; bad backend data), no secret in `info`, `list`, errors, `inspect` or `JSON.stringify`, `knownSecrets` after rotation and removal, `onAccess` carries no secret.

The gate lines the tests cover: ANT-1 (items 2 to 5), PRV-1 (10), PRV-2 (5, 6, 10), PRV-4 (guard scan with the vault redactor), PRV-6 (guard budget with the adapter's pricing and usage events).

## 12. Open questions

0. **Contract coverage of redirects.** The shared suite never serves a 3xx, so an adapter that follows redirects and sends the key along passes all of it. It needs a `redirect` scenario and a hook that reports every URL the adapter requested; see the review follow-up. Until then the adapter's own tests carry ANT-1's redirect property.

1. **Thinking blocks.** Models that always think return blocks that must be passed back on tool turns. Options: an opaque provider-state content block in adapter API v2 (preferred; needs a change in `@axis/providers`), or a per-connection in-memory cache keyed by tool-use id (lost on restart). Until decided, v1 ignores them (§4.5). Needed before ticket 10's tool loop is exercised against such a model.
2. **`temperature` and `toolChoice` reporting.** The Models API does not report them, so they are `unknown` and refused. If the product needs forced tool choice on a given model, that needs either a documented capability field or a user-visible override.
3. **Pricing source.** The adapter takes pricing from the daemon. Where that configuration lives and who reviews it is a ticket 10 decision; without it, only token budgets are enforceable.
4. **Error body inspection.** §8 reads a bounded body of a 400 for one fixed decision. If the owner prefers no body reads at all, `context_length_exceeded` on a 400 is lost (the status alone says `invalid_request`).
5. **Key kinds.** v1 sends `x-api-key` for a provider-issued API key only. Workspace-scoped keys that need an `anthropic-workspace-id` header, and bearer or OAuth credentials, are not supported (`PROVIDERS.md` connection type 2 only).
