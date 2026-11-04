# Daemon host: the composition root for the Axis daemon

- **Status:** Proposed (design only, no code). Reviewed before any ticket below starts.
- **Date:** 2026-11-04.
- **Decision owner:** Dylan Lambertson.
- **Depends on:** ADR 0003 (Electron IPC bridge; D1 handshake, D2 contracts, D3 call semantics, D4 policy and approvals, D5 audit, validation criteria 1 to 7), ADR 0005 (D3 staging, D9 `node:sqlite`), `docs/packages.md` ("Wiring the daemon", "Audit anchor", "Single instance", "Principals", "Data directory"), `docs/design/axis-agent-shell.md` §5 and §8.2, `docs/design/axis-agent-shell-policies.md` §6, threat model Phase 1 (DMN-1 to DMN-7, G-11, G-12, G-20, G-24).
- **Evidence tags:** **[V]** verified in this repository at `e961613` (or on the named branch); **[I]** inferred, not verified.
- **Branches this design waits on (not edited by it):** `fix/daemon-sigterm` (graceful shutdown, in review), `feat/daemon-idempotency-store` (journal-backed store, in review), `feat/worktree-manager` (the macOS host's `@axis/worktrees`, in re-review), `feat/tool-broker-core` and `feat/git-snapshot` (1b and drift, in review).

## 1. Purpose and scope

The merged libraries (`protocol`, `challenge`, `daemon`, `pty-policy`, `git-ops`, `audit`, `journal`, `providers`) are parts. Nothing yet starts a process, opens the database, takes the lock, registers handlers, wires approvals or answers a request. `@axis/daemon` is deliberately a core with every service injected ([V] `DaemonOptions`: `identity`, `audit`, `idempotency` required; `policy` absent means deny all; `approvals` absent refuses tier 3 and above). **`@axis/daemon-host` is the one place that chooses and connects those services.** It is the earliest thing that can answer a real request, so it is also the first demonstrable vertical slice (§10), before any UI work.

In scope: package boundary, startup and shutdown order, the contract registry and policy table, the wiring of challenge, idempotency, audit and anchor, the worktrees port, trust attestation, transports, error and logging policy, the headless slice test, tickets.

Out of scope: Code OSS, Electron builds and patches, the main seam and the overlay entry (`axisDaemonMain.ts`, ADR 0003 D6), the Axis pty process (B9), the shell, the vault and broker (1b). The host exposes the seams those plug into.

## 2. Package boundary: `@axis/daemon-host`

One new package, `packages/daemon-host`. It is the **only** package allowed to import every other package, and nothing in `packages/*` imports it. The overlay entry (a ~30 line file that adapts `process.parentPort` and calls `runHost`) is the single consumer.

```mermaid
flowchart LR
  subgraph supervisor [Supervisor: main / test parent / web server]
    S[control + attestation]
  end
  subgraph host [@axis/daemon-host]
    T[transport + mux] --> D[@axis/daemon]
    D --> H[handlers per contract]
    H --> P[ports]
    C[compose: storage, audit, anchor, approvals, policy] --> D
  end
  S -- control messages, connections --> T
  P --> WT[worktrees port]
  P --> RN[runs / cli process port]
  P --> RV[review port]
  H --> GO[@axis/git-ops]
  H --> PV[@axis/providers]
  C --> J[@axis/journal, @axis/audit, @axis/challenge]
```

### 2.1 Imports

| May import | Only where | Never |
|---|---|---|
| `node:*`, `zod` 4.6.6 | anywhere | `electron`, `vs/*`, DOM, a socket listener (ADR 0003 D1.1, DMN-4) |
| `@axis/protocol`, `daemon`, `challenge`, `audit`, `journal`, `git-ops`, `pty-policy`, `providers` | anywhere | |
| `@axis/journal/daemon-principal` | `src/handlers/review.ts` only | any handler that is not the person's own act |
| `@axis/worktrees` | `src/bindings/worktrees.ts` only | handlers, ports, compose |
| `@axis/worktrees/daemon-confirm` | `src/gate/worktrees-confirm.ts` only | everything else. This is "the integration package that implements the gate adapter" of `docs/packages.md`, which is this package. |
| `@axis/runs`, `@axis/review` (when they land) | `src/bindings/*.ts` only | |

`test/packages/imports.test.mjs` must be extended with these rows: today it allows `@axis/journal/daemon-principal` only to package `daemon` [V `docs/packages.md` "Principals"], so ticket H1 changes the rule to "package `daemon-host`, file `src/handlers/review.ts`" and keeps the rule for package `daemon` if its connection layer still needs it.

### 2.2 Layout (every file under 500 lines)

```text
packages/daemon-host/
  src/
    config.ts            HostConfig schema (strict), parsed from the init message
    ports/               service interfaces the handlers use (the only thing handlers import)
      worktrees.ts runs.ts review.ts cli-process.ts git-runners.ts trust.ts clock.ts
    contracts/           registry assembly, handler/policy coverage check
    handlers/            one file per contract: approvals, audit, cliRuns, git, projects, providers, review, worktrees
    gate/                ApprovalGate adapter, native-confirm bridge, worktrees-confirm.ts
    policy/              rule table, trust registry
    storage/             lock, directory, database, journal, idempotency store, recovery
    audit/               sinks (daemon, challenge), anchor manager
    control/             privileged message schemas, attestation verifier, connect limiter
    transport/           mux, node-port and electron-port adapters (re-uses @axis/daemon's)
    log/                 logger, redaction, safe error summary
    bindings/            the only files that import @axis/worktrees, @axis/runs, @axis/review
    host.ts              createHost(deps) -> { start, shutdown }
    node-main.ts         runHost(): crash handlers, signals, exit codes
  testing/               support outside src/ (never staged): supervisor, fake ports, typed client, fixtures
  test/                  unit tests and test/slice/headless.test.ts
```

`createHost(deps)` takes every OS-touching dependency as an argument (clock, filesystem seam, runner, transport, supervisor channel). `node-main.ts` supplies the real ones. This is how the same host runs under Electron, a child process and a web host without conditionals.

### 2.3 Ports: what is injected

Handlers see only these interfaces. A port is defined against `@axis/protocol` schemas, never against another package's types, so the real implementation can land later and a fake can stand in now.

| Port | Shape (summary) | Fake in `testing/` | Real binding |
|---|---|---|---|
| `WorktreesService` | `list, status, create, finalise, remove, restoreFromRunBase, previewDiscard, assertNoDrift, reconcile`, all **id-based**, returning the `axis.worktrees/1` response shapes | yes, real `git worktree add` through a hooks-off plain runner (fixture only) | `bindings/worktrees.ts` over `WorktreeManager` (§7) |
| `CliProcessHost` | `spawn(exactCommand) -> { pid, exited: Promise<exit>, kill() }`, status only, never output into the daemon | Node `child_process` with the PTY-5 env (fixture) | the Axis pty process control channel (B9) |
| `RunsService` | CLI run lifecycle over the journal: `start, stop, get, list`, run-base refs | fake over `Journal` | `@axis/runs` |
| `ReviewService` | `diff(workspaceId) -> { treeHash, files, patchesBounded }` | fake over `git diff` | `@axis/review` |
| `GitRunners` | `{ daemon: GitRunner, pty: GitRunner }` for `@axis/git-ops` (`GitContext`) | one local Node runner for both (labelled test only) | `daemon`: `createNodeRunner`; `pty`: control-channel runner (B9) |
| `TrustRegistry` | `isTrusted(identity)`, updated by main | in-memory | same, fed by control messages |

## 3. Startup order

Startup is a straight line. Any failure before step 12 exits with a typed code and no listener ever existed. Nothing "falls back": a missing or invalid step fails closed.

1. **Process hardening.** Install `uncaughtException` and `unhandledRejection` handlers first (§9.3). No `process.env` reads outside `config.ts` and the runners.
2. **Init message.** Wait (bounded, 10 s) for exactly one `init` message from the supervisor on the control channel: `HostConfig` (strict Zod): `dataDir`, `worktreeRoot`, `platform`, `logLevel`, `devDiagnostics` (false when packaged), `attestationKey` (≥ 32 random bytes), limits overrides. A second `init` is ignored and logged. **The data directory and key come from main, never from a renderer message or an environment variable the renderer can influence.**
3. **Data directory and instance lock.** `acquireInstanceLock(dir)` from `@axis/audit` (creates the directory 0700, applies the ownership, symlink and parent checks of `docs/packages.md` "Data directory"). Failure: `E_CONFLICT` (a second daemon) exits 75; `E_INVALID_ARGUMENT` or `E_POLICY_DENIED` exits 78. Hold the lock object until exit.
4. **One database handle.** `openDatabase(dir/axis.db)` once. **The journal, the audit log and the idempotency store all use this `DatabaseSync`** (`Journal.open` already refuses an `AuditLog` on another handle, [V]; the store does the same on its branch [V]).
5. **Redactor.** One process `Redactor` (`@axis/audit`), seeded with the built-in rules. Registered secrets are added in 1b by the vault. The audit log, the idempotency store, the logger and the providers guard all receive this instance (§9.2).
6. **Audit log and anchor check.** `new AuditLog(db, { redactor })`. Ask the supervisor for the stored anchor (`anchor.get`, bounded 5 s) and run `verify({ expectedHead: anchor })`, then a full `checkpoint()` ([V] `docs/packages.md` "Audit anchor", requirements 1 and 3).
   - `ok: true`: continue. `reason: "truncated"` with a chain that is shorter than the anchor: report "the database is behind the anchor", never "tampering" and never silence.
   - `ok: false` or no anchor reachable on a database that already has events: enter **degraded mode** (§5.5), do not continue to step 10 with mutating methods.
   - A first start (empty chain, no anchor) is normal and creates the first anchor after step 9.
7. **Journal.** `Journal.open(db, { audit })`.
8. **Idempotency store.** `JournalIdempotencyStore.open(db, { audit, redactor })` (`feat/daemon-idempotency-store`). It marks keys of the previous boot as `unknown: interrupted` itself ([V] `UnknownReason`). Until that branch merges, the host refuses to start with `MemoryIdempotencyStore` unless `config.devMemoryIdempotency` is set by the test supervisor; the product path has no such flag.
9. **Recovery.** `journal.recover(lock)` (interrupts RUNNING runs, DMN-7), then `worktrees.reconcile()` (§7.3: `git worktree list --porcelain` and `refs/axis/*` against the journal, gate G-12). Reconcile has a time budget (default 20 s). Failure or timeout marks only the affected workspaces `needs attention` (their methods answer `E_UNAVAILABLE`), and is audited. It never blocks the other workspaces and never aborts startup. Then `checkpoint(previousAnchor)` and persist the new anchor (the recovery events are in the chain).
10. **Services.** Build, in this order: `ChallengeManager` (synchronous sink, §5.2), the gate adapter, `TrustRegistry`, the attestation `IdentityVerifier`, `RuleTablePolicy`, the `Daemon`; `register()` every handler with its content hooks; run the **coverage check** (§4.2). A mismatch throws, and the host exits 70 before listening.
11. **Signals.** Install the shutdown handlers (§8).
12. **Ready.** Send `ready { protocolVersion, contracts, degraded?: reason }` on the control channel. The supervisor starts brokering connections only after this. From here the host accepts `connect` messages. **There is no listening socket**; "listening" means the control channel handler is attached.

## 4. Contract registry

### 4.1 Where definitions live

Contract schemas (strict Zod objects, `MethodSpec`) live in `@axis/protocol`, one file per contract, because the renderer client and the web target import them and the package has no Node imports ([V] `NO_NODE`). `@axis/protocol`'s `contracts` table today holds **only `axis.worktrees/1`** [V `contracts.ts`]. Every contract below except that one is new work (tickets P1a to P1c). The host builds its registry with `protocolRegistry` filtered by `config.contracts` (an allow-list), so a build or test can serve fewer contracts, never more than the table holds.

The envelope carries only `hello`/`welcome`/request/cancel/response frames [V `envelope.ts`]. **There is no server-push event or stream frame.** ADR 0003 D2/D3 describe `stream` and `event`, but neither exists in the protocol or the daemon. Phase 1a UI state therefore polls (`get`/`list`, 1 to 2 s with jitter) and the headless slice does the same. A protocol extension (ticket E1) is a UI-quality item, not a blocker for the slice.

### 4.2 The table

Tier and `sideEffect` are the contract's declared minimum; policy may raise, never lower ([V] `PolicyDecision`). "Appr" means the request schema has an optional `approval` field, which the daemon requires for tier 3 and above (`register()` throws otherwise, [V]); "native" means tier 4 or 5, which adds `confirmNative` over the privileged channel (ADR 0003 D4). Idempotency `req` means `requiresIdempotencyKey`. "Trust" means the policy row `requireTrusted`.

| Contract | Method | Side effect | Tier | Idem | Appr | Trust | Actors | Backed by | Phase |
|---|---|---|---|---|---|---|---|---|---|
| `axis.worktrees/1` | `list`, `status` | read | 0 | none | | | user | `WorktreesService` | 1a, exists |
| | `create` | write | 2 | req | | yes | user | same | 1a, exists |
| | `finalise` | write | 2 | req | | | user | same | 1a, exists |
| | `remove` | destructive | 4 | req | yes, native | | user | same, content hook (§7.2) | 1a, exists |
| | `restoreFromRunBase` | write | 2 | req | | yes | user | same | 1a, exists |
| | `discard`, `setUserEditing` | write | 2 | req / none | | | user | same | 1a, **named in the design docs, absent in the protocol** (additive, ticket P1d) |
| `axis.projects/1` | `list` | read | 0 | none | | | user | journal | 1a, new |
| `axis.approvals/1` | `resolve` | write | 2 | none | | | **user only** | `ChallengeManager.resolve` | 1a, new (the request and challenge shapes exist in `@axis/protocol`, [V] `challenge.ts`) |
| | `pending` | read | 0 | none | | | user | challenge listing for the caller's own window | 1a, new |
| `axis.cliRuns/1` | `start` | write | 2 | req | | yes | user | `RunsService` + `CliProcessHost` | 1a, new |
| | `stop` | write | 2 | req | | | user | same | 1a, new |
| | `get`, `list` | read | 0 | none | | | user | journal | 1a, new |
| `axis.review/1` | `diff` | read | 1 | none | | | user | `ReviewService` | 1a, new |
| | `complete` (run REVIEWING to COMPLETED) | write | 2 | req | | | **user only**, mints `UserPrincipal` | journal | 1a, new |
| `axis.git/1` (recommended, see Q1) | `pushPlan` | read | 1 | none | | | user | `git-ops` `planPush` | 1a, new |
| | `commit` | write | 2 | req | | yes | user | `executeCommit` | 1a, new |
| | `push` | network | 4 | req | yes, native | yes | user | `executePush` (content hook, §6.4) | 1a, new |
| | `compareUrl` | read | 0 | none | | | user | `compareUrl` | 1a, new |
| `axis.audit/1` | `status` | read | 0 | none | | | user | anchor manager | 1a, new |
| | `list` (`afterSeq`, `limit` ≤ 200) | read | 1 | none | | | user | `AuditLog.list` (events are redacted at write) | 1a, new |
| | `verify` | read | 1 | none | | | user | `AuditLog.verify`, one at a time, bounded, cancellable | 1a, new |
| `axis.providers/1` | `list` | read | 0 | none | | | user | `@axis/providers` mock and registered adapters | 1a, new (list only) |
| `axis.runs/1` | `start`, `cancel`, `get`, `list` (composer) | write / read | 2 / 0 | req / none | | yes | user | composer service, broker, `GuardedProvider` | **1b**, not served in 1a |

Notes on the table:

- **Default deny at two layers.** A method with no handler is not served. A method with no policy row is denied (I2). Both are enforced at startup (§4.2.1), not left to review.
- **Agent actors.** In 1a no agent actor connects through a port. Every `Actors` cell is `user`. A connection whose identity is `agent:*` or `daemon` is refused for every method, so the DMN-3 negative test (an agent resolving a challenge, or completing a review) is a policy-table test, not a special case in handlers. In 1b the broker is in-process and gets its own rows.
- **No path in any payload.** Projects and workspaces are named by journal ids, and the host resolves paths itself ([V] `worktrees.ts` header). Review each new schema against this (DMN-2).
- **`approvals.resolve` is not itself tier 3 or above**, otherwise resolving would need a challenge.

#### 4.2.1 Coverage check

At startup and as a unit test, assert: the set of `(contract, version, method)` in the served registry equals the set with a handler, equals the set with a policy row, equals the set with an audit action declaration (§5.3). Any difference throws. Every tier 3 or above method has a content hook or is explicitly marked "request digest content" in the table. This stops "a method was added to the protocol and is silently served, or silently dropped".

### 4.3 Handler shape

A handler is an adapter: validate nothing (the daemon already did, strict), derive identity from `ctx.identity` only, call one port method, map the result and errors (§9.1). It holds no state and no timer. Domain logic stays in the packages.

## 5. Wiring the services

### 5.1 Idempotency

`JournalIdempotencyStore` (not `MemoryIdempotencyStore`) is passed as `DaemonOptions.idempotency`. Scope is `(actorId, workspaceId, contract, version, method, key)`, 24 h. The store's `unknown` states (`interrupted`, `result-not-stored`, `failed-after-start`) map to `E_CONFLICT` with `details.reason`, never to a re-run, because the side effect may have happened. `exhausted` is `E_BACKPRESSURE`. These mappings are in the `feat/daemon-idempotency-store` daemon change; the host adds no logic. Retention for audit and keys is a config value with the ADR 0003 defaults (open question 4 there).

### 5.2 Challenge manager and the approval gate

- One `ChallengeManager`, built with a **synchronous** audit sink: `AuditLog.append` is synchronous [V], so the sink is a direct adapter. It must never return a promise (a promise counts as a failed write, so `issue` would fail closed).
- The gate adapter follows `docs/packages.md` "Wiring the daemon" and "Adapter rules" exactly and adds nothing: `args` and `requestDigest: input.digest` to both `issue` and `consume`; identity only from `input.identity`, `input.actor`, `input.connectionId`; `ChallengeError` mapped to `ApprovalError`; never `error.toWire`; `withdraw` and `withdrawConnection` wrapped in try/catch.
- **Native proof.** For tier 4 and 5, after `issue`, the adapter calls `takeNativeProof(challengeId)` once and sends `native.confirm { challengeId, proof, windowId, summary }` to the supervisor on the control channel. The proof never goes to a connection. The supervisor shows the dialog and replies `native.result { challengeId, proof, confirmed, windowId }`; the host calls `manager.confirmNative({ windowId }, ...)`. A supervisor that never answers lets the challenge expire (60 s); that is not an error path that needs recovery.
- **Capability minting** (worktrees `remove`, discard): inside the `action`, after the spend, in `gate/worktrees-confirm.ts`, bound to `content.target` and `content.contentDigest`. Handlers read `ctx.approved.capability`; none mints one.
- Quotas use the package defaults; the host exposes them in `HostConfig.limits` and tests lower them. The per-window **connect** rate limit that ADR 0003 and `docs/packages.md` assign to the daemon is the host's `ConnectLimiter` (token bucket per `windowId`, default 10 connects per minute, burst 5, bounded map with eviction), applied before `daemon.accept`. Over the limit, close the port without a `hello-rejected` (it would be a reconnect oracle).

### 5.3 Audit sink

Three writers, one chain, one handle:

1. **Journal events** commit with their state change in the same transaction (journal-first). Nothing to wire.
2. **Daemon sink** (`DaemonAuditSink`): adapter from `DaemonAuditEvent` (`policy.decision`, `rpc.execute`) to `AuditEventInput`. `actor` is the identity actor, `target` a canonical id (`workspace:<id>`, `run:<id>`), `payload` only allow-listed scalar fields from `DEFAULT_PAYLOAD_ALLOWLIST`; host-specific keys are added to the allow-list in the same change as the handler that emits them, enforced by the coverage check (§4.2.1). A throw or rejection **fails the request closed** (the daemon already does this, [V]). Marks the batch dirty for the anchor.
3. **Challenge sink**: §5.2.

No sink runs inside a journal transaction: handlers are async, transactions are synchronous, and `node:sqlite` is single threaded, so appends never interleave with a transaction [I; confirm in H2 with a test that appends from a sink during `withTransaction`].

### 5.4 Audit anchor

`AnchorManager` implements the three requirements of `docs/packages.md` "Audit anchor":

- At the end of each request that wrote events, and at most once per 500 ms under load (coalesced), call `checkpoint(previousAnchor)` and send `anchor.put { seq, hash }` to the supervisor. The anchor store belongs to the supervisor (the OS keychain through main in the product), **never a file the daemon writes**: a file under the same OS user does not count ([V] "Audit anchor", requirement 2).
- The supervisor acks `anchor.ack { seq }` only after the value is durable. The host persists nothing itself and tracks `lag = chainHead.seq - ackedSeq` and `age`.
- **Fails closed.** If `lag > 1000` events or the oldest un-acked anchor is older than 5 minutes, every tier 3 and above method answers `E_UNAVAILABLE` (`details.reason: "anchor_stalled"`) until acks resume. Reads and tier 0 to 2 continue. A stalled anchor is audited once per transition (not per request).
- Persist an anchor only after the covering commit is durable: `openDatabase` already uses `synchronous=FULL` ([V]); `checkpoint` runs after `append` returned.
- Final `checkpoint` and `anchor.put` on shutdown (§8), bounded 2 s.

### 5.5 Degraded mode

Entered when the anchor check fails (step 6), the database is behind the anchor, or an unrecoverable storage error occurs after start. In degraded mode only `axis.audit/1.status`, `axis.audit/1.list`, `axis.audit/1.verify` and `axis.projects/1.list` are served; everything else is `E_UNAVAILABLE` with `details.reason`. `ready` carries `degraded`, so main can show the integrity failure to the user. The host never self-heals the chain and never re-anchors on its own (open question Q2).

## 6. Identity, trust and the transport

### 6.1 Attestation and caller identity

`IdentityVerifier.verify(attestation)` receives what the supervisor attached to the port. The host's verifier:

1. Parses `{ identity, issuedAt, mac }` with a strict schema.
2. Recomputes `HMAC-SHA256(attestationKey, canonicalJson(["axis.attest/1", identity, issuedAt]))` and compares with `timingSafeEqual` (equal length checked first).
3. Requires `now - issuedAt <= 30 s` and `issuedAt <= now + 5 s` (injected clock).
4. Returns `identity` only after `identitySchema` accepts it ([V] it is `parseIdentity` in the daemon), which enforces `connectionId` of at least 22 base64url characters, `windowId`, `actor`, `trusted`, `clientKind`.
5. The daemon refuses a second live session with the same `connectionId` ([V] `accept`). The verifier also keeps the `connectionId`s seen within the freshness window, in a bounded ring, so a replayed attestation after the first session closed is refused for as long as it is fresh.

The key reaches the host in `init` from the supervisor over the control channel (`parentPort` under Electron, which only main can write [V ADR 0003 D1.4]) and never through a data port. The MAC is defence in depth in Electron. It is the main control for the web host and the child-process test host, where the transport is not intrinsically main-only. Nothing in a client message selects an actor: `actor` is `user` for a renderer connection, and an `agent:*` identity can only come from the supervisor (the broker, 1b).

### 6.2 Trust

`identity.trusted` is fixed for a connection, but Workspace Trust can be revoked while it is open, and the gate requires "a revoked trust refuses the next run start" (ROADMAP 1a trust line). So trust is two inputs ANDed in policy: the attested `identity.trusted` and a live `TrustRegistry`, fed by supervisor control messages `trust.set { windowId, workspaceId?, trusted }`. Default for an unknown window is untrusted. Policy rows with `requireTrusted` (`worktrees.create`, `restoreFromRunBase`, `cliRuns.start`, `git.commit`, `git.push`) consult it **at policy evaluation and again inside the handler immediately before the side effect** (a revoke between the two refuses). Granularity (per repository versus per window) is Q6.

### 6.3 Transport abstraction

Two planes, never mixed:

- **Control plane** (supervisor to host): `init`, `connect`, `trust.set`, `anchor.get/ack`, `native.result`, `projects.register`, `shutdown` in; `ready`, `anchor.put`, `native.confirm`, `fatal`, `log` out. Every message is a strict Zod union. **Everything on this channel is supervisor-authenticated by construction**; a client's byte stream is never parsed as host control.
- **Data plane** (client to host): `Connection` as `@axis/daemon` defines it (`send`, `onMessage`, `onClose`, `close`). The daemon already ships `fromElectronPort`, `fromNodePort` and `memoryPair`.

| Host | Control channel | How a `Connection` arrives |
|---|---|---|
| Electron `utilityProcess` | `process.parentPort` (structural type `ElectronPortLike`; no `electron` import) | `connect` message carries a transferred `MessagePortMain`; wrapped by `fromElectronPort` (it already closes extra transferred ports, [V]) |
| Node child process (tests) | the `child_process` IPC channel, JSON serialization (not `advanced`, so no shared references or exotic types reach `inspectMessage`) | **`ChannelMux`**: node IPC cannot transfer a `MessagePort`, so virtual connections are multiplexed over the one ordered channel as `{ kind: "frame", cid, data }` / `{ kind: "close", cid }`, wrapped as `Connection`s |
| Worker thread (fast in-process tests) | a `MessagePort` pair | `fromNodePort` |
| Web (reh child process, later) | the reh server's child IPC | `ChannelMux`; the reh server authenticates the user and mints the attestation (ADR 0003 D1.7); same contracts, no host change |

`ChannelMux` limits: per-connection queue bounded by messages and bytes (overflow closes that connection and counts it, never drops silently), at most `maxConnections` virtual connections, frames for an unknown or closed `cid` ignored and counted, and close is idempotent. A mux frame is size-checked before it reaches `daemon.accept`'s own pre-identity limits.

## 7. Worktrees through the contract only

### 7.1 The seam

The host depends on `WorktreesService` (§2.3), defined from the `axis.worktrees/1` request and response schemas in `@axis/protocol` (merged, [V]). It does not import `@axis/worktrees` outside `bindings/worktrees.ts`. So:

- the handlers, policy rows, content hooks, the headless slice and the conformance tests are built and run now against the fake;
- when `feat/worktree-manager` lands, **one file** (`bindings/worktrees.ts`) and one gate file (`gate/worktrees-confirm.ts`) are added, and the slice test is run a second time against the real manager (H8b) with no other change;
- the fake and the real binding are checked by the same **port conformance suite** (`testing/worktrees-conformance.ts`, node:test) that asserts the contract schemas on every response and the error-code mapping.

### 7.2 What the binding must do (stated now so the fake does not drift)

`WorktreeManager`'s public API is **path-based** (`list(repoPath)`, `status(worktreePath)`, `restoreFromRunBase({ path })`, [V on `origin/feat/worktree-manager`]) while the contract is **id-based**. The binding is therefore the DMN-2 enforcement point:

- ids to paths only through the journal and project registry at the moment of use; `realpath` at use; never a path from a payload;
- `projectId` to repository root from the project registry (registered by main, §7.4);
- `refuseIfActiveRun` wired to `RunsService` so finalise, remove and restore refuse while a run is active;
- `remove`'s content hook returns `target = workspace:<id>` and `withLock(fn)` that takes the per-project git mutex then the manager's workspace lock, computes the `previewDiscard` fingerprint under it as `contentDigest`, and runs `fn`. Lock order is always project mutex, then workspace lock;
- the capability is `markDiscardConfirmed` from `daemon-confirm`, minted in the gate adapter (§5.2), not in the binding;
- `registeredRepos` returns the project registry roots, so the worktree root is never inside a registered repository.

### 7.3 Reconcile on start

`WorktreesService.reconcile()` compares `git worktree list --porcelain` and `refs/axis/*` with the journal (G-12) and returns a report of workspaces needing attention. It is read-only on the repository except through the manager's own safe operations, runs under the same per-project mutex, and is bounded (§3 step 9).

### 7.4 Projects

A project is registered by **main** over the control channel (`projects.register { path, trusted }`, from the folder the window opened, after the trust decision), never by a renderer request. The host canonicalises the path, checks it is a git repository that is not inside a registered project or the worktree root, stores it in the journal and returns `projectId`. `axis.projects/1.list` returns ids, display names and trust, not paths.

### 7.5 Journal gaps this exposes [V `packages/journal/src/schema.ts`]

The journal today has `agent_workspaces`, `agent_runs`, `state_transitions`, `idempotency`. Not present: a `projects` table, worktree path and lock state, the last **pushed** sha per workspace (git-ops needs it as `baseSha`, [V] `docs/packages.md` "Using `@axis/git-ops`"), and the reviewed tree hash recorded at diff review. Its workspace states are `CREATING, READY, REMOVING, REMOVED, FAILED` while the protocol's are `READY, FINALISED, CLEANED`; `FINALISED` has no journal state. Ticket J1 is a journal migration for these. This is also a question of who is the source of truth, the journal or the manager's own `WorkspaceMeta` files (Q7).

## 8. Shutdown

Uses `Daemon.shutdown(reason)` and `installShutdownSignals(daemon, { exit })` from `fix/daemon-sigterm` [V on the branch]. Order:

1. Trigger: SIGTERM or SIGINT, or the control message `shutdown` (the only trigger on Windows, where SIGTERM is not delivered and `utilityProcess.kill()` is TerminateProcess; the supervisor sends `shutdown` first and kills after its own timeout, [V review N4]). A repeated trigger calls `escalate()`.
2. `daemon.shutdown(reason)`: drain, grace (default 10 s), cancel, settle (2 s), close, flush the idempotency store (5 s). Result `{ graceful, escalated, cancelled, unsettled, flushed }`.
3. Stop accepting control `connect`; stop the anchor manager; the git runner kills live process groups (it does so on a normal exit, [V `docs/packages.md`]).
4. Final `checkpoint` and `anchor.put`, bounded 2 s. Not acked in time: exit code reports it, the next start's check will reconcile.
5. **Close the database and release the instance lock only when `result.unsettled === 0 && result.flushed !== "running"`** ([V] the `exit` hook doc on the branch). Otherwise leave both open and exit: a handler still running would otherwise write to a closed handle. The OS releases the file; a stale lock is taken over by the pid-and-start-time check.
6. Exit code: 0 clean; 1 cancelled or unsettled work; 70 internal; 75 lock held; 78 bad config or data directory; 79 degraded at start.

A lifecycle registry (`Disposables`) holds every timer, listener and child the host creates, disposes them in reverse order and `unref`s timers. The slice test asserts the child exits **by draining** (no `process.exit` needed) within 2 s of the exit hook, which catches a leaked timer or listener.

## 9. Errors and logging

### 9.1 Wire errors

The daemon owns the wire answer and the correlation id ([V]). Handlers throw only `AxisError` (from `@axis/audit`/`@axis/protocol` codes) or a mapped domain error. A closed mapping table per adapter turns `WorktreeError`, `GitOpsError`, `ChallengeError` (via `ApprovalError`), provider errors and SQLite errors into `{ code, retryable, details.reason }` with a **fixed message per code and reason**. A foreign error's `.message` is forwarded only where its package documents it as user-safe (`git-ops` `sanitizeText`/`redactUrls`; a challenge action error's message, [V] `docs/packages.md`), and each such forward is one reviewed line. Anything else is `E_INTERNAL` with the correlation id.

