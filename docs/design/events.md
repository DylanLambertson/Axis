# Server-pushed events (ticket E1)

- **Status:** Built (ticket E1, `docs/design/daemon-host-plan.md` row E1). Answers plan open question 5 for after the slice: the UI subscribes instead of polling every 1 to 2 s.
- **Depends on:** ADR 0003 D2 (contracts, `kind: event`), D3 (backpressure: "dropped stream events are counted, not silently lost"), D4 (one pipeline, default deny); `docs/design/daemon-host.md` (sections 4 and 5.4, degraded mode 5.5, shutdown 8); `docs/design/daemon-host-compose.md` (registrar only, coverage).
- **Code:** `packages/protocol/src/events.ts` (contract and frames), `packages/daemon/src/events.ts` and `event-sub.ts` (the hub and one subscription), `packages/journal/src/tail.ts` (the read-only transition tail), `packages/daemon-host/src/events/sources.ts` (the emitters), composed in `src/compose.ts`.

## 1. Model

An event is an **invalidation hint**: it names what changed (an id and, where the value is a closed enum, the new state) and never carries the thing itself. The UI answers an event by calling the read method it already uses (`worktrees.status`, `cli-runs.get`, `approvals.pending`, `audit.status`). So the event payload never needs a path, a name, a message, a challenge id, a digest or any other value a read method guards, and a lost or spurious hint costs one read, never a wrong screen.

| Topic | Emitted when | Body | Audience |
|---|---|---|---|
| `workspaces` | a workspace row changes state in the journal (create, READY, FINALISED, REMOVING, REMOVED, FAILED, a recovery transition) | `{ topic, workspaceId }` | every subscriber of the topic |
| `runs` | a run row changes state in the journal (QUEUED to a terminal state, recovery included) | `{ topic, runId, state? }` (`state` from the closed run-state enum; left out if the stored value is not in it) | every subscriber of the topic |
| `approvals` | the set of open challenges of a window changes (issued, resolved, consumed, withdrawn, expired) | `{ topic }` | only subscriptions of **that window** (the same scope as `approvals.pending`) |
| `anchor` | the anchor stall state flips | `{ topic, stalled }` | every subscriber of the topic |
| `audit` | the audit chain head moves | `{ topic, headSeq }` | every subscriber of the topic |

