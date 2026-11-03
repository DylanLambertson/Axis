# Axis packages

Axis-owned TypeScript that does not need Code OSS services lives in `packages/*` as npm workspaces (`@axis/<name>`). The decision and the rules are in `docs/adr/0005-axis-packages-layout.md`; this page is the working summary.

| Package | Purpose |
|---|---|
| `@axis/protocol` | Versioned envelope, structured errors, contracts such as `axis.worktrees/1`, and the challenge shape. Zod schemas and inferred types. No Node imports. |
| `@axis/pty-policy` | Pure logic for terminal environments and CLI agent launch: the PTY-5 deny-list (`buildCliEnv`), SI-ENV (`buildPlainTerminalEnv`), GIT-ENV-1 (`buildGitEnv`), the `axis.cliAgents` schema, setting-scope resolution and `resolveLaunch`. Axis resolves launch executables itself (PATH only, never the cwd or worktree). Imports `node:*` and `zod` only; no `process.env` access. |
| `@axis/challenge` | Daemon-side approval challenges for tier 3-5 destructive operations: issue, user resolve, native confirmation, single-use `consume`. Node `crypto` only. |
| `@axis/daemon` | Transport-agnostic daemon core: connections, handshake, dispatch, tiers, idempotency, cancel and timeout, backpressure, error sanitisation. Every service (identity, policy, approvals, idempotency store, audit sink, handlers) is injected. No Electron. |
| `@axis/daemon` | Transport-agnostic daemon core: connections, handshake, dispatch, tiers, idempotency, cancel and timeout, backpressure, error sanitisation. Every service (identity, policy, approvals, idempotency store, audit sink, handlers) is injected. No Electron. `MemoryIdempotencyStore` is for tests and dev wiring only (it forgets on restart); the product uses the journal-backed store. The approval gate must check the request digest (`requestDigest()`, shared with `@axis/challenge`), the actor and the connection id, and burn the challenge on use. |

More packages (worktrees, journal, audit) are added by their own changes.

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

`@axis/daemon` implements the identical function and pins the same vectors; the two copies must stay in step. The shared function moves into `@axis/protocol` later, and both packages will then import it.
## Request digest

The approval digest is defined once, in the doc comment of `requestDigest()` in `packages/daemon/src/digest.ts` (`sha256hex(JSON.stringify(["axis.request/1", contract, version, method, canonicalJson(payloadWithoutApproval)]))`, ECMAScript `JSON.stringify` semantics, bare contract id, integer version). `@axis/challenge` implements the same function; both are pinned by the same fixed vectors, and the copies are to be merged into `@axis/protocol`.

## Wiring the daemon

`@axis/daemon` never imports `@axis/challenge`; the product wiring (in main or the daemon entry) connects them in two places. The daemon computes the request digest once and hands it to the gate; the handler of the destructive method spends the approval.

1. **Gate (`ApprovalGate.check`)**: issues, and answers `confirmed` only when the retry carries `approval`. The daemon calls it for tier 3 and above, after policy and idempotency, with an `ApprovalInput`:
   - No `input.approval`: call `manager.issue({ contract: input.contract, version: input.contractVersion, method: input.method, requestDigest: input.digest, target, contentDigest, actor: input.actor, connectionId: input.connectionId, windowId: input.identity.windowId, tier: input.tier })`, with `target` (`workspace:<id>`) and `contentDigest` computed by the wiring from the parsed payload. Return `{ status: "required", challenge }`; for tier 4 and 5 also call `takeNativeProof(challengeId)` once and pass it to main, never to the renderer.
   - With `input.approval`: return `{ status: "confirmed", confirmation: { challengeId: input.approval.challengeId, target } }`. The gate does not call `consume`, because `consume` runs the action itself. `input.digest` already equals the `requestDigest` the challenge was issued with, because both use `requestDigest()` with the bare contract id and the integer version.
   - Pass `input.signal` to anything pending and stop on abort.
2. **Handler** (runs after the gate answered `confirmed`, receives `ctx.confirmation`): wraps the destructive step in `manager.consume(ctx.confirmation.challengeId, { actor: ctx.identity.actor, connectionId: ctx.identity.connectionId }, { contract, version, method, requestDigest: <the digest>, target, currentContentDigest }, (confirmed) => doTheDestructiveThing(confirmed))`. Compute `currentContentDigest` under the lock that protects the content, immediately before the call.

| Daemon field | Challenge field |
|---|---|
| `input.contract` (bare id), `input.contractVersion` | `contract`, `version` |
| `input.digest` | `requestDigest` (do not pass `args` as well) |
| `input.actor` | `actor` |
| `input.connectionId` | `connectionId` |
| `identity.windowId` | `windowId` |
| `input.approval.challengeId` | the id given to `consume` |

Order of calls for one destructive request: policy, idempotency `begin`, `gate.check` (issue, answer `required`), user resolve and native confirm via `axis.approvals/1` and main, the retry with the same idempotency key and `approval`, `gate.check` again (`confirmed`), audit `policy.decision`, the handler calls `consume`, which audits and spends the approval before the action runs. A failed action cannot be retried on the same approval; the idempotency key is freed and the user confirms again.

## Rules

- Packages may import `node:*`, `zod` (exactly 4.6.6) and other `@axis/*` packages. They never import `vs/*`, Electron or the DOM.
- The UI and workbench code in `code-oss/overlay/src/vs/axis/**` reaches the daemon only through `@axis/protocol`.
- Tests use `node:test`. No other test framework. `test/packages/imports.test.mjs` enforces the import allowlist.

## Commands

Use Node 24.22.1 (see `code-oss/upstream.json`). From the repository root:

```bash
npm ci --ignore-scripts
npm run typecheck   # strict tsc across all packages
npm run build       # clean, then tsc -b with the root tsconfig.json references
npm test            # clean build (scripts/clean-dist.mjs), then node --test "dist/test/**/*.test.js" in each package
```

## Adding a package

1. Copy `packages/protocol/package.json` and `tsconfig.json` to `packages/<name>/` and rename. Keep `"type": "module"` in the package; the repository root stays CommonJS so the existing `test/` scripts load.
2. Add `{ "path": "packages/<name>" }` to `references` in the root `tsconfig.json`, `references` in the package tsconfig, and a `"0.0.0"` dependency for each workspace package you use.
3. Use `.js` suffixes on relative imports, put sources in `src/` and tests in `test/` (`*.test.ts`).
4. Run `npm install --ignore-scripts` and commit the lockfile.
5. Start every file with `// Copyright (c) 2026 Dylan Lambertson. All rights reserved.`

## Reaching the app

Planned in ADR 0005 D3: a post-apply hook stages package sources into `src/vs/axis/packages/` so Code OSS's own esbuild bundles them into the daemon. Not implemented yet.
