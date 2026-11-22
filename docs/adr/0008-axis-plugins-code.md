# ADR 0008, code map and divergences

Companion to `docs/adr/0008-axis-plugins.md`. Nothing of the plugin system is built, so this file does two things: it maps each claim the ADR makes about **existing** code to its anchor, and it lists every place where today's code, `docs/design/extensibility.md` ("the design"), the trust design or another ADR differs from the ADR, with the ticket that closes it. Verified on `origin/main` at `2d3909c`. Paths are relative to `packages/` unless they start with `code-oss/` or `docs/`; anchors are exported symbols, so they survive line moves.

## 1. Claims about existing code

| ADR | Claim | Code |
|---|---|---|
| Context, 3 | Three actor kinds; the identity schema refuses any other | `daemon/src/types.ts` `ActorId`; `daemon/src/identity.ts` `identitySchema` (`actor`, `clientKind: desktop \| web`) |
| Context | Main attests only `user`, desktop | `daemon-host/src/main/attest-sign.ts` `MainIdentity`; `main/connect-broker.ts` (identity built with `actor: "user"`) |
| Context, 4 | Every policy row admits only `user`; anything else is denied | `daemon-host/src/policy/rule-types.ts` `RuleActor`, `userRule`; `policy/rule-table-policy.ts` `RuleTablePolicy` |
| Context, 3 | `vscode:axisConnect` from anything that is not a code window's main workbench frame gets no port | `main/connect-broker.ts` `CONNECT_REFUSALS`, `isWorkbenchFrame`; `code-oss/overlay/src/vs/axis/code/electron-main/axisMainPorts.ts` (`getWindowByWebContents`) |
| 3 | Code windows are `w<n>`; the web client is `web` | `main/connect-broker.ts` `windowIdOf`; `policy/rule-table-policy.ts` `WEB_WINDOW_ID` |
| 3 | No plugin on the web client: web calls are limited to listed reads | `policy/rule-table-policy.ts` `WEB_ALLOWED`, `WEB_MAX_TIER` |
| Context, 4 | Only `user` resolves approvals, in the rows and in the handler | `daemon-host/src/policy/rules.ts` `axis.approvals/1.resolve`, `pending`; `daemon-host/src/handlers/approvals.ts` (`identity.actor !== "user"` → `E_NOT_FOUND`) |
| 4 | The coverage check compares the served registry with the rule tables | `policy/coverage.ts` `coverageProblems`, `servedMethods` |
| Context, 6 | Plugin principal and id format on the message wire | `protocol/src/messages-wire.ts` `pluginIdSchema`, `principalKey`, the `plugin` sender variant |
| Context, 6 | A plugin may address only the user and cannot open a thread | `daemon-host/src/messages/policy.ts` `mayAddress`, `newThreadProject` |
| 4 | A plugin message sender is audited as `daemon` with its id in the payload | `daemon-host/src/messages/audit.ts` `actorOf`, `who` |
| 9 | Plugin output is taint source 6; `plugin` is a sender kind | `protocol/src/taint.ts` `TAINT_SOURCES` (`plugin_output`), `TAINT_SENDER_KINDS` |
| 9 | A delivered plugin message is shown and tainted as a plugin sender | `daemon-host/src/messages/delivery.ts` (sender `plugin`, `taintKind: "plugin"`) |
| Context, 8 | Main reads gated settings from policy, application or user scope only (the CFG-1 pattern reused for enablement) | `daemon-host/src/main/settings-scope.ts` `userScopeValue` |
| Context, 6 | The vault exists as a package; its daemon wiring and any credential proxy do not | `vault/src/index.ts`; no `axis.integrations` contract in `protocol/src` |
| Context, 5 | No plugin view host exists | no `WebContentsView`, `fromPartition` or `webRequest` under `code-oss/overlay` |

## 2. Divergences

Each item is a place where existing code or a document says something the ADR changes, or a gap the ADR names. None is a defect today, because no plugin exists; each must be closed by the ticket named before that ticket's gate.

