<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/axis-logo-dark.svg">
  <img alt="Axis" src="assets/brand/axis-logo-light.svg" width="240">
</picture>

# Project Axis — Agent-Ready Product Blueprint

**Status:** approved product direction; architecture subject to proof-of-concept gates. **Working name:** Project Axis.

Project Axis is a desktop-and-web AI agent manager for software development, with a fully capable Code OSS-class IDE built in. Its home is a workspace dashboard: each workspace is an isolated Git worktree and branch where agents work, with its own terminals, file tree, changes and diff review. Any file or diff opens in the IDE view, by toggle or side-by-side split. Axis adds multi-provider AI access, multi-agent execution, local-first project intelligence, and real-time team collaboration. It must feel like one fast, minimal product—not a copy of VS Code and not an IDE with dashboards bolted on.

## Read in order
1. `DEVELOPMENT.md` — repository workflow, Git conventions, PRs, phase checks and attribution.
   - `docs/ci.md` — the CI checks every pull request must pass.
2. `docs/PRODUCT.md` — product scope and acceptance criteria.
3. `docs/ARCHITECTURE.md` — boundaries, runtimes, data flows, technical decisions.
4. `docs/AGENT_SYSTEM.md` — orchestration, isolation, review, lifecycle.
5. `docs/PROVIDERS.md` — supported authentication, capability negotiation, routing.
6. `docs/CONTEXT.md` — local-first memory and cross-project intelligence.
7. `docs/UX.md` — design principles, layouts, interaction rules.
8. `docs/SECURITY.md` — trust model, secrets, isolation, sync, enterprise controls.
   - `docs/security/threat-model-phase0.md` — Phase 0 threat model (history); the threat IDs cited across the ADRs.
   - `docs/security/threat-model-phase1.md` and `threat-model-phase1-controls.md` — Phase 1 revision (agent-first shell, 1a and 1b): data-flow diagram, new threats, control-to-gate matrix, residual risks, risk register. Read before the Phase 1a gate.
9. `docs/ROADMAP.md` — phases, milestones, release gates.
10. `docs/IMPLEMENTATION.md` — proposed repository, interfaces, initial backlog.
11. `docs/adr/` — architecture decision records (start with ADR 0001, ADR 0002, and ADR 0004 for the agent-first workspace shell).
12. `docs/feasibility/` — Phase 0 research behind the decisions: Code OSS inventory, licensing and marketplace constraints, integration alternatives.

## Operating rule
Do not implement the entire product in one pass. First establish the Code OSS compatibility spike with the agent-view skeleton, security boundaries, and the agent workspace vertical slice. Record decisions as ADRs. Do not claim provider features, CLI authentication, or extension compatibility without verified supported paths.

## Repository privacy
Local development-agent instruction files are private context and are intentionally excluded from Git. `DEVELOPMENT.md` and product specifications are repository documentation. Do not commit private agent instructions, transcripts, or local context dumps. Check staged files before every commit.
