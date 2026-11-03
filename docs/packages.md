# Axis packages

Axis-owned TypeScript that does not need Code OSS services lives in `packages/*` as npm workspaces (`@axis/<name>`). The decision and the rules are in `docs/adr/0005-axis-packages-layout.md`; this page is the working summary.

| Package | Purpose |
|---|---|
| `@axis/protocol` | Versioned envelope, structured errors, contracts such as `axis.worktrees/1`, and the challenge shape. Zod schemas and inferred types. No Node imports. |
| `@axis/pty-policy` | Pure logic for terminal environments and CLI agent launch: the PTY-5 deny-list (`buildCliEnv`), SI-ENV (`buildPlainTerminalEnv`), GIT-ENV-1 (`buildGitEnv`), the `axis.cliAgents` schema, setting-scope resolution and `resolveLaunch`. Axis resolves launch executables itself (PATH only, never the cwd or worktree). Imports `node:*` and `zod` only; no `process.env` access. |
| `@axis/challenge` | Daemon-side approval challenges for tier 3-5 destructive operations: issue, user resolve, native confirmation, single-use `consume`. Node `crypto` only. |
| `@axis/daemon` | Transport-agnostic daemon core: connections, handshake, dispatch, tiers, idempotency, cancel and timeout, backpressure, error sanitisation. Every service (identity, policy, approvals, idempotency store, audit sink, handlers) is injected. No Electron. |
| `@axis/daemon` | Transport-agnostic daemon core: connections, handshake, dispatch, tiers, idempotency, cancel and timeout, backpressure, error sanitisation. Every service (identity, policy, approvals, idempotency store, audit sink, handlers) is injected. No Electron. `MemoryIdempotencyStore` is for tests and dev wiring only (it forgets on restart); the product uses the journal-backed store. The approval gate must check the request digest (`requestDigest()`, shared with `@axis/challenge`), the actor and the connection id, and burn the challenge on use. |
| `@axis/daemon` | Transport-agnostic daemon core: connections, handshake, dispatch, tiers, idempotency, cancel and timeout, backpressure, error sanitisation. Every service (identity, policy, approvals, idempotency store, audit sink, handlers) is injected. No Electron. `MemoryIdempotencyStore` is for tests and dev wiring only (it forgets on restart); the product uses the journal-backed store. The pipeline owns approvals (`ApprovalGate.issue` and `execute`, see "Wiring the daemon"). |

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

`@axis/daemon` never imports `@axis/challenge`. The product wiring supplies an `ApprovalGate` adapter, and the pipeline owns the whole approval sequence: a handler never sees a challenge id and the gate cannot answer "confirmed" without spending a live challenge.

- No `approval` in the request: the pipeline calls `gate.issue(input, content)` and answers `E_APPROVAL_REQUIRED`. The adapter calls `manager.issue({ contract: input.contract, version: input.contractVersion, method: input.method, args: input.args, requestDigest: input.digest, target: content.target, contentDigest: content.contentDigest, actor: input.actor, connectionId: input.connectionId, windowId: input.identity.windowId, tier: input.tier })`. `args` is required and `requestDigest` is only a cross-check, so both must agree. For tier 4 and 5 it also takes `takeNativeProof(challengeId)` once and passes it to main, never to a renderer.
- With `approval: { challengeId }`: the pipeline calls `gate.execute(input, approval, content, action)` inside the method's content lock. The adapter calls `manager.consume(approval.challengeId, { actor: input.actor, connectionId: input.connectionId }, { contract, version, method, args, requestDigest: input.digest, target: content.target, currentContentDigest: content.contentDigest }, action)`, translates a `ChallengeError` into `ApprovalError` (`E_POLICY_DENIED`, or `E_CONFLICT` for used, expired or changed content; `executed: true` if the action ran) and returns what `action` returns. The handler runs inside `action`, so it can only run with a spent approval, and it receives only `ctx.approved` (`method`, `target`, `requester`). The `approval` field is stripped from its payload.
- Content: a tier 3+ method registers a hook, `daemon.register(contract, version, handlers, { content: { method: (ctx, payload) => ({ target, withLock }) } })`. `withLock(fn)` takes the lock that protects the content and calls `fn(contentDigest)`. The digest is read under that lock at issue and again at execute, and the handler runs under the same lock, so "the content is unchanged right now" and the action cannot be separated. A method without a hook (including a policy-raised tier) is approved against target `request:<digest>` with the digest as content digest. Review each hook with the destructive call it guards; a handler must check `ctx.approved.target` against what it is about to act on.
- Replay: a tier 3+ replay from the originating connection returns the stored result. From any other connection it needs its own approval, and the stored result is returned inside `execute`.
- Withdrawal: a cancel or timeout before the approval was spent calls `gate.withdraw(challengeId, { actor, connectionId })` once; a closed connection calls `gate.withdrawConnection(connectionId)` once. Both are best effort.

| Daemon field | Challenge field |
|---|---|
| `input.contract` (bare id), `input.contractVersion` | `contract`, `version` |
| `input.method`, `input.args` | `method`, `args` |
| `input.digest` | `requestDigest` (cross-check) |
| `input.actor`, `input.connectionId` | `actor`, `connectionId` |
| `input.identity.windowId` | `windowId` |
| `content.target`, `content.contentDigest` / digest under lock | `target`, `contentDigest` / `currentContentDigest` |

Destructive library entry points are protected independently of the daemon: `@axis/worktrees` requires a token that only `markDiscardConfirmed` can mint, and that function is exported only from the `@axis/worktrees/daemon-confirm` subpath. Only the integration package that implements the gate adapter may import that subpath, never a handler. This cannot be enforced inside `@axis/daemon`, so it is a review rule.

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
