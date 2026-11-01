# ADR 0001: Architecture baseline (provisional)

**Status:** Proposed pending Phase 0 validation.

## Context
The product requires a custom desktop/web workbench with Code OSS-class capabilities, multi-provider agents, and local-first storage.

## Decision
Use Electron desktop and a shared web UI; prototype a Code OSS-derived integration before locking the fork strategy. Keep AI gateway, orchestration, execution, context, sync and policy as separate versioned services. Prefer local execution with optional cloud workers and worktree-per-agent Git isolation.

## Alternatives
Build IDE on Monaco alone (faster customization, substantial loss of integrated IDE infrastructure); embed unmodified Code OSS UI (less customization); cloud-only architecture (poor offline/local-first fit); shared-directory agents (collisions).

## Consequences
High upstream maintenance and extension compatibility risk; requires explicit Phase 0 go/no-go. Easier to evolve providers and execution independently after stable interfaces.

## Revisit when
Code OSS service reuse proves infeasible, web parity demands a different architecture, or threat model invalidates current execution assumptions.
