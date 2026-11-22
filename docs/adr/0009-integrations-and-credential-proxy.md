# ADR 0009: Integrations and the credential proxy

- **Status:** Proposed. Becomes Accepted when the Phase 4a integration gate lines pass (ticket PV-N4, validation criteria below). The owner decisions it records (extensibility D-7 to D-11 and D-14, product vision O-5) are decided; the engineering decisions it adds are decided and revisable.
- **Date:** 2026-11-22.
- **Decision owner:** Dylan Lambertson. The owner delegated every open decision to the project lead on 2026-11-21; the decisions are recorded in `docs/design/owner-decisions-2026-11-21.md` §1 (O-5) and §4, and the owner can reverse any of them there.
- **Depends on:** ADR 0003 (bridge, D1.1 no daemon listener, D1.6 the privileged main port and secret broker, D4 approvals and native confirmation), ADR 0004 (decision 9, decision 14: the provider adapter's HTTP pattern), ADR 0007 (decision 7.1: a listener outside the daemon, in the pty process), ADR 0008 (the `plugin:<id>` principal and the `net:<origin>` and `integration:<id>` permissions it holds back for this ADR; in review, PR #576). All Proposed.
- **Amends:** ADR 0004 decision 9's engineering addition "Axis stores no forge credentials", **from Phase 4a only** (decision 9 below). **Keeps** ADR 0003 D1.1 and DMN-4: the daemon opens no listener, and the OAuth loopback exception lives in the pty process (decision 6).
- **Related:** `docs/design/extensibility.md` ("the design": §7, §8 INT-1 to INT-6, §9 4a integration lines, §11 D-7 to D-14), `docs/design/forge-pr-list.md` (PV-D2, the `gh`-based PR list), `docs/design/inter-agent-communication.md` §6.6 (taint source 7), `docs/design/product-vision-v2-tickets.md` (PV-N1 to PV-N4, PV-R8), `docs/security/threat-model-phase1.md` (PRV-1, PRV-2, PRV-5, ANT-1, DMN-4, DMN-5, DMN-6, EL-4, EL-5, NET-1, A7, A10).
- **Detail:** `docs/adr/0009-integrations-and-credential-proxy-code.md` maps each claim about existing code to its anchor and lists every divergence.
- **Evidence tags:** **[V]** verified in the code on `origin/main` at `0addd58` (file and symbol named); **[D]** decided here or in the design, not built; **[I]** inferred, not verified.

## Context

### Owner direction

The owner wants third-party services (forge, issue tracker, chat, monitoring) inside Axis (`product-vision-v2.md` §1). The design §7 proposes a daemon credential proxy; on 2026-11-21 its open decisions were taken as the recommended defaults (owner decisions §4: D-7 to D-11, D-14), and O-5 keeps the 1c PR list on the user's `gh` with no stored token.

### What exists on main

- **The vault package and its first binding.** `@axis/vault` stores named secrets through an injected `SecretBackend`, checks the backend on every store (PRV-1) and audits each read with a closed purpose [V, `packages/vault/src/types.ts` `SecretBackend`, `SECRET_PURPOSES` (`provider_request`, `validate_connection`); `vault.ts` `createVault`]. The providers binding (composer ticket C6) is the only importer: it reads the Anthropic key once per request, registers it with the host redactor first, audits the read and refuses a response that echoes it [V, `packages/daemon-host/src/bindings/providers.ts`].
- **No production secret backend.** The composition takes the backend as an option, and the daemon entry passes none, so in a built app no provider key is ever read [V, `daemon-host/src/compose.ts` `composer.anthropic`; no `anthropic` option in `entry.ts`]. Main's secret broker over the privileged port (ADR 0003 D1.6) is not built; main has a `safeStorage` cipher only for the audit anchor [V, `code-oss/overlay/src/vs/axis/code/electron-main/axisMainSeam.ts`, `safeStorageCipher`].
- **The outbound HTTP pattern (ANT-1).** A fixed `https` origin, `redirect: "manual"`, byte, depth and time caps, closed errors [V, `packages/anthropic/src/limits.ts` `ANTHROPIC_ORIGIN`; `adapter.ts` (`redirect: "manual"`)]. It uses Node's global `fetch`, so it cannot pin a checked address, and the threat model accepts a system proxy or trust store for it (ANT-1, A7) [V, threat model].
- **The forge today.** The 1c PR list runs the user's `gh` in the pty process with an allow-listed environment and no stored token (PV-D2, `forge-pr-list.md`) [V, `packages/pty-process/src/forge-env.ts` `buildForgeEnv`, `forge-list.ts`].
- **Taint source 7** (`integration_data`) and the sender kind `integration` are in the closed list; nothing produces them [V, `packages/protocol/src/taint.ts`].
- **Not built:** any `axis.integrations` or `axis.net` contract, any OAuth flow, any address check or pinning [V: none in `packages/protocol/src`].

## Options

The proxy's shape (the daemon composes every request and attaches the credential) was settled by the design and its two reviews. Two questions were open and touch earlier ADRs:

| | Question | Options | Taken |
|---|---|---|---|
| Q1 | How the proxy reaches the network | (a) Node's global `fetch`, like the provider adapter; (b) **`node:https` with a dedicated agent and a `lookup` that checks and pins every address** | (b): global `fetch` cannot pin the checked address (DNS rebinding) and can be routed through an environment proxy [I: Node's `NODE_USE_ENV_PROXY`] |
| Q2 | Where the one-shot OAuth loopback listens, when a service has no device flow | (a) the daemon (breaks ADR 0003 D1.1 and DMN-4); (b) main; (c) **the pty process, relaying the one redirect to the daemon**, as ADR 0007 7.1 does for the CLI endpoint | (c): main stays free of network listeners; with PKCE the code alone is useless to the pty process |

