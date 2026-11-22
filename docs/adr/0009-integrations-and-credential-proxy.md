# ADR 0009: Integrations and the credential proxy

- **Status:** Proposed. Becomes Accepted when the Phase 4a integration gate lines pass (ticket PV-N4, validation criteria below). The owner decisions it records (extensibility D-7 to D-11 and D-14, product vision O-5) are decided; the engineering decisions it adds are decided and revisable.
- **Date:** 2026-11-22.
- **Decision owner:** Dylan Lambertson. The owner delegated every open decision to the project lead on 2026-11-21; the decisions are recorded in `docs/design/owner-decisions-2026-11-21.md` §1 (O-5) and §4, and the owner can reverse any of them there.
- **Depends on:** ADR 0003 (bridge, D1.1 no daemon listener, D1.6 the privileged main port and secret broker, D4 approvals and native confirmation), ADR 0004 (decision 9, decision 14: the provider adapter's HTTP pattern), ADR 0008 (the `plugin:<id>` principal and the `net:<origin>` and `integration:<id>` permissions it holds back for this ADR; merged, #576). All Proposed.
- **Amends:** ADR 0004 decision 9's engineering addition "Axis stores no forge credentials", **from Phase 4a only** (decision 9 below); ADR 0008 decision 6's dangerous combinations (section "Amendment to ADR 0008"). **Keeps** ADR 0003 D1.1, DMN-4 and the NET-1 gate line: 4a adds no listener anywhere (decision 6).
- **Related:** `docs/design/extensibility.md` ("the design": §7, §8 INT-1 to INT-6, §9 4a integration lines, §11 D-7 to D-14), `docs/design/forge-pr-list.md` (PV-D2, the `gh`-based PR list), `docs/design/inter-agent-communication.md` §6.6 (taint source 7), `docs/design/product-vision-v2-tickets.md` (PV-N1 to PV-N4, PV-R8), `docs/security/threat-model-phase1.md` (PRV-1, PRV-2, PRV-5, ANT-1, DMN-4, DMN-5, DMN-6, EL-4, EL-5, NET-1, A7, A10).
- **Detail:** `docs/adr/0009-integrations-and-credential-proxy-code.md` maps each claim about existing code to its anchor and lists every divergence.
- **Evidence tags:** **[V]** verified in the code on `origin/main` at `15be311` (file and symbol named); **[D]** decided here or in the design, not built; **[I]** inferred, not verified.

## Context

### Owner direction

The owner wants third-party services (forge, issue tracker, chat, monitoring) inside Axis (`product-vision-v2.md` §1). The design §7 proposes a daemon credential proxy; on 2026-11-21 its open decisions were taken as the recommended defaults (owner decisions §4: D-7 to D-11, D-14), and O-5 keeps the 1c PR list on the user's `gh` with no stored token.

### What exists on main

- **The vault package and its first binding.** `@axis/vault` stores named secrets through an injected `SecretBackend`, checks the backend on every store (PRV-1) and audits each read with a closed purpose [V, `packages/vault/src/types.ts` `SecretBackend`, `SECRET_PURPOSES` (`provider_request`, `validate_connection`); `vault.ts` `createVault`, `reveal(connectionId, purpose)`]. A purpose is not bound to an entry kind today. The providers binding (composer ticket C6) is the only allowed importer: it reads the Anthropic key once per request, registers it with the host redactor first, audits the read and refuses a response that echoes it [V, `packages/daemon-host/src/bindings/providers.ts`; `test/packages/imports.test.mjs`, `@axis/vault` allowed only in `src/bindings/providers.ts`].
- **No production secret backend.** The composition takes the backend as an option, and the daemon entry passes none, so in a built app no provider key is ever read [V, `daemon-host/src/compose.ts` `composer.anthropic`; no `anthropic` option in `entry.ts`]. Main's secret broker over the privileged port (ADR 0003 D1.6) is not built; main has a `safeStorage` cipher only for the audit anchor [V, `code-oss/overlay/src/vs/axis/code/electron-main/axisMainSeam.ts`, `safeStorageCipher`].
- **The outbound HTTP pattern (ANT-1).** A fixed `https` origin, `redirect: "manual"`, byte, depth and time caps, closed errors [V, `packages/anthropic/src/limits.ts` `ANTHROPIC_ORIGIN`; `adapter.ts` (`redirect: "manual"`)]. It uses Node's global `fetch`, so it cannot pin a checked address, and the threat model accepts a system proxy or trust store for it (ANT-1, A7) [V, threat model].
- **The daemon entry** refuses `NODE_OPTIONS`, inspector flags and any `execArgv` at start [V, `daemon-host/src/entry.ts` step 1, `node_options_refused`]; it does not check `NODE_TLS_REJECT_UNAUTHORIZED` or `NODE_USE_ENV_PROXY` [V].
- **The forge today.** The 1c PR list runs the user's `gh` in the pty process with an allow-listed environment and no stored token (PV-D2, `forge-pr-list.md`) [V, `packages/pty-process/src/forge-env.ts` `buildForgeEnv`, `forge-list.ts`].
- **Taint source 7** (`integration_data`) and the sender kind `integration` are in the closed list; nothing produces them [V, `packages/protocol/src/taint.ts`].
- **Not built:** any `axis.integrations` or `axis.net` contract, any OAuth flow, any address check or pinning [V: none in `packages/protocol/src`].

## Options

The proxy's shape (the daemon composes every request and attaches the credential) was settled by the design and its two reviews. Two questions were open:

| | Question | Options | Taken |
|---|---|---|---|
| Q1 | How the proxy reaches the network | (a) Node's global `fetch`, like the provider adapter; (b) **`node:https` with a dedicated agent and a `lookup` that checks and pins every address** | (b): global `fetch` cannot pin the checked address (DNS rebinding) and can be routed through an environment proxy [I: Node's `NODE_USE_ENV_PROXY`] |
| Q2 | Services without a device-code flow | (a) a one-shot loopback listener in 4a; (b) **device flow only in 4a; such a service cannot ship** | (b), conservatively: the loopback would be Axis's first TCP listener in a desktop run, reachable by any same-user process and by browser pages guessing the port; it is deferred (decision 6) |

