# Decision note: the tier of integration writes and `axis.net/1.send`

- **Status:** for the owner's decision. The recommendation is §4.
- **Date:** 2026-11-27.
- **Question:** should `axis.integrations/1.write` and `axis.net/1.send` require main's native confirmation (tier 4) before any real credential is stored? Today both are tier 3, and RR-92 accepts that.
- **Inputs:**
  - ADR 0003 I3: tiers 4 and 5 need `approvals.confirmNative`.
  - ADR 0009 decisions 1 and 2 and D-10: a write is its own permission and a tier 3 challenge showing the values.
  - ADR 0011 §"Security" item 2: native only at tier 4 and above; tiers 1 to 3 are the renderer's approval cards.
  - `docs/design/integrations-contract.md` §1, RR-92, and INT-13 (threat model 4a).

## 1. What tier 3 and tier 4 mean here

- **Tier 3:** the daemon raises a challenge bound to a digest of the request. The user resolves it in the app's approval card, a core-shell component that module content, pages and plugin views cannot draw or imitate (ADR 0011). Only a `user` actor can resolve it, so a plugin or a worker cannot approve its own call.
- **Tier 4:** the same challenge, plus main draws a native dialog with the digest (`packages/challenge/src/manager.ts`: `native = tier >= 4`). A compromised renderer cannot click or cover that dialog (EL-4).
- **What tier 3 leaves open (RR-92):** a compromised renderer can approve its own outbound write. That means a comment, an issue move or a plugin's POST, sent with the user's credential to a declared origin. The credential itself never reaches the renderer: the vault and the egress client are daemon-side, and the client owns the `authorization` header. Today this is accepted under A10 ("the renderer is the user").
- **What changes with ADR 0011:** our own renderer has much less authority than the Code OSS renderer did. It has no file system, no pty and no `encryption` channel (ADR 0011 §"Security" item 1). A10 is therefore a weaker assumption than before, and a renderer compromise is more likely to be the attacker's ONLY foothold. In that case, the native dialog is the one control left between the attacker and an outbound write made with the user's credential.

## 2. Options

| | Option | Contract | Effect |
|---|---|---|---|
| **A** | Keep tier 3 (status quo) | unchanged | RR-92 stays accepted. Approval cards in the renderer only. |
| **B** | Raise both contracts to tier 4 | a pre-release change of the contract minimum, like `worktrees.finalise` (2026-11-05): allowed once, because no client has shipped | Native dialog for every write and every send. Lowering it later needs a new major version. |
| **C** | Contracts stay tier 3; the **shipped policy raises both to tier 4** | unchanged (the contract declares the minimum; policy may raise, never lower; ADR 0003) | Native dialog for every write and every send. Later the owner (or a per-integration user setting) can relax a raise back to 3 without a contract change. |
| **D** | Tier 4 for `integrations.write` only; `net.send` stays 3 | as C, for one method | Native dialog for connector writes; plugin POSTs rely on the per-plugin request and byte budget (OI-9, RR-87) and the card. |

## 3. Effect on the user

- **Phase 4a writes nothing.** The only connector in 4a is GitHub read-only (PV-N3, D-9 as taken), and plugin `net:` sends need PV-K. So in 4a, options B, C and D cost the user nothing: no write or send exists to confirm. The cost arrives with the first write connector or the first plugin that POSTs.
- **With writes (after 4a):** every write or send is one native dialog showing the integration, the operation and the exact values (D-10, unchanged). That is one more click than the card per write.
  - For a user comment, that is acceptable: it is rare and deliberate.
  - For a plugin that POSTs often, it is noisy. Option D, or a later per-integration relaxation under C, is the release valve.
- **No batching is assumed.** A tier 4 challenge confirms one request digest. A "confirm the next N" grant would be a new design with its own review.
- **Copy:** under B, C or D, the card for these methods says the confirmation will appear in a system dialog. Under A, no copy may call it native (ADR 0011 item 2).

## 4. Recommendation: option C, before any credential is stored

- **What:** raise `axis.integrations/1.write` and `axis.net/1.send` to tier 4 in the shipped rule table, and keep the contracts' declared minimum at 3. Then:
  - update RR-92 to "closed by policy: tier 4 by default";
  - record the relaxation path as an owner decision, never a default. A per-integration "allow writes with an in-app approval" setting is the only way back to 3; it is never below the contract minimum, and changing it is itself a main-drawn confirmation (like the OS-4 `axis.cliAgents` change).
- **Why C over B:** it gives the same protection now, and keeps the option to relax for a frequent, low-risk plugin without a breaking contract change. Under B, relaxing would need a new major version.
- **Why not A:** A10 is weaker with our own renderer (§1). The cost of C in 4a is zero (§3), and the protection covers the one case where the renderer is the attacker's only foothold.
- **Why not D:** a plugin POST carries the user's data to a third-party origin, which is at least as sensitive as a connector write. Its budget bounds how much leaves, not whether it should.
- **Cost:** a rule-table change and its tests (the policy raise, the challenge tier at issue and at execute, the native route). It also needs the copy in OS-11, plus a test that a tier 3 relaxation can never be set by a renderer call. All of this is small.

## 5. What must be true before PV-N1 stores a real credential

The minimal list. Each item is a ticket that exists today, or a decision.

1. **The vault is wired to secure storage.**
   - PV-N0c: the daemon `SecretBackend` over the control client, `weakPolicy: "refuse"`, and the startup reveal with a tolerant list.
   - The own shell's Electron adapter (`safeStorage`) and OS-27's "No secure storage: read only" state.
   - PV-N0a and PV-N1c are merged.
2. **The credential path is complete and reviewed.**
   - PV-N1f: the connector registry, the request handler with its two audit rows, the redactor and echo refusal, scope recording and refusal, and disconnect (vault entry, memory token, in-flight cancel).
   - The authorized-send consumer: the egress client owns `authorization` and attaches it only from an `AuthorizedRequest` to exactly its URL.
3. **Connecting is native.** PV-N2a (the device-code flow in the daemon) and PV-N2b: main's native code dialog and the system browser opened under EL-5, in the own shell's main (ADR 0011 keeps the dialog's policy and text).
4. **Approvals exist in the own shell.**
   - OS-11: approval cards as core components, with tier 4 and up routed to main's dialog.
   - OS-3: main's `native.confirm` answer.
   - OS-20: the renderer boundary pins.
   - Plus this note's decision, applied to the rule table.
5. **The egress client stays pinned.** The hash pin, the import-shape and edge rules and `node:dns`/`node:https` for the one file must move with ADR 0011 to `scripts/lint/`. The bundle-graph check must be re-done for the own shell's daemon entry, so the client keeps both a source check and a bundle check.
6. **Packaged NET-GATE evidence** on the own shell's packaged build (OS-21): no listening TCP socket in a desktop run. The statement that egress is outbound only and not observed by that gate stands (`net-gate.md`).
7. **Start-up refusals.** The daemon entry refuses `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_USE_ENV_PROXY` (PV-N1b, merged). The own shell's main must start the daemon with the same environment rules.
8. **Residuals accepted by the owner.**
   - RR-76: no certificate pinning; Node's default CA store.
   - RR-77: operator NAT64 prefixes.
   - RR-81: the request bytes are counted in the budget.
   - RR-83: tokens are plaintext in daemon memory while in use.
   - RR-91: the system resolver is the name trust anchor.
   - RR-92: updated per this decision.

Not on the list, because they are not needed for the first credential: plugin `net:` grants (PV-K), any write connector, and the 4a gate evidence (PV-N4, which follows).
