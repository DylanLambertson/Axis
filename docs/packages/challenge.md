# Axis packages: Using @axis/challenge

Part of the package notes; the package map and the cross-cutting rules are in [docs/packages.md](../packages.md).

## Using `@axis/challenge`

The daemon owns one `ChallengeManager` and wires it like this. Identity (`actor`, `connectionId`, `windowId`) always comes from the transport, never from a request payload.

1. A tier 3-5 request arrives without `approval`. The daemon computes `contentDigest` (SHA-256 of what will be destroyed) and calls `issue({ contract, version, method, args, target, contentDigest, actor, connectionId, windowId })`. `args` is required: the request params without `approval`. The manager computes the request digest itself (see "Shared request digest"), so the contract, version and method are bound to it. The daemon may also pass its own `requestDigest` as a cross-check; it must equal the computed one. `target` must be a canonical daemon id such as `workspace:<id>`, never a path or alias. `targetSummary`, if given, is built by the daemon from `path` or `public` fields. It answers `E_APPROVAL_REQUIRED` with the returned challenge. For tier 4-5 it also calls `takeNativeProof(challengeId)` once and passes the proof to main over the privileged port; the proof never goes to a renderer or an agent.
2. The renderer's `axis.approvals/1.resolve` goes to `resolve({ actor, windowId }, params)`. Main's dialog result goes to `confirmNative({ windowId }, { challengeId, proof, confirmed })`.
3. The requester retries with `approval: { challengeId }`. The daemon recomputes `currentContentDigest` under the lock that protects the content and calls `consume(challengeId, { actor, connectionId }, { contract, version, method, args, target, currentContentDigest }, action)`. The daemon keeps no map from challenge id to grant: the id alone is not a credential.
4. When the request is aborted or its connection closes, the daemon calls `withdraw(challengeId, { actor, connectionId })` or `withdrawConnection(connectionId)`. The challenge is dropped (resolve and consume then refuse its id with `E_POLICY_DENIED`). A withdrawn challenge still counts against the requester's per-actor, per-window and total quotas until its original expiry, so an issue/withdraw loop gets `E_BACKPRESSURE`; `withdrawConnection` leaves the same tombstones, so reconnecting in a loop cannot get past the quota (the tombstones are bounded by the same quotas). `withdraw` returns `{ withdrawn: true }`, or `{ withdrawn: false, reason: "spent" }` when the approval was already consumed (the action ran or is running) and `reason: "ended"` when it was already denied, expired or burned. The audit write is best effort.
5. Every error is a `ChallengeError` over the protocol code set. `error.toWire(correlationId)` is for standalone use. Under `@axis/daemon`, the integration adapter does not call it: it maps `ChallengeError` to the daemon's `ApprovalError` (`E_POLICY_DENIED` and `E_CONFLICT` stay; any other code, or `executed: true`, becomes `E_INTERNAL`) and lets the daemon build the wire answer and own the correlation id. `details.executed` tells the caller whether the action ran. When the action throws a protocol-shaped error (a valid code, retryable flag and message), `consume` rethrows that code and message verbatim with `executed: true`, so a domain error's message must be safe to show the user (details, causes and stacks are dropped); any other throw becomes `E_INTERNAL`. The audit sink must be synchronous: a returned promise counts as a failed write.

The package limits open challenges per actor in one window (`maxOutstandingPerActor`, so one window cannot lock the same user out of another), per actor across windows (`maxOutstandingPerActorOverall`, the backstop), per window and overall; `method` is any name `@axis/protocol`'s `methodNameSchema` accepts, such as `restoreFromRunBase`; the per-window rate limit from ADR 0003 belongs to the daemon.

### Shared request digest

`requestDigest({ contract, version, method, payload })` binds a challenge to the exact request. It is, byte for byte:

```
sha256hex(JSON.stringify(["axis.request/1", contract, version, method, canonicalJson(payload)]))
```

- `contract` is the bare contract id exactly as `@axis/protocol` defines it (`contractIdSchema`, for example `axis.worktrees`), never the slash form `axis.worktrees/1`. `version` is the separate integer major version (`contractVersionSchema`). `issue` and `consume` validate both with those schemas and refuse anything else.
- `method` is the method name as sent.
- `canonicalJson(payload)` is a string: the payload's JSON text with object keys sorted recursively and a top-level `approval` field removed. It is embedded in the array as a string element, not as a nested object, so no delimiter can be forged.
- The digest function itself accepts any strings; only `issue` and `consume` enforce the schemas.

Fixed vectors (`sha256hex` as lowercase hex):

| contract | version | method | payload | digest |
|---|---|---|---|---|
| `axis.worktrees/1` (function-level only) | 1 | `remove` | `{id:"ws-1",deleteBranch:false}` | `ccb3a71aa0bc5bd6db5ccfe6fe9a09abef12092dce13ba4f6d99e929a30e0fd7` |
| `c` | 1 | `m` | `{b:[1,{z:null,y:true}],a:"x"}` | `de8399306f850ad7498d82c8f95ec94ca317181b2422480425c52ad8ed55e596` |
| `axis.worktrees` | 1 | `remove` | `{id:"ws-1",deleteBranch:false}` | `adb7a157e75395816cf74974fbdfa2b5bdf32831996a578ff80cdb46fe9d2735` |
| `axis.worktrees` | 1 | `finalise` | `{id:"ws-1",outcome:"archived"}` | `14241a246e41957535270af54e54f5de9eaa8bce5f816c44010664057f641878` |

`@axis/daemon` implements the identical function and pins the same vectors; the two copies must stay in step. The shared function moves into `@axis/protocol` later, and both packages will then import it.
