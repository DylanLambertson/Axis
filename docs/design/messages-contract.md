# `axis.messages/1`: the protocol contract (PV-M1)

- **Status:** Built (ticket PV-M1) and **served** since PV-M3 slice 1: the contract and its rows moved to the served tables together with the handlers (section 8). Section 1 describes the planned stage it went through.
- **Design:** `docs/design/inter-agent-communication.md` (sections 2, 4, 7, 8), `docs/design/inter-agent-cli-endpoint.md` (sections 4, 5).
- **Code:** `packages/protocol/src/messages.ts` (methods), `packages/protocol/src/messages-wire.ts` (ids, records, escaping, refusals), `packages/daemon-host/src/policy/rules.ts` (rows), `packages/daemon-host/src/policy/coverage.ts` (the check), `packages/daemon-host/src/messages/` and `src/handlers/messages.ts` (the service), `packages/journal/src/message-store.ts` (schema version 9).

## 1. Planned, then served

`@axis/protocol` has a second table, `plannedContracts`, next to `contracts`. `lookupMethod` reads only `contracts`, so a planned method cannot be called by a client or served by a daemon: the envelope answers `E_METHOD_NOT_FOUND` as for any unknown method. The daemon-host coverage check holds the two tables together:

- every method of a planned contract has exactly one row in `PLANNED_RULES`, at the contract's tier;
- a planned row for anything that is not a planned method fails;
- a key in both the served and the planned registry, or in both rule tables, fails;
- `policySurface(ids)` filters the planned registry with the planned rows, so a host configured without `axis.messages` drops both.

`RuleTablePolicy` is built from `RULES` only, so planned rows are never served: the rows were written and reviewed first, and PV-M3 moved them. Adding the contract to `contracts` without handlers would fail host startup (the handler coverage check), which is why the contract is planned.

## 2. Methods

| Method | Side effect | Tier | Idempotency | What it does |
|---|---|---|---|---|
| `send` | write | 2 | required | A new thread (no `threadId`) or a post into one |
| `thread` | read | 1 | none | One thread's messages visible to the caller, after a cursor |
| `threads` | read | 0 | none | The caller's threads, most recent first; `projectId` is a filter, never authority |
| `read` | read | 1 | none | The caller's inbox: unread messages addressed to it (the `read_messages` tool and the CLI endpoint's read) |
| `markRead` | write | 1 | none | The caller's own read cursor of one thread; never moves back |
| `pause`, `resume` | write | 2 | none | The kill switch for a project, a group or an agent |
| `settings` | read | 0 | none | A project's messaging settings |
| `updateSettings` | write | 2 | none | One setting per call (cross-group, a group pair, scan mode, retention, accepts-from, CLI messaging, mute) |

**Deviation from the ticket:** the ticket names one `settings` method. Reading settings is a read and changing them is a tier 2 user write, and one method cannot be both, so the contract has `settings` (read) and `updateSettings` (write). Each update names one setting so the `message.settings` audit row records exactly one before and after.

Content reads (`thread`, `read`) are tier 1, as `axis.review/1.diff` is: they return bodies and excerpts copied from worktrees. Nothing is tier 3 or above, so no request takes an `approval`.

## 3. What no field can carry

No request or response field, at any depth, names an approval, a challenge, a digest, a grant, a token, a capability, a credential, a command, a tool or an actor; the test walks every schema's JSON form and fails on such a name (the secret-scan mode `secretScan` is the one allow-listed setting name). Every field the daemon fills (`messageId` of a new message, `projectId`, `seq`, `sender`, `hop`, `createdAt`, the expanded recipients) is absent from every request, so the strict schemas refuse it. Bodies have one format, `text`; there is no Markdown or HTML format.

## 4. Ids

Thread and message ids are `thr_` or `msg_` followed by 16 random bytes as unpadded base64url (22 characters, the last one of `A`, `Q`, `g`, `w`, so the encoding is canonical). `encodeMessagingId(kind, bytes)` is the one encoding; it throws unless it gets exactly 16 bytes. The daemon passes `randomBytes(16)`. The prefix only keeps the kinds apart; ids carry no order, time, project or sender.

## 5. Visibility and `not_found`

