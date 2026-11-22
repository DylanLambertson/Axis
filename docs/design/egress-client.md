# The daemon's egress client (PV-N1d)

- **Status:** slice A built (the target and address rules, and the pinning test); slice B (the client itself) follows.
- **Date:** 2026-11-22.
- **Inputs:** ADR 0009 decision 4 (network egress, INT-2, INT-3, D-14), `docs/security/threat-model-phase4a.md` TB24, `docs/design/integrations-contract.md` (the caps), `docs/design/net-gate.md`.
- **Code:** `packages/daemon-host/src/net/host.ts`, `packages/daemon-host/src/net/address.ts`; tests in `packages/daemon-host/test/net/`.

## 1. What it is for

One egress client in the daemon serves integrations (PV-N1f) and plugin `net:<origin>` requests alike. It is the only way from the daemon to the internet; nothing else in the daemon opens an outbound connection, and the daemon opens no listening socket (DMN-4).

## 2. Slice A: the rules, as pure functions

**Target** (`egressTarget(url, declared)`): a request goes only to an HTTPS origin in the declared set, written in exactly one spelling, so the origin match, the address check, SNI and the certificate check all see the same host. Refused, each with its own reason:

- not `https://` (`not_https`), a URL the WHATWG parser refuses or a backslash in the authority (`malformed`);
- userinfo, even empty (`userinfo`);
- an IP literal in any spelling: the WHATWG parser turns the decimal, octal, hexadecimal and short IPv4 forms into dotted quads and keeps IPv6 bracketed, and both are refused (`ip_literal`);
- a trailing dot, refused, never normalised (`trailing_dot`);
- any other difference between the host or port as written and as parsed: upper case, Unicode instead of punycode, a percent escape, a default port written out (`not_canonical`);
- an origin outside the declared set (`origin_not_declared`). Declared origins are kept only in `URL.origin` form (`declaredOrigins`); any other spelling can match nothing.

Only the host and the port are held to one spelling. The path and query are normalised by the WHATWG parser (`/a/%2e%2e/admin` becomes `/admin`, tabs and newlines are stripped, a backslash becomes a slash), so everything after the origin MUST be read from the parsed `target.url`, never from the raw input: the client (slice B) sends `target.url`'s path and query, with a test that the path sent is that one, and PV-N1e's URL-pattern check runs on `target.url` too.

**Addresses** (`addressRefusal(address)`, `resolvedRefusal(addresses)`): every address the lookup returned must be public unicast, or the request is refused (none returned is refused too).

- IPv4 excludes the fifteen ranges of the ADR (`IPV4_RESERVED`), checked on strict dotted decimal only: any other spelling is `malformed`.
- IPv6 must be inside `2000::/3`, minus `2001::/23`, `2001:db8::/32`, `3fff::/20` and `2002::/16` (`ipv6_not_global`, `ipv6_reserved`).
- An embedded IPv4 address (IPv4-mapped, IPv4-compatible, SIIT, the NAT64 prefixes `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4, Teredo's server and its client) is checked FIRST against the IPv4 list and refused with its own reason (`embedded_ipv4_reserved`), whatever the outer rule says.
- A zone id, bad compression or a bad word is `malformed`.

The reasons are internal (tests and the audit row of PV-N1f); the error a caller sees is closed and fixed (slice B).

## 3. The pinning test (ADR 0009's first test)

`test/net/agent-pinning.test.ts` pins the Node behaviour the client relies on, at Node 24.22.1: a dedicated `https.Agent` whose `lookup` answers with checked addresses connects to those and to nothing else (a decoy listening on `::1` at the server's own port, proven to accept by a control connection, receives nothing; a `.invalid` host proves the system resolver is never asked), asks for every address when `autoSelectFamily` is on, and keeps SNI and the certificate check on the original host (a certificate for another name fails at the checked address). It passed; the design stands. It needs `openssl` to make a test certificate: without it the test FAILS under the gate (`scripts/gate.mjs` sets `AXIS_REQUIRE_PINNING_TEST=1`) and in CI (`CI` set), and only a dev run skips it, with a reason that says the gate requires it.

## 4. Slice B (next, its own review)

- `src/net/egress-client.ts`: the ONE file in the daemon that loads `node:https`, pinned like the CLI endpoint template (an exact-import rule and a reach rule in `scripts/code-oss/web-rules.mjs`: no other daemon or host file may load `node:https`, `node:http`, `node:tls`, `node:net` or `node:dns`, statically or dynamically). The NET-GATE stays a TCP-listener check, and `net-gate.md` will state what it does and does not observe about outbound traffic.
- A dedicated agent: the `lookup` resolves once and returns only addresses `resolvedRefusal` accepts; `rejectUnauthorized: true`; no proxy; SNI and the certificate on the original host. A test-only CA seam that production wiring never sets (tested), never `NODE_EXTRA_CA_CERTS`.
- `3xx` is `redirect_refused` (its `Location` never read out); no `Accept-Encoding`, only `identity` accepted; the caps (request 1 MiB before sending, response 4 MiB, headers 16 KiB, JSON depth 64, 10 s to the first byte, 30 s in all), never a truncated result.
- At most 4 requests in flight per integration; `Retry-After` integer seconds only, backoff capped at 15 minutes, on an injected clock.
- Errors are closed: fixed text and the status only, never URL, header or body text (a canary test over errors and logs).
