<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/axis-logo-dark.svg">
  <img alt="Axis" src="assets/brand/axis-logo-light.svg" width="240">
</picture>

# Project Axis — Agent-Ready Product Blueprint

**Status:** approved product direction; architecture subject to proof-of-concept gates. **Working name:** Project Axis.

Project Axis is a desktop-and-web, AI-native software development workspace combining Code OSS-class editing, multi-provider AI access, autonomous multi-agent execution, local-first project intelligence, and real-time team collaboration. It must feel like one fast, minimal product—not an IDE with several dashboards bolted on.

## Read in order
1. `DEVELOPMENT.md` — repository workflow, Git conventions, PRs, phase checks and attribution.
2. `docs/PRODUCT.md` — product scope and acceptance criteria.
3. `docs/ARCHITECTURE.md` — boundaries, runtimes, data flows, technical decisions.
4. `docs/AGENT_SYSTEM.md` — orchestration, isolation, review, lifecycle.
5. `docs/PROVIDERS.md` — supported authentication, capability negotiation, routing.
6. `docs/CONTEXT.md` — local-first memory and cross-project intelligence.
7. `docs/UX.md` — design principles, layouts, interaction rules.
8. `docs/SECURITY.md` — trust model, secrets, isolation, sync, enterprise controls.
9. `docs/ROADMAP.md` — phases, milestones, release gates.
10. `docs/IMPLEMENTATION.md` — proposed repository, interfaces, initial backlog.

## Operating rule
Do not implement the entire product in one pass. First establish the Code OSS compatibility spike, security boundaries, and an end-to-end vertical slice. Record decisions as ADRs. Do not claim provider features, CLI authentication, or extension compatibility without verified supported paths.

## Repository privacy
Local development-agent instruction files are private context and are intentionally excluded from Git. `DEVELOPMENT.md` and product specifications are repository documentation. Do not commit private agent instructions, transcripts, or local context dumps. Check staged files before every commit.
