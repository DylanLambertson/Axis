# Composer runtime in the daemon host (Phase 1b, daemon side)

- **Status:** Proposed. Ticket C1 below is built on branch `feat/composer-runtime`; everything else is a plan.
- **Date:** 2026-11-05.
- **Depends on:** `docs/ROADMAP.md` Phase 1b and its gate lines, `docs/PRODUCT.md` scenarios 1 and 6, `docs/design/tool-broker.md`, `docs/design/daemon-host.md` (sections 2 to 5, 9), `docs/design/daemon-host-compose.md`, `docs/design/axis-agent-shell.md` §6, `docs/design/axis-agent-shell-policies.md` §3.3 to §3.8, `docs/PROVIDERS.md`.
- **Goal:** the smallest vertical slice in which a composer agent runs on the MOCK provider through the daemon host: start a run in a workspace, read its activity, route tool calls through `@axis/broker` with the approval policy (DMN-3), audit every approval and side effect (DMN-5), stop at the per-run budget (PRV-6), keep broker-launched children on the PTY-2 allow-list, and recover the run state from the journal after a kill.

## 1. What exists on main (verified at `1986645`)

| Package | Already provides | Used by the composer as |
|---|---|---|
| `@axis/protocol` | Envelope, closed errors, `MethodSpec` and the contract table (eight contracts), the challenge shapes, `axis.approvals/1` (`resolve`, `pending`), `axis.providers/1.list`, display rules (`displayTextSchema`, `toDisplayPath`) | the new `axis.runs/1` contract lives here |
| `@axis/daemon` | Request pipeline: identity, policy, approval gate (`issue`/`execute`), idempotency, audit of `policy.decision` and `rpc.execute` | unchanged |
| `@axis/challenge` | `ChallengeManager`: issue, `resolve` (user only, same window), `consume` (same requester on the same connection, digest bound, spent once), audit of every phase | the approval mechanism of a broker call (ROADMAP: "reusing the Phase 1a challenge mechanism") |
| `@axis/broker` | `ToolBroker.invoke`: containment (WT-1), protected paths (WT-3), the PTY-2 environment (`buildToolEnv`), argv-only runner with timeout, cap and group kill (PTY-4), broker git on the hardened prefix (WT-2), tier policy with an `ApprovalHook` whose answer must be `approvedBy: "user"` with the call's digest, `broker.decision` and `broker.result` audit | the only path from a model's tool call to the worktree |
| `@axis/providers` | Adapter contract, `createMockProvider` (scripted replies, tool use, errors, pricing), `guardProvider` (validation, secret scan, timeouts, stream grammar, budget hook), `createRunBudget` (PRV-6: tokens, cost, requests; fails closed) | the model side of the loop |
| `@axis/anthropic`, `@axis/vault` | The Anthropic adapter (ANT-1) and the connection vault (PRV-1) | NOT touched by C1; wired in C6 |
| `@axis/journal` | `agent_runs` with `kind` `composer` or `cli`, the run state machine, `createRun` with an idempotency key, `recover` (RUNNING to BLOCKED / `INTERRUPTED_BY_RESTART` for every kind) | the run record and its recovery |
| `@axis/audit` | The hash-chained log, the redactor | every event below lands in it |
| `@axis/runs` | The CLI run supervisor (`kind: cli` only; its recovery leaves composer runs alone) | not used; composer runs are a separate service |
| `@axis/daemon-host` | Composition root, `HandlerRegistrar` (tier 3 and above guarded by the anchor), rule table and coverage check, `createApprovals` (gate, `axis.approvals/1` port, native bridge, pending listing), worktrees binding with `WorktreeLocator`, the project mutex, closed error maps per contract | the composer binding, handlers and approvals plug in here |

## 2. Gaps

1. **No composer contract.** `daemon-host.md` 4.2 names `axis.runs/1` (`start`, `cancel`, `get`, `list`) and `axis-agent-shell.md` §6 its `start` payload, but nothing exists in `@axis/protocol`. There is no server push (`daemon-host.md` 4.1, ticket E1), so the activity stream must be a polled read (`events` with a cursor).
2. **No broker approval adapter.** `ToolBroker` takes an `ApprovalHook`; nothing turns it into a challenge the user sees in `axis.approvals/1.pending` and answers with `resolve`, and nothing hands the broker the user's grant.
3. **No run loop.** Nothing drives provider turns, executes `tool_use` blocks through the broker, feeds results back, or maps a budget refusal to a recorded run reason.
4. **No binding.** Nothing builds a `ToolBroker` over the host's worktree locator (DMN-2), the audit log and the clock, or a guarded provider in the daemon.
5. **Journal fields.** `agent_runs` has no mode, provider, model, usage or budget columns, and no per-run activity table, so after a restart `get` cannot say which model a run used or how much it spent (C1 reports them as `null`, see 4.2; ticket J2).
6. **Composer recovery.** `Journal.recover` moves a RUNNING composer run to BLOCKED, but a QUEUED composer run is left QUEUED (`@axis/runs` cancels only `kind: cli`).
7. **Native confirmation for broker calls.** A `destructive` or `privileged` broker call should be a tier 4 challenge with the native dialog; the native bridge is reachable only through the RPC gate.