## Decision

### 1. The credential proxy is the only way out

- Every integration request, and every plugin `net:<origin>` request (ADR 0008 decision 6), is made **by the daemon**. No plugin, renderer, composer prompt, CLI environment or log ever sees an integration credential (PRV-2, DMN-6, INT-1) [D].
- **Contracts.** `axis.integrations/1`: `list` and `status` (reads), `connect` and `disconnect` (user-only), `request { integrationId, operation, args }`. `axis.net/1.request { origin, path, method, body? }` for plugins with `net:<origin>`. There is no raw URL, header, cookie or credential field in any request; ADR 0003 D7 forbids credentials in any response schema [D].
- **Who may call `request`.** The user's built-in surfaces and a plugin holding `integration:<id>` for that integration and project. **Composer agents get no integration operation in 4a**: integration data reaches a run only when the user passes it, as taint source 7 (design §7.5). CLI agents never: they have their own credentials and network as the user [D].

### 2. An integration is a typed connector

- A fixed set of HTTPS origins; an auth method; a **closed set of operations**, each with a fixed HTTP method, a path template, typed arguments and a response schema; a scope (project or Space). Built in, or contributed by a plugin in 4a under ADR 0008 [D].
- **Read-only by default.** Each **write** operation (comment on a PR, move an issue) is its **own permission** and a **tier-3 challenge** that shows the integration, the operation and the exact values sent (D-10) [D].

### 3. Request composition (INT-6)

