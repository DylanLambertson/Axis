# Daemon host: headless slice, ticket plan and open questions

Companion to `docs/design/daemon-host.md` (the design). References such as "design §3" point there. Status, evidence tags and the dependency status table are in the design's header.

## 1. The headless slice test

The earliest demonstrable vertical slice, with **no Electron, no UI, no Code OSS**: `packages/daemon-host/test/slice/headless.test.ts` (`node:test` only, Node 24.22.1, runs in `npm test`). It also becomes the Phase 1a gate evidence for the L7, L8, L10 and L24 items it covers.

### 1.1 Fixtures (`testing/`)

- `TestSupervisor`: forks the host as a **child process** (real `process`, real lock, real signals, real exit code), sends `init` with a fresh data directory under `os.tmpdir()`, answers `anchor.get/put/ack` from an in-memory store it owns, answers `native.confirm` on command, mints attestations with the real HMAC key, and speaks `ChannelMux`. A second variant runs the host in a worker thread for fast non-process tests.
- `TestClient`: typed over `@axis/protocol` schemas (hello/welcome, request, cancel), generates UUIDv4 idempotency keys, polls `get`/`list`.
- Git fixture: a source repository and a **bare remote** (`git init --bare`), created with feature-detected git (initial branch set with `symbolic-ref`, no `-b`; the identity through `GIT_*` env of the fixture only). The test skips with an explicit reason if `git --version` is older than `MIN_GIT_VERSION` from `@axis/git-ops` (`requireGitVersion(deps, worktree, env)` needs a repository and deps, so it is not a pure version check). It assumes no git version beyond that and no OS (paths built with `node:path`, no shell strings).
- Real `@axis/worktrees` (on main) over the fixture repository, bound by `bindings/worktrees.ts`; no fake manager. The slice also runs `WorktreeLocator`, the single git path resolved once (`daemon-host.md` §3 step 5a) and `RunSupervisor` for real.
- Fake `PtyPort`: runs a tiny Node script (the "fake CLI", launched with the exact argv and env that `@axis/runs` built through `@axis/pty-policy` `resolveLaunch` and `buildCliEnv` from a test `axis.cliAgents` entry) that writes `src/hello.txt` in its working directory and exits 0; a slow variant sleeps, for the kill test. If `resolveLaunch` refuses an absolute interpreter path, the fixture puts a shim on a temporary PATH directory (resolution is PATH only by design).
- Fake `ReviewService` until `@axis/review` merges; a fake pty-process runner for `context: "pty"` git commands (one local Node runner, test only).
- A project is registered through the supervisor (`projects.register`), as main would.

### 1.2 The flow and what it asserts