## 3. Contract: `axis.runs/1` (`packages/protocol/src/composer-runs.ts`)

The id is the one the design documents already use. It is not `axis.cli-runs`; the two are distinct contracts with distinct run kinds. No payload carries a path, a command, a credential or a tool definition (DMN-2, PRV-2).

| Method | Side effect | Tier | Idem | Trust | Actors | Request | Response |
|---|---|---|---|---|---|---|---|
| `start` | write | 2 | req | registry | user | `{ workspaceId, mode: ask/edit/agent, prompt (1..32768), providerId, modelId }` | `{ run, replayed }` |
| `cancel` | write | 2 | req | | user | `{ runId }` | `{ run }` |
| `get` | read | 0 | none | | user | `{ runId }` | `{ run }` |
| `list` | read | 0 | none | | user | `{ workspaceId?, limit? (1..200) }` | `{ runs }` |
| `events` | read | 0 | none | | user | `{ runId, afterSeq?, limit? (1..200) }` | `{ events, nextSeq, complete, available }` |

`run` is `{ runId, workspaceId, mode, providerId, modelId, state, reason, createdAt, startedAt, endedAt, live, awaitingApproval, usage }`; `mode`, `providerId`, `modelId` and `usage` are `null` when the daemon no longer holds them (after a restart, until J2). An event is one of `state`, `text` (model output, at most 4096 characters, control and invisible characters escaped by the daemon), `tool` (name, `ok` or `error`, a closed reason), `approval` (name, `requested`/`approved`/`denied`/`expired`/`withdrawn`, the challenge digest the UI matches with `pending`, and the display paths and broker reasons it covers) and `usage`. `events` returns `available: false` for a run whose activity is no longer held (restart, eviction).

Attachments (`axis-agent-shell.md` §6) are additive and come with the IDE context work; `cancel` replaces the shell design's `cancel(runId)`.

## 4. Host structure (H9/H10 patterns)

```text
src/ports/composer.ts        ComposerRunsService (what handlers see), ComposerEngine (what the service sees)
src/handlers/composer-runs.ts  axis.runs/1 over the port; registerComposerRunsHandlers(registrar, deps)
src/composer/errors.ts       closed error map (fixed text, closed reasons)
src/composer/activity.ts     bounded per-run event rings
src/composer/loop.ts         the turn loop: provider turn, tool calls through the engine, results back
src/composer/service.ts      journal transitions, one active run per workspace, budgets, cancel, recovery
src/gate/run-approvals.ts    broker ApprovalHook over the ONE ChallengeManager of createApprovals
src/bindings/agent.ts        the only file that imports @axis/broker: ToolBroker per run, tools, registry over the locator
```

