# Axis packages

Axis-owned TypeScript that does not need Code OSS services lives in `packages/*` as npm workspaces (`@axis/<name>`). The decision and the rules are in `docs/adr/0005-axis-packages-layout.md`; this page is the working summary.

| Package | Purpose |
|---|---|
| `@axis/protocol` | Versioned envelope, structured errors, the contract registry (`contracts`, `lookupMethod`, `specProblem`, `tableProblems`: tier, side effect, idempotency and timeout per method, frozen, fail closed on an invalid spec) with `axis.worktrees/1`, `axis.projects/1`, `axis.approvals/1` and `axis.audit/1`, and the challenge shape. Zod schemas and inferred types. Every method schema is wrapped by `guarded`: the input is walked and structurally copied before parsing (accessors, Proxies, irregular arrays, forbidden keys and oversize input are refused), the parsed copy is returned, and a failure is one fixed issue that never echoes input. No Node imports. |
| `@axis/pty-policy` | Pure logic for terminal environments and CLI agent launch: the PTY-5 deny-list (`buildCliEnv`), SI-ENV (`buildPlainTerminalEnv`), GIT-ENV-1 (`buildGitEnv`), the `axis.cliAgents` schema, setting-scope resolution and `resolveLaunch`. Axis resolves launch executables itself (PATH only, never the cwd or worktree). Imports `node:*` and `zod` only; no `process.env` access. |
| `@axis/challenge` | Daemon-side approval challenges for tier 3-5 destructive operations: issue, user resolve, native confirmation, single-use `consume`. Node `crypto` only. |
| `@axis/daemon` | Transport-agnostic daemon core: connections, handshake, dispatch, tiers, idempotency, cancel and timeout, backpressure, error sanitisation. Every service (identity, policy, approvals, idempotency store, audit sink, handlers) is injected. No Electron. `MemoryIdempotencyStore` is for tests and dev wiring only (it forgets on restart); the product uses the journal-backed store. The pipeline owns approvals (`ApprovalGate.issue` and `execute`, see "Wiring the daemon"). |
| `@axis/providers` | Provider adapter API (v1): normalized requests, stream events, capability reports, error taxonomy; the daemon-side guard (budget hook PRV-6, redaction hook PRV-2, timeouts, cancellation, stream checks); the mock provider. `@axis/providers/contract` is the reusable adapter contract suite (test support in `packages/providers/contract/`, outside `src/` so it is never staged; imports `node:test`). |
| `@axis/git-ops` | Daemon-orchestrated Axis commit and push, and GitHub compare URLs. Takes an injected git runner (`context: "pty" \| "daemon"`): hooks run only in the pty context. Commit binds the reviewed tree, push uses one explicit refspec, both are refused while a CLI run is active. |
| `@axis/audit` | Secret redaction, canonical JSON, and the hash-chained append-only audit log on `node:sqlite` (DMN-5, DMN-6). Also the SQLite helpers (`openDatabase`, `withTransaction`, `runMigrations`). |
| `@axis/journal` | Durable `agent_workspaces` and `agent_runs`, the Phase 1a run state machine, idempotency keys and restart recovery (DMN-7). Depends on `@axis/audit`. |
| `@axis/anthropic` | Anthropic (Claude) Messages API adapter for `@axis/providers` (ticket 9, ANT-1): hand-written SSE parser with byte, event and depth limits, redirects refused, error text never built from a response body, injected `fetch`. Design: `docs/design/anthropic-adapter.md`. |
| `@axis/vault` | Connection vault: key storage interface, backend reporting, the PRV-1 rule for the Linux `basic_text` backend (consent or refusal), an in-memory test backend, and the seam for real OS backends. Runs in the daemon only. |

More packages (worktrees, and so on) are added by their own changes.

## Audit anchor (requirement on the daemon)

A hash chain cannot show that its newest events were deleted. Threat model G-11 is closed only if the daemon keeps a copy of the chain head outside the database. The daemon MUST:

1. Call `AuditLog.checkpoint(previousAnchor)` after each append batch (for example at the end of each handled request that wrote events, and on clean shutdown). It verifies only the events after the previous anchor, so the cost is proportional to the batch, and returns `{ seq, hash }`; it throws `E_INTERNAL` if the chain is already broken, and a broken chain is never anchored. Run the full `checkpoint()` (no argument) at startup.
2. Persist that anchor outside the journal database, where an attacker who edits the database file does not also write (for example the OS keychain through the main process, or a store owned by a different principal). A separate file under the same OS user does not count: the attacker in DMN-5 runs as that user and can rewrite the file as easily as the database. Where it is stored is daemon work and is not decided here.
3. At every start, before accepting work, call `verify({ expectedHead: anchor })` and treat `ok: false` as an integrity failure (surface it to the user; do not silently continue). A longer chain that still contains the anchor is valid.

