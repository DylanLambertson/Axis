# Request composition (PV-N1e)

- **Status:** built.
- **Date:** 2026-11-22.
- **Inputs:** ADR 0009 decision 3 (INT-6) and decision 1 (`axis.net/1`), `docs/design/integrations-contract.md`, `docs/design/egress-client.md`.
- **Code:** `packages/daemon-host/src/net/compose-request.ts`, `packages/daemon-host/src/net/url-pattern.ts`, and the shared path table in `packages/protocol/src/integrations-wire.ts` (`NET_PATH_REFUSALS`, `netPathRefusal`). Tests are in `packages/daemon-host/test/net/` (`compose-request`, `url-pattern`, `compose-property`, `net-compose`).

## 1. What it does

It turns a connector operation's template and typed arguments, or a plugin's `axis.net/1` path, into the one URL the egress client sends. It then checks the parsed URL against what was composed, before any credential is attached. It is pure code: no socket, no import of the egress client, no credential in composition. PV-N1f owns the order of match, then attach, then send, and the two audit rows.

## 2. Composition (ADR 0009 decision 3)

- **Templates:** an operation fixes its method (GET, HEAD or POST, the egress client's set) and its path template of literal and `{arg}` segments. It also fixes its declared query keys and, for a POST, the typed body fields. There is no free-form query, header or body. A bad template composes nothing (`template_invalid`).
- **Placeholder types:**
  - `int`: a safe integer, with an optional range;
  - `enum`: a closed set of unreserved tokens;
  - `id`: ASCII, letters, digits and `-._~`, or the template's own anchored pattern;
  - `text`: Unicode allowed.
- **Refused before encoding:**
  - an empty value;
  - a control character (C0, DEL, C1, U+2028 and U+2029, the bidi controls);
  - `/`, `?`, `#`, `\` and `;`;
  - ANY `%` (review 1 SF3): a split escape such as `%2%65` is no escape to a strict decoder but `%2e` to a lenient one, so a value holds no percent sign at all. Then the encoded value decodes to the same text however many times, strict or lenient, it is decoded (the property test checks three decodes);
  - `.` or `..` as a path segment; and in a `text` path segment any value whose NFKC or NFKD form holds a separator, a `%` or a control character or is a dot segment (a RULE, review 2 SF3: U+2025 and U+FE30 normalise to `..`, U+2100 to `a/c`; a test scans every code point), plus the slash look-alikes with no compatibility decomposition (U+2215, U+29F5 and others), and any Unicode default-ignorable code point (U+200B, U+00AD, the joiners and others, by the property: some servers strip them, so `.`, U+200B, `.` would read as `..`; N1e review 3). Also refused there, as the safe default for invisible characters that are not default-ignorable (N1f review 1 nit 5): every format character (Cf), every space separator but the ASCII space (Zs), and the blank glyphs no property names (U+2800, U+1D159, U+16FE4). The ASCII space stays, since a label name holds spaces. Also refused in a path value (N1f nits review B): any private-use or unassigned code point (Co, Cn: the noncharacters such as U+FDD0 and U+FFFE included), whose reading a server or a later Unicode version may set, and any value that is a dot segment once its combining marks are dropped (`.`, U+0301, `.`). A mark on a letter stays (`cafe` + U+0301). A query value may keep them;
  - **Residual (accepted):** values such as `. .`, `.. `, `...` and `....` are accepted. They are a dot segment only to a server that deletes spaces or trailing dots before it resolves the path, which no connector target is known to do (N1f follow-up review F).
  - a lone surrogate;
  - more than 256 UTF-8 bytes;
  - non-ASCII text unless the type is `text`.
  - `;` is refused because, encoded, it is `%3B`, which the contract refuses anywhere.
- **Unicode:** never normalised. A `text` value is UTF-8 percent-encoded once.
- **The one encoder** (`encodeValue`): every byte outside the unreserved set becomes `%XX` in upper case, the sub-delimiters `!'()*` included.
- **The integration** is recorded on every composed request (`integration_refused` for a malformed id), so a credential attaches only to a request of its own integration (§4).
- **Arguments:** exactly the template's own properties of the arguments object. Inherited ones are ignored; an unknown one is `argument_unknown` and a missing required one is `argument_missing`.
- **The re-check:** the composed path and query are judged by the contract's own refusal table, `netPathRefusal`. It is imported from `@axis/protocol`, never copied, and the protocol test checks that the schema and the table agree on the whole spelling table. The table refuses any `%25` in the path part (review 1 SF4: `/a/%25%32%65%25%32%65/b` is `/a/%2e%2e/b` after one decode).
- **`axis.net/1`:**
  - `read` is GET or HEAD; `send` is a POST with an optional JSON object body (`netBodySchema`).
  - The plugin's path is judged by the same table, and a control character is refused too.
  - The origin must pass `originSchema` (`origin_refused`).
- **Errors:** `CompositionError` carries a closed reason only. No argument, origin or path appears in it.

## 3. The final check (`matchTarget`)

It reads only the PARSED `target.url` that `egressTarget` returned for the composed URL, through the built-in `URL.prototype` getters (a URL subclass cannot lie through overridden getters, and a fresh parse of the href must give the same origin; review 2 SF2), and it compares ENCODED forms exactly:

- the origin;
- no userinfo, and no fragment (not even an empty `#`);
- for an operation:
  - every segment equal to the composed one and in the one spelling (upper-case hex);
  - the query pairs exactly the composed ones, in order, each key once and each with one `=`;
- for `axis.net/1`: the path and the query exactly the composed text;
- finally the whole `href` equal to the composed URL. Compose, then parse, must be the identity, or the request is refused (`identity`).

Tabs and newlines the parser strips are not seen, because the parsed URL is what is sent. A quote in an `axis.net/1` query, which the parser would encode, is refused rather than sent differently.

## 4. The snapshot and the credential

- **The snapshot (review 1 SF1):** a match reads each field of the composed request once and records the integration, the origin, the href, the method and a COPY of the body as frozen values in a module-private record. Nothing later reads the caller's target or composed objects again, so changing them after the match (`target.url.href = "https://evil.example/"`) changes nothing that is sent. A body whose buffer was detached (transferred) before the match is refused (`target`), never a throw (N1f nits review D).
- **The body copy** is taken by the typed-array slots (`src/net/bytes.ts`), so no caller code runs; a composed request whose body is not a real `Uint8Array` is refused (`target`).
- **The brand:** `matchTarget` returns a `MatchedTarget`, a frozen brand for that record (type level and run time). It is single-use, and a composed request can be matched once (`already_matched`, review 1 nit a). A malformed target or composed request is a closed refusal (`target`, nit d).
- **The credential (review 1 SF2):** `Credential` is created with its header value and its binding, one integration and one origin. The value is held in a module-private map, and `String`, `JSON.stringify` and `util.inspect` all show `[credential]`.
- **Attaching:** `authorize(matched, credential)` refuses anything but an unspent MatchedTarget (`not_matched`: a look-alike, a copy, an object inheriting from it, or a spent one). It also refuses a credential bound to another integration or origin (`credential_mismatch`), and a refused attach does not spend the match. The credential's origin is compared exactly and must pass the contract's origin schema; before attaching, a fresh parse of the snapshot's URL must give the bound origin (review 2).
- **The result:** an `AuthorizedRequest` built from the snapshot only: method, URL, origin, integration and a copy of the body. The header value is NOT a property (review 1 nit c): a spread, `structuredClone`, `v8.serialize` or `inspect` of the request shows none of it. The egress client TAKES it through `takeAuthorization(request)`, the only reader: single-use, refusing a copy, a forgery or a second take (`not_authorized`). It hands over the body bytes kept at match time, so changing the request's `body` array after authorize changes nothing that is sent. No non-spending reader is exported, and an import pin lets only the egress client import `takeAuthorization` (`scripts/code-oss/egress-client-imports.mjs`: no other shipped file may name it, or load url-pattern by namespace, default, re-export, `import()`, `require()` or `import =`), so no other daemon module can read the value (N1f review 1 nits 1 and 4, nits review A).
- **LIMIT:** the value is in daemon memory, so a debugger or a heap dump sees it. Nothing here defends against code running in the daemon itself.
- **The client side (built, the PV-N1f consumer):** the egress client OWNS the `authorization` header: `send()` refuses it in any spelling for any host (`header_refused`), and `sendAuthorized(request)` attaches it only from a genuine `AuthorizedRequest`, TAKEN once (`takeAuthorization`: a replay, a copy, a clone or a look-alike is `not_authorized` and sends nothing), to exactly that request's URL, origin, method and body (`docs/design/egress-client.md` §4).

## 5. Evidence

- Refusal tables cover every rule and type.
- A fixed-seed property test (seeds logged, 4,800 cases) shows that a value is either refused by an independent statement of the rule, or composes, parses and matches as the identity, with one decode giving it back.
- Hand-built requests prove each matcher check on its own.
- The mutation run is committed: `scripts/mutation/request-composition.mjs`, on the shared runner `scripts/mutation/run.mjs`. Every plain mutant must be killed. The 7 documented equivalents are RUN and must survive (a test that kills one fails the run as misclassified): the dot-segment fast path, the client's `isBytes` (it only refuses more), the fresh parse in match, NFKC-only, NFKD-only, authorize's fresh-parse recheck and `sendAuthorized`'s url and origin recheck. A missing test file, a spawn error or a timeout is an ERROR, never a kill. The egress client's own run is `scripts/mutation/egress-client.mjs` (2 runnable equivalents).