1. **Start.** `ready` arrives, not degraded; `hello`/`welcome` selects the served contracts. A second host on the same data directory exits 75 (`E_CONFLICT`).
2. **Create.** `axis.worktrees/1.create` with an idempotency key returns an id and a worktree with `baseSha`. Replaying the same key and payload returns the stored result and creates nothing new; the same key with another payload is `E_IDEMPOTENCY_CONFLICT`. The journal has the workspace READY, `createdBy` is the attested actor (not anything in the payload).
3. **Run.** `axis.cli-runs/1.start { workspaceId, agentId: "fake" }` (the supervisor channel answers `trust.check` as main would; the single-use attestation is minted and spent inside the call). Polling `get`/`list` shows QUEUED, RUNNING, then REVIEWING when the fake CLI exits 0. The CLI environment contains none of the PTY-5 denied names (the fake CLI dumps its env to a file the test reads).
4. **Review.** `axis.review/1.diff` lists `src/hello.txt` and returns `treeHash`. `axis.review/1.complete` as the `user` connection moves the run to COMPLETED; the same call from a connection attested as `agent:*` is `E_POLICY_DENIED`.
5. **Commit.** `axis.git/1.commit { workspaceId, reviewedTreeHash, message }` returns a commit whose tree equals `treeHash` (checked with git in the test). Altering the worktree after the review and committing again is refused (the reviewed-tree binding). **Interim (hooks not built, H9-hooks):** a fixture `pre-commit` hook planted in the repository does NOT run (the test checks that the hook's marker file is absent). No audit field records "made without hooks" and none is asserted; adding one is part of H9-hooks. **Extension when H9-hooks lands:** a read-only hook runs, a hook that modifies a file refuses the commit, and a rewritten `commit-msg` message is committed and audited (the audit field is defined by H9-hooks).
6. **Push.** `axis.git/1.pushPlan` shows no findings. `axis.git/1.push` without `approval` is `E_APPROVAL_REQUIRED` with a challenge; the supervisor receives `native.confirm` with a proof; the user connection calls `axis.approvals/1.resolve` (approve) and the supervisor answers `native.result` (confirmed); the retry with `approval` succeeds. Asserted on the bare remote: `refs/heads/axis/<slug>` equals the commit and **no other ref changed**. Then: the same challenge reused is refused; the same request from a second connection needs its own approval; a replay of the same idempotency key returns the stored result and the remote is not pushed twice.
7. **Secret path.** A second workspace commits a file containing a canary assembled at runtime to look like a credential; `pushPlan` reports a finding by rule name and path only (never the matched text) and requires confirmation; a push whose plan changed after confirmation is `E_CONFLICT` (`plan_changed`). This step needs the scanner (H9-scan).
8. **Audit chain.** After graceful shutdown (SIGTERM, exit code 0, process exits by draining): open the database read-only and assert (a) `verify({ expectedHead: supervisorAnchor })` is ok and the supervisor holds the final anchor; (b) the ordered actions include the policy decision and execution for every call above, the challenge issue, resolve and consume, the run transitions, the commit and the push, each with actor `user` and the connection's workspace; (c) the canary, the attestation key and the absolute temporary paths appear **nowhere** in the database file bytes, in the host's stderr or in any response; (d) the destructive or privileged actions (push, commit) each have exactly one `success` event.
9. **Tamper and truncation.** Editing a stored event's payload makes `verify` fail with `hash_mismatch`. Deleting the last N events (dropping the append-only triggers, as an attacker with file access could) and restarting yields `ready.degraded` ("database behind the anchor"), serves only the audit read methods, and refuses `worktrees.create` with `E_UNAVAILABLE`.
10. **Kill and recover.** SIGKILL the host while the slow fake CLI is RUNNING; restart on the same directory: the stale lock is taken over, the run is BLOCKED with `INTERRUPTED_BY_RESTART`, the worktree is intact, the old idempotency key answers `unknown`, not a re-run, and the next start's anchor check is ok.
11. **Anchor stall.** With the supervisor withholding acks, the host stops serving tier 3 and above after the lag limit and resumes when acks return.

## 2. Tickets (dependency order)

Re-derived on 2026-11-04 from what is on main: `@axis/runs` and `@axis/worktrees` are merged, so the former host ticket R1 (the runs package, not the cursor item of the same name in `docs/packages.md`) is done and the former H8a/H8b are one ticket (H8) against the real package. Sizes: **S** under half a day, **M** one to two days, **L** several days. "Review" marks security-critical code that goes to an independent review before any PR. Tickets in one wave have no dependency on each other and can be built by separate sessions.

| ID | Ticket | Size | Depends on | Status / review |
|---|---|---|---|---|
| **P1** | Protocol: `axis.projects`, `axis.approvals`, `axis.audit`, `axis.cli-runs`, `axis.providers` | done | n/a | merged (#44) |
| **P1b** | Protocol: `axis.git/1` and `axis.review/1`; amend shell §5.4 and policies §6.1 | M | none (Q1 decided) | review |
| **P1d** | Protocol: `worktrees.finalise` to tier 3 with `approval`, plus `discard` and `setUserEditing` | S | coordinate with the worktrees owner | review |
| **J1** | Journal migration: projects, worktree path and lock state, last pushed sha, reviewed tree hash, `FINALISED` alignment, and (only if Q7 decides it) a recorded acknowledged baseline; the manager already keeps the baseline in the git directory | M | idempotency store merged | review |
| **H1** | Scaffold `@axis/daemon-host` (exists on `feat/daemon-host-scaffold`; `GitRunners` is already replaced by `GitPort`); keep its runs port, with the compile-time type test of its methods and `RunSummary` against `@axis/runs` (design §2.3; `PtyPort` is not covered); add the import rows and the packages.md "Principals" amendment (design §2.1) | S remaining | none | in review / fix |
| **H2** | Storage and startup: lock, directory, database, git resolved once, redactor, audit, journal, idempotency store (clock re-review), recovery, exit codes | M | H1, idempotency store merged | review |
| **H3** | Control channel and transports: message schemas incl. `trust.check`, attestation verifier, `ChannelMux`, Electron parent-port adapter, connect limiter, `TestSupervisor` | M | H1 | review |
| **H6** | Policy rule table, `TrustRegistry`, coverage check | S | H1, P1 merged | review |
| **H11** | `axis.providers/1.list` over the mock provider and the guard | S | P1 merged, H1 | |
| **H4** | Anchor manager, degraded mode, `axis.audit/1` handlers | M | H2, H3, P1 merged | review |
| **H5** | Challenge manager, gate adapter, native bridge, `axis.approvals/1` | M | H2, H3, P1 merged | review |
| **H7** | Shutdown and signals integration, crash handlers, Windows `shutdown` message, exit-by-draining test | S | H2, H3, `fix/daemon-sigterm` merged | review |
| **H8** | Worktrees binding over the real `@axis/worktrees`: `WorktreeLocator`, id to path, content hooks, `refuseIfActiveRun`, `reconcile` (new code), `gate/worktrees-confirm.ts`, conformance suite | L | H1, H5, J1 | review |
| **H9** | Git handlers: commit, pushPlan, push (content hook, last pushed sha), compareUrl; `GitOpsDeps` assembly | M | J1, P1b, H5, H6, H8, the bound commit (merged, #47) | review |
| **H9-scan** | The secret scanner (PSH-1) and its mode, per Q15; the product refuses to register `git.push` without it | M | Q15, H1 | review |
| **H9-hooks** | **Not built yet.** Host side of the hooks decision: pre-commit and commit-msg in the pty process on a scratch checkout under the lock; closes the ROADMAP hooks gate line | M | H9, B9 channel (or the fake runner) | review |
| **H10** | `axis.cli-runs` handlers, `bindings/runs.ts` over `RunSupervisor`, `gate/run-trust.ts` (`attestTrust`) | M | P1 merged, H3, H6, H8 | review |
| **H10b** | `axis.review` handlers, `UserPrincipal` minting | M | P1b, J1, `feat/review-core` merged (fake until then) | review |
| **H12** | Headless slice test, fixtures, CI wiring | L | H4, H5, H7, H8, H9, H9-scan, H10, H10b | review |
| **E1** | Protocol and daemon: server events or stream frames | L | after H12 | review |
| **X1** | Overlay entry `axisDaemonMain.ts`, main seam, staging (ADR 0005 D3); needs the Code OSS build | M | H3, H7 | outside the package work |
| **W1** | Web host entry over `ChannelMux` | M | H3, X1 | review |

Order and parallelism:

- **Wave 0 (now, independent):** P1b, P1d, H1 fixes. J1 as soon as the idempotency store merges.
- **Wave 1 (after H1):** H2, H3, H6, H11 in parallel.
- **Wave 2:** H4, H5, H7 in parallel once H2 and H3 are done; H8 starts after H5 and J1.
- **Wave 3:** H9, H9-scan, H10, H10b in parallel (H10b may use a fake review service).
- **Wave 4:** H12 (the slice) and H9-hooks in parallel; H12 does not wait for H9-hooks (see the interim assertion in §1.2 step 5), which extends it when it lands. It now uses the real worktrees and the real run supervisor, with a fake pty and a fake review until `@axis/review` merges.
- **Later:** E1, X1, W1.
- **Critical path to the first slice:** H1, H2 and H3, H5, H8, H9 and H10, H12.

FU-GIT-RESOLVE is the follow-up in `docs/packages.md` (on main, #47) to replace the separate git resolver in `@axis/worktrees` with the single path the host passes in; it is folded into H2.

Merge-conflict note: each contract has its own handler file, protocol file and policy rows; the registry file and the policy table are the shared files (one line per ticket), and the coverage check catches an omission.

## 3. Open questions for the owner

"Answered" and "partly" items are recorded in the design; the rest stay open, each with a recommendation.

| # | Question | Status | Recommendation |
|---|---|---|---|
| 1 | `axis.git/1` or `axis.worktrees/1.commit/.push` | **Answered (decided):** a separate `axis.git/1` | P1b amends shell §5.4 and policies §6.1 |
| 2 | Audit integrity failure: degraded mode only, or an audited re-anchor? | Open | Degraded read-only mode with a native dialog in main; no automatic re-anchor; the only exit is a reset of the data directory until a re-anchor design exists |
| 3 | Where the anchor lives on Linux without a keyring | Open | Apply the vault's PRV-1 pattern: consent or refuse. Without a secure backend the anchor is as weak as the database, so say so in the UI and mark the audit "unanchored" |
| 4 | Project registration and who owns "add repository" | Open | Main only, over the control channel; no registration without a window |
| 5 | UI updates in 1a: poll or events | Open | Poll (1 to 2 s with jitter) in 1a; E1 after the slice |
| 6 | Trust granularity and revocation | **Partly answered:** run start uses the single-use `TrustAttestation` per start (TRU-2); a revoke refuses the next start | For create, commit and push: per project, via `TrustRegistry`; no stop of a running run on revoke in 1a |
| 7 | Source of truth for a worktree (journal or `WorkspaceMeta`), and whether the journal also records the GIT-SNAP baseline the manager keeps in the git directory | Open | The journal is authoritative (written journal-first and audited); `WorkspaceMeta` is checked against it, and `reconcile` reports a disagreement and never repairs the repository on its own |
| 8 | Import allowlist for `daemon-principal` and `daemon-attestation` | **Answered:** granted to `daemon-host` at named files (design §2.1) | Land with H1 |
| 9 | Tiers: commit tier 2 without a challenge, push always tier 4 | **Answered** (the design's table states them) | Yes to both: commit is guarded by the reviewed-tree binding and the hooks sequence; push is outward-facing and always challenged with native confirmation, including with no findings |
| 10 | Which package backs `assertNoDrift` (`@axis/git-snapshot` or `@axis/worktrees` `gitSnap`) | **Partly:** git-ops takes an injected callback, so either works; the host passes one resolved `gitPath` to both | One owner of GIT-SNAP-1. Decide when `feat/git-snapshot` merges; never run both |
| 11 | One package or several | Open | One `@axis/daemon-host`, a directory per contract |
| 12 | Platforms | **Still accurate:** the `Axis packages` job runs on ubuntu-24.04 only (`docs/ci.md`) | Add a macOS job for the slice before the 1a gate |
| 13 | Daemon lifetime (ADR 0003 open question 1) | Open | Lives and dies with the app in 1a |
| 14 | Retention of idempotency and audit records | Open | 24 h fixed for keys; audit "keep", as config |
| 15 | **New:** who supplies the secret scanner (PSH-1) and in which mode | Open | A small dedicated scanner (ticket H9-scan) run in the daemon context over the diff text, `refuse` by default, `warn` as a user setting |