Persist an anchor only after the commit it covers is durable. `openDatabase` uses `synchronous=FULL` everywhere and, on macOS, also `fullfsync` and `checkpoint_fullfsync`, because plain `fsync` there does not flush the drive cache. That makes a commit survive a process kill on every platform, and power loss on Linux (`fsync`), Windows (`FlushFileBuffers`) and macOS (F_FULLFSYNC), provided the drive or virtualisation layer honours flushes; if it does not, nothing in the database can tell. A power cut that loses commits an anchor already covered shows up at the next start as `truncated`, and must be reported as "the database is behind the anchor", not silently treated as tampering or ignored.

Without the anchor, `verify()` detects edits, deletions in the middle and reordering, but not removal of the tail. The chain gives local tamper evidence only (ADR 0003 D5). The append-only triggers stop no one with write access to the file (`DROP TRIGGER` works), and the chain has no key, so everything after the last anchor can be recomputed. It does not stop an attacker who can also rewrite the anchor.

## Single instance (requirement on the daemon)

`Journal.recover(lock)` interrupts every RUNNING run, which is correct only when the previous writer is dead. The daemon MUST take the exclusive instance lock (`acquireInstanceLock(dir)` from `@axis/audit`, a pid and process-start-time lock file in the database directory) before opening the journal, and hold it until exit. `recover()` refuses to run without a held lock, and the lock must be the `InstanceLock` object `acquireInstanceLock` returned (an object literal with the same fields is refused) and must guard the directory of the journal's own database file. A second daemon on the same directory fails with `E_CONFLICT`.

## Principals

`createdBy` and every transition `actor` come from the authenticated connection (`ConnectionContext`), never from a request payload. The journal requires `createdBy` on `createRun` (there is no default) and scopes idempotency keys by it, so a caller that could choose its own principal could both forge attribution and replay another principal's keys. Completing a run in review (REVIEWING to COMPLETED) is the person's act in Phase 1a (diff review), and the journal does not take the string `"user"` for it. It needs a `UserPrincipal`, an unforgeable brand (a class with a private field and a module-private mint symbol; a literal, `Object.create` of the prototype or a `structuredClone` fails the check with `E_POLICY_DENIED`). The only way to get one is `userPrincipal()` from the subpath `@axis/journal/daemon-principal`, which is not exported from the package root, and `test/packages/imports.test.mjs` allows only the daemon's connection layer (package `daemon`) to import it. The daemon mints it from the attested connection (the `ConnectionContext` the renderer cannot influence) at the moment the person acts, and never from a request payload or a field a client supplied.

## Data directory

`openDatabase` and `acquireInstanceLock` create a missing data directory 0700. An existing directory is never chmod-ed, and is refused (`E_INVALID_ARGUMENT`, `details.reason` one of `symlink`, `not-owned`, `group-writable`, `world-writable`, `dotdot-path`, `parent-group-writable`, `parent-world-writable`, `parent-sticky-foreign-owner`) when its last component is a symlink or the real directory is not owned by the current user or is writable by group or others. The path is judged as the kernel resolves it: a `..` after a symlink leads to the symlink target's parent, and a missing directory is never created through a path that contains `..`. The database files themselves are always 0600. File system errors from these steps are mapped into the closed error set without the path: a bad path (too long, a component that is a file) is `E_INVALID_ARGUMENT`, an operating system permission refusal is `E_POLICY_DENIED`, a full disk or a busy file is `E_UNAVAILABLE`, and `details.errno` carries only the errno name.

The check is deliberately narrow:
- For a directory that already exists, only that directory is judged, not its ancestors. (For a MISSING one, the nearest existing ancestor must not be writable by group or others, unless it is sticky like `/tmp` AND owned by root or the current user (`parent-sticky-foreign-owner` otherwise, because the sticky bit does not restrict the owner), and a symlinked ancestor is judged by its target.) A parent that another user can write to (and that is not sticky) lets them rename the checked directory away and plant another, so the data directory must sit under a parent only the user controls, which the per-user application-data directory does.
- Only mode bits and the owner are read. POSIX ACLs (macOS `chmod +a`, Linux `setfacl`) can grant access that the bits do not show, and are ignored.
- Windows has no owner or mode bits to read here, so the check is skipped; the per-user profile directory is protected by its ACL.

## Journal and audit share one connection