### 9.2 Logging and redaction

- **Structured, bounded, redacted.** JSON lines over the control channel (`log` messages) and stderr. Fields: `ts`, `level`, `event` (a closed set), `correlationId`, `code`, ids. Never payloads, file contents, commit messages, repository paths (use workspace and project ids), URLs with credentials, or environment values.
- **Errors are summarised, never serialised.** `summarizeError(e)` returns `{ name, code?, errno? }` by reading **own data properties only** (`Object.getOwnPropertyDescriptor`, `typeof` string, length bounded), so a getter, a `Proxy` or a hostile `toString` cannot run code or smuggle a secret, and never reads `cause`, `stack` (unless `devDiagnostics`) or `message` of a foreign error. The daemon's `onInternalError(correlationId, error)` and every `catch` use it. Review bug class: errors carrying secrets through `cause`, getters or `Proxy`.
- **One `Redactor`** (§3 step 5) filters every string that reaches a sink, as the second layer behind the closed field set (DMN-6).
- **Bounded memory.** A fixed-size log queue; on overflow the oldest low-level records are dropped and a counter is logged. A failing log sink never blocks or throws into a request.
- No secret, token or credential value appears in any log, audit event, error or test fixture. Test canaries are built at runtime from fragments, not written as literals, so the secret scanner in CI stays quiet.

