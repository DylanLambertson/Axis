# ADR 0009, code map and divergences

Companion to `docs/adr/0009-integrations-and-credential-proxy.md`. Nothing of the integration system is built, so this file maps each claim the ADR makes about **existing** code to its anchor and lists every place where today's code, `docs/design/extensibility.md` ("the design") or another document differs from the ADR, with the ticket that closes it. Verified on `origin/main` at `15be311`. Paths are relative to `packages/` unless they start with `code-oss/`, `docs/`, `test/` or `scripts/`; anchors are exported symbols or named steps.

## 1. Claims about existing code

| ADR | Claim | Code |
|---|---|---|
| Context, 5 | The vault stores through an injected backend, checks it on every store, audits reads with a closed purpose; `reveal` takes a name and a purpose and binds no entry kind | `vault/src/types.ts` `SecretBackend`, `StoragePolicy`, `SECRET_PURPOSES`; `vault/src/vault.ts` `createVault`, `ConnectionVault.reveal`; `vault/src/consent.ts` |
| Context, 5, 8 | The providers binding is the only allowed vault importer; key read per request, redactor first, audited before use, echo refused | `daemon-host/src/bindings/providers.ts` (module comment, `ProvidersBindingDeps`); `test/packages/imports.test.mjs` (`@axis/vault` → `src/bindings/providers.ts` only); `scripts/code-oss/stage-scan.mjs` `RESTRICTED_MODULES` |
| Context, 5 | The production entry passes no backend, so no key is read in a built app | `daemon-host/src/compose.ts` `composer.anthropic`; `daemon-host/src/entry.ts` (no `anthropic` option) |
| Context, 5 | Main's secret broker is not built; main uses `safeStorage` only for the audit anchor | `code-oss/overlay/src/vs/axis/code/electron-main/axisMainSeam.ts` (`safeStorageCipher`, `createAnchorStore`) |
| Context, 4 | The provider adapter's pattern: fixed origin, manual redirects, global `fetch` | `anthropic/src/limits.ts` `ANTHROPIC_ORIGIN`; `anthropic/src/adapter.ts` (`options.fetch(url, { …, redirect: "manual" })`); `anthropic/src/transport.ts` |
| Context, 4 | The daemon entry refuses `NODE_OPTIONS`, inspector flags and any `execArgv`; it does not check `NODE_TLS_REJECT_UNAUTHORIZED` or `NODE_USE_ENV_PROXY` | `daemon-host/src/entry.ts` step 1 (`node_options_refused`, `debug_flag_refused`, `exec_args_refused`) |
| Context, 9 | The PR list runs the user's `gh` in the pty process, allow-listed environment, no token | `pty-process/src/forge-env.ts` `buildForgeEnv`, `forgeListArgv`; `pty-process/src/forge-list.ts` |
| Context, 7 | Taint source 7 and sender kind `integration` exist | `protocol/src/taint.ts` `TAINT_SOURCES` (`integration_data`), `TAINT_SENDER_KINDS` |
| Context | No integrations or net contract | no `axis.integrations` or `axis.net` in `protocol/src`; no row in `daemon-host/src/policy/rules.ts` or `planned.ts` |
| Amendment to 0008 | ADR 0008's dangerous combinations name read grants or a write-capable integration with `net:` | `docs/adr/0008-axis-plugins.md` decision 6, "Dangerous combinations" |

## 2. Divergences

| # | Where | Today | ADR | Closed by |
|---|---|---|---|---|
| 1 | `vault/src/types.ts` `SECRET_PURPOSES`; `vault.ts` `reveal` | two provider purposes; no entry kind | `integration:<id>` entries; three integration purposes; each purpose valid only for its entry kind, a mismatch refused and audited | PV-N1 |
| 2 | `bindings/providers.ts` note; `test/packages/imports.test.mjs`; `scripts/code-oss/stage-scan.mjs` | providers binding is the only allowed importer of `@axis/vault` | the integrations binding is a second allowed importer | PV-N1 |
| 3 | ADR 0003 D1.6; `entry.ts` | no secret broker, no production backend | integrations connect only once both exist | the secret-broker ticket (not yet cut), before PV-N1's gate |
| 4 | `entry.ts` step 1 | refuses `NODE_OPTIONS` only among environment variables | also refuses `NODE_USE_ENV_PROXY` and `NODE_TLS_REJECT_UNAUTHORIZED` | PV-N1 |
| 5 | the design §7.3 "Node `fetch`" | the pinning mechanism left open | `node:https` with a dedicated agent, a checking `lookup` and `rejectUnauthorized: true` | PV-N1 |
| 6 | the design §7.3 address ranges | "private, loopback, link-local, metadata, mapped and NAT64" | IPv4 list; IPv6 public unicast = inside `2000::/3` minus documentation, Teredo and 6to4; the embedded-IPv4 rule; WHATWG-parsed IP literals; trailing-dot hosts refused; the operator-NAT64 residual | PV-N1 |
| 7 | the design §7.2 composition | refuses `/`, `?`, `#`, dot segments, control characters | also `\`, `%2f`, `%5c`, mixed-case `%2e`; `axis.net/1.request` gets the same refusals, `GET`/`HEAD`/`POST` only, and never a credential | PV-N1 |
| 8 | the design §7.3 redirects and caps | "not followed across origins"; "byte, time and depth caps" | every `3xx` a closed error, `Location` never kept; identity encoding only, caps on decoded bytes; 1 MiB, 4 MiB, depth 64, 10 s, 30 s, 4 in flight; integer `Retry-After`, backoff capped at 15 minutes | PV-N1 |
| 9 | the design §7.2 OAuth; owner decision D-7 | device flow, else a one-shot loopback listener | device flow only in 4a; the loopback is deferred to its own decision with a 1a/L29 amendment; verification host within declared origins; `interval`, `slow_down` and `expires_in` caps; token-endpoint redaction and rotation order | PV-N2 |
| 10 | the design §7.1 callers | integration operations from plugins and agents | no composer integration operations in 4a; data reaches runs only through the user (source 7) | PV-N1 |
| 11 | the design §7 audit | one request event | two rows: `integration.credential` before attach (failure refuses), `integration.request` after (failure discards the response) | PV-N1 |
| 12 | ADR 0004 decision 9; owner decisions O-5 and D-8; tickets doc PV-N3 | "only if D-9 is reversed" | superseded by D-9 as decided: a read-only fine-grained token from 4a, PV-N3 built in 4a; write-capable forge credentials need a new decision. The owner-decisions rows are updated with this ADR | PV-N3 |
| 13 | ADR 0008 decision 6 | `net:` and `integration:` refused at install until this ADR is accepted | the egress client and proxy here serve both | PV-N1, then ADR 0008's install rule is lifted |
| 14 | ADR 0008 decision 6, dangerous combinations | read-only `integration:<id>` with `net:<origin>` not flagged | flagged: "can send data from <integration> to <origin>" (amendment) | PV-K2 |
| 15 | threat model ANT-1 | the provider adapter accepts a system proxy (A7) | unchanged for the provider adapter; integrations ignore every proxy (D-14) | none (recorded difference) |

## 3. Not built

Everything the ADR decides: the contracts and their rows, the egress client, address checks and pinning, request composition, the vault namespaces and purposes, the entry's environment refusals, device-code OAuth with its main dialog, the two audit rows and taint source 7 (PV-N1, PV-N2); the GitHub token integration (PV-N3); the gate evidence (PV-N4). The threat-model rows come with PV-R8.
