# Decision note: the tier of integration writes and `axis.net/1.send`

- **Status:** **DECIDED: option C**, by owner delegation on 2026-11-27 (reversible). §4 records the decision and what it takes to implement. Nothing here is built yet, and RR-92 changes only when the raise ships.
- **Question:** should `axis.integrations/1.write` and `axis.net/1.send` require main's native confirmation (tier 4) before any real credential is stored? Both contracts declare tier 3 today (`packages/daemon-host/src/policy/planned.ts`, `docs/design/integrations-contract.md` §1). They are planned contracts, not served, so every call is denied today. RR-92 accepts tier 3.
- **Inputs:**
  - ADR 0003 I3: tiers 4 and 5 need `approvals.confirmNative`; the policy can raise a contract's tier, never lower it.
  - ADR 0009 decisions 1 and 2 and D-10.
  - ADR 0011 §"Security" items 1 and 2.
  - INT-13 (threat model 4a).
  - `docs/design/plugin-run-start.md` §3.1.

## 1. What tier 3 and tier 4 mean here

- **Tier 3:** the daemon raises a challenge bound to a digest of the request. The user resolves it in the app's approval card, a core-shell component that module content, pages and plugin views cannot draw or imitate (ADR 0011). Only a `user` actor resolves it, so a plugin or a worker cannot approve its own call.
- **Tier 4:** the same digest-bound challenge, plus main's native dialog (`packages/challenge/src/manager.ts`: `native = tier >= 4`). A compromised renderer cannot click or cover the dialog (EL-4).
  - The dialog shows a one-line SUMMARY the daemon builds (`main/native-queue.ts` hands the dialog the summary string, not the digest).
  - The digest binds the approval to the exact request, whatever the line shows.
- **What tier 3 leaves open (RR-92):** a compromised renderer can approve its own outbound write. That means a comment, an issue move or a plugin's POST, sent with the user's credential to a declared origin.
  - The credential itself never reaches the renderer: the vault and the egress client are daemon-side, and the client owns the `authorization` header.
  - Today this is accepted under A10 ("the renderer is the user").
- **What changes with ADR 0011:** our own renderer has much less authority than the Code OSS renderer did: no file system, no pty and no `encryption` channel (ADR 0011 §"Security" item 1). So A10 is a weaker assumption than before, and a renderer compromise is more likely to be the attacker's ONLY foothold. In that case, the native dialog is the one control left between the attacker and an outbound write made with the user's credential.

## 2. Options

| | Option | Contract | Effect |
|---|---|---|---|
| **A** | Keep tier 3 (status quo) | unchanged | RR-92 stays accepted. Approval cards in the renderer only. |
| **B** | Raise both contracts to tier 4 | a pre-release change of the contract minimum, like `worktrees.finalise` (2026-11-05) | Native dialog for every write and every send. Lowering it later needs a new major version. |
| **C** | Contracts stay at minimum 3; the **shipped policy raises both to 4** | unchanged | Native dialog for every write and every send. A later per-integration relaxation needs no contract change (§4.3). |
| **D** | Tier 4 for `integrations.write` only | as C, for one method | Native dialog for connector writes. Plugin POSTs rely on the per-plugin budget (OI-9, RR-87) and the card. |

## 3. Effect on the user

- **The first credential milestone costs nothing.** The first connector is GitHub read-only (PV-N3, D-9 as taken), and plugin `net:` sends are not enabled with it. So C adds no dialog while only the built-in read-only connector holds a credential.
- **This is not true of all of Phase 4a.** PV-K is in the same phase, and a granted plugin can POST to its `net:` origin. Once plugin sends are enabled, C adds one native dialog per send, and per connector write once a write connector exists.
- **With writes or sends:** one native dialog per request, carrying the line of §4.1. That is one more click than the card per write.
  - For a deliberate user comment, that is acceptable.
  - For a plugin that POSTs often, it is noisy. A per-integration relaxation (§4.3) is the release valve; it needs its own design first.
- **No batching is assumed.** A tier 4 challenge confirms one request digest. "Confirm the next N" would be a new design.
- **Copy:** the card for these methods says the confirmation appears in a system dialog. Under A, no copy may call it native (ADR 0011 item 2).

## 4. Decision: option C

**Decided** by owner delegation on 2026-11-27, reversible:
- `axis.integrations/1.write` and `axis.net/1.send` keep the contract minimum 3, and the shipped policy raises both to 4 before any credential is stored.
- Any later per-integration relaxation is a main-drawn confirmation and never goes below the contract minimum.

**Why C:**
- **Over A:** A10 is weaker with our own renderer (§1).
- **Over B:** B gives the same protection, but relaxing it later would need a breaking contract change.
- **Over D:** a plugin POST carries the user's data to a third-party origin, at least as sensitive as a connector write; its budget bounds how much leaves, not whether it should.