### 9.3 Process level

`uncaughtException` and `unhandledRejection`: log a summary, make one best-effort audit append in a `try/catch` (`daemon.crash`), send `fatal` to the supervisor, exit 70. After an uncaught exception state is unknown, so the host does not try to continue; DMN-7 recovery on the next start repairs the journal.

## 10. The headless slice test

The earliest demonstrable vertical slice, with **no Electron, no UI, no Code OSS**: `packages/daemon-host/test/slice/headless.test.ts` (`node:test` only, Node 24.22.1, runs in `npm test`). It also becomes the Phase 1a gate evidence for L7, L8, L10 and L24 items it covers.

### 10.1 Fixtures (`testing/`)

- `TestSupervisor`: forks the host as a **child process** (real `process`, real lock, real signals, real exit code), sends `init` with a fresh data directory under `os.tmpdir()`, answers `anchor.get/put/ack` from an in-memory store it owns, answers `native.confirm` on command, mints attestations with the real HMAC key, and speaks `ChannelMux`. A second variant runs the host in a worker thread for fast non-process tests.
- `TestClient`: typed over `@axis/protocol` schemas (hello/welcome, request, cancel), generates UUIDv4 idempotency keys, polls `get`/`list`.
- Git fixture: a source repository and a **bare remote** (`git init --bare`), created with feature-detected git (initial branch set with `symbolic-ref`, no `-b`; the identity through `GIT_*` env of the fixture only). The test skips with an explicit reason if `requireGitVersion` from `@axis/git-ops` says the host git is too old. It assumes no git version beyond that and no OS (paths built with `node:path`, no shell strings).
- Fake `WorktreesService` (§2.3): creates a real worktree and branch `axis/<slug>` with hooks off, records `baseSha`. Fake `CliProcessHost` runs a tiny Node script (the "fake CLI", launched through `@axis/pty-policy` `resolveLaunch` and `buildCliEnv` from a test `axis.cliAgents` entry) that writes `src/hello.txt` in its working directory and exits 0; a slow variant sleeps, for the kill test. If `resolveLaunch` refuses an absolute interpreter path, the fixture puts a shim on a temporary PATH directory (resolution is PATH only by design).
- A project is registered through the supervisor (`projects.register`), as main would.

