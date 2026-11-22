# ADR 0007, code map and divergences

Companion to `docs/adr/0007-inter-agent-messaging.md`. It maps each built claim of the ADR to the code that holds it, and records every place where the code differs from `docs/design/inter-agent-communication.md` ("the design") or `docs/design/inter-agent-cli-endpoint.md` ("the endpoint design"). Verified on `origin/main` at `f540b60`. Paths are relative to `packages/`; anchors are exported symbols, so they survive line moves.

## 1. Claims and their code

| ADR | Claim | Code |
|---|---|---|
| 1 | Nine methods, tiers 0 to 2, `send` needs an idempotency key | `protocol/src/messages.ts` `messagesMethods` |
| 1 | Every row is user-only; handlers refuse any other actor and web clients with `not_found` | `daemon-host/src/policy/rules.ts` (`axis.messages/1.*`, `userRule`), `daemon-host/src/handlers/messages.ts` |
| 1 | The caller is attested, never a payload | `daemon-host/src/messages/policy.ts` `MessageCaller`; `handlers/messages.ts` builds it from `ctx.identity` |
| 1 | Project of a new thread; recipients spanning projects refused | `messages/policy.ts` `newThreadProject`, `expandRecipients` |
| 2 | No capability-named field at any depth; one body format | `protocol/test/contracts-messages.test.ts` (schema walk); `protocol/src/messages-wire.ts` `messageBodySchema` |
| 3 | Participants only join, at most 64 | `journal/src/schema.ts` version 9 (`message_participants` triggers); `messages-wire.ts` `MAX_THREAD_PARTICIPANTS` |
| 3 | A reader sees messages addressed to it or after it joined | `journal/src/message-store.ts` `VISIBLE`, `visible`, `visibleAfter` |
| 3 | One participant-scoped lookup; hidden and unknown are the same miss | `messages/service.ts` `resolve` |
| 3 | `{ reason }` only, closed set, fixed message | `messages-wire.ts` `MESSAGES_REFUSALS`, `messagesRefusalDetailsSchema`, `MESSAGES_REFUSAL_MESSAGE` |
| 3 | Random 128-bit ids | `messages-wire.ts` `encodeMessagingId`; `messages/service.ts` `accept` (`random.bytes(16)`) |
| 3.1 | Send policy, `acceptsFrom`, CLI agents start at `none`, cross-group off | `messages/policy.ts` `mayAddress`, `defaultAgentSettings`, `DEFAULT_PROJECT_SETTINGS` |
| 3, 3.1 | Every recipient re-checked at delivery | `messages/service.ts` `deliverable`; `messages/delivery.ts` `createMessageDelivery` |
| 4 | Sticky journaled flag, refused clearing | `daemon-host/src/composer/taint.ts` `createRunTaint`; `journal/src/schema.ts` version 8; `journal/src/composer-store.ts` |
| 4 | Hook raises only; a failing hook denies | `broker/src/policy.ts` `DecisionHook`, `PolicyOptions.hook`, reason `decision-hook` |
| 4 | Flag bound at issue, re-read at consume | `daemon-host/src/gate/run-approvals.ts` (`args.tainted`) |
| 4 | Closed source enum, hop cap 8 | `protocol/src/taint.ts` `TAINT_SOURCES`, `MAX_TAINT_HOP` |
| 4 | Source 1 taints at delivery, same transaction as `message.deliver` | `messages/delivery.ts` |
| 5 | Rates, quotas, thread and project caps, bounded counters | `messages/limits.ts` `DEFAULT_MESSAGING_LIMITS`, `WindowCounter`, `TotalCounter` |
| 5 | Refuse when full; user messages uncounted | `messages/service.ts` `accept` (`counted`); `message-store.ts` `queued` |
| 5 | Hop rule | `messages/policy.ts` `hopOf`; `messages-wire.ts` `MAX_HOP = MAX_TAINT_HOP` |
| 5 | Reply caps 32 / 204,800 / 32 | `messages-wire.ts` `MAX_READ_MESSAGES`, `MAX_READ_TEXT`, `MAX_THREADS_LIST`; `protocol/test/contracts-messages-bounds.test.ts` |
| 6 | Audit allow-list, no text, no body hash | `messages/audit.ts` `MESSAGES_PAYLOAD_ALLOWLIST`, `MESSAGE_AUDIT` |
| 6 | Scan before accept; `warn` only for composer and user recipients | `messages/service.ts` `accept` |
| 6 | One escaping path | `messages-wire.ts` `REFUSED_MESSAGE_TEXT`, `toMessageText`; `daemon-host/src/messages/wire.ts` |
| 6 | Delivery block: nonce, `| ` prefix, 8 messages, 65,536 units | `messages/delivery.ts` (`maxMessages`, `maxText`); `daemon-host/src/composer/loop.ts` system text |
| 7 | `cliMessaging: true` refused until PV-M7 | `messages/settings.ts` (`bypass_entry`) |
| 8 | Pause stops sends and deliveries in scope | `messages/policy.ts` `senderPaused`, `recipientPaused` |
| Amendment | PTY-5 denies `AXIS_*` in any letter case | `pty-policy/src/names.ts` `canonical`, `classifyDeniedName` |