**C is NOT only a table change.** The runtime raise works today: `RuleTablePolicy` returns tier 4 for a minimum-3 method with a tier-4 row, and the pipeline takes the higher tier. But two prerequisites must be built and reviewed first.

### 4.1 Prerequisite 1: coverage accepts a policy raise

- **The problem:** `policy/coverage.ts` requires a rule's tier to EQUAL the contract's tier, for served and planned rows alike. The host and the composition run it at start (`host.ts`, `compose.ts`), so a raised row makes the daemon refuse to start.
- **The change:**
  - Raise the rows in `policy/planned.ts` now, and in `policy/rules.ts` when the methods are served.
  - Change coverage to accept a row ABOVE the contract tier (within the tier range) and keep refusing one below it or out of range. Update the equality-based tests and the table comments that state equality.
  - The protocol minima stay 3.
- **Tests:**
  - start-up with the raised rows;
  - the challenge is issued and executed at tier 4;
  - a row below the minimum is refused at start.

### 4.2 Prerequisite 2: a plugin tier-4 path for the two outbound methods

- **The problem:** a plugin send at tier 4 is denied today, by design.
  - `policy/plugin-rules.ts` caps a plugin call at `PLUGIN_MAX_TIER = 3`, and plugin coverage refuses a set at tier 4 or more.
  - `RuleTablePolicy` denies an effective plugin tier above 3.
  - `gate/plugin-approvals.ts` refuses a plugin challenge at tier 4 or more before issuing it.
  - The native wait is reserved on the calling connection's window (`gate/approvals.ts`), not the plugin view's attested host window.
- **What is needed (its own reviewed design, before any plugin can send):**
  - a narrow exception to the plugin ceiling for exactly `axis.integrations/1.write` and `axis.net/1.send`, with every other tier-4 plugin method still denied;
  - challenge preparation for those two;
  - native routing to the ATTESTED host window;
  - binding of the native proof to that challenge;
  - revocation and connection checks after the dialog.
- **Tests:**
  - a granted plugin send gets a native dialog in its host window;
  - an unrelated tier-4 plugin method is still denied;
  - closing the plugin view or the host during the dialog refuses the effect.

### 4.3 The per-integration relaxation: to be designed before it is promised

- **The problem:** the policy input today holds the method, the identity and the tier; it has no integration argument, and the rule table is method-wide. A per-integration setting therefore needs a daemon-owned override, consulted by the policy for these two methods, that does not exist yet.
- **Requirements:**
  - Changing the setting is itself a main-drawn confirmation, like the OS-4 `axis.cliAgents` change.
  - It can never set a tier below the contract minimum, and a renderer call can never set it.
  - It is designed, reviewed and tested (setting, scoped evaluation, the native-confirmed change, no lowering below 3) before any copy offers it.
- **RR-92:** changes only when the raise ships, to "closed by policy: tier 4 by default".

### 4.4 The native dialog line

The dialog's one-line detail is built by the daemon, the same way as the task Start line (`daemon-host/src/tasks/confirm.ts`). The full request is a separate thing, shown in the approval card, escaped, and bound by digest.

- **Why a separate line:** the dialog's sanitiser (`gate/summary.ts`) cannot know where text came from. It replaces a detail holding a control, format or separator character with the bare target, cuts a long one in the MIDDLE to 80 UTF-16 units, and shows any safe ASCII text verbatim, a caller's text included. So the line carries ONLY daemon-derived values, sanitised and fitted by the daemon BEFORE the generic cut, with the most important field first, so the meaning survives.
- **Integration write**, in this order:
  1. the fixed action `write`;
  2. the integration id, daemon-validated against the registry (`[a-z][a-z0-9-]{0,31}`);
  3. the operation id, daemon-validated (`[a-z][a-z0-9_]{0,63}`);
  4. the destination host from the connector's registry entry.
  The id rules keep every field ASCII and safe; the operation and host are cut, never the action or the integration.