Each operation fixes its method and path template. Each argument is a schema-typed value placed into one named path segment or one declared query parameter and percent-encoded. A value holding `/`, `?`, `#`, `\`, a literal or percent-encoded dot segment (`.`, `..`, `%2e`, `%2E`, mixed), `%2f`, `%5c` or any control character is **refused before encoding**. No free-form query, header or body passthrough: a body, when an operation has one, is built from typed fields. The final URL is parsed and matched against the operation's URL pattern (origin, path segments, query keys) **before** the credential is attached; a mismatch is refused and audited [D].

### 4. Network egress (INT-2, D-14)

One egress client in the daemon serves integrations and `net:<origin>` alike [D, every item]:

- **HTTPS only**, to an origin in the integration's declared set (or the plugin's granted `net:` origins). **IP-literal origins are refused**, as are origins with userinfo, a non-default port not declared, or a non-ASCII host not in its punycode form.
- **Address checks and pinning.** The client resolves the host itself, refuses the request if **any** returned address is not public unicast, and connects to a checked address with TLS server name and certificate checks against the original host. Refused ranges: IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (cloud metadata included), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`; IPv6 `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `2001::/32` (Teredo); and for the IPv4-embedding forms **IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, and 6to4 `2002::/16`**, the embedded IPv4 address is checked against the IPv4 list. Implemented with `node:https`, a dedicated agent and a `lookup` function (Q1) [I: the pinning behaviour at Node 24.22.1 is PV-N1's first test].
- **Proxies ignored (D-14).** `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` and the system proxy do not apply to this client, so the address check tests the real destination. If PV-N1 cannot show that the dedicated agent ignores Node's environment-proxy support (`NODE_USE_ENV_PROXY`) [I], the daemon entry refuses to start with that variable set, as it already refuses `NODE_OPTIONS` [V for `NODE_OPTIONS`, `daemon-host/src/entry.ts` step 1]. A proxy option needs its own design, and the address check must then move to the proxy's resolution.
- **Redirects** are never followed across origins and never with the credential; a same-origin redirect is not followed either in v1 (the operation's URL is fixed).
- **Caps:** request body 1 MiB; response 4 MiB, JSON depth 64, 10 s to first byte, 30 s total; responses validated by the operation's schema; error text built from fixed strings and the status, never the body.
- **Rate:** per integration at most 4 requests in flight; polling honours the service's rate-limit headers with backoff.
- **P2 processes are not covered:** they reach the network as the user, as ADR 0008 states at install.

### 5. Credentials in the vault (PRV-1, PRV-2, D-9)

- Tokens are vault entries; **PRV-1 applies** (consent or refusal on Linux `basic_text`; the UI shows the backend). The vault gains closed purposes `integration_request`, `integration_refresh` and `integration_validate`; each read is audited with its purpose, never the value [D; the purpose list is V and closed today].
- **The plaintext lives only in the daemon**, read immediately before the request, registered with the host redactor before use, never kept in a run row, event, error or log, and a response that echoes it is refused, as the providers binding already does for the Anthropic key [V for that pattern, `bindings/providers.ts`; D for integrations]. For OAuth, the vault holds the refresh token; the access token is kept in daemon memory only, registered with the redactor, until it expires.
- **Production backend.** Integrations ship only once main's secret broker over the privileged port (ADR 0003 D1.6) exists and the daemon entry passes it; until then no integration can connect [D; V that neither exists today].
- **Scopes (INT-5).** Prefer the narrowest credential the service offers (fine-grained, read-only, expiring). The granted scopes are recorded at connect and shown. **A token whose granted scopes exceed the integration's declared scopes is refused.** A service whose granted scopes cannot be read back cannot ship a token-based integration until its per-service review names how they are verified [D].
- **Revocation.** Disconnect deletes the vault entry and, where the service has an API for it, revokes the token. Disconnect is user-only and needs no dialog: it only lowers privilege [D].

### 6. Connecting: OAuth (D-7, INT-4)

- **Connecting is user-only** (a policy row admitting `user` alone), and a plugin's `integration:<id>` grant never includes connect [D].
- **Device-code flow first.** The daemon starts the flow; **main** shows the user code and the verification host in a **native dialog it builds** (EL-4: not plugin or renderer text, which limits device-code phishing), and opens the verification URL in the system browser under the EL-5 rules. The daemon polls the token endpoint under decision 4's rules [D].
- **One-shot loopback, only when a service lacks the device flow**, recorded here as a **NET-1 exception**: a listener bound to `127.0.0.1` (never `0.0.0.0` or `::`) on a random port, **in the pty process** (Q2), open only during the flow and closed after the first request or 5 minutes. The authorization request uses PKCE `S256` and a 128-bit `state`; the pty process relays the one redirect's `code` and `state` to the daemon over its control channel and answers the browser with a fixed page; the daemon checks `state` in constant time and exchanges the code with the verifier, which never leaves the daemon. The daemon opens no listener (ADR 0003 D1.1, DMN-4 hold) [D].
- **No inbound webhooks (D-11).** A webhook would need a listener reachable from the internet. Integrations **poll** with backoff and the service's rate limits. Inbound events can come with cloud runners (Phase 5) [D].

### 7. Integration data is untrusted (INT-3)

Issue bodies, PR comments, chat messages and alerts are attacker-reachable text. Validated by schema and capped (decision 4), escaped in the UI, never sent to an agent automatically, and **taint source 7** (`integration_data`) when the user passes them to a run. PV-N1 wires source 7 [D; the enum is V].

### 8. Audit

`integration.connect`, `integration.disconnect`, `integration.request` (integration, operation, actor `user` or `plugin:<id>`, status, byte counts, duration, refusal reason) and `integration.credential` (purpose, outcome). Never a token, an argument value marked `content`, or a body. A request whose audit row cannot be written is refused, as for provider keys (DMN-5) [D; the pattern is V in `bindings/providers.ts`].

### 9. Forge credentials (D-8, D-9, O-5)

- **Phases 1c to 3:** ADR 0004 decision 9's "Axis stores no forge credentials" stands. The PR list is the user's `gh`, read-only, no stored token (PV-D2) [V].
- **From Phase 4a:** Axis **may** store one kind of forge credential: a **read-only, fine-grained, expiring** token in the vault, used only by the credential proxy (D-9 as taken). The first token-based integration (PV-N3, GitHub read-only) is therefore built in 4a. A **write-capable** forge credential is not decided here and needs a new owner decision [D].
- The `gh`-based PR list stays available; the token-based one does not replace it unless the user connects GitHub.

## Owner decisions recorded here

| # | Decision | Taken | Section |
|---|---|---|---|
| O-5 | PR data source | The user's `gh`, read-only, no stored token; a vault-token GitHub integration only in 4a | 9 |
| D-7 | OAuth redirect | Device-code flow with a main-built code dialog; a one-shot loopback listener only as a recorded NET-1 exception | 6 |
| D-8 | First integration | GitHub read-only through `gh` (PV-D2); a token-based GitHub integration (PV-N3) in 4a under D-9 | 9 |
| D-9 | "Axis stores no forge credentials" | Kept until 4a; then a vault-held, read-only, fine-grained token behind the proxy | 9 |
| D-10 | Integrations that write | Each write operation is its own permission and a tier-3 challenge | 2 |
| D-11 | Inbound webhooks | Not on desktop; polling only | 6 |
| D-14 | System proxy | Ignored in 4a; a proxy option needs its own design | 4 |

## Amendment to ADR 0004

Decision 9's engineering addition "Axis stores no forge credentials" holds until Phase 4a. From 4a, Axis may store a read-only, fine-grained, expiring forge token in the vault, used only by the daemon credential proxy (decision 9 above); a write-capable forge credential needs a new decision. Pushing and `gh pr create` keep using the user's own Git and `gh` credentials.

## Security implications

1. **New surface:** outbound requests carrying a stored credential; an address checker; an OAuth flow; a short-lived loopback listener in the pty process for services without a device flow. Each is trust-boundary code with an independent review and mutation testing of its refusal paths (design §10).
2. **Residuals:** a service that leaks or over-scopes a token on its own side; the system trust store (A7: no certificate pinning); a compromised pty process during a loopback flow sees one authorization code, which is useless without the PKCE verifier; a plugin with `integration:<id>` read access and a `net:` origin can move service data to that origin, which the install dialog states (ADR 0008 decision 6).
3. **Threat rows** INT-1 to INT-6 go into the threat model with PV-R8, with the NET-1 exception of decision 6.

## Consequences

- **Positive:** one egress path with one set of checks for every integration and plugin request; credentials never leave the daemon; no listener in the daemon.
- **Negative:** a second HTTP client next to the provider adapter's `fetch`; integrations wait for main's secret broker; services without a device flow need the pty-process relay.

## Validation criteria

**Accept** this ADR when the design's §9 4a integration lines pass (PV-N4), plus:

1. A canary credential never appears in renderer state, plugin views, prompts, CLI environments, logs, audit or errors; a response echoing it is refused.
2. A host resolving to each refused range, including `::ffff:127.0.0.1`, `64:ff9b::a9fe:a9fe` and `2002:7f00:1::`, is refused; an IP-literal origin is refused; a resolver that answers a public address first and a private one on the next lookup cannot redirect the connection (pinning).
3. With `HTTPS_PROXY`, `ALL_PROXY` and `NODE_USE_ENV_PROXY=1` set, the request goes to the checked address, or the daemon refuses to start.
4. Arguments `../x`, `%2e%2e/x`, `%2E./x`, `a%2fb`, `a\b`, `1?a=b` and `1#x` are refused before any request; a template mismatch after composition is refused before the credential is attached.
5. A cross-origin and a same-origin redirect are not followed, and the credential is not sent.
6. `connect` from a plugin or a non-user actor is refused; a token with excess scopes is refused; a write operation without its permission is refused, and with it raises a tier-3 challenge showing the values sent.
7. No listener exists outside an active loopback flow; the loopback listener is on `127.0.0.1` in the pty process, accepts one request, refuses a wrong `state`, and is gone after it or after 5 minutes; the daemon owns no listening socket.
8. A request whose audit row cannot be written is refused.

**Revisit** if the owner reverses any decision above, if PV-N1 cannot pin addresses with `node:https`, if a write-capable forge credential is wanted, or when a proxy option is designed.

## Rollback

Before 4a ships: revert this ADR; nothing depends on it. After: disconnecting every integration deletes every credential; removing the integration rows denies every request by default.

## Tickets this unblocks

PV-N1 (proxy, egress client, vault purposes, taint source 7), PV-N2 (OAuth), PV-N3 (GitHub read-only token integration, under D-9 as taken), PV-N4 (gate evidence); ADR 0008's `net:<origin>` and `integration:<id>` permissions once this ADR is accepted; PV-R8 (threat model) follows.
