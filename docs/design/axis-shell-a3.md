# Shell A3: the dashboard follows the daemon's events

Companion to `axis-shell-a2.md` (the read path and the `IAxisDaemonClient` seam) and `events.md` (the `axis.events/1` contract, ticket E1). A2 refreshes by polling every 1 to 2 s. A3 replaces that with the server-pushed subscription and keeps polling as the fallback. Nothing visible changes except timeliness and fewer reads.

## What an event is to the shell

An event is an invalidation hint (`events.md` section 1): it names an id and, for runs, a closed state, and never carries a value. The shell therefore does **not** apply events to the workspace, run and approval models. It answers an event with the read it already makes (`AxisSnapshotLoader.load` through `AxisDaemonApi`), so every value that reaches a model still passes the A2 validators: exact shape, no duplicate ids, absolute paths without control characters, cleaned display strings, bounded lists, `textContent` only. A lost, forged or spurious event costs one read and can never put a wrong value on screen. There is no second code path that builds model state from push data.

## Seam

`IAxisDaemonClient` gains an optional `events?: IAxisEventTransport` (`axisDaemonClient.ts`): `subscribe`, `unsubscribe`, `ack`, `onFrame` (raw frames) and `onDidClose`. An implementation that cannot carry events leaves it undefined (the current `UnavailableDaemonClient` does). The shell validates every reply and frame itself (`axisEventFrames.ts`); the transport hands over raw values.

## Pieces

| Piece | File | Job |
|---|---|---|
| Frame validators | `daemon/common/axisEventFrames.ts` | Subscribe reply, event bodies and `event`/`resync`/`end` frames, exactly the contract shape. Anything else is `undefined`. The reply window may not exceed 32, the shell's buffer. |
| Subscription | `daemon/common/axisEventSubscription.ts` | One subscription and its credit protocol. |
| Event driver | `workspaces/common/axisEventDriver.ts` (`AxisEventDriver`) | Subscribes, turns hints into reads, reconnects, resumes. |
| Adaptive driver | same file (`AxisAdaptiveRefreshDriver`) | What the service uses: events when live, `AxisPollDriver` otherwise. |

## Credit and validation rules (subscription)

- Topics: `workspaces`, `runs`, `approvals` (the ones the dashboard shows). `resumeFrom` is sent only with a position this client saw.
- An `event` frame whose envelope is sound but whose body is not one the shell knows (an additive field or a new topic from a newer daemon) is **tolerated as an opaque hint**: the body is discarded, the frame is counted and acknowledged like any other, and everything shown is read again. A frame of this subscription whose envelope is broken (version, `sub`, `seq`, extra or missing keys), that carries an `event` `seq` not above the last one (a `resync` may repeat it, never go below), or that would take the unacknowledged count above the granted window ends the subscription as a violation. A gap in `seq` is never a loss; only `resync`, `end` or a closed connection are.
- Frames of other subscriptions are ignored and never acknowledged, also before the `subscribe` reply is processed: until then frames are held per `sub` (at most 8 ids, one window each), so another subscription's flood cannot end or crowd out this one.
- Frames are handed to the driver synchronously and then counted as consumed. Nothing is queued except frames that arrive before the `subscribe` reply is processed: at most one window (32); more is a violation.
- Credit goes back with `ack` after 8 consumed frames or 50 ms, whichever comes first (a failed send is retried after 50 ms), and always names the last `seq` received, so the shell never grants more than the daemon delivered. Unacknowledged frames can therefore never reach the window while acks go through; if acks cannot be sent (closed port) the window check ends the subscription.
- A reply with `resumed: true` that was not asked for is `invalid_reply`.

## Driver behaviour

- **Connect.** On `start` the driver subscribes (jittered backoff 1 s doubling to 16 s on every failed or lost subscription). The backoff starts over only when a stream has stayed up for 10 s without breaking the protocol (the open-time read and valid frames do not count; a hidden window restarts the wait), so a stream that breaks soon after it opens keeps backing off; after a protocol violation the next subscription does not resume (fresh baseline). A fresh (not resumed) subscription starts with one full read; a resumed one relies on the replayed events.
- **Hints become reads.** Events within 150 ms cause one read; a `resync` reads at once. Reads never overlap; an event during a read causes one more afterwards. A failed read is retried with the same backoff and keeps the data marked changed.
- **Reconcile.** With no event, everything is read again after 30 to 60 s, in case a hint was lost. A hint cancels the wait.
- **Loss.** `end`, a violation or a closed connection drops the subscription, reports "not live" and reconnects with `resumeFrom` set to the last `{epoch, seq}`; the daemon says `resumed: false` after a restart, which triggers the full read.
- **Hidden window.** `setPaused(true)` holds no timer. Frames are still consumed and acknowledged (bounded work), they only mark the data changed; showing the window again reads once.
- **Stop.** Unsubscribes (best effort), cancels the pending call, removes listeners and timers. The position is kept for the next `start`.

## Fallback

`AxisAdaptiveRefreshDriver` starts the poll driver and the event driver together and stops the poll as soon as the subscription is live; it restarts the poll whenever the subscription is lost or cannot be made. So: no `events` on the client, a daemon in degraded mode (`welcome` does not offer `axis.events/1`, `subscribe` is refused), or a reconnect in progress all behave exactly as A2 did. The service depends on `IAxisRefreshDriver` only.

## Not in A3

The real renderer client. `AxisPortClient` (`@axis/protocol`, X1b) parses only response envelopes and ignores `event`/`resync`/`end` frames and has no `ack`; the `IAxisDaemonClient` implementation that bridges it (still the unavailable client in the shell) must expose `events` by adding a frame listener and an `ack` send to the port client. That is renderer-side work in the protocol package and needs no daemon change. Until then `events` is undefined and the shell polls.

## Tests

Overlay unit tests (`./scripts/test.sh --grep Axis`, also run under plain Node with mocha): frame validators (`axisEventFrames.test.ts`), the credit protocol with a scripted transport and manual timers (`axisEventSubscription.test.ts`), the driver and the fallback (`axisEventDriver.test.ts`). No test waits for wall-clock time. Each rule above was checked by mutation (a rule removed makes a test fail).
