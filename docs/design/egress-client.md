# The daemon's egress client (PV-N1d)

- **Status:** slice A built (the target and address rules, and the pinning test); slice B built (the client, its lint pin and import rules).
- **Date:** 2026-11-22.
- **Inputs:** ADR 0009 decision 4 (network egress, INT-2, INT-3, D-14), `docs/security/threat-model-phase4a.md` TB24, `docs/design/integrations-contract.md` (the caps), `docs/design/net-gate.md`.
- **Code:** `packages/daemon-host/src/net/` (`host.ts`, `address.ts`, `egress-client.ts`, `egress-limits.ts`, `egress-errors.ts`); tests in `packages/daemon-host/test/net/` and `test/packages/egress-client-rule.test.mjs`.

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

## 4. Slice B: the client

`src/net/egress-client.ts` is the ONE daemon file that may load node:https and node:dns, and it opens no listener.

- **Lint:**
  - It is pinned by its SHA-256 (`scripts/code-oss/web-rules.mjs` rule 1b, `EGRESS_CLIENT_SHA256`), checked wherever a source is scanned: the import lint, the staging hook and the staged-tree check. Any edit fails until the pin changes in the same reviewed change.
  - Its node:dns use must be exactly `import { lookup } from "node:dns"` (one line names node:dns, as a string). `node:dns/promises`, a default or namespace import, `Resolver` and the `resolve*` functions are therefore refused.
  - Every other daemon file is refused `node:https`, `node:http`, `node:tls`, `node:net` and `node:dns`, whether loaded statically, by `import()` or by `require` (a computed specifier is refused by the scanner itself).
  - Only the composition root may import the client (`EGRESS_CLIENT_IMPORTERS`, `egressClientEdgeRefusal`), and none does until PV-N1f. Whatever imports it may take only `createEgressClient`, `EGRESS_METHODS` and the client's types, by a static named import (`scripts/code-oss/egress-client-imports.mjs`). A namespace import (whose computed element access could reach the test factory), a default or side-effect import, a re-export, `import()`, `require()` and an `import()` type of the client are refused, so the test factory cannot be reached from src by any spelling (review 1 S1).
  - The NET-GATE stays a listener check (`net-gate.md`).
- **Resolution:**
  - The agent's `lookup` resolves with `{ all: true, order: "verbatim" }`. `order` is Node 24's name for the deprecated `verbatim: true`.
  - EVERY returned address passes through `resolvedRefusal` before the agent sees any. One reserved address among public ones refuses the request, as does none at all; nothing is filtered and continued.
  - The agent then connects only to those addresses (§3), with SNI and the certificate on the original host.
- **TLS:** `rejectUnauthorized: true` and `minVersion: "TLSv1.2"` on the agent (and the request), with Node's default CA store (its bundled list, plus `NODE_EXTRA_CA_CERTS` when set: RR-76). There is no proxy option, so no proxy applies; the entry refuses `NODE_USE_ENV_PROXY` and `NODE_TLS_REJECT_UNAUTHORIZED`, and a test runs a child with `NODE_USE_ENV_PROXY=1` and the proxy variables set: the target gets the request, the proxy nothing.
- **Path:** the path and query sent are `target.url`'s, never the raw input. A test sends `/v1/a/%2e%2e/items` and the server sees `/v1/items`.
- **Responses:**
  - A `3xx` is `redirect_refused` with its status, and `Location` is never read.
  - No `Accept-Encoding` is sent, and a caller may not set it or any other client-owned header (`header_refused`). Only `identity` is accepted (`encoding_refused`).
  - The caps:
    - request 1 MiB, refused before resolving (`request_too_large`);
    - response 4 MiB, and nothing is kept past it (`response_too_large`);
    - response headers 16 KiB (`maxHeaderSize`);
    - JSON depth 64, checked before parsing (`parseJsonBody`);
    - 10 s to the response headers and 30 s in all, on an injected clock.
  - Never a truncated result.
- **Rate:** at most 4 requests in flight per integration (`busy`). A `429` or `503` backs off for `Retry-After` when it is whole seconds, otherwise for 2, 4, 8 … seconds; a success resets the doubling. The cap is 15 minutes, and nothing is sent to that integration meanwhile (`rate_limited`).
- **Run-time checks (review 1 B1):** every field a caller passes is checked at run time before a slot is taken, whatever the types say: the method against `GET`, `HEAD` and `POST` (`method_refused`); the integration, the origins, the URL, the body (a `Uint8Array`, never on a read) and the signal (`request_refused`); the headers (`header_refused`). Any throw, before the request or inside it (a Node `TypeError` that would echo the input), becomes a closed error, and the slot is released on every path: a throw, an abort, a timeout, an error or an answer. A throw inside the lookup is `connect_failed`, never a hung request.
- **Byte copies and header names (review 3 nits):** a caller's body is recognised and copied by the internal typed-array slots only (`src/net/bytes.ts`: `isBytes`, `copyBytes`), so no subclass species, overridden getter or Proxy trap runs, and `Content-Length` is the copy's real length (a test sends a body whose `byteLength` lies). A header name is checked against the token rule before it is lower-cased, so U+212A (KELVIN SIGN), which lower-cases to `k`, is refused.
- **Errors:** `EgressError` carries a closed code, a fixed text and an integer status only. A Node error's message, which can name the host, is never read; only its code is mapped. The tests check that no URL, header or body text reaches an error.
- **Test seam:** `createEgressClientForTest` takes a CA, a dial map and either a resolver or a stand-in for the node:dns lookup on the system resolver path (so a test sees the options `{ all: true, order: "verbatim" }` and the order kept). Tests run against a local server while the address rule judges the resolver's public answer. `createEgressClient` passes none, and the pin freezes that. The production client is tested on `localhost` only (`address_refused`; the hosts file answers, so no DNS query leaves the machine in CI), and its `systemTrustOnly` is read from the agent's own options. `NODE_EXTRA_CA_CERTS` is never used by Axis code.

## 5. Residuals

- **RR-91 (new):** the system resolver is the trust anchor for names. A malicious resolver cannot reach a private range, but it can substitute another public address. TLS against the declared host is the control there.
- RR-76 (no certificate pinning) and RR-77 (operator-specific NAT64 prefixes) stand.
- RR-80 is closed by §3.