## 2. Divergences from the design

Each is deliberate unless marked; none weakens a control.

| # | Design | Code | Why |
|---|---|---|---|
| 1 | One `settings` method (PV-M1 ticket) | `settings` (read, tier 0) and `updateSettings` (write, tier 2, one setting per call) | One method cannot be both a read and a tier-2 write; one setting per call gives the `message.settings` row exactly one before and after (contract doc §2) |
| 2 | Refs at most 16, no excerpt count | At most 4 excerpts per message, each at most 2,000 lines (`MAX_EXCERPTS`, `MAX_EXCERPT_LINES`) | Bounds the reply walk |
| 3 | Participant set unbounded | At most 64 participants (`MAX_THREAD_PARTICIPANTS`); past it `too_many_recipients` | The set only grows, so it needs a bound |
| 4 | A read returns at most 50 messages and 256 KiB | At most 32 messages and 204,800 UTF-16 units; `threads` at most 32 | 50 messages at 262,144 units, or 50 threads of 64 participants, did not fit the 1 MiB / 10,000-value message walk; the design's figure is a ceiling |
| 5 | Policy refusals are `E_POLICY_DENIED` (PV-M1) | `E_CONFLICT` with a closed reason | Only the pipeline raises `E_POLICY_DENIED`, with its own audit row; a handler that tried would answer `E_INTERNAL` (contract doc §5). A read by an actor without a row is still `E_POLICY_DENIED` from the pipeline |
| 6 | Hop is 1 + the highest hop the run received | 1 + the larger of the received hop and the replied-to message's hop | Stricter; a reply cannot reset the hop |
| 7 | A refused read or post audits the requested thread id | Same, and a `rate_limited` refusal is audited once per caller and minute | The aggregation the design asks for in §8.1 |
| 8 | Endpoint design §2: "the daemon creates one endpoint" | Not built; this ADR moves the listener to the pty process (decision 7.1) | ADR 0003 D1.1 and DMN-4: the daemon opens no listener in Phases 1–3 |
| 9 | The endpoint answers `revoked` after revocation | `revoked` is not a contract reason | An endpoint-level answer, not a message-service refusal; PV-M6 adds it to the relay's closed set |
| 10 | Peer uid and descendant checks on accept | This ADR ships Unix without a native peer helper (decision 7.2) and refuses Windows without one (7.3) | Node exposes neither; the endpoint design §8 asked for this decision |
| 11 | Mute hides an agent from the attention block | Mute does not stop delivery | As the design defines it (§10); confirmed in review 1 of slice 2 |
| 12 | 500 sends per run | The per-run count is kept for at most 4,096 runs; past it the longest idle run's count is forgotten (`TotalCounter`) | Bounded memory; the per-minute limits still hold for that run. A residual, not a design choice |

## 3. Not built

| Item | Design | Ticket | State on main |
|---|---|---|---|
| Agents and groups in the directory | §4.1 | PV-G3 | `journalDirectory` knows projects only; every agent recipient is `recipient_refused` |
| A run's agent for delivery | §6.1 | PV-G4 | `agentOf` knows none; nothing is delivered in production |
| `send_message`, `read_messages`; taint sources 2 and 3; raising `receivedHop` | §6.1, §7.3 | PV-M4 | Until then the hop bounds reply chains only |
| Excerpts with path refusals and review containment | §2 | PV-M3 later | Every excerpt ref is refused `excerpt_path_refused` |
| `bodyMac` (HMAC-SHA-256, per-install key) | §8.1 | PV-M3 later | No body hash is written at all |
| Retention purge (M-7) | §7.1 | PV-M3 later | Setting stored (default 30 days); nothing purged yet |
| User notices (hop limit, full queue) | §7.2, §7.3 | PV-M3 later | Only delivery-failure notices exist |
| "Add to thread" for the user and plugins | §4.2 | PV-M3 later | Participants join only through a send |
| Transitive minter walk | §5.3 rule 1 | PV-M3 later | No test yet |
| Plugin callers and `messages.send` | §6.3 | PV-K | No plugin binding exists |
| Endpoint, relay, token, PTY-5 variables | endpoint design | PV-M6 | None |
| Shim, label wrapper, bypass checks | endpoint design §5, §6 | PV-M7 | `cliMessaging: true` refused for every agent |
| Thread view, Pause UI | §10 | PV-M5 | Contract only |