`Journal.open(db, { audit })` rejects (`E_INTERNAL`) an `AuditLog` that was created on a different `DatabaseSync` handle. Sharing the handle is what makes a state change and its audit event commit or roll back together.

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
## Using `@axis/git-ops`

`planPush` and `executePush` take a required `baseSha`: **the last commit that was actually pushed** (or the workspace's recorded base before the first push), read from the journal by the daemon. The secret scan covers `baseSha..tip`, every commit's patch and its commit message, so everything reachable from `baseSha` is assumed to be on the remote already. If a workspace's base is a local commit that was never pushed, its ancestors go out unscanned: the journal must record the sha of each successful push and supply it next time. A `baseSha` that is not in the repository or not an ancestor of the branch (history was rewritten) is refused with `E_CONFLICT`. Never derive it from a ref under `refs/remotes`: the code in the worktree can write those.

A plan that needs confirmation (warn mode findings, binary files, a scan that was too large) carries `tip` and `digest`. The caller passes `confirmed: true` and `confirmedPlan: { tip, digest }` to `executePush`, which re-scans and answers `E_CONFLICT` with `details.reason: "plan_changed"` if either differs. The runner reports `truncated` when it cut off output, and any truncated scan call fails closed.

Commit messages are scanned as bytes: the runner is asked for `raw` stdout (one character per byte) and must say it complied, or the scan fails with `E_UNAVAILABLE`. The scanner gets the UTF-8 reading and, when the commit declares an `encoding` other than UTF-8 (git decodes a message from it when showing it, and `i18n.commitEncoding` makes git write one), the message decoded from that encoding too, so legacy commits such as ISO-8859-1 are scanned and confirmed like any other. A message is refused in both scan modes (`E_POLICY_DENIED`, naming only commit ids) when it holds a NUL byte (UTF-16 and NUL padding), has bytes that are invalid in its declared encoding (UTF-8 when none), or declares an encoding the runtime does not know. Axis's own commit pins `i18n.commitEncoding=utf-8`.

This closes byte-level encodings only. Valid text that merely looks different (zero-width, bidi or fullwidth characters, or control characters inside a key) is not normalised and is not caught: the scan guards against accidental leaks, not a determined author. A commit object over 8 MiB is checked only up to that limit, and the scan reports it as too large (refused in refuse mode, confirmable in warn mode, unless the cut splits a multibyte character, which is refused in both). Only the first `encoding` header counts, as in git, and the whole object (headers included) is decoded from it with a strict decoder; a commit with two or more `encoding` headers is refused, and so is one whose decode fails (the runtime's decoder is stricter than git's, so there is no weaker fallback). For the ISO-2022-JP family the scan also reads the bytes with shift sequences and control characters removed. Labels git accepts but the runtime does not know are refused with a hint to push from a terminal, except a few common aliases (CP932, eucJP, CP936, CP949, ISO-2022-JP-2).

The node runner starts git in its own process group so a timeout kills git's children. A normal daemon exit kills the live groups; a crash of the daemon cannot, and may leave an orphaned git running until it finishes.

## Request digest

The digest is specified under "Shared request digest" above. The daemon computes it once with `requestDigest()` (`packages/daemon/src/digest.ts`, whose doc comment states the ECMAScript `JSON.stringify` semantics) and passes it to the gate as `input.digest`; both packages are pinned by the same fixed vectors, and the copies are to be merged into `@axis/protocol`.

## Wiring the daemon

`@axis/daemon` never imports `@axis/challenge`. The product wiring supplies an `ApprovalGate` adapter, and the pipeline owns the whole approval sequence: a handler never sees a challenge id and the gate cannot answer "confirmed" without spending a live challenge.

- No `approval` in the request: the pipeline calls `gate.issue(input, content)` and answers `E_APPROVAL_REQUIRED`. The adapter calls `manager.issue({ contract: input.contract, version: input.contractVersion, method: input.method, args: input.args, requestDigest: input.digest, target: content.target, contentDigest: content.contentDigest, actor: input.actor, connectionId: input.connectionId, windowId: input.identity.windowId, tier: input.tier })`. `args` is required and `requestDigest` is only a cross-check, so both must agree. For tier 4 and 5 it also takes `takeNativeProof(challengeId)` once and passes it to main, never to a renderer.
- With `approval: { challengeId }`: the pipeline calls `gate.execute(input, approval, content, action)` inside the method's content lock. The adapter calls `manager.consume(approval.challengeId, { actor: input.actor, connectionId: input.connectionId }, { contract, version, method, args, requestDigest: input.digest, target: content.target, currentContentDigest: content.contentDigest }, action)`, translates a `ChallengeError` as described under the adapter rules and returns what `action` returns (the daemon ignores that value). The handler runs inside `action`, so it can only run with a spent approval, and it receives only `ctx.approved` (`method`, `target`, `requester` and the adapter's `capability`). The `approval` field is stripped from its payload.
- Content: a tier 3+ method registers a hook, `daemon.register(contract, version, handlers, { content: { method: (ctx, payload) => ({ target, withLock }) } })`. `withLock(fn)` takes the lock that protects the content and calls `fn(contentDigest)`. The digest is read under that lock at issue and again at execute, and the handler runs under the same lock, so "the content is unchanged right now" and the action cannot be separated. A method without a hook (including a policy-raised tier) is approved against target `request:<digest>` with the digest as content digest. Review each hook with the destructive call it guards; a handler must check `ctx.approved.target` against what it is about to act on.
- Replay: a tier 3+ replay from the originating connection returns the stored result. From any other connection it needs its own approval, and the stored result is returned inside `execute`.
- Withdrawal: a cancel or timeout before the approval was spent calls `gate.withdraw(challengeId, { actor, connectionId })` once; a closed connection calls `gate.withdrawConnection(connectionId)` once. Both are best effort.

