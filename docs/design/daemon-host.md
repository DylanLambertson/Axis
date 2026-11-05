# Daemon host: the composition root for the Axis daemon

- **Status:** Proposed (design only, no code). Reviewed before any ticket below starts.
- **Date:** 2026-11-04.
- **Decision owner:** Dylan Lambertson.
- **Depends on:** ADR 0003 (Electron IPC bridge; D1 handshake, D2 contracts, D3 call semantics, D4 policy and approvals, D5 audit, validation criteria 1 to 7), ADR 0005 (D3 staging, D9 `node:sqlite`), `docs/packages.md` ("Wiring the daemon", "Audit anchor", "Single instance", "Principals", "Data directory"), `docs/design/axis-agent-shell.md` §5 and §8.2, `docs/design/axis-agent-shell-policies.md` §6, threat model Phase 1 (DMN-1 to DMN-7, G-11, G-12, G-20, G-24).
- **Evidence tags:** **[V]** verified in this repository at `38d42bd` (`origin/main` on 2026-11-05) or on the named branch; **[I]** inferred, not verified. **Decided** marks a choice the owner delegated to the master session on 2026-11-04.
- **Companion page:** `docs/design/daemon-host-plan.md` holds the headless slice test, the ticket plan and the open questions (this page stays under the 500 line limit).
- **Dependency status (2026-11-05).** On main: the P1 protocol contracts (#44), `@axis/runs` (#39), `@axis/worktrees` (#40), the gate script (#41), the providers split (#35), the bound commit and the commit hooks decision (#47), `@axis/vault`, `@axis/anthropic` (#31), the git-ops UTF-16 fix (#30), the tool broker `@axis/broker` (#46) and the `@axis/daemon-host` scaffold, ticket H1 (#50, with #49). The branches below are not on main, so every claim about them is tagged to the branch and must be re-checked when it merges:

| Branch | Provides | Status |
|---|---|---|
| `fix/daemon-sigterm` | `Daemon.shutdown`, `escalate`, `installShutdownSignals` | in review |
| `feat/daemon-idempotency-store` | `JournalIdempotencyStore`, the daemon `unknown` key state | in review. Its clock handling must be re-reviewed before the product uses it (decided) |
| `feat/review-core`, `feat/git-snapshot` | `@axis/review`, the GIT-SNAP-1 snapshot | in review / fix |

## 1. Purpose and scope

The merged libraries (`protocol`, `challenge`, `daemon`, `pty-policy`, `git-ops`, `audit`, `journal`, `providers`, `runs`, `worktrees`, `vault`, `anthropic`) are parts. Nothing yet starts a process, opens the database, takes the lock, registers handlers, wires approvals or answers a request. `@axis/daemon` is deliberately a core with every service injected ([V] `DaemonOptions`: `identity`, `audit`, `idempotency` required; `policy` absent means deny all; `approvals` absent refuses tier 3 and above). **`@axis/daemon-host` is the one place that chooses and connects those services.** It is the earliest thing that can answer a real request, so it is also the first demonstrable vertical slice (`daemon-host-plan.md` §1), before any UI work.

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
  P --> RN[runs binding + pty port]
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
| `@axis/vault`, `@axis/anthropic` | `src/bindings/providers.ts` only, 1b | handlers |
| `@axis/journal/daemon-principal` | `src/handlers/review.ts` only | any handler that is not the person's own act |
| `@axis/worktrees` | `src/bindings/worktrees.ts` only | handlers, ports, compose |
| `@axis/worktrees/daemon-confirm` | `src/gate/worktrees-confirm.ts` only | everything else. This is "the integration package that implements the gate adapter" of `docs/packages.md`, which is this package. |
| `@axis/runs` (root: `RunSupervisor` and its port types) | `src/bindings/runs.ts` only | handlers |
| `@axis/runs/daemon-attestation` (`attestTrust`) | `src/gate/run-trust.ts` only | everything else. Today `imports.test.mjs` allows it only to package `daemon`; it mints the single-use `TrustAttestation` and is the daemon's connection layer's job, which this package now is |
| `@axis/review` (when it lands) | `src/bindings/review.ts` only | handlers |

**Amendments this design requires, in the same pull request as H1.** (1) `docs/packages.md` "Principals" says only package `daemon` may import `@axis/journal/daemon-principal` and that "the daemon mints it". The mint moves to `daemon-host/src/handlers/review.ts` (the person's act, from the attested connection), so that paragraph changes. (2) `test/packages/imports.test.mjs` gets the rows above: `daemon-principal` and `daemon-attestation` to package `daemon-host` at the named files; the rule for package `daemon` stays while its connection layer still needs it. Open question Q8 is answered by this. Until H1 lands, `docs/packages.md` "Principals" and this design **diverge on purpose**: the paragraph describes the current rule, this page the target.

### 2.2 Layout (every file under 500 lines)

```text
packages/daemon-host/
  src/
    config.ts            HostConfig schema (strict), parsed from the init message
    ports/               service interfaces the handlers use (the only thing handlers import)
      worktrees.ts review.ts worktree-locator.ts git-ops-deps.ts trust.ts clock.ts
    contracts/           registry assembly, handler/policy coverage check
    handlers/            one file per contract: approvals, audit, cli-runs, git, projects, providers, review, worktrees
    gate/                ApprovalGate adapter, native-confirm bridge, worktrees-confirm.ts
    policy/              rule table, trust registry
    storage/             lock, directory, database, journal, idempotency store, recovery
    audit/               sinks (daemon, challenge), anchor manager
    control/             privileged message schemas, attestation verifier, connect limiter
    transport/           mux, node-port and electron-port adapters (re-uses @axis/daemon's)
    log/                 logger, redaction, safe error summary
    bindings/            the only files that import @axis/worktrees, @axis/runs, @axis/review (and gate/ for the two daemon-only subpaths)
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
| `WorktreesService` | `list, status, create, finalise, remove, restoreFromRunBase, previewDiscard, assertNoDrift, reconcile`, all **id-based**, returning the `axis.worktrees/1` response shapes | none: tests use the real `@axis/worktrees` on a temporary repository (it is on main, [V]) | `bindings/worktrees.ts` over `WorktreeManager` (§7) |
| `WorktreeLocator` | `locate(workspaceId) -> { workTree, gitDir }`, absolute and normalised, `realpath` at the moment of use, from the journal and project registry, never from a payload or by discovering the directory (GIT-4) | in-memory map | one implementation in `bindings/worktrees.ts`, **shared** by the three consumers below, which declare the same structural shape (`@axis/runs` `WorktreeLocator`/`RunWorktree`, `@axis/git-ops` `WorktreeRef`, the worktrees binding) |
| `PtyPort` (from `@axis/runs`) | `spawn({ runId, argv, cwd, env, cols, rows }) -> PtyHandle` (`write`, `resize`, `kill`, `onData`, `onExit`) | Node `child_process` behind the same interface, with the exact argv and env `@axis/runs` built through `@axis/pty-policy` (fixture) | the Axis pty process control channel (B9) |
| Runs | **a thin host runs port** (`ports/runs.ts`: `start`, `stop`, `get`, `list`, `hasActiveRun`, with `RunSummary`), **whose method and `RunSummary` types are asserted equal to `@axis/runs` by a compile-time type test**, so they cannot drift. `PtyPort` is different: `packages/daemon-host/src/ports/pty.ts` is a **hand copy** that nothing compares with `@axis/runs`, and the type test does not cover it (follow-up: a test that compares the two); handlers import the port and only `bindings/runs.ts` imports the package. `bindings/runs.ts` builds one `RunSupervisor` ([V] `packages/runs`: `SupervisorOptions` = `journal, audit, pty, clock, locator, snapshotter, env, redactor`, optional `limits`, `managedWorktreeRoots`, `onInternalError`). Handlers call `start({ workspaceId, agent, actor, trust, idempotencyKey })` returning `{ run: RunSummary, replayed }`, `stop(runId, actor)`, `get`, `list({ workspaceId, limit })`; the wire shape is the protocol `cliRunSchema`, not a host type. `start` needs `agent`, the `axis.cliAgents` entry the daemon resolved: the wire request carries only `agentId`, so the host reads `axis.cliAgents` from the application or machine scope setting main holds (CFG-1: user, application or machine scope, never workspace or folder) through the control message `settings.get { key }` (control-plane table, §6.3), validates it with the `@axis/pty-policy` schema, and re-reads it on every start; the same channel supplies `axis.git.runHooks` | the real supervisor with the fake `PtyPort` | same |
| `RunSnapshotter` | `before(ctx)`, `after(ctx) -> { drift }` | no-op | the GIT-SNAP-1 snapshot (`@axis/git-snapshot` or `@axis/worktrees` `gitSnap`, Q10) |
| `ReviewService` | `diff(workspaceId) -> { treeHash, files, patchesBounded }` | fake over `git diff` | `@axis/review` (`feat/review-core`, in review) |
| `GitRunner` (one, routing) | `run(req)` dispatching on `req.context`: `"daemon"` to the Node runner (`createNodeRunner`, hooks off), `"pty"` to the control-channel runner. **There is no pair of runners:** `GitOpsDeps` takes ONE `runner` ([V] `packages/git-ops/src/types.ts`) | one local Node runner serving both contexts (labelled test only) | `daemon`: `createNodeRunner`; `pty`: B9 channel |
| `GitOpsDeps` inputs | `runner`, `env: { daemon, pty }` (GIT-ENV-1 and PTY-5 environments), `runHooks` (`axis.git.runHooks`, user, application or machine scope), `isCliRunActive` (from the supervisor), `assertNoDrift` (from the worktrees/snapshot binding), `scanner?`, `scanMode?`, `emptyHooksDir?`, `platform?` | test values | assembled once in `bindings/git.ts` |
| `TrustRegistry` | `isTrusted(identity)` for methods other than run start, updated by main | in-memory | fed by control messages (§6.2) |

H1 (#50) replaced `GitRunners` by a `GitPort` over `GitOpsDeps`, which matches the rows above. It keeps a host `RunsService`, `RunSummary` and `PtyPort` on purpose; the rows above now agree with that, on the condition that a compile-time type test asserts the runs port methods and `RunSummary` equal to the `@axis/runs` types (a mismatch fails the build); the test does not cover `PtyPort`, which is a hand copy (follow-up: a comparing test).

## 3. Startup order

Startup is a straight line. Any failure before step 12 exits with a typed code and no listener ever existed. Nothing "falls back": a missing or invalid step fails closed.

1. **Process hardening.** Install `uncaughtException` and `unhandledRejection` handlers first (§9.3). No `process.env` reads outside `config.ts` and the runners.
2. **Init message.** Wait (bounded, 10 s) for exactly one `init` message from the supervisor on the control channel: `HostConfig` (strict Zod): `dataDir`, `worktreeRoot`, `platform`, `logLevel`, `devDiagnostics` (false when packaged), `attestationKey` (≥ 32 random bytes), limits overrides. A second `init` is ignored and logged. **The data directory and key come from main, never from a renderer message or an environment variable the renderer can influence.**
3. **Data directory and instance lock.** `acquireInstanceLock(dir)` from `@axis/audit` (creates the directory 0700, applies the ownership, symlink and parent checks of `docs/packages.md` "Data directory"). Failure: `E_CONFLICT` (a second daemon) exits 75; `E_INVALID_ARGUMENT` or `E_POLICY_DENIED` exits 78. Hold the lock object until exit.
4. **One database handle.** `openDatabase(dir/axis.db)` once. **The journal, the audit log and the idempotency store all use this `DatabaseSync`** (`Journal.open` already refuses an `AuditLog` on another handle, [V]; the store does the same on its branch [V]).
5. **Redactor.** One process `Redactor` (`@axis/audit`), seeded with the built-in rules. Registered secrets are added in 1b by the vault. The audit log, the idempotency store, the logger and the providers guard all receive this instance (§9.2).
5a. **Resolve git once (decided).** Find the absolute `git` path once, searching `PATH` with the current directory and every managed worktree root and registered repository excluded, and pass **the same absolute `gitPath`** to `@axis/git-ops`, `@axis/worktrees` and the snapshotter. No component re-resolves git later, so none can be redirected to a binary planted in a worktree. (`docs/packages.md` (#47) documents the resolver options in `docs/packages.md`; `@axis/worktrees` has its own resolver today, which the host replaces by passing the path in. That follow-up is named FU-GIT-RESOLVE there and in `daemon-host-plan.md`.)
6. **Audit log and anchor check.** `new AuditLog(db, { redactor })`. Ask the supervisor for the stored anchor (`anchor.get`, bounded 5 s) and run `verify({ expectedHead: anchor })`, then a full `checkpoint()` ([V] `docs/packages.md` "Audit anchor", requirements 1 and 3).
   - `ok: true`: continue. `reason: "truncated"` with a chain that is shorter than the anchor: report "the database is behind the anchor", never "tampering" and never silence.
   - `ok: false`, or **no answer** to `anchor.get` (a timeout or a closed channel, whatever the chain holds), or events with an explicit "no anchor": enter **degraded mode** (§5.5), do not continue to step 10 with mutating methods. No answer is never read as "no anchor": otherwise deleting the database plus a slow supervisor would look like a first start and the host would replace the stored anchor with a lower one. The host does not retry in the same process; the supervisor recovers by starting a new host once it can answer, and should read its keychain entry BEFORE spawning the host so that a keychain prompt cannot use up the 5 s budget (first install included).
   - A first start is an empty chain AND an explicit `anchor.result { anchor: null }` from the supervisor. It is normal and creates the first anchor after step 9 (nothing to anchor until the first event).
7. **Journal.** `Journal.open(db, { audit })`.
8. **Idempotency store.** `JournalIdempotencyStore.open(db, { audit, redactor })` (`feat/daemon-idempotency-store`). It marks keys of the previous boot as `unknown: interrupted` itself ([V] `UnknownReason`). **Its clock handling must be re-reviewed before the product uses it (decided; ticket H2 checks it).** Until that branch merges, the host refuses to start with `MemoryIdempotencyStore` unless `config.devMemoryIdempotency` is set by the test supervisor; the product path has no such flag.
9. **Recovery.** `journal.recover(lock)` (interrupts RUNNING runs, DMN-7), then `worktrees.reconcile()` (§7.3: `git worktree list --porcelain` and `refs/axis/*` against the journal, gate G-12). Reconcile has a time budget (default 20 s). Failure or timeout marks only the affected workspaces `needs attention` (their methods answer `E_UNAVAILABLE`), and is audited. It never blocks the other workspaces and never aborts startup. Then `checkpoint(previousAnchor)` and persist the new anchor (the recovery events are in the chain).
10. **Services.** Build, in this order: `ChallengeManager` (synchronous sink, §5.2), the gate adapter, `TrustRegistry`, the attestation `IdentityVerifier`, `RuleTablePolicy`, the `Daemon`; `register()` every handler with its content hooks; run the **coverage check** (§4.2). A mismatch throws, and the host exits 70 before listening.
11. **Signals.** Install the shutdown handlers (§8).
12. **Ready.** Send `ready { protocolVersion, contracts, degraded?: reason }` on the control channel. The supervisor starts brokering connections only after this. From here the host accepts `connect` messages. **There is no listening socket**; "listening" means the control channel handler is attached.

## 4. Contract registry

### 4.1 Where definitions live

Contract schemas (strict Zod objects, `MethodSpec`) live in `@axis/protocol`, one file per contract, because the renderer client and the web target import them and the package has no Node imports ([V] `NO_NODE`). `@axis/protocol`'s `contracts` table on main holds six contracts [V `contracts.ts`, #44]: `axis.worktrees`, `axis.projects`, `axis.approvals`, `axis.audit`, `axis.cli-runs` and `axis.providers`. Only `axis.git/1` and `axis.review/1` are unstarted (ticket P1b). **Contract ids contain no uppercase letters:** the id is `axis.cli-runs`, not `axis.cliRuns`; `contractIdSchema` rejects the latter, so a wrong spelling fails the coverage check. The host builds its registry with `protocolRegistry` filtered by `config.contracts` (an allow-list), so a build or test can serve fewer contracts, never more than the table holds.

The envelope carries only `hello`/`welcome`/request/cancel/response frames [V `envelope.ts`]. **There is no server-push event or stream frame.** ADR 0003 D2/D3 describe `stream` and `event`, but neither exists in the protocol or the daemon. Phase 1a UI state therefore polls (`get`/`list`, 1 to 2 s with jitter) and the headless slice does the same. A protocol extension (ticket E1) is a UI-quality item, not a blocker for the slice.

### 4.2 The table

Tier and `sideEffect` are the contract's declared minimum; policy may raise, never lower ([V] `PolicyDecision`). "Appr" means the request schema has an optional `approval` field, which the daemon requires for tier 3 and above (`register()` throws otherwise, [V]); "native" means tier 4 or 5, which adds `confirmNative` over the privileged channel (ADR 0003 D4). Idempotency `req` means `requiresIdempotencyKey`. "Trust" means the policy row `requireTrusted`.

| Contract | Method | Side effect | Tier | Idem | Appr | Trust | Actors | Backed by | Phase |
|---|---|---|---|---|---|---|---|---|---|
| `axis.worktrees/1` | `list`, `status` | read | 0 | none | | | user | `WorktreesService` | 1a, exists |
| | `create` | write | 2 | req | | yes | user | same | 1a, exists |
| | `finalise` | write | 2 now, **3 after P1d+** | req | yes after P1d+ | | user | same, content hook after P1d+ | 1a, exists. **Decided:** becomes tier 3 with a challenge, as a follow-up outside the first protocol PR |
| | `remove` | destructive | 4 | req | yes, native | | user | same, content hook (§7.2) | 1a, exists |
| | `restoreFromRunBase` | write | 2 | req | | yes | user | same | 1a, exists |
| | `discard`, `setUserEditing` | write | 2 | req / none | | | user | same | 1a, **named in the design docs, absent in the protocol** (additive, ticket P1d) |
| `axis.projects/1` | `list` | read | 0 | none | | | user | journal | 1a, new |
| `axis.approvals/1` | `resolve` | write | 2 | none | | | **user only** | `ChallengeManager.resolve` | 1a, new (the request and challenge shapes exist in `@axis/protocol`, [V] `challenge.ts`) |
| | `pending` | read | 0 | none | | | user | challenge listing for the caller's own window. **Handler duty:** the list holds up to 1024 challenges and each `targetSummary` must be shortened to at most 192 characters (head, `...`, tail, cut on code-point boundaries) or the whole listing fails the response schema (`docs/packages.md`) | 1a, on main |
| `axis.cli-runs/1` | `start` | write | 2 | req | | via `TrustAttestation` (§6.2) | user | `RunSupervisor.start` | 1a, on main. **Decided:** stays tier 2, with the EXT-2 amendment |
| | `stop` | write | 2 | req | | | user | `RunSupervisor.stop` | 1a, new |
| | `get`, `list` | read | 0 | none | | | user | `RunSupervisor` queries; `list` takes a `limit` of 1 to 500 (the contract limit); `RunSupervisor.list` itself accepts up to 1000 and the handler clamps to the contract limit. There is no cursor: a `runs.list` cursor is the named follow-up in `docs/packages.md` | 1a, new |
| `axis.review/1` | `diff` | read | 1 | none | | | user | `ReviewService` | 1a, new |
| | `complete` (run REVIEWING to COMPLETED) | write | 2 | req | | | **user only**, mints `UserPrincipal` | journal | 1a, new |
| `axis.git/1` (**decided:** a separate contract) | `pushPlan` | read | 1 | none | | | user | `git-ops` `planPush` | 1a, new |
| | `commit` | write | 2 | req | | yes | user | `executeCommit` | 1a, new |
| | `push` | network | 4 | req | yes, native | yes | user | `executePush` (content hook, §6.4; unstarted, P1b) | 1a, new |
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
- **Contracts not yet in the protocol.** `axis.git/1` and `axis.review/1` do not exist in any branch; P1b also amends `axis-agent-shell.md` §5.4 and `axis-agent-shell-policies.md` §6.1, which still name `axis.worktrees/1.commit` and `.push`.
- **`approvals.resolve` is not itself tier 3 or above**, otherwise resolving would need a challenge.

#### 4.2.1 Coverage check

At startup and as a unit test, assert: the set of `(contract, version, method)` in the served registry equals the set with a handler, equals the set with a policy row, equals the set with an audit action declaration (§5.3). Any difference throws. Every tier 3 or above method (including `worktrees.finalise` once it is tier 3) has a content hook or is explicitly marked "request digest content" in the table. This stops "a method was added to the protocol and is silently served, or silently dropped".

### 4.3 Handler shape

A handler is an adapter: validate nothing (the daemon already did, strict), derive identity from `ctx.identity` only, call one port method, map the result and errors (§9.1). It holds no state and no timer. Domain logic stays in the packages.

## 5. Wiring the services

### 5.1 Idempotency

`JournalIdempotencyStore` (not `MemoryIdempotencyStore`) is passed as `DaemonOptions.idempotency`. Scope is `(actorId, workspaceId, contract, version, method, key)`, 24 h. The store's `unknown` states (`interrupted`, `result-not-stored`, `failed-after-start`) map to `E_CONFLICT` with `details.reason`, never to a re-run, because the side effect may have happened. `exhausted` is `E_BACKPRESSURE`. These mappings are in the `feat/daemon-idempotency-store` daemon change; the host adds no logic. The store uses an injected clock for its 24 h and 7 day windows; a clock that goes backwards or jumps must not extend or drop a key early (re-review item, §3 step 8). Retention for audit and keys is a config value with the ADR 0003 defaults (open question 4 there).

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

Two mechanisms, for two kinds of method.

**Run start: the single-use `TrustAttestation`.** `RunSupervisor.start` requires a `TrustAttestation` ([V] `packages/runs`): a class instance minted only by `attestTrust` from `@axis/runs/daemon-attestation`, carrying `{ workspaceId, projectId, issuedAt }`, workspace-bound, expiring and **single use**. TRU-2: main attests, per start, that the source repository of this workspace is trusted now. So the host cannot hold a long-lived "trusted" flag for runs. The flow:

1. The renderer calls `axis.cli-runs/1.start { workspaceId, agentId }`.
2. The handler asks the supervisor channel for a fresh per-start decision: control message `trust.check { windowId, workspaceId, projectId } -> trust.result { trusted }`. Main answers from its live Workspace Trust state. No answer within 2 s, or `trusted: false`, is `E_POLICY_DENIED` (`details.reason: "untrusted"`).
3. Only then `src/gate/run-trust.ts` calls `attestTrust({ workspaceId, projectId, issuedAt: clock.now() })` and passes the result to `start` in the same tick. The attestation is never stored, logged or reused; `projectId` comes from the journal, not the payload.
4. A revoked trust therefore refuses the next start (ROADMAP 1a trust line). A running run is not stopped by a revoke in 1a (Q6).

**Other methods (`worktrees.create`, `restoreFromRunBase`, `git.commit`, `git.push`): attested flag plus live registry.** `identity.trusted` is fixed for a connection, so trust is two inputs ANDed in policy: the attested `identity.trusted` and a live `TrustRegistry`, fed by supervisor control messages `trust.set { windowId, workspaceId?, trusted }`. The registry has **two levels only, window and workspace; there is no project level and `trust.set` has no project field.**
- A workspace decision is **global across windows**: a revoke recorded from any window revokes that workspace everywhere.
- A window that main has not announced has no trust of its own. It inherits a granted workspace's trust only if the connection's attested `trusted` flag is set.
- An unknown subject is untrusted.
- At the registry cap (4096 entries) it **fails closed** and never evicts a revoke: a new grant is refused before a recorded revoke is dropped.
The policy row `requireTrusted` consults it at evaluation and the handler re-checks immediately before the side effect (a revoke between the two refuses). Q6 is answered for these methods by the two levels above; whether a revoke should also stop a running run stays open.

### 6.3 Transport abstraction

Two planes, never mixed:

- **Control plane** (supervisor to host). Every message is a strict Zod union, and everything on this channel is supervisor-authenticated by construction; a client's byte stream is never parsed as host control.

| Message | Direction | Payload summary | Answered by |
|---|---|---|---|
| `init` | in | `HostConfig` (data directory, key, limits) | once, at start |
| `connect` | in | attestation plus a transferred port or mux connection id | host accepts or closes |
| `ready` | out | protocol version, served contracts, `degraded?` | n/a |
| `anchor.get` / `anchor.put` | out | request the stored anchor; send `{ seq, hash }` | supervisor (`anchor.ack { seq }` in, after it is durable) |
| `native.confirm` | out | `{ challengeId, proof, windowId, summary }` | supervisor shows the dialog, replies `native.result { challengeId, proof, confirmed, windowId }` in |
| `trust.check` | out | `{ windowId, workspaceId, projectId }`, once per run start (§6.2) | main, from its live Workspace Trust state: `trust.result { trusted }` in; no answer in 2 s is a refusal |
| `trust.set` | in | `{ windowId, workspaceId?, trusted }` for the live registry | n/a |
| `settings.get` | out | `{ key }` for `axis.cliAgents` or `axis.git.runHooks` | main, from the user, application or machine scope value only (CFG-1; a workspace or folder value is never returned): `settings.result { key, value }` in, validated by the host with the `@axis/pty-policy` schema, 2 s timeout is a refusal |
| `projects.register` | in | `{ path, trusted }` (§7.4) | host replies `{ projectId }` out |
| `shutdown` | in | none | host starts graceful shutdown (§8) |
| `fatal`, `log` | out | summary only (§9) | n/a |
| `trust.result`, `settings.result` | in | the answers to `trust.check` and `settings.get` above; each carries the request id it answers and is ignored if none is pending | n/a |
| `projects.result` | out | `{ projectId }` or a typed refusal, answering `projects.register` | n/a |

- **Data plane** (client to host): `Connection` as `@axis/daemon` defines it (`send`, `onMessage`, `onClose`, `close`). The daemon already ships `fromElectronPort`, `fromNodePort` and `memoryPair`.

| Host | Control channel | How a `Connection` arrives |
|---|---|---|
| Electron `utilityProcess` | `process.parentPort` (structural type `ElectronPortLike`; no `electron` import) | `connect` message carries a transferred `MessagePortMain`; wrapped by `fromElectronPort` (it already closes extra transferred ports, [V]) |
| Node child process (tests) | the `child_process` IPC channel, JSON serialization (not `advanced`, so no shared references or exotic types reach `inspectMessage`) | **`ChannelMux`**: node IPC cannot transfer a `MessagePort`, so virtual connections are multiplexed over the one ordered channel as `{ kind: "frame", cid, data }` / `{ kind: "close", cid }`, wrapped as `Connection`s |
| Worker thread (fast in-process tests) | a `MessagePort` pair | `fromNodePort` |
| Web (reh child process, later) | the reh server's child IPC | `ChannelMux`; the reh server authenticates the user and mints the attestation (ADR 0003 D1.7); same contracts, no host change |

`ChannelMux` limits: per-connection queue bounded by messages and bytes (overflow closes that connection and counts it, never drops silently), at most `maxConnections` virtual connections, frames for an unknown or closed `cid` ignored and counted, and close is idempotent. A mux frame is size-checked before it reaches `daemon.accept`'s own pre-identity limits.

### 6.4 Git: hooks, the scanner and what a push is bound to

- **Hooks (decided).** The daemon never runs repository commit hooks. When `axis.git.runHooks` is on (user, application or machine scope, never workspace: CFG-1; default true in 1a), the **host** runs `pre-commit` and `commit-msg` **in the pty process**, on a scratch checkout of the reviewed tree, under the same lock as the commit. **NOT BUILT YET (follow-up H9-hooks).** Until it is built, an Axis commit runs no hook, and the ROADMAP hooks gate line (GIT-ENV-1) stays open; the headless slice asserts that interim behaviour (plan §1). The designed sequence, recorded in `docs/packages.md` (merged in #47): CLI-run check and drift re-check; hooks on a temporary index; freshness re-check; commit. A hook that modifies files refuses the commit. A `commit-msg` hook that rewrites the message has its message committed and audited. `post-commit` style hooks are not run in 1a. The daemon runner (`context: "daemon"`) always has hooks off; the `"pty"` runner is the only one that can run them. ADR 0004 §4 is amended by #47 (ticket H9-hooks implements the host side).
- **Scanner (PSH-1).** `GitOpsDeps.scanner` is injected and optional, and the mode is `warn` or `refuse`. Who supplies the scanner is open (Q15). Until one is wired the host serves `git.push` with `scanMode: "refuse"` and no scanner only in tests; the product path refuses to register `git.push` without a scanner.
- **Push content hook.** For `git.push` the hook returns `target = workspace:<id>` and `withLock(fn)` takes the per-project git mutex, runs `planPush` and passes `plan.digest` as the `contentDigest`. A challenge is therefore bound to the exact tip and findings the user saw. `executePush` receives `confirmedPlan: { tip, digest }` taken from that locked plan, never from the payload. `baseSha` is the last pushed sha from the journal (J1), never a ref under `refs/remotes`.
- **Commit.** Built from the reviewed tree hash recorded at diff review (REV-1); the remote and branch come from the journal.

## 7. Worktrees through the contract only

### 7.1 The seam

The host depends on `WorktreesService` (§2.3), defined from the `axis.worktrees/1` request and response schemas in `@axis/protocol` (merged, [V]). It does not import `@axis/worktrees` outside `bindings/worktrees.ts`. So:

- the handlers, policy rows and content hooks are written against the port, so the host never depends on the manager's path-based types;
- `@axis/worktrees` is on main, so there is no fake manager: **one file** (`bindings/worktrees.ts`) and one gate file (`gate/worktrees-confirm.ts`) bind the real package (ticket H8, a single ticket), and the slice runs against it from the start;
- a **port conformance suite** (`testing/worktrees-conformance.ts`, node:test) asserts the contract schemas on every response and the error-code mapping, so a later change of manager cannot drift from the contract.

### 7.2 What the binding must do (stated now so the fake does not drift)

`WorktreeManager`'s public API on main is **path-based** (`list(repoPath)`, `status(worktreePath)`, `restoreFromRunBase({ path })`, [V `packages/worktrees/src/manager.ts` on main]) while the contract is **id-based**. The binding is therefore the DMN-2 enforcement point:

- ids to paths only through the journal and project registry at the moment of use; `realpath` at use; never a path from a payload;
- `projectId` to repository root from the project registry (registered by main, §7.4);
- `refuseIfActiveRun` wired to the `RunSupervisor` (live run state) so finalise, remove and restore refuse while a run is active;
- `remove`'s content hook returns `target = workspace:<id>` and `withLock(fn)` that takes the per-project git mutex then the manager's workspace lock, computes the `previewDiscard` fingerprint under it as `contentDigest`, and runs `fn`. Lock order is always project mutex, then workspace lock;
- the capability is `markDiscardConfirmed` from `daemon-confirm`, minted in the gate adapter (§5.2), not in the binding;
- `registeredRepos` returns the project registry roots, so the worktree root is never inside a registered repository.

### 7.3 Reconcile on start

`reconcile` is **new code in the binding, not a manager call** ([V] `WorktreeManager` has no `reconcile`; it has `list(repoPath)` and `sweepSnapshotRefs`). It compares `git worktree list --porcelain` and `refs/axis/*` with the journal (G-12) and returns a report of workspaces needing attention. It is read-only on the repository except through the manager's own safe operations, runs under the same per-project mutex, and is bounded (§3 step 9).

### 7.4 Projects

A project is registered by **main** over the control channel (`projects.register { path, trusted }`, from the folder the window opened, after the trust decision), never by a renderer request. The host canonicalises the path, checks it is a git repository that is not inside a registered project or the worktree root, stores it in the journal and returns `projectId`. `axis.projects/1.list` returns ids, display names and trust, not paths.

### 7.5 Journal gaps this exposes [V `packages/journal/src/schema.ts`]

The journal today has `agent_workspaces`, `agent_runs`, `state_transitions`, `idempotency`. Not present: a `projects` table, worktree path and lock state, the last **pushed** sha per workspace (git-ops needs it as `baseSha`, [V] `docs/packages.md` "Using `@axis/git-ops`"), and the reviewed tree hash recorded at diff review. Its workspace states are `CREATING, READY, REMOVING, REMOVED, FAILED` while the protocol's are `READY, FINALISED, CLEANED`; `FINALISED` has no journal state. The GIT-SNAP baseline is **not** missing: `@axis/worktrees` writes one into the worktree's git directory at create and on `acknowledgeDrift`, and `assertNoDrift(worktreePath, { baseline? })` falls back to reading it ([V] `manager.ts`, `createWorkspace.ts`). The host therefore passes no baseline by default. Two questions remain (Q7): a baseline file inside the git directory of a worktree that a CLI can write is itself something GIT-SNAP-1 must say who may modify (the manager's own checks, and `@axis/git-snapshot` if it becomes the single owner, Q10), and whether the journal should also record the acknowledged baseline so a tampered file is detected. Ticket J1 covers the other columns. This is also a question of who is the source of truth, the journal or the manager's own `WorkspaceMeta` files (Q7).

## 8. Shutdown

Uses `Daemon.shutdown(reason)` and `installShutdownSignals(daemon, { exit })` from `fix/daemon-sigterm` [V on the branch]. Order:

1. Trigger: SIGTERM or SIGINT, or the control message `shutdown` (the only trigger on Windows, where SIGTERM is not delivered and `utilityProcess.kill()` is TerminateProcess; the supervisor sends `shutdown` first and kills after its own timeout, [V: a graceful path on Windows needs a message, as the `fix/daemon-sigterm` change documents]). A repeated trigger calls `escalate()`.
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

## 10. Review checklist (bug classes already found in this codebase)

Each ticket's reviewer maps its diff to this table. They come from the earlier review reports for the merged packages (not in the repository), summarised here.

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