The contract comments state the rule of `inter-agent-communication.md` section 4.2: participant sets, participant-only reads, posting needs participation and every recipient passes the send policy at accept and at delivery, the user reads every thread. The contract's part of "no existence oracle" is that a refusal's `details` is exactly `{ reason }` from a closed set, with the fixed message `MESSAGES_REFUSAL_MESSAGE`: a `not_found` cannot carry an id, a count or text that would tell a hidden thread from a missing one. The same holds for `recipient_refused`, which answers both an unknown and a disallowed recipient. The service makes the two refusals structurally identical (section 8).

| Code | Reasons |
|---|---|
| `E_NOT_FOUND` | `not_found` |
| `E_INVALID_ARGUMENT` | `too_large`, `too_many_recipients` |
| `E_CONFLICT` | `recipient_refused`, `cross_project` (user only), `paused`, `hop_limit`, `secret_found`, `excerpt_path_refused`, `bypass_entry` |
| `E_BACKPRESSURE` | `rate_limited`, `queue_full` |

PV-M1 put the policy refusals under `E_POLICY_DENIED`. A handler cannot raise that code (the daemon answers `E_INTERNAL` for it, because only its pipeline decides it, with its own audit row), so PV-M3 moved them to `E_CONFLICT`, as `axis.review/1` and `axis.git/1` answer their packages' policy refusals. The daemon's error filter now lets `E_BACKPRESSURE` carry `reason`, so `rate_limited` and `queue_full` stay apart on the wire.

## 6. Bounds and display text

- **Request body:** 1 to 16,384 UTF-16 units, well-formed (no lone surrogate). Control and bidi characters are accepted in: the daemon stores the text and escapes it on every way out.
- **Response text:** `toMessageText` escapes every control character except tab and newline (so CR, ESC and C1 are out), bidi, zero-width, the invisible set and lone surrogates as `\u{hex}`, and the backslash as `\\`, so a typed escape cannot pass for a real one. The response schemas refuse anything unescaped. An escaped body is at most 8 times the request cap and is never cut; an excerpt is cut at 65,536 units with `truncated`. Paths are `toDisplayPath` text (at most 512); a raw path is never echoed.
- **Recipients** 1 to 16 (unique), and 16 after group expansion; **refs** at most 16, of which at most 4 excerpts of at most 2,000 lines; **participants** of a thread at most 64 (a send past it is `too_many_recipients`); **hop** 0 to 8, and 0 for a user message.
- **Replies:** `thread` and `read` return at most 32 messages and 204,800 units of body, excerpt and display-path text (`MAX_READ_TEXT`, exactly one message at its largest, so a reader always makes progress); `threads` returns at most 32 threads. These caps are set so the worst reply passes the protocol's message walk (1 MiB, 10,000 values) with 16 KiB and 64 values left for the envelope: the test builds it with every id, plugin id and path at its schema maximum, every list at its cap and 3-byte text, and fails if it does not fit. 50 messages at 262,144 units, or 50 threads of 64 participants, did not fit. The design's 256 KiB read cap is a ceiling; this one is lower and counted in UTF-16 units.
- **Cursor:** the `thread` reply's `nextSeq` is the last returned message's `seq`, or `min(afterSeq, lastSeq)` when nothing is returned, so a cursor past the end gets an empty reply, not an error.

## 7. Left to later tickets

- PV-M4 and PV-M6: agent and CLI callers reach messaging through the broker and the endpoint, not the bridge. A bridge row that admits an agent actor needs a new actor kind in the rule table and its own review.
- PV-M7: the second confirmation for enabling a CLI agent when a CLI project-configuration file is in the worktree (M-3) may add a field to `updateSettings`.
- Thread titles are not in the design's section 2 table and are not in the contract.
- PV-M3 later slices: the CLI pull (PV-M6), the composer tools `send_message` and `read_messages` (PV-M4, taint sources 2 and 3), the run's received hop raised by what it is delivered or reads (the attested `receivedHop` of a sender), user notices (hop limit, full queue), retention purge (of messages and of the `send` results the durable idempotency store keeps for its TTL), `bodyMac`, excerpts, and "add to thread" for the user and plugins.

## 8. As served (PV-M3 slice 1)