Adapter rules:

- Pass both `args` and `requestDigest: input.digest` to `issue` and `consume`; the manager computes its own digest and a mismatch is `E_INVALID_ARGUMENT`.
- `gate.withdraw` calls `manager.withdraw(challengeId, { actor, connectionId })` and `gate.withdrawConnection` calls `manager.withdrawConnection(connectionId)`; the adapter may return their result (an object or a count) or discard it, the daemon ignores it. A withdrawn id is refused with `E_POLICY_DENIED` afterwards.
- Handler errors are mapped by the pipeline inside `action` and never pass through `consume`. A handler that fails (or returns an error) has still spent the approval; the user confirms again and the idempotency key is freed. `action` throws only for an abort or a failed decision-audit write.
- Map `ChallengeError` to `ApprovalError` for refusals: `E_POLICY_DENIED`, `E_CONFLICT`, `E_BACKPRESSURE` (issue out of capacity) and `E_INVALID_ARGUMENT` (arguments over 16 KiB canonical or not a plain object, a target that is not display-safe or over 1024 characters) keep their code; any other code is `E_INTERNAL`. An action failure (`ChallengeError` with `executed: true`; the flag is in `detail`, singular, not `details`) is re-thrown as it is, as `ApprovalError(code, true)` or the original error, and answered `E_INTERNAL` (or the abort code). Never call `error.toWire`: the daemon owns the wire answer and the correlation id.
- Mint the handler's capability inside the action, after the spend: for worktrees, call `markDiscardConfirmed` from `@axis/worktrees/daemon-confirm` there, bound to `content.target` and `content.contentDigest`, and pass it as `capability` in the `ConfirmedAction` given to `action`. The handler reads `ctx.approved.capability` (non-enumerable, never serialised or logged) and never mints one itself.
- Identity comes from the daemon only: pass `input.identity.windowId`, `input.connectionId` and `input.actor` (attested by the transport) to the manager, never a value from the request payload or the envelope.
- `manager.withdrawConnection` can throw `E_INTERNAL` (for example on a bad clock reading). The adapter should catch it; if it throws anyway the daemon's close path still completes and reports the error locally through `onInternalError`.
- Quotas are described under "Using `@axis/challenge`". Closing a connection leaves tombstones until they expire (at most one challenge TTL), so a legitimate window reload is held to its quota for up to one TTL.
- The challenge manager's audit sink must be synchronous (a returned promise counts as a failed write, so every `issue()` would fail closed). Never hand it a journal sink with an async `append`; wrap that in a synchronous buffer or queue.
- `issue()` out of capacity is `E_BACKPRESSURE` (retryable): ask-and-cancel cycles also count against the actor's challenge quota until withdrawn, so map it through, never to `E_INTERNAL`.
- Tier 3+ methods must declare `approval` as an optional field of their strict request schema: `register()` throws otherwise, and a policy-raised tier on a method without it is refused with `E_POLICY_DENIED` (audit reason `not_approvable`) before any challenge is issued.
- The daemon runs the action at most once and answers with the action's own outcome, never with `execute`'s return value; a gate that returns before the action completed gets `E_INTERNAL`, and the slot stays held until the handler settles.
- A challenge issued for a request that was aborted during an async `issue` is withdrawn on a best-effort basis; if that fails it holds its slots until the challenge TTL (60 s by default).

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