| # | Where | Today | ADR | Closed by |
|---|---|---|---|---|
| 1 | `daemon/src/types.ts` `ActorId`, `Identity`; `identity.ts` `identitySchema` | `user`, `daemon`, `agent:<id>`; `clientKind` `desktop` or `web`; no host window field | adds `plugin:<id>`, `clientKind: plugin` and `hostWindowId` (decision 3). **Built (PV-K1a):** the schema ties them (plugin kind ⇔ plugin actor ⇔ `p<n>` window, `w<n>` host and a project; `actorId` equals the actor and may be up to 71 characters; no other identity carries a `p<n>` window, a host window or a `plugin:` actorId); no row admits a plugin until PV-K1b, tested over every served method | PV-K1a |
| 2 | `protocol/src/messages-wire.ts` `pluginIdSchema` | up to four 64-character words, 259 characters | the 64-character cap is enforced at install (manifest validation); `axis.messages/1` is unchanged, since a plugin id reaches the wire only from main's attestation. Narrowing the schema stays an option for PV-K1 only if needed | PV-K2 (cap), PV-K1 (option) |
| 3 | `main/attest-sign.ts` `MainIdentity` | `actor: "user"`, `clientKind: "desktop"` only | a second signed shape for plugin views; the byte-equality test with the daemon's signer extends to it. **Built (PV-K1a):** `MainPluginIdentity`, `hostWindowId` signed; nothing mints one until PV-K1d | PV-K1a |
| 4 | `policy/rule-types.ts` `RuleActor`; `policy/coverage.ts` | `"user"` only; coverage knows no plugin table | a plugin allow-list table of closed per-permission method sets, plus a coverage deny list as a second fence (decision 4) | PV-K1 |
| 5 | `audit/src/log.ts` `AuditActor`; `messages/audit.ts` `actorOf` | no plugin actor; plugin senders recorded as `daemon` | `plugin:<id>` as the actor (decision 4). **Built (PV-K1a)** | PV-K1a |
| 6 | `daemon-host/src/handlers/messages.ts` (`USER`) | the bridge handlers build only the user caller; no plugin caller is ever built (ADR 0007 code map) | the binding builds a plugin caller from the attested plugin connection, never a payload | PV-K1, PV-K4 |
| 7 | `docs/design/extensibility.md` §3.3 | "no preload beyond a fixed Axis port shim" | the shim exposes no `contextBridge` global (ADR 0003 D7) and hands the port over with one `window.postMessage` | PV-K3 |
| 8 | the design §3.3 | WebRTC disabled "by a Chromium switch or a patch" | if neither works within the ADR 0002 budget, P1 does not ship (decision 5) | PV-K3 |
| 9 | the design §4 | integrity "checked at every load" | the served bytes are the bytes checked at this load, not files re-read after the check | PV-K2, PV-K3 |
| 10 | the design §4 extraction row | symlinks, hard links, absolute paths, `..`, three caps | adds NUL, backslash, drive letters, Windows reserved names, case-colliding entries, caps measured on decompressed bytes | PV-K2 |
| 11 | the design §4 curated list and §9 gate line | a list fetched from an origin, with a version and an expiry; the gate refuses a lower version, an expired list and an unknown key | the list ships inside the app release and is never fetched in v1; the expiry is **kept** (`notAfter`, default 180 days after the release build) to bound how long an old build trusts a revoked publisher key. An expired list refuses new curated installs and updates, while installed plugins keep running with a warning, so an app that is not updated never loses them. The §9 line is kept and extended (the note added there; validation criterion 5). A fetched list needs its own ADR | PV-K2, PV-R8 |
| 12 | the design §3.5 `net:<origin>`, `integration:<id>` | granted by the plugin system | refused at install until ADR 0009 is accepted | PV-R6 |
| 13 | the design §4 install and update | "the user approves" | through a main-built native dialog (EL-4 pattern) | PV-K2 |
| 14 | the design §3.3 identity; `project-registration-and-trust.md` §5.4 | "maps it to `plugin:<id>`"; trust is per call on the project (T1 to T4); `requireProjectTrust` takes `{ projectId, windowId, workspaceId?, signal }`, and T4 is keyed by window | fixes `actorId`, `windowId` `p<n>` (never reused), `hostWindowId` (fixed at creation) and `workspaceId`; `trusted` informational; plugin rows use the same trust modes and gate; **the gate gains `hostWindowId`** (T3 asks about the host window, T4 checks both ids): an amendment to the trust design §5.4 (decision 4) | PV-K1, with the trust slices |
| 15 | ADR 0010 page view (merged, #571) | `img-src` attachment scheme only, no bridge port | the plugin view keeps `img-src 'self' data:` and one port; same host otherwise | PV-Q2, PV-K3 |
| 16 | the design §3.3 | "workers get the same CSP"; nothing on other IPC | `worker-src 'none'`, service workers refused; main drops every IPC message from a plugin view (decisions 3, 5) | PV-K3 |
| 17 | the design §4 signature and extraction rows | signature over manifest and bundle hash; no version rule; no canonical form; no normalisation, duplicate, length or depth rule | domain-separated signature binding id, version and tier; the manifest canonicalised per RFC 8785 (JCS); the bundle hash over a sorted listing of path, size and content hash; no silent version downgrade; the extraction additions and the in-memory serving (decisions 5, 7, 8) | PV-K2, PV-K3 |
| 18 | the design §3.5 permissions; ADR 0010 user actions | permissions named, method sets not | each permission's exact method set and tier (decision 6 table); page export, restore, mark reviewed, delete and attachments, and task Start, excluded and on the deny list | PV-K1, PV-Q1, PV-T1 |

## 3. Not built (all of the ADR's decisions)

The principal and its attestation (PV-K1); the manifest, permissions, grant store, installer, extractor, signature and list verifier and the update diff (PV-K2); the host view, its partition, handlers, protocol handler and WebRTC switch (PV-K3); contribution points and taint source 6 (PV-K4); the contract tests (PV-K5). The threat-model rows PLG-1 to PLG-9 come with PV-R8.