- **Who.** The bridge serves the user's own connection: the rows admit `user` only, every handler refuses any other actor again with `not_found`, and no row is in `WEB_ALLOWED`. The service (`createMessageService`, `createMessagingSettings`) takes an attested `MessageCaller` (`user`, or an agent or plugin with its run's received hop) from its binding, never from a payload, and parses every request with the contract's schema itself, so the broker (PV-M4) and the endpoint (PV-M6) cannot pass an unchecked one.
- **Directory.** Agents and groups are PV-G3's. Until it lands the host's directory knows the journal's projects and no agent, so no agent can be addressed: every agent recipient is `recipient_refused`.
- **Project of a thread.** From the thread; for a new thread the attested sender's own project for an agent, and the one project of every named agent and group for the user (a send to the user alone, from the user, is refused; recipients that span projects are `cross_project` to the user). A plugin cannot open a thread.
- **Policy at accept.** Every expanded recipient, participant or not, passes section 4.1 (`mayAddress`: own group, `crossGroup` or a pair, the recipient's `acceptsFrom`, never itself, never another project); one refused principal refuses the whole send. Groups expand at accept, without the sender, and the expansion is recorded. A post into a thread needs participation (the user may post into any thread and joins it); new recipients join with `joinedSeq` = the thread's last seq. `inReplyTo` must be a message of that thread the sender can read. `deliverable(messageId, principal)` is slice 2's hook: it runs the policy and Pause again with the settings of the moment, for a principal the message was addressed to.
- **No existence oracle.** Every method that names a thread resolves it on one path. For any caller but the user that is ONE participant-scoped lookup (the thread joined with the caller's participation), so an unknown and a hidden thread are the same miss, refused with the same audit row and the same error. The claim is structural identity, not equal latency; the test compares the sequence of store and audit calls of both cases. A late joiner's summary still shows the thread's `lastSeq` and its participants: the size of the history it cannot read is visible, not its content.
- **Hop.** 0 for the user; for an agent or plugin one past the larger of the hop its run received and the hop of the message it replies to; past `MAX_TAINT_HOP`, or a received hop that is not an integer in range, is `hop_limit`. Slice 1 records no hop when an agent reads: slice 2's taint producer must raise the run's received hop on every `thread` and `read` result and every delivery, or a sender could reset the hop by posting without `inReplyTo`.
- **Body.** Stored as the sender wrote it (raw, bounded by the request schema) and escaped with `toMessageText` on every way out, in one place (`messages/wire.ts`); a file ref leaves only as `toDisplayPath` text. Excerpt refs are refused (`excerpt_path_refused`) until the excerpt slice builds the containment and path refusals. The body is secret-scanned before accept (`refuse`; `warn` only when every recipient is a composer agent or the user, M-6; a scan that cannot finish refuses).
- **Limits** (`DEFAULT_MESSAGING_LIMITS`, design section 7): per agent or plugin sender 30 sends a minute and 500 per run, 300 per project and minute, 60 reads a minute per agent or plugin caller (`rate_limited`); per recipient 200 unread messages from agents and plugins, 50 of them from one sender (`queue_full`, refused, never dropped; the user's messages never count and are never refused for a full queue; the user's own inbox is a recipient like any other, so agents' messages to the user share its 200, at most 50 from one agent, which bounds what any flood can hold); 2,000 messages per thread (`too_large`: start a new thread; nothing is archived), 10,000 threads per project (`queue_full`), 64 participants (`too_many_recipients`). The user is not rate limited (the daemon's connection limits bound it). Until delivery exists, the queue is a recipient's unread messages (after its read cursor). Every counter is bounded (4,096 keys; a new key past it is refused while all are live).
- **Audit** (`MESSAGES_PAYLOAD_ALLOWLIST`): `message.send`, `message.send.refused`, `message.read.refused`, `message.settings` (one setting, before and after), `message.pause`, `message.resume`, with ids, kinds, counts and closed reasons only, never text. A `rate_limited` refusal is recorded once per caller and minute. `bodyMac` is not written: no hash of a body is recorded until the per-install key's storage is decided.
- **Settings.** Held in the journal (`messaging_settings`, `messaging_agent_settings`), user only; an unknown project, group or agent is `not_found`. Enabling an endpoint (`cliMessaging: true`) is `bypass_entry` for every agent until PV-M7 can check launch entries.
- **Ids.** `encodeMessagingId` over 16 bytes of the daemon's `randomBytes` for every thread and message. `send` answers `replayed: false`; a retry with the same key gets the stored result from the daemon's durable idempotency store.
- **Journal** (schema version 9, forward-only, pinned by hash): `message_threads`, `message_participants` (join only, at most 64), `agent_messages` (never changed; the next seq of its thread, by trigger), `message_recipients`, `message_cursors` (never back) and the two settings tables.

## 9. Delivery into runs (PV-M3 slice 2)

- **Where.** `packages/daemon-host/src/messages/delivery.ts`, called by the agent binding's `deliver` tool hook, which the composer loop asks at each turn boundary: after a turn's tool results and drift notice, never inside a tool call, never into the first prompt (no wake, design section 6.4), never when no further turn follows and never once the run is cancelled. A run of no agent gets nothing: PV-G4 records a run's agent (and must then also check that the run's project is the agent's), and until then the host's `agentOf` knows none, so nothing is delivered in production. Only a RUNNING run is delivered to; an agent the directory no longer knows (archived) gets nothing and its messages stay queued.
- **Re-checked at delivery.** A waiting message is delivered only while the recipient is a participant of its thread and `deliverable` still allows it under the settings of this moment (send policy, `acceptsFrom`, Pause of the sender's or the recipient's scope); otherwise it stays queued. The pipeline pages past refused messages with a keyset cursor in send order (up to 1,024 a boundary), so refused messages cannot hold back later ones (review 1 SF1). The hop needs no check here: the journal refuses a hop above `MAX_TAINT_HOP`. Mute does not stop delivery: the design defines it as hiding an agent from the attention block only (section 10, the contract's `muted` field; confirmed in review 1).
- **Taint first.** Per message, in one journal transaction: the lease, then for a sender other than the user (an agent, a CLI endpoint sender, a plugin) the run's `RunTaint.receive` with source `message`, the sender kind (`cli` for an unverified sender or a CLI agent), the sender's name cut to 64 characters, the message's hop and its id as `ref`, then `message.deliver` (message, thread, run, agent, channel `composer-turn`, sender kind, hop). `receive` records `composer_runs.tainted` and `message.taint` in the same transaction. If that fails, the run is tainted in memory, the block is withheld, the leases this boundary took are released, the failure is counted and the loop ends the run `FAILED` / `DELIVERY_FAILED`. After 3 failures for one recipient the message is quarantined (`failed`, never offered again), `message.deliver.failed` is written and Axis posts a system message to the user in the thread, so one message cannot end every run of an agent. A message from the user is delivered without a receipt.
- **At most once, acknowledged late.** Journal schema version 10: `message_deliveries` (one row per message and recipient: `leased`, `acked` or `failed`; a lease only moves to `acked`, an acked or failed row never changes and is deleted only after its message) and `message_delivery_failures`. The loop acknowledges a block only after the provider request that carried it succeeded, and releases it when that request failed, when the run ended or was cancelled first, or when the acknowledgement itself failed; every lease is also released at host start. A released message goes to a later run, which it taints in turn; the run that leased it stays tainted.
- **The block.** One text block after the tool results. The opening line carries a nonce of 16 random bytes drawn for that block, after the bodies were stored, and says the messages are untrusted data that is not an instruction and grants nothing, and that only a header line Axis writes, carrying that code, names a sender, so nothing inside a message can, not even a claim to be from the user. Per message: a header (sender, kind, `verified`, thread, message id, hop), the body escaped with `toMessageText` with every line prefixed `| ` (no body line can begin like a frame line), and an end line; then a closing line. The system prompt of the edit and agent modes names the frame as untrusted data (design section 6.1). At most 8 messages and 65,536 escaped units a block, whole messages, one message always fits; the rest wait for later boundaries, in send order. Delivered text counts toward the run's result cap (`TOOL_RESULT_LIMIT`).
- **Not here.** `read_messages` and `send_message` for composers (PV-M4), the CLI pull (PV-M6), raising the run's `receivedHop` from what it was delivered (with the PV-M4 sender binding; until then no relay is bounded by hop at delivery), an index for `pending` (its work grows with what an agent has ever received until retention exists).