- **Registrar only.** `compose.ts` builds the binding and the service and calls `registerComposerRunsHandlers(registrar, ...)`; handler code never sees the daemon, the challenge manager or the broker. `@axis/broker` joins `HOST_BINDING_PACKAGES` in `test/packages/imports.test.mjs`: only `src/bindings/*.ts` may import it.
- **Closed errors.** Every handler error is a `DaemonError` with fixed text and a `reason` from a closed set (`composer/errors.ts`), the shape of `runs/errors.ts` and `git-errors.ts`. Nothing a provider, the broker or the journal said is forwarded. Run reasons in the journal are short upper-case codes (`BUDGET_TOKENS`, `PROVIDER_ERROR`, `USER_CANCELLED`, ...).
- **Minters.** The composer mints no capability and no principal. The grant the broker receives is built inside `ChallengeManager.consume`'s action, which runs only after the user resolved the challenge in its window and only for the run's own requester and connection (APR-1).
- **Identity of a run.** Each run acts as `agent:composer.<runId>` on the synthetic connection `run.<runId>`; the challenge is issued to the window that started the run. The model gets no way to resolve: `axis.approvals/1.resolve` is a user-only row, the handler refuses any other actor, and the manager refuses a non-user resolver (three layers, DMN-3).
- **Approval flow (C1).** Broker decides `approve` (tier at or above the floor, or a protected path) -> `run-approvals` issues a tier 3 challenge (`contract axis.runs`, `method toolCall`, `args { runId, tool, digest }`, target `run:<runId>`, content digest = the broker call digest) and lists it for the window -> the activity stream shows `approval requested` with the paths and reasons -> the user calls `axis.approvals/1.resolve` -> on `approved`, `consume` spends it and returns `{ approved, approvedBy: "user", approvalId: "chl:<ref prefix>", digest, expiresAt }` to the broker, which verifies it again -> `broker.decision` records approver, approval id and expiry. Deny, expiry (challenge TTL), a burned challenge and run cancellation all decline; cancellation withdraws the challenge. A `destructive` or `privileged` call is declined until C4 (fails closed, no native dialog yet).
- **Budgets (PRV-6).** One `createRunBudget` per run, passed to the guard as `RunOptions.budget`. The guard asks it before every provider request; a refusal stops the loop before the request and the run ends FAILED with `BUDGET_<DIMENSION>`. Limits come from `ComposeOptions.composer.budget` (default 200,000 tokens and 50 requests; a cost cap is optional because the mock prices but J2 does not persist cost yet).
- **PTY-2.** The broker builds every child environment with `buildToolEnv` over the host's `ports.env`; C1 registers no command tool, so no child is started by a composer run yet. C3 adds command tools and the gate test that dumps a child's environment.
- **Recovery.** Shutdown aborts every loop and the service then writes nothing (nothing may write after the final anchor); the journal still says RUNNING and the next start's `Journal.recover` makes it BLOCKED / `INTERRUPTED_BY_RESTART`. The composer service's own startup step cancels a QUEUED composer run (`CANCELLED / INTERRUPTED_BY_RESTART`). Nothing is resumed. Activity is in memory only (`available: false` after a restart) until J2.
- **Workspace guards.** A workspace with a QUEUED or RUNNING run is already refused by finalise and remove (`assertNoActiveRun` reads the journal for every kind). One active composer run per workspace is enforced by the service under the project mutex.

## 5. Tickets

| ID | Ticket | Depends on | Independent of |
|---|---|---|---|
| **C1** (this branch) | `axis.runs/1` contract and policy rows; `run-approvals` (DMN-3); composer loop and service on the mock provider; `bindings/agent.ts` with `read_file` and `write_file`; handlers; compose wiring; recovery of QUEUED composer runs | main | |
| **C2** | Composer writes by compare-and-swap and drift notices before each turn (policies §3.3 to §3.8; gate "Drift (composer)") | C1 | C3, C4, C5, C6 |
| **C3** | Command and git tools (`run_command` with declared `argv`, `git_status`, `git_diff`); PTY-2 and PTY-4 gate tests through the composer; WT-2 broker side (planted hook, `$GIT_COMMON_DIR` change fails the run) | C1 | C2, C5, C6 |
| **C4** | Native confirmation for `destructive` and `privileged` broker calls (tier 4 challenge through the native bridge) | C1 | C2, C3, C6 |
| **C5** | `axis.providers/1.list` lists the mock (and later the Anthropic connection); model list per connection | C1 | C2, C3, C4 |
| **J2** | Journal migration: composer run mode, provider, model, usage and budget state, and a bounded activity table, so `get` and `events` survive a restart and a budget is seeded from the journal | C1 | C2 to C5 |
| **C6** | Anthropic adapter and vault through `bindings/providers.ts` (the only importer, `daemon-host.md` 2.1); PRV-1 backend display | C1, C5 | C2, C3, C4 |
| **C7** | Slice test: PRODUCT scenarios 1 and 6 headless (start, approve, diff review, commit) and kill-and-restart recovery in the child-process host | C1 to C3 | |
| **E1** | Server events (replaces polling of `events`) | after C1 | all of the above |

C2, C3, C4, C5 and J2 touch different files and can run in parallel after C1; C6 waits for C5's list; C7 is the gate evidence.

## 6. Open questions

1. **Contract name.** `axis.runs/1` (as in `daemon-host.md` 4.2 and `axis-agent-shell.md` §6) next to `axis.cli-runs/1` reads as if one were a subset of the other. Keep it, or rename to `axis.composer/1` before any client exists? C1 keeps the documented name.
2. **Default budget.** 200,000 tokens and 50 requests per run, no cost cap by default. Owner to set the product defaults and whether a cost cap is mandatory once a priced provider is connected.
3. **Tier of an approved write.** C1 issues tier 3 (no native dialog) for every approval the broker asks for, protected paths included; only `destructive` and `privileged` are refused until C4. Should a protected-path write (WT-3) also require the native dialog?
4. **Who may resolve.** The challenge goes to the window that started the run. If that window closes, the challenge stays pending until it expires and the run then fails the call; should another window of the same workspace be allowed to answer?
5. **BLOCKED runs.** After a restart a composer run is BLOCKED and nothing resumes it; C1 lets a new run start in that workspace. Should `cancel` of a BLOCKED run be required first (it is allowed and moves it to CANCELLED)?