### 10.2 The flow and what it asserts

1. **Start.** `ready` arrives, not degraded; `hello`/`welcome` selects the served contracts. A second host on the same data directory exits 75 (`E_CONFLICT`).
2. **Create.** `axis.worktrees/1.create` with an idempotency key returns an id and a worktree with `baseSha`. Replaying the same key and payload returns the stored result and creates nothing new; the same key with another payload is `E_IDEMPOTENCY_CONFLICT`. The journal has the workspace READY, `createdBy` is the attested actor (not anything in the payload).
3. **Run.** `axis.cliRuns/1.start { workspaceId, agentId: "fake" }`. Polling shows QUEUED, RUNNING, then REVIEWING when the fake CLI exits 0. The CLI environment contains none of the PTY-5 denied names (the fake CLI dumps its env to a file the test reads).
4. **Review.** `axis.review/1.diff` lists `src/hello.txt` and returns `treeHash`. `axis.review/1.complete` as the `user` connection moves the run to COMPLETED; the same call from a connection attested as `agent:*` is `E_POLICY_DENIED`.
5. **Commit.** `axis.git/1.commit { workspaceId, reviewedTreeHash, message }` returns a commit whose tree equals `treeHash` (checked with git in the test). Altering the worktree after the review and committing again is refused (the reviewed-tree binding).
6. **Push.** `axis.git/1.pushPlan` shows no findings. `axis.git/1.push` without `approval` is `E_APPROVAL_REQUIRED` with a challenge; the supervisor receives `native.confirm` with a proof; the user connection calls `axis.approvals/1.resolve` (approve) and the supervisor answers `native.result` (confirmed); the retry with `approval` succeeds. Asserted on the bare remote: `refs/heads/axis/<slug>` equals the commit and **no other ref changed**. Then: the same challenge reused is refused; the same request from a second connection needs its own approval; a replay of the same idempotency key returns the stored result and the remote is not pushed twice.
7. **Secret path.** A second workspace commits a file containing a canary assembled at runtime to look like a credential; `pushPlan` reports a finding by rule name and path only (never the matched text) and requires confirmation; a push whose plan changed after confirmation is `E_CONFLICT` (`plan_changed`).
8. **Audit chain.** After graceful shutdown (SIGTERM, exit code 0, process exits by draining): open the database read-only and assert (a) `verify({ expectedHead: supervisorAnchor })` is ok and the supervisor holds the final anchor; (b) the ordered actions include the policy decision and execution for every call above, the challenge issue, resolve and consume, the run transitions, the commit and the push, each with actor `user` and the connection's workspace; (c) the canary, the attestation key and the absolute temporary paths appear **nowhere** in the database file bytes, in the host's stderr or in any response; (d) the destructive or privileged actions (push, commit) each have exactly one `success` event.
9. **Tamper and truncation.** Editing a stored event's payload makes `verify` fail with `hash_mismatch`. Deleting the last N events (dropping the append-only triggers, as an attacker with file access could) and restarting yields `ready.degraded` ("database behind the anchor"), serves only the audit read methods, and refuses `worktrees.create` with `E_UNAVAILABLE`.
10. **Kill and recover.** SIGKILL the host while the slow fake CLI is RUNNING; restart on the same directory: the stale lock is taken over, the run is BLOCKED with `INTERRUPTED_BY_RESTART`, the worktree is intact, the old idempotency key answers `unknown`, not a re-run, and the next start's anchor check is ok.
11. **Anchor stall.** With the supervisor withholding acks, the host stops serving tier 3 and above after the lag limit and resumes when acks return.

