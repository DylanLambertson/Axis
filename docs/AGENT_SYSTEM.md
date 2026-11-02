# Autonomous Agent System

## Roles
**Planner:** decomposes user goal into a dependency DAG, proposes risks, file scope, acceptance tests, estimated cost and permissions. **Worker:** implements one bounded task in a dedicated worktree. **Reviewer:** checks diff, tests, security, spec alignment and integration risk; cannot self-approve its own work. **Integrator:** coordinates sequential merges and conflict resolution under policy. Optional researcher/tester agents use the same task protocol.

## Run state machine
DRAFT → PLANNING → AWAITING_APPROVAL (if needed) → QUEUED → RUNNING → VALIDATING → REVIEWING → READY_TO_MERGE → MERGING → COMPLETED. Alternative terminal states: CANCELLED, FAILED, BLOCKED, ROLLED_BACK. Durable journal and restart recovery required.

## Scheduling
Tasks have IDs, dependencies, scopes, priority, budget, allowed tools, model requirements, branch/worktree refs and acceptance tests. Run ready tasks concurrently within per-device/per-team quotas. Prevent overlapping write scopes when possible; Git isolation is the final boundary. Planner cannot override policy.

## Git isolation
Create one branch and worktree per coding worker; no shared writable repository directory. In the product, each worktree is a **workspace** (ADR 0004): worktree + branch + base SHA + agent runs + terminals + changes. Phase 1 runs one composer agent at a time per workspace, plus any CLI agent runs the user launches there; agents never run in the user's local checkout. Worktrees live outside the repository, under the Axis app data directory by default. User edits during a run are allowed: the changeset shows them and the workspace flags "files changed outside the agent". Composer agents are told of the drift before their next tool write; CLI agents are not, and Axis never injects input into their terminals. Phase 3 gives each planner worker its own workspace. Record base SHA. Capture diff, tests, artifacts and commit. Review before merge; detect drift and conflicts; serialize merges through an integration queue; require user approval according to risk. Retain rollback refs and clean worktrees only after safe finalization.

## Tool contract
Every tool declares JSON schema, scope, side effects, network use, approval class, timeout and result type. Broker validates inputs and policy before execution. Outputs are untrusted and size-limited. Secret-bearing tools use short-lived scoped handles rather than exposing raw values to models.

## Permission tiers
Read-only project inspection; scoped workspace writes; package installs and network access; destructive operations and deployment; sensitive data/credentials. Higher-risk tiers require explicit user/team policy approval. Never allow prompt text to grant itself permissions.

## Model selection
Task router chooses only among connected, authorized, capability-compatible models; user can pin model/account per task or role. Respect context limits, tools, streaming, cost budgets and regional restrictions. Graceful fallback requires explicit policy and never silently crosses trust boundaries.

## Agent UI
Dashboard: every workspace with its agents and state (idle, running, waiting for approval, failed, done), branch, terminals and changed files; rows needing the user come first. Workspace view: composer (Ask/Edit/Agent), activity stream, file tree, changes and diff review with accept/reject/commit, terminals. Advanced detail on demand inside the workspace view: DAG, live worker activity, provider/model, tokens/cost, logs, permissions, checkpoints, worktrees, merge queue. CLI agent runs are first-class on the dashboard, with status from process and terminal state Axis owns; they run with user privileges under the CLI's own permission model, are not brokered (they can write outside the worktree and push), and their changes go through the same diff review, with changes to the repository's shared Git configuration and hooks during the run flagged. Users can pause, cancel, retry, branch, and take over a task.

## Test cases
Parallel workers touching distinct files; overlapping file conflict; worker crash; rate limit; provider outage; denied network; prompt injection in repo; expired token; failed test; merge conflict; cancellation mid-command; resume after restart; user rejection and rollback.