- **Plugin send**, in this order:
  1. the fixed action `send`;
  2. the attested plugin id (from main's signed attestation, not the call);
  3. the daemon-validated granted `net:` origin's host (punycode).
  A long host is cut to its last labels, never the action or the plugin.
- **Never in the line:** a request body (a comment's text, a POST's values), a URL, path or query text the caller or the renderer supplied, a header, credential material, a scope token, or any label the caller wrote. The exact values are in the card, escaped and bound by digest.
- **Tests:**
  - long ids and hosts still show the action and the integration or plugin;
  - a bidi or control character in any input never reaches the line and never drops it to the bare target;
  - a body or URL value never appears in the line.

## 5. Response echo (RESPONSE-ECHO), a release-order requirement

A server can echo request headers in its response body or headers: a debug endpoint, a misconfigured proxy. The low-level egress client returns the response bytes unchanged (`net/egress-client.ts`). So the proxy service must stop the credential coming back that way.

- **Register before use:** every revealed credential is registered with the redactor BEFORE it is used.
- **Refuse before release:** a reply holding the credential (the header value, or the token after its scheme, in the body or a header) is refused with a closed error BEFORE any response reaches a renderer, a plugin or a worker.
- **Redact everywhere else:** logs, audit and errors are redacted, and audited without the value.
- **The test:**
  - a canary server answers 200 with the `authorization` value inside a valid JSON field;
  - no response content holding the canary reaches a caller;
  - removing or bypassing the refusal fails the test.
- **Status:** the authorized-send consumer is built (the client owns the header). The service's response-echo boundary (PV-N1f's "redactor registration and echo refusal") is still PENDING, and no integration response may reach a caller until it is in place.

## 6. What must be true before PV-N1 stores a real credential (built-in connector only)

The scope is a BUILT-IN connector with plugin access to integrations and `net:` kept disabled. Each item is an existing ticket or a decision.

1. **The vault is wired to secure storage.**
   - PV-N0c: the daemon `SecretBackend` over the control client, `weakPolicy: "refuse"`, and the startup reveal with a tolerant list.
   - The own shell's `safeStorage` adapter and OS-27's "No secure storage: read only" state.
   - PV-N0a and PV-N1c are merged.
2. **The credential path is complete and reviewed.**
   - PV-N1f's service: connector registry, the request handler with its two audit rows, scope recording and refusal, disconnect.
   - The request-byte accounting (path, query, arguments, body) in the per-plugin byte budget; the accepted residual of that budget is RR-87.
   - The authorized-send consumer (built).
3. **RESPONSE-ECHO (§5)** is in place and its release-order test passes.
4. **Connecting is native.** PV-N2a (the device-code flow in the daemon) and PV-N2b (main's native code dialog and the system browser opened under EL-5, in the own shell's main).
5. **Approvals exist in the own shell.**
   - OS-11: approval cards as core components, with tier 4 and up routed to main's dialog.
   - OS-3: main's `native.confirm` answer.
   - OS-20: the renderer boundary pins.
   - Option C applied: prerequisite 1 (§4.1) and the native line (§4.4).
6. **The egress client stays pinned.** The hash pin, the import-shape and edge rules and `node:dns`/`node:https` for the one file move with ADR 0011 to `scripts/lint/`. The bundle-graph check is re-done for the own shell's daemon entry.
7. **Packaged NET-GATE evidence** on the own shell's packaged build (OS-21): no listening TCP socket in a desktop run. The statement that egress is outbound only and not observed by that gate stands (`net-gate.md`).
8. **Start-up refusals.** The daemon entry refuses `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_USE_ENV_PROXY` (PV-N1b, merged), and the own shell's main starts the daemon under the same rules.
9. **Residuals accepted by the owner:**
   - RR-76: no certificate pinning; Node's default CA store.
   - RR-77: operator NAT64 prefixes.
   - RR-81: a service without a device-code flow cannot ship; no loopback OAuth fallback, and so no listener.
   - RR-83: tokens are plaintext in daemon memory while in use.
   - RR-87: a plugin's quota and data-out use within its budget, once plugins send.
   - RR-91: the system resolver is the name trust anchor.
   - RR-92: tier 3, until the raise ships.
   - **Correction:** `integrations-contract.md` §1 ("Request bytes count (RR-81)") and the PV-N1f ticket row label the request-byte accounting as RR-81. That is a mislabel: RR-81 is the device-code-only residual. It is flagged for its own correction.

## 7. Before ANYTHING plugin-facing is enabled

Plugin access to `axis.integrations/1` and `axis.net/1` stays disabled until ALL of these hold for the operation being exposed. They follow `plugin-run-start.md` §3.1.

1. **The card.** The own shell's pending and detail card shows the full escaped request (and a run's required fields where one is started).
2. **The listing.** Every supported pending-approvals reader accepts the optional `requester` and detail, or the Code OSS shell is retired.
3. **The composition.** A test through the real host composition: an attested plugin, its host window's pending, detail and card, resolution, spend, and the attributed effect (and a tainted run where one is started), with the refusals.
4. **One grant path.** Every production grant path, install, update and any alternate writer included, goes through its tier-4 native flow.
5. **The tiers.** PV-K1e-T4 is decided before `runs.start` is granted, and this note's prerequisite 2 (§4.2) is built for the two outbound methods.
6. **Liveness.** The plugin connection and its host window are checked after the spend and again at the final effect or recording boundary, with a refusal test for a close at each step.

None of these is required to store a credential for a built-in connector that no plugin can reach. All of them are required before that isolation is relaxed.