Run the same test a second time with `AXIS_SLICE_WORKTREES=real` semantics (a config switch in the fixture, not an environment read in the host) against `@axis/worktrees` when H8b lands, with no other change.

## 11. Review checklist (bug classes already found in this codebase)

Each ticket's reviewer maps its diff to this table. They come from `~/.cache/project-axis/reviews/`.

| Class | Host rule |
|---|---|
| TOCTOU between check and use | Paths resolved inside ports at use, never in handlers; content digests taken under the lock that covers the action; trust re-checked in the handler |
| Errors carrying secrets (`cause`, getters, `Proxy`) | `summarizeError` reads own data properties only; foreign messages never forwarded by default (§9) |
| Accounting that fails open | Anchor lag, audit write failure, idempotency `exhausted`, challenge quota all fail closed (§5) |
| Unbounded memory or CPU | Bounded log queue, mux queues, connect limiter map, attestation ring; `audit.verify` and `list` capped, one at a time, cancellable |
| Regex DoS | No new regex on client input; ids and paths use the protocol schemas |
| Timers and listeners left behind | `Disposables` registry; exit-by-draining assertion (§8) |
| Slot or resource released while work still runs | Mutex and lock released only when the work settles, not on abort; database closed only when `unsettled === 0` |
| Fallback paths that fail open | No memory-store fallback; no default policy; no "continue" after an anchor failure; no unattested identity |

