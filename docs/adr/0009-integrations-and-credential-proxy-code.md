# ADR 0009, code map and divergences

Companion to `docs/adr/0009-integrations-and-credential-proxy.md`. Nothing of the integration system is built, so this file maps each claim the ADR makes about **existing** code to its anchor and lists every place where today's code, `docs/design/extensibility.md` ("the design") or another document differs from the ADR, with the ticket that closes it. Verified on `origin/main` at `0addd58`. Paths are relative to `packages/` unless they start with `code-oss/` or `docs/`; anchors are exported symbols or named steps.

## 1. Claims about existing code

| ADR | Claim | Code |
|---|---|---|
| Context, 5 | The vault stores through an injected backend, checks it on every store, audits reads with a closed purpose | `vault/src/types.ts` `SecretBackend`, `StoragePolicy`, `SECRET_PURPOSES`; `vault/src/vault.ts` `createVault`; `vault/src/consent.ts` |
| Context, 5, 8 | The providers binding is the only vault importer; key read per request, redactor first, audited, echo refused, an unwritable audit row refuses | `daemon-host/src/bindings/providers.ts` (module comment, `ProvidersBindingDeps`) |
| Context, 5 | The production entry passes no backend, so no key is read in a built app | `daemon-host/src/compose.ts` `composer.anthropic`; `daemon-host/src/entry.ts` (no `anthropic` option) |
| Context, 5 | Main's secret broker is not built; main uses `safeStorage` only for the audit anchor | `code-oss/overlay/src/vs/axis/code/electron-main/axisMainSeam.ts` (`safeStorageCipher`, `createAnchorStore`) |
| Context, 4 | The provider adapter's pattern: fixed origin, manual redirects, global `fetch` | `anthropic/src/limits.ts` `ANTHROPIC_ORIGIN`; `anthropic/src/adapter.ts` (`options.fetch(url, { …, redirect: "manual" })`); `anthropic/src/transport.ts` |
| 4 | The daemon entry refuses `NODE_OPTIONS` and inspector flags at start | `daemon-host/src/entry.ts` (module comment, step 1) |
| Context, 9 | The PR list runs the user's `gh` in the pty process, allow-listed environment, no token | `pty-process/src/forge-env.ts` `buildForgeEnv`, `forgeListArgv`; `pty-process/src/forge-list.ts` |
| Context, 7 | Taint source 7 and sender kind `integration` exist | `protocol/src/taint.ts` `TAINT_SOURCES` (`integration_data`), `TAINT_SENDER_KINDS` |
| Context | No integrations or net contract | no `axis.integrations` or `axis.net` in `protocol/src`; no row in `daemon-host/src/policy/rules.ts` or `planned.ts` |
| 6 | A local listener outside the daemon, in the pty process, relaying to the daemon | ADR 0007 decision 7.1 (decided; PV-M6 builds it) |

## 2. Divergences

| # | Where | Today | ADR | Closed by |
|---|---|---|---|---|
| 1 | `vault/src/types.ts` `SECRET_PURPOSES` | `provider_request`, `validate_connection` | adds `integration_request`, `integration_refresh`, `integration_validate` | PV-N1 |
| 2 | ADR 0003 D1.6; `entry.ts` | no secret broker, no production backend | integrations connect only once both exist | the secret-broker ticket (not yet cut), before PV-N1's gate |
| 3 | the design §7.3 "Node `fetch`" | the pinning mechanism left open | `node:https` with a dedicated agent and a checking `lookup` | PV-N1 |
| 4 | the design §7.3 proxy variables | names four variables | also Node's `NODE_USE_ENV_PROXY`: ignored by the dedicated agent, or refused at daemon start | PV-N1 |
| 5 | the design §7.3 address ranges | "private, loopback, link-local, metadata, mapped and NAT64" | an explicit range list, with 6to4 and Teredo and the embedded-IPv4 rule | PV-N1 |
| 6 | the design §7.2 composition | refuses `/`, `?`, `#`, dot segments, control characters | also `\`, `%2f`, `%5c`, mixed-case `%2e` | PV-N1 |
| 7 | the design §7.2 OAuth loopback | "a one-shot loopback listener" (place unstated) | in the pty process, relayed; never in the daemon or main | PV-N2 |
| 8 | the design §7.1 callers | integration operations from plugins and agents | no composer integration operations in 4a; data reaches runs only through the user (source 7) | PV-N1 |
| 9 | the design §7.3 caps | "byte, time and depth caps" | fixed: 1 MiB request, 4 MiB response, depth 64, 10 s and 30 s, 4 in flight | PV-N1 |
| 10 | ADR 0004 decision 9; tickets doc PV-N3 ("only if D-9 is reversed") | no forge credentials | a read-only fine-grained token from 4a (D-9 as taken), so PV-N3 is built in 4a; write-capable forge credentials need a new decision | PV-N3; the tickets doc row is updated with this ADR |
| 11 | ADR 0008 decision 6 | `net:` and `integration:` refused at install until this ADR is accepted | the egress client and proxy here serve both | PV-N1, then ADR 0008's install rule is lifted |
| 12 | threat model ANT-1 | the provider adapter accepts a system proxy (A7) | unchanged for the provider adapter; integrations ignore every proxy (D-14) | none (recorded difference) |

## 3. Not built

Everything the ADR decides: the contracts and their rows, the egress client, address checks and pinning, request composition, the vault purposes, OAuth with its main dialog and the pty-process relay, the audit events and taint source 7 (PV-N1, PV-N2); the GitHub token integration (PV-N3); the gate evidence (PV-N4). The threat-model rows come with PV-R8.
