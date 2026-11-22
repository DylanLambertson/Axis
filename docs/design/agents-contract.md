# Agents and agent groups: the contracts (PV-G2)

- **Status:** Served (PV-G3 slice 1): the handlers are registered and the rows are in `rules.ts`. Slice 2 wires the messaging directory to the journal (section 5).
- **Date:** 2026-11-22.
- **Inputs:** ADR 0006 decisions 4 to 6 and 10; journal schema version 12 (`packages/journal/src/schema-agents.ts`, PV-G1); `docs/design/product-vision-v2-tickets.md` PV-G2 and PV-G3.
- **Code:** `packages/protocol/src/agents.ts`; rows in `packages/daemon-host/src/policy/rules.ts`; the records in `packages/journal/src/agent-store.ts` (`Journal.agents`); the service and handlers in `packages/daemon-host/src/agents/service.ts` and `src/handlers/agents.ts`. Tests: `packages/protocol/test/contracts-agents.test.ts`, `packages/journal/test/agent-store.test.ts`, `packages/daemon-host/test/policy/agents-policy.test.ts`, `packages/daemon-host/test/agents/agents-handlers.test.ts`.

## 1. Methods

| Contract | Method | Side effect | Tier | Idempotency | What it does |
|---|---|---|---|---|---|
| `axis.agents/1` | `list` | read | 0 | none | A project's agents, live only unless `includeArchived` |
| | `get` | read | 0 | none | One agent by id |
| | `create` | write | 2 | required | A new agent with a new home workspace (the same inputs as `axis.worktrees/1.create`) or an existing workspace of the project, optionally in a group |
| | `update` | write | 2 | none | Rename, or change the launch within the agent's kind |
| | `archive` | write | 1 | none | Archive; never removes the home workspace |
| | `restore` | write | 1 | none | Restore while the home is live and the name is free |
| `axis.agent-groups/1` | `list` | read | 0 | none | A project's groups in order |
| | `create` | write | 1 | required | A new group, last in order |
| | `rename` | write | 1 | none | |
| | `reorder` | write | 1 | none | The full new order: exactly the project's group ids, each once |
| | `delete` | write | 1 | none | Ungroups its agents (listed in the reply); archives none |
| | `assign` | write | 2 | none | Put an agent in a group of its project, or take it out (`null`) |