## 12. Tickets (dependency order)

Sizes: **S** under half a day, **M** one to two days, **L** several days. "Review" marks security-critical code that goes to an independent review before any PR. Tickets in the same wave have no dependency on each other and can be built by separate sessions.

| ID | Ticket | Size | Depends on | Review |
|---|---|---|---|---|
| **P1a** | Protocol: `axis.approvals/1`, `axis.audit/1`, `axis.projects/1` (schemas, tiers, registry entries, vectors) | S | none | yes (identity, tiers) |
| **P1b** | Protocol: `axis.git/1` and `axis.review/1` | M | Q1 | yes |
| **P1c** | Protocol: `axis.cliRuns/1` and `axis.providers/1` (list) | S | none | |
| **P1d** | Protocol: add `discard` and `setUserEditing` to `axis.worktrees/1` (additive) | S | coordinate with the macOS host | |
| **J1** | Journal migration: projects, worktree rows, last pushed sha, reviewed tree hash, `FINALISED` alignment | M | `feat/daemon-idempotency-store` merged | yes |
| **H1** | Scaffold `@axis/daemon-host`: package, root and package tsconfig references, docs row, lockfile, import-allowlist rows, `config.ts`, ports, `Disposables`, logger, `summarizeError` | M | none | partly |
| **H2** | Storage and startup: lock, directory, database, redactor, audit, journal, idempotency store, recovery, exit codes | M | H1, idempotency store merged | yes |
| **H3** | Control channel and transports: message schemas, attestation verifier, `ChannelMux`, Electron parent-port adapter, connect limiter, `TestSupervisor` | M | H1 | yes |
| **H6** | Policy rule table, `TrustRegistry`, coverage check | S | H1, P1a | yes |
| **H8a** | Worktrees port, fake, handlers, content hook, conformance suite | M | H1, P1d (optional) | |
| **H4** | Anchor manager, degraded mode, `axis.audit/1` handlers | M | H2, H3, P1a | yes |
| **H5** | Challenge manager, gate adapter, native bridge, `axis.approvals/1` | M | H2, H3, P1a | yes |
| **H7** | Shutdown and signals integration, crash handlers, Windows `shutdown` message, exit-by-draining test | S | H2, H3, `fix/daemon-sigterm` merged | yes |
| **H9** | Git handlers: commit, pushPlan, push (content hook, last pushed sha), compareUrl, `GitRunners` | M | J1, P1b, H5, H6, H8a | yes |
| **H10** | `axis.cliRuns/1` and `axis.review/1` handlers, `UserPrincipal` minting, runs and review ports and fakes | M | J1, P1b, P1c, H6 | yes |
| **H11** | `axis.providers/1.list` over the mock provider and the guard | S | P1c, H1 | |
| **H12** | Headless slice test, fixtures, CI wiring | L | H4, H5, H7, H9, H10 (fakes are enough) | |
| **H8b** | Real worktrees binding and gate confirm, reconcile on start, slice rerun | M | `feat/worktree-manager` merged, H8a, H5 | yes |
| **R1, R2** | `@axis/runs` and `@axis/review` packages (their own designs) | L | n/a; owner decides who | |
| **E1** | Protocol and daemon: server events or stream frames, subscribe | L | after H12; not needed for the slice | yes |
| **X1** | Overlay entry `axisDaemonMain.ts`, main seam, staging (ADR 0005 D3) | M | H3, H7; **outside this repo's package work, needs the Code OSS build** | |
| **W1** | Web host entry over `ChannelMux` (reh tunnel) | M | H3, X1 | yes |