## Decision

### 1. The credential proxy is the only way out

- Every integration request, and every plugin `net:<origin>` request (ADR 0008 decision 6), is made **by the daemon**. No plugin, renderer, composer prompt, CLI environment or log ever sees an integration credential (PRV-2, DMN-6, INT-1) [D].
- **Contracts.** `axis.integrations/1`: `list` and `status` (reads), `connect` and `disconnect` (user-only), `request { integrationId, operation, args }`. `axis.net/1.request { origin, path, method, body? }` for plugins with `net:<origin>`. There is no raw URL, header, cookie or credential field in any request; ADR 0003 D7 forbids credentials in any response schema [D].
- **`axis.net/1.request`** allows the methods `GET`, `HEAD` and `POST` only; its `path` (with query) goes through the same refusals as decision 3 (control characters, CR and LF, `\`, dot segments in any spelling, `%2f`, `%5c`); its headers are a fixed set the daemon writes (`Accept`, and `Content-Type` for a body). **No credential, cookie or authorization header is ever attached**, even when the origin equals an integration's origin; a plugin needs `integration:<id>` for credentialed calls [D].
- **Who may call `request`.** The user's built-in surfaces and a plugin holding `integration:<id>` for that integration and project. **Composer agents get no integration operation in 4a**: integration data reaches a run only when the user passes it, as taint source 7 (design §7.5). CLI agents never: they have their own credentials and network as the user [D].

### 2. An integration is a typed connector

- A fixed set of HTTPS origins; an auth method; a **closed set of operations**, each with a fixed HTTP method, a path template, typed arguments and a response schema; a scope (project or Space). Built in, or contributed by a plugin in 4a under ADR 0008 [D].
- **Read-only by default.** Each **write** operation (comment on a PR, move an issue) is its **own permission** and a **tier-3 challenge** that shows the integration, the operation and the exact values sent (D-10) [D].
- **Origins are shown in punycode.** Install, update and connect dialogs show every origin in its `xn--` form and flag any punycode label (homographs) [D].

### 3. Request composition (INT-6)

Each operation fixes its method and path template. Each argument is a schema-typed value placed into one named path segment or one declared query parameter and percent-encoded. A value holding `/`, `?`, `#`, `\`, a literal or percent-encoded dot segment (`.`, `..`, `%2e`, `%2E`, mixed), `%2f`, `%5c` or any control character is **refused before encoding**. No free-form query, header or body passthrough: a body, when an operation has one, is built from typed fields. The final URL is parsed and matched against the operation's URL pattern (origin, path segments, query keys) **before** the credential is attached; a mismatch is refused and audited [D].

### 4. Network egress (INT-2, INT-3, D-14)

One egress client in the daemon serves integrations and `net:<origin>` alike [D, every item]:

- **Origins.** HTTPS only, to an origin in the integration's declared set (or the plugin's granted `net:` origins). The host is taken from the **WHATWG-parsed URL**, and the IP-literal check runs on that parsed host, so the decimal, hexadecimal, short and bracketed forms (`2130706433`, `0x7f.1`, `127.1`, `[::1]`) are all IP literals and refused. Also refused: userinfo, a port not declared, a host not in punycode form, and a **trailing-dot host** (refused, not normalised, so the origin match and SNI see one spelling).
- **Address checks and pinning.** The client resolves the host itself, refuses the request if **any** returned address is not public unicast, and connects only to a checked address, with TLS server name and certificate checks against the original host.
  - **IPv4 public unicast** excludes `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (cloud metadata included), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` and `240/4`.
  - **IPv6 public unicast** is an address **inside `2000::/3`**, minus `2001::/23` (the IETF protocol block: Teredo `2001::/32`, benchmarking `2001:2::/48`, ORCHID `2001:10::/28` and ORCHIDv2 `2001:20::/28` included), `2001:db8::/32` and `3fff::/20` (documentation) and `2002::/16` (6to4); everything outside `2000::/3` is refused, which covers `::/128`, `::1`, `::/96` (IPv4-compatible), `::ffff:0:0/96` (mapped), `::ffff:0:0:0/96` (SIIT), `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64), `100::/64`, `fc00::/7`, `fe80::/10`, `fec0::/10` and `ff00::/8`.
  - **Embedded IPv4:** for the mapped, IPv4-compatible, SIIT, well-known NAT64 and 6to4 forms, the embedded IPv4 address is also checked against the IPv4 list, and the request is refused whatever the outer rule says.
  - Implemented with `node:https`, a dedicated agent and a `lookup` function (Q1) [I: that the agent connects only to the addresses the `lookup` returned, with `autoSelectFamily`, at Node 24.22.1 is PV-N1's first test].
- **TLS.** The agent sets `rejectUnauthorized: true` explicitly; no request can override it. The daemon entry refuses to start with `NODE_TLS_REJECT_UNAUTHORIZED` set, as it refuses `NODE_OPTIONS` (a PV-N1 item in `entry.ts` step 1). `NODE_EXTRA_CA_CERTS` and the system trust store are the A7 residual: no certificate pinning.
- **Proxies ignored (D-14).** `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` and the system proxy do not apply to this client, so the address check tests the real destination. The daemon entry also refuses to start with `NODE_USE_ENV_PROXY` set (with `NODE_TLS_REJECT_UNAUTHORIZED`, a PV-N1 item). A proxy option needs its own design, and the address check must then move to the proxy's resolution.
- **Redirects.** Any `3xx` answer is a closed error (`redirect_refused`). Its `Location` is never followed, logged, audited or returned. Nothing is sent to another origin, and the credential never moves.
- **Caps on decoded bytes.** The client sends no `Accept-Encoding` and refuses a response with a `Content-Encoding` other than `identity`, so the caps measure what is parsed: request body 1 MiB; response 4 MiB, JSON depth 64, 10 s to first byte, 30 s total. Responses are validated by the operation's schema; error text is built from fixed strings and the status, never the body.
- **Rate.** Per integration at most 4 requests in flight. `Retry-After` and rate-limit headers are parsed as integer seconds only (a date or any other form is ignored), and backoff is capped at 15 minutes.
- **P2 processes are not covered:** they reach the network as the user, as ADR 0008 states at install.

### 5. Credentials in the vault (PRV-1, PRV-2, D-9)

- **Namespaced entries.** Integration tokens are vault entries named `integration:<integrationId>` (refresh or long-lived token), separate from provider entries. Each purpose is valid **only for its entry kind**: `provider_request` and `validate_connection` reveal only provider entries; the new closed purposes `integration_request`, `integration_refresh` and `integration_validate` reveal only `integration:` entries. A reveal with a purpose that does not match the entry's kind is refused and audited [D; the purpose list is V and closed today, and `reveal` checks no kind today].
- **PRV-1 applies** (consent or refusal on Linux `basic_text`; the UI shows the backend). Each read is audited with its purpose, never the value.
- **A second vault importer.** The integrations binding becomes the second module allowed to import `@axis/vault`, next to the providers binding; the import test, the stage scan and the providers binding's "only importer" note change with PV-N1 [D].
- **Plaintext only in the daemon**, read immediately before the request, registered with the host redactor before use, never kept in a run row, event, error or log; a response that echoes it is refused, as the providers binding does for the Anthropic key [V for that pattern, `bindings/providers.ts`; D for integrations]. For OAuth, the vault holds the refresh token; the access token lives in daemon memory only, registered with the redactor, until it expires or the integration is disconnected.
- **Token endpoint.** Every access and refresh token in a token or refresh response is registered with the redactor **before** any parsing beyond extracting it, any validation error and any log line; token-endpoint error bodies are never logged or audited (a fixed error and the status only).
- **Rotation.** A rotated refresh token is written to the vault **before** the old one is discarded. If the write fails, the old token is kept, the new one is dropped, and the integration is marked "needs reconnect" for the user; no request uses a token that is not stored.
- **Production backend.** Integrations ship only once main's secret broker over the privileged port (ADR 0003 D1.6) exists and the daemon entry passes it; until then no integration can connect [D; V that neither exists today].
- **Scopes (INT-5).** Prefer the narrowest credential the service offers (fine-grained, read-only, expiring). The granted scopes are recorded at connect and shown. **A token whose granted scopes exceed the integration's declared scopes is refused.** A service whose granted scopes cannot be read back cannot ship a token-based integration until its per-service review names how they are verified [D].
- **Disconnect** deletes the vault entry, drops the in-memory access token, cancels in-flight requests of that integration and, where the service has an API for it, revokes the token. It is user-only and needs no dialog: it only lowers privilege [D].

### 6. Connecting: OAuth (D-7, INT-4)

- **Connecting is user-only** (a policy row admitting `user` alone), and a plugin's `integration:<id>` grant never includes connect [D].
- **Device-code flow only, in 4a.** The daemon starts the flow; **main** shows the user code and the verification host in a **native dialog it builds** (EL-4: not plugin or renderer text, which limits device-code phishing), and opens the verification URL in the system browser under the EL-5 rules. The `verification_uri` and `verification_uri_complete` hosts must be within the integration's declared origins, or the flow is refused: this matters most for plugin-contributed integrations. The daemon polls the token endpoint under decision 4's rules, honouring `interval` and `slow_down` (each `slow_down` adds 5 s, the interval is capped at 60 s), and stops at `expires_in`, capped at 15 minutes [D].
- **A service without a device flow cannot ship in 4a.** The one-shot loopback listener of D-7's fallback is **deferred**: it would be the first TCP listener of a default desktop run. It needs its own decision and, with it, a threat-model amendment of the 1a/L29 gate line ("no listener outside an active flow"), a stated residual that any same-user process can reach it (there is no socket directory or peer credential for TCP), and hardening rules: `127.0.0.1` only, a random port, one request or 5 minutes, a wrong `state` in the first request closes it, a fixed response with no reflection, and no claim that the CLI process tree cannot reach it. It is not a parallel of ADR 0007's endpoint, which is not a TCP listener [D].
- **No inbound webhooks (D-11).** A webhook would need a listener reachable from the internet. Integrations **poll** with backoff and the service's rate limits. Inbound events can come with cloud runners (Phase 5) [D].

### 7. Integration data is untrusted (INT-3)

Issue bodies, PR comments, chat messages and alerts are attacker-reachable text. Validated by schema and capped (decision 4), escaped in the UI, never sent to an agent automatically, and **taint source 7** (`integration_data`) when the user passes them to a run. PV-N1 wires source 7 [D; the enum is V].

### 8. Audit, in two rows per request

- **Before the credential is attached:** an `integration.credential` row (integration, operation, actor `user` or `plugin:<id>`, purpose). If it cannot be written, the request is refused and nothing is sent, as the providers binding audits its key read before use [V for that pattern; D here].
- **After the response:** an `integration.request` row (status, byte counts, duration, refusal reason). If it cannot be written, the response is discarded and the caller gets a closed error.
- Also `integration.connect` and `integration.disconnect`. Never a token, an argument value marked `content`, a body or a `Location` [D].

### 9. Forge credentials (D-8, D-9, O-5)

- **Phases 1c to 3:** ADR 0004 decision 9's "Axis stores no forge credentials" stands. The PR list is the user's `gh`, read-only, no stored token (PV-D2) [V].
- **From Phase 4a:** Axis **may** store one kind of forge credential: a **read-only, fine-grained, expiring** token in the vault, used only by the credential proxy (D-9 as taken). The first token-based integration (PV-N3, GitHub read-only) is therefore built in 4a; the "only if D-9 is reversed" wording of O-5 and D-8 is superseded by D-9 as decided. A **write-capable** forge credential is not decided here and needs a new owner decision [D].
- The `gh`-based PR list stays available; the token-based one does not replace it unless the user connects GitHub.

## Owner decisions recorded here

| # | Decision | Taken | Section |
|---|---|---|---|
| O-5 | PR data source | The user's `gh`, read-only, no stored token; a vault-token GitHub integration in 4a under D-9 | 9 |
| D-7 | OAuth redirect | Device-code flow with a main-built code dialog. The loopback fallback is **deferred** (project lead, 2026-11-22): a service without a device flow does not ship in 4a | 6 |
| D-8 | First integration | GitHub read-only through `gh` (PV-D2); a token-based GitHub integration (PV-N3) in 4a under D-9 | 9 |
| D-9 | "Axis stores no forge credentials" | Kept until 4a; then a vault-held, read-only, fine-grained token behind the proxy | 9 |
| D-10 | Integrations that write | Each write operation is its own permission and a tier-3 challenge | 2 |
| D-11 | Inbound webhooks | Not on desktop; polling only | 6 |
| D-14 | System proxy | Ignored in 4a; a proxy option needs its own design | 4 |

## Amendment to ADR 0004

Decision 9's engineering addition "Axis stores no forge credentials" holds until Phase 4a. From 4a, Axis may store a read-only, fine-grained, expiring forge token in the vault, used only by the daemon credential proxy (decision 9 above); a write-capable forge credential needs a new decision. Pushing and `gh pr create` keep using the user's own Git and `gh` credentials.

## Amendment to ADR 0008

Decision 6's dangerous combinations gain one line: **any `integration:<id>` together with any `net:<origin>`** reads "can send data from <integration> to <origin>", read-only integrations included, because the plugin can read service data through the proxy and post it to its own origin.

## Security implications

1. **New surface:** outbound requests carrying a stored credential; an address checker; a device-code OAuth flow. Each is trust-boundary code with an independent review and mutation testing of its refusal paths (design §10). No listener is added.
2. **Residuals:** a service that leaks or over-scopes a token on its own side; the system trust store and `NODE_EXTRA_CA_CERTS` (A7: no certificate pinning); **NAT64 behind an operator's network-specific prefix** cannot be told apart from a public IPv6 address, so an internal IPv4 host reachable through such a translator is not caught; a plugin with `integration:<id>` and a `net:` origin can move service data to that origin, which the install dialog now states (amendment to ADR 0008).
3. **Threat rows** INT-1 to INT-6 go into the threat model with PV-R8.

## Consequences

- **Positive:** one egress path with one set of checks for every integration and plugin request; credentials never leave the daemon; no new listener: the only listener class in a default desktop run stays ADR 0007's per-run CLI endpoint in the pty process, which is not TCP.
- **Negative:** a second HTTP client next to the provider adapter's `fetch`; integrations wait for main's secret broker; services without a device flow wait for a later decision.

## Validation criteria

**Accept** this ADR when the design's §9 4a integration lines pass (PV-N4), plus:

1. A canary credential, and a canary access and refresh token in a token response (including an invalid one), never appear in renderer state, plugin views, prompts, CLI environments, logs, audit or errors; a response echoing a credential is refused.
2. A host resolving to each refused range is refused, including `::ffff:127.0.0.1`, `::7f00:1`, `::ffff:0:7f00:1`, `64:ff9b::a9fe:a9fe`, `2002:7f00:1::`, `fec0::1`, `2001:2::1`, `2001:20::1` and `3fff::1`; the origins `https://2130706433`, `https://0x7f.1`, `https://127.1`, `https://[::1]` and a trailing-dot host are refused; a resolver that answers a public address first and a private one on the next lookup cannot redirect the connection (pinning).
3. With `HTTPS_PROXY` and `ALL_PROXY` set, the request goes to the checked address; the daemon refuses to start with `NODE_USE_ENV_PROXY` or `NODE_TLS_REJECT_UNAUTHORIZED` set; a self-signed server certificate is refused.
4. Arguments `../x`, `%2e%2e/x`, `%2E./x`, `a%2fb`, `a\b`, `1?a=b` and `1#x` are refused before any request; a template mismatch after composition is refused before the credential is attached; an `axis.net/1.request` with a `PUT`, a CRLF in the path or a dot segment is refused, and one to an integration's origin carries no credential.
5. A `3xx` answer is a closed error; nothing is sent to its `Location`, which appears nowhere; a gzip-encoded response is refused.
6. `connect` from a plugin or a non-user actor is refused; a token with excess scopes is refused; a device flow whose verification host is outside the declared origins is refused; a write operation without its permission is refused, and with it raises a tier-3 challenge showing the values sent.
7. No TCP listening socket exists in any Axis process during a default desktop run, including during a connect flow; the daemon owns no listening socket (ADR 0003 D1.1, DMN-4); the integration system adds no listener of any kind (the only listener class is ADR 0007's non-TCP CLI endpoint in the pty process).
8. A request whose `integration.credential` row cannot be written sends nothing; a response whose result row cannot be written is discarded.
9. A refresh whose new token cannot be stored keeps the old token and marks the integration "needs reconnect"; disconnect cancels in-flight requests and a later request finds no token in memory or the vault.
10. A `reveal` of an `integration:` entry with `provider_request`, or of a provider entry with `integration_request`, is refused and audited.

**Revisit** if the owner reverses any decision above, if PV-N1 cannot pin addresses with `node:https`, if a service without a device flow is wanted (the loopback decision), if a write-capable forge credential is wanted, or when a proxy option is designed.

## Rollback

Before 4a ships: revert this ADR; nothing depends on it. After: disconnecting every integration deletes every credential; removing the integration rows denies every request by default.

## Tickets this unblocks

PV-N1 (proxy, egress client, vault purposes and namespaces, the entry's environment refusals, taint source 7), PV-N2 (device-code OAuth only), PV-N3 (GitHub read-only token integration, under D-9 as taken), PV-N4 (gate evidence); ADR 0008's `net:<origin>` and `integration:<id>` permissions once this ADR is accepted; PV-R8 (threat model) follows.