Not emitted: project registration (rare; the UI reads `projects.list` on focus), review and git results (they are replies to the caller's own request), run output (a later stream contract), trust changes (main owns them). Each is a later additive topic within `axis.events/1`.

## 2. Wire

`axis.events/1` has two call methods, both tier 0, side effect `read`, no idempotency key, so they run through the normal pipeline: envelope check, schema, policy (one rule row each, actor `user` only), audit (`rpc.execute`), handler.

- `subscribe { topics, resumeFrom? }` answers `{ subscriptionId, epoch, seq, resumed, window }`.
- `unsubscribe { subscriptionId }` answers `{ subscriptionId }`, or `E_NOT_FOUND` for an id that is not this connection's (one answer for unknown and foreign ids).

The daemon then sends **frames** on the same port, outside the request and response envelopes:

```text
event   { v, sub, seq, event: <body> }
resync  { v, sub, seq, resync: { reason: "overflow" } }
end     { v, sub, end: { reason: "shutdown" } }
```

and the client sends **acks**, a third client message beside `request` and `cancel`: `{ v, ack: <subscriptionId>, seq }`. An ack is not a request: it is not audited and has no reply, but it is parsed by `parseClientMessage` (the bounded walk first), counts against the connection's message rate limit like every message, and before the handshake it closes the connection like any other early message.

### Identifiers and sequence numbers

- `epoch`: 128 random bits (base64url) minted when the daemon process starts. A new process is a new epoch.
- `seq`: one daemon-wide counter, incremented per published event, starting at 1. Frames of one subscription carry strictly increasing `seq` (a `resync` carries the head at the moment it is sent, which is at least every `seq` before it). The sequence is **not dense per subscription**: topic and audience filtering and coalescing leave gaps, so a gap never means a loss. A loss is always said explicitly, by a `resync` frame.
- `subscriptionId`: 128 random bits minted by the daemon. Knowing one gives nothing: every lookup is by the connection that owns it.

### Resume

`resumeFrom { epoch, seq }` asks for the events after `seq`. The daemon keeps the last 256 published events (with their audience) in a ring. When `epoch` is the current one and `seq` is no older than the oldest retained event and no newer than the head, the matching events after `seq` are queued for the new subscription and the answer says `resumed: true`. Otherwise (`resumed: false`: another process, too old, or a `seq` from the future) the client must re-read everything it shows; events after the reply's `seq` follow as usual. A client that reconnects after a daemon restart always gets `resumed: false`.

### Ordering

- The `subscribe` reply is sent **before any frame of that subscription**: the subscription is created in the handler but held inactive until the session has sent the successful reply; if the reply is an error (a timeout, a failed response check), the inactive subscription is dropped and nothing of it is ever sent.
- Frames of one subscription are in `seq` order.
- Events are **not** ordered against the replies to other requests: a hint can arrive before the reply of the request that caused it. That is harmless because a hint only triggers a read.
- Sources are commit-ordered (section 4): a workspace or run event is published only after the journal row is committed, so the read the hint triggers sees the new state.

## 3. Backpressure, coalescing and limits

A MessagePort has no flow control of its own, so the client grants it: each subscription has a **window** of 32 unacknowledged frames (returned in the `subscribe` answer). The daemon sends while fewer than `window` frames are unacknowledged and queues the rest; an ack of `seq` acknowledges every sent frame up to it.

- **Coalescing.** The queue holds at most one entry per key (`workspaces:<id>`, `runs:<id>`, `approvals`, `anchor`, `audit`). A newer event with the same key replaces the queued one and moves to the back, so the order of `seq` is kept and the client sees the latest value.
- **Bounded queue, drop and resync.** The queue holds at most 64 entries. On overflow the queue is emptied, the drop is counted, and the subscription is marked "needs resync": nothing more is queued for it. When the window opens again it gets one `resync { reason: "overflow" }` carrying the current head, after which events flow again. The client re-reads everything. Memory per subscription is therefore at most 64 queued frames plus 32 sent sequence numbers, whatever the client does.
- **Never blocks.** `publish` is synchronous and constant work per subscription: it filters, coalesces, enqueues and sends what the window allows. It never awaits, never throws to its caller (a failing send closes that connection, as a failing reply does), and is a no-op after shutdown began.
- **Subscription limits.** At most 4 subscriptions per connection and 256 per daemon; one more is refused `E_BACKPRESSURE` (without details: the handler error policy allows none on that code). A subscription dies with its connection.

## 4. Sources (the host emitters)

`createEventSources` (`packages/daemon-host/src/events/sources.ts`) runs one unreferenced interval timer (250 ms, owned by the host's `Disposables`) that does nothing while the hub has no subscription. Each tick:

1. **Journal transitions.** Reads the rows of `state_transitions` after its cursor through the host's read facade (`journalRead.transitionsSince(afterId, limit)` over `@axis/journal` `transitionsSince`; read only, ids and states only, at most 512 per tick, the rest on the next tick). The cursor starts at the newest row when the host starts, so history is never replayed as events. `node:sqlite` is synchronous and `withTransaction` takes a synchronous function, so a timer callback never sees a row of an open transaction, and a rolled-back transition is never seen at all. This is the one source for workspace and run state: it covers every writer (the worktrees service, the run supervisor, recovery) without a hook in `@axis/runs` or `@axis/worktrees`, and it orders events after commit.
2. **Anchor.** Compares `anchors.status().stalled` with the last value and publishes on a change.
3. **Audit head.** Compares the audit head sequence with the last value and publishes on a change.
4. **Approvals.** For each window that has an `approvals` subscription (`hub.windowsFor("approvals")`, bounded by the connection cap), takes the ids of `approvals.pending(window)` (which also drops expired challenges) and publishes a window-scoped event when the set differs from the last one seen. Only a hash of the id set is kept per window; a window with no subscription is forgotten.

A tick that throws is reported to the log by a fixed reason (`events_source`) and the next tick tries again; nothing a source read is put into the log.

## 5. Security properties

- **No secrets or paths on the wire.** Every body is a strict schema of ids, closed enums, a boolean and a count; `publish` refuses (drops and counts) anything else, and the session checks each frame against the frame schema again before it is sent, as it does for replies. The workspace path, project path, names, challenge ids, digests and audit payloads never appear in a frame.
- **Authorisation per subscription.** `subscribe` goes through the policy (`axis.events/1.subscribe` and `.unsubscribe`, `user` only, tier 0, no trust condition, like the other reads), and the handler refuses a non-user identity again. Topics are the subscription's own; `approvals` events carry an audience and reach only the window they belong to. The window comes from the attested identity, never from the payload.
- **Authority does not grow.** Every event is something the same connection could already learn with a tier 0 read; events add timeliness, not information.
- **Bounded.** Subscriptions per connection and per daemon, queue entries, window, ring and per-tick rows are all fixed bounds (section 3). Subscriptions are removed when their connection closes and all at shutdown, so nothing outlives its port.

## 6. Degraded mode, anchor stall and shutdown

- **Degraded** (design 5.5): `axis.events/1` is not in the degraded surface, so `welcome` does not offer it and the UI falls back to polling the audit and projects reads. The hub is not built.
- **Anchor stall:** events keep flowing (they are tier 0 reads); the `anchor` topic tells the UI that tier 3 and above are refused until acknowledgements return.
- **Shutdown:** when draining begins, every subscription receives `end { reason: "shutdown" }` and is removed before requests are cancelled; a `subscribe` arriving after that is refused `E_UNAVAILABLE` by the pipeline, and `publish` does nothing. The sources timer is disposed with the host.

## 7. Client duties

Ack promptly (one ack may cover many frames); treat a `resync` or `resumed: false` as "re-read everything shown"; on `end` or a closed port, reconnect with `resumeFrom` set to the last `{ epoch, seq }` seen; never treat a `seq` gap as a loss.

## 8. Tests (mutation-checked)

`packages/protocol/test/events.test.ts` (schemas, closed reasons, strictness); `packages/daemon/test/events-*.test.ts` (ordering of the reply and the first frame, resume and its refusals, slow subscriber drop and resync, coalescing, subscription caps, window audience, no unknown field on the wire, shutdown ends subscriptions, close removes them); `packages/journal/test/tail.test.ts`; `packages/daemon-host/test/events-sources.test.ts` (journal transitions incl. a rolled-back one, the per-tick bound, anchor, audit head and approvals emitters over a real journal); `packages/daemon-host/test/slice/headless-events.test.ts` (the composed host in a child process: workspace, run, approvals and audit hints pushed; no path, name or challenge id in any frame; approvals scoped to the window; `end` at shutdown).