Order and parallelism:

- **Wave 0 (start now, all independent):** P1a, P1c, P1d, H1. J1 starts as soon as the idempotency store merges.
- **Wave 1 (after H1):** H2, H3, H6, H8a, H11 in parallel (five sessions are possible; H2 and H3 are the critical path).
- **Wave 2:** H4, H5, H7 in parallel once H2 and H3 are done; H9 and H10 once J1, P1b and their ports are in.
- **Wave 3:** H12 (the slice). It uses fakes, so it does **not** wait for the worktree manager, `@axis/runs` or `@axis/review`.
- **Later:** H8b when the worktree manager lands; E1, X1, W1 after the slice.
- **Critical path to the first slice:** H1, H2 and H3, H5, H9 and H10, H12.

Merge-conflict note: each contract's handler file, protocol file and policy rows are separate files, so Wave 2 sessions touch disjoint files. `contracts/registry.ts` and the policy table are the shared files; each ticket adds one line, and the coverage check catches an omission.

## 13. Open questions for the owner

1. **`axis.git/1` or `axis.worktrees/1.commit/.push`?** The design docs ([V] shell §5.4, policies §6.1) name `axis.worktrees/1.commit` and `.push`. This design recommends a separate `axis.git/1` because the worktrees contract belongs to the macOS host's in-review package and git-ops is a different library and policy domain. It means amending those two docs. Decide before P1b.
2. **Audit integrity failure.** Recommended: degraded read-only mode with a native dialog in main, no automatic re-anchor. Should a user ever be allowed to re-anchor (an audited, native-confirmed act), or is the only way out a reset of the data directory?
3. **Where the anchor lives.** The product answer is the OS keychain through main. On Linux without a keyring (the `basic_text` backend) the anchor is as weak as the database. Accept that, refuse to anchor there, or use a different principal? Phase 1a CI would use the in-memory supervisor store.
4. **Project registration.** Main registers repositories over the control channel (§7.4). Who owns the "add repository" UX and its trust decision, and may a project ever be added without a window?
5. **UI updates in 1a.** Poll until E1, or block the dashboard on server events?
6. **Trust granularity and revocation.** Per repository, or per window and workspace? Is a revoke while a run is active a stop, or only a block on the next start?
7. **Source of truth for a worktree.** The journal (J1) or the manager's `WorkspaceMeta` files, and which direction does reconcile repair?
8. **Import allowlist.** Approve granting `@axis/journal/daemon-principal` to `daemon-host/src/handlers/review.ts` and keeping the daemon package's own entry (§2.1).
9. **Tiers.** Is `git.commit` right at tier 2 with no challenge (the reviewed-tree binding is the guard), and `git.push` always tier 4 with native confirmation, including when the scan finds nothing?
10. **Drift gate package.** `feat/git-snapshot` (`@axis/git-snapshot`) and `@axis/worktrees` (`gitSnap.ts`, `diffGitSnapshots`) both implement GIT-SNAP-1 pieces. Which one backs `assertNoDrift` for `git-ops`?
11. **One package or several.** This design keeps one `@axis/daemon-host` with a directory per contract. Splitting handlers into per-contract packages would cut conflicts but multiplies the `docs/packages.md` and allowlist overhead.
12. **Platforms.** The `Axis packages` CI job runs on ubuntu-24.04 only ([V] `docs/ci.md`), so the slice runs on Linux in CI; the macOS path and the Windows shutdown message and shim are untested until those jobs exist.
13. **Daemon lifetime.** ADR 0003 open question 1 (does the daemon outlive windows or the app) changes the lock, the supervisor `shutdown` rules and the connect limiter. This design assumes the daemon lives and dies with the app.
14. **Retention.** Idempotency keys 24 h are fixed by ADR 0003 D3; audit retention is not decided (ADR 0003 open question 4). The host takes it as config, default "keep".