**Tiers.** Reads are 0. `create` is 2 with a required idempotency key, as `axis.worktrees/1.create`, because it can create a worktree. Changing what an agent runs (`update` with a launch) and its messaging scope (`assign`: group membership feeds the send policy's `accepts_from: group`) are 2, as the messaging settings are. The other writes are 1. Archive and delete are not `destructive`: nothing is lost and the user can undo both. `restore` stays at 1 although it brings the agent back into its old group (archive keeps `group_id`): it only undoes the user's own archive and widens nothing the user had not already set, whereas `assign` is 2 because it chooses a new messaging scope.

**Actors.** Every row is user-only, reads included (ADR 0006 decision 10). No agent, plugin or message creates, changes or groups an agent, so no agent can mint a messaging principal, join a group or widen its own scope. The journal backs this independently: `created_by` is always `user`.

## 2. Payload rules

- **No path, command or credential.** A launch is a reference: a CLI agent names an `axis.cliAgents` entry id (`cliAgentIdSchema`), a composer agent a vault connection name, a model id and a mode. The daemon resolves the entry when a run starts (PV-G4). A new home is a workspace name and an optional base ref, exactly what `axis.worktrees/1.create` takes; the daemon derives every path from its own records. Tests refuse `command`, `args`, `env`, an absolute path or `../` as an entry id, an `apiKey`, a URL as a connection, and a `path` in the home.
- **Bypass entries are not this contract's.** The composer `mode` enum is `ask`, `edit` or `agent` (no bypass value). Messaging decision M-3 (CLI entries that bypass the CLI's own prompts are refused for messaging) applies where a CLI entry is registered and where messaging is enabled for it, not here: `entryId` is only a reference.
- **The creator is the connection's.** No request carries `createdBy`; the handler records the authenticated principal (always the user under these rows).
- **Kind is fixed.** `update` with a launch of the other kind is refused `kind_changed`; the journal refuses it too.
- **Names.** 1 to 64 characters, no edge space, none of `safeTextSchema`'s refused set (Cc, Cs, the line and paragraph separators, Cf) and none of the space separators U+00A0, U+2000 to U+200A, U+202F and U+205F. That is exactly the journal's `NAME_REFUSED_RANGES` plus NUL; `agents-policy.test.ts` compares the two over every code point, so a name the wire accepts is one the journal stores. Live names are unique per project ignoring ASCII case (journal); other case pairs and look-alikes are not folded, and agents are always addressed by id.
- **Bounds.** At most 500 agents (archived included) and 100 groups per project; a list answers all of them in one reply (within the envelope's node limit).

## 3. Refusals

Closed, with one fixed message (`agent request refused`) and `details: { reason }`, so no stored name reaches an error:

| Code | Reasons |
|---|---|
| `E_NOT_FOUND` | `not_found`: unknown id, or an id of a project the caller cannot see |
| `E_CONFLICT` | `name_taken`, `cross_project` (a group or an existing workspace of another project), `kind_changed`, `archived` (a write to an archived agent other than `restore`), `home_unavailable` (an existing workspace that is not live, or a restore whose home is not live), `order_mismatch` (a reorder that is not exactly the project's groups), `limit_reached`, `untrusted_project` |

Schema failures are `E_INVALID_ARGUMENT` as everywhere. Policy denials are the pipeline's `E_POLICY_DENIED`, never a handler's.

## 4. What PV-G3 must do (handler obligations)

1. `create` with a new home composes `axis.worktrees/1.create` under the project mutex, then inserts the agent in a separate journal transaction: the worktree work is asynchronous git work that writes its own rows, so the two cannot share one transaction. An insert refused after the worktree exists leaves a workspace without an agent (section 5). The daemon's idempotency store replays a retried `create` by its key (the first result, no second worktree).
2. Every write re-reads the agent, group and workspace from the journal; the project comes from the journal, never the payload.
3. Archive, restore, assign and delete write one audit event each, keyed by ids; a workspace leaving the live states archives its agents in the journal (trigger), and the host writes the audit events for those archives in the same flow that moved the workspace.
4. Untrusted projects: agents can be created with an existing home, viewed and grouped while the project is untrusted (ADR 0006 security implication 6), and runs stay refused until it is trusted (PV-G4). `create` with a **new** home makes a worktree, and the trust check of `axis.worktrees/1.create` lives in the policy pipeline (its row's registry trust mode), not in its handler, so a handler that calls the worktrees service internally skips it. The `create` handler MUST therefore check trust itself before it creates a worktree: the connection's attested trusted flag AND the live trust registry for the connection's window and workspace, exactly as the pipeline would for `axis.worktrees/1.create`, and refuse `untrusted_project` otherwise. That rule is per window and workspace, not per project, until ticket S1b's project gate replaces it through the `admitNewHome` seam (section 5). PV-G3 tests it (an untrusted project, and a trust revoked between two calls).
5. When the contracts move to `contracts`, their rows move from `planned.ts` to `rules.ts` unchanged; the coverage check fails until they do.

## 5. Built (PV-G3 slice 1)

- **Create.** With an existing home: under the project mutex, one journal transaction inserts the agent; the journal refuses a home that is not READY, of another project or missing. With a new home: the handler checks trust first (the attested flag AND the live trust registry for the connection's window and workspace, as the `registry` trust mode), then, under the project mutex, refuses what the record would refuse (live name, group, cap) before any worktree exists, then calls the worktrees service's `create` (the same mutex, re-entrant), then inserts the agent. A worktree failure is `home_unavailable` (cancellation stays `E_CANCELLED`). If the insert is refused after the worktree exists, the workspace stays, without an agent (listed under Workspaces, ADR 0006 decision 5). The daemon's idempotency store replays a retried `create` by its key.
- **Trust seam.** The new-home decision is one function, `AgentsServiceDeps.admitNewHome(caller, projectId)`, defaulting to `registryAdmission(trust)` (`src/agents/service.ts`): the registry rule, per window and workspace, not per project. When ticket S1b's project gate (`admit`, the `requireProjectTrust` equivalent over the journal's main-owned run-trust record) merges, the composition root passes it as `admitNewHome` in `registerAgentsHandlers`: a one-line change, and the handler and service stay as they are.
- **Every other write** runs in one journal transaction (`Journal.agents.transaction`), re-reads its ids, and tells the audit anchor after it commits; `update` with a name and a launch is one transaction (a refused launch keeps the old name).
- **Audit.** Each write is one `journal.agent.record` event (`field` and ids only; a name is never stored). A workspace leaving CREATING or READY archives its live agents in the schema trigger; `Journal.transitionWorkspace` and recovery's CREATING-to-FAILED write one `archive` event per such agent (`reason: home_not_live`, the transition's actor) in the same transaction, so every path that moves a workspace is covered.
- **Handlers** refuse any actor but the user and any web client (`not_found`), map only the closed reasons, and check every answer against the response schema (`E_INTERNAL` otherwise).
- **Messaging directory (slice 2).** `journalAgentsDirectory` (`src/agents/directory.ts`) answers messaging from the journal: live agents only, a group's live members in id order up to `MAX_SETTINGS_AGENTS`, read per call so an archive, restore or group change takes effect on the next send. The host's `agentOf` is the run's recorded agent (`Journal.agents.agentOfRun`); runs record one only when PV-G4 starts them from an agent, so delivery and the composer tools stay inert until then.
