# Product vision v2: ticket breakdown and ADRs to write

- **Status:** Proposed plan. Companion to `docs/design/product-vision-v2.md`. Nothing here is scheduled until the owner approves the phase proposal (`product-vision-v2.md` §5–§7).
- **Date:** 2026-11-05. Verified against `origin/main` at `74cd12e`.

## 1. Conventions

- Style follows `docs/design/daemon-host-plan.md` §2: **S** under half a day, **M** one to two days, **L** several days. "Review" marks trust-boundary code that goes to an independent security review before any PR.
- **Builder:** **large** means a long session that owns a design and its security reasoning (the master's development builders); **small** means a short, non-architectural job for a secondary builder (docs, schemas over an agreed design, UI wiring, tests).
- New prefixes avoid the ones in use (A and B in `axis-agent-shell.md` §8; C in both the shell design and `composer-runtime.md`; H, P, J, E, X, W, FU in the daemon-host plan): **G** agents and groups, **D** dashboard, **V** views, **M** messaging, **T** tasks, **Q** pages, **K** plugins, **N** integrations, **R** ADRs and threat-model docs.
- Dependencies on existing tickets use their existing ids: E1 (server events, branch `feat/events-e1`), B9 (pty process, branch `feat/pty-process`), X1 (daemon entry, merged, #454), C1 to C12 and J2 (`composer-runtime.md` §5, branch `feat/composer-runtime`), H10 (merged, #430), H9-scan (merged, #425).

## 2. Docs first

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **R1** | ADR 0006 "Agent home information architecture": Space, Project, Agent, Agent group, project home; agent to workspace rules; amendment to ADR 0004 (landing surface, row unit, terminology per O-1) | M | owner decisions O-1 to O-8 | large | design review |
| **R2** | Apply the approved §6 edits of `product-vision-v2.md` to `ROADMAP.md`, `PRODUCT.md`, `UX.md` | S | R1 approved | small | docs review |
| **R3** | ADR 0007 "Inter-agent messaging": daemon mediation, no capabilities, taint rule, CLI endpoint and the PTY-5 amendment, NET-1 note for the local socket | M | R1 | large | security review |
| **R4** | Threat-model revision for 2a: IAC-1 to IAC-12, PAG-1, PAG-2, TSK-1 and the gate lines, on top of the open 1a revision (branch `docs/threat-model-1a-revision`) | M | R3; the 1a revision merged | large | security review |
| **R5** | ADR 0008 "Axis plugins": separate from Code OSS extensions; execution tiers; `plugin:*` principal (ADR 0003 change); permissions; install, signature, update | L | R1, owner D-1 to D-4 | large | security review |
| **R6** | ADR 0009 "Integrations and the credential proxy": vault, egress rules, OAuth flow and the NET-1 exception, no inbound webhooks, D-9 | M | R5, owner D-7 to D-11 | large | security review |
| **R7** | ADR 0010 "Pages": storage (D-5), format (D-6), rendering rules, agent access | S | R1 | small | design review |
| **R8** | Threat-model revision for 4a: PLG, INT rows and gate lines | M | R5, R6 | large | security review |

## 3. Phase 1c: agent home

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **G1** | Journal migration: `agents` (id, project, name, kind `composer`/`cli`, launch config ref: `axis.cliAgents` entry id or connection, model and default mode; home workspace id; group id; archived; created by) and `agent_groups` (id, project, name, order); `agent_runs.agent_id` | M | R1 | small (schema over the ADR) | review |
| **G2** | Protocol `axis.agents/1` (`create`, `update`, `archive`, `list`, `get`) and `axis.agent-groups/1` (`create`, `rename`, `reorder`, `delete`, `assign`); policy rows, user-only writes; no path, command or credential in any payload | M | G1 | small | review |
| **G3** | Daemon-host: agents service and handlers; `create` composes `axis.worktrees/1.create` under the project mutex with idempotency; archive never removes a workspace (remove stays tier 4); runs record `agent_id`; coverage check | M | G2, H8 (merged) | large | review |
| **G4** | Run start by agent: the shell starts CLI and composer runs from an agent (the daemon resolves the agent's workspace and launch entry; the caller still cannot supply a command) | S | G3, C1 | small | review |
| **D1** | Project home part in the shell: sections of `product-vision-v2.md` §3.4, empty states, keyboard order, polled then E1 | L | G3, E1 | large | UI review |
| **D2** | PR list: `axis.forge/1.pullRequests { projectId }` runs the user's `gh pr list` with JSON output in the pty-process context (PTY-5 environment), strict schema, size and count caps, display escaping, cache and minimum refresh; no `gh` and other-forge states | M | B9, X1 | large | review (untrusted output of a user binary) |
| **D3** | Usage and cost rows per agent and project from J2, budget remaining (PRV-6); CLI rows "not available" | S | J2, G3 | small | none |
| **D4** | Needs-attention summary over approvals pending, failed runs, quiet CLI runs, drift flags, unread messages (unread added in 2a) | S | G3 | small | none |
| **V0** | **Spike:** embed the Code OSS editor widget in an Axis part with the shared text model; measure focus routing and the ADR 0002 criterion 2 footprint; recommend embed or the split-half fallback | M | A1 (merged, #429) | large | design review |
| **V1** | All-agents surface: one lane per agent (state, step, waiting reason, changes), density at 5, 20, 50 agents | L | G3, E1 | large | UI review |
| **V2** | Side panel: Agents tab (groups tree, New agent, New group, bulk stop) and Code tab (file tree, Changes, editor per V0); Restricted Mode read-only; local-checkout switch | L | V0, G3, A5 | large | UI review |
| **V3** | Hand-off rules: side-panel editor to IDE view in all three modes; `axis.sidePanel.toggle`; announcements; keybinding check against the pin | M | V2 | small | a11y review |
| **V4** | 1c gate evidence: the proposed gate line in `product-vision-v2.md` §6 item 1 as automated and manual checks | M | D1 to D4, V1 to V3 | large | gate review |

## 4. Phase 2a: collaboration

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **M1** | Protocol `axis.messages/1` (`send`, `thread`, `threads`, `markRead`, `pause`, `resume`, `settings`), strict schemas without capability fields, closed refusal reasons | M | R3 | small | review |
| **M2** | Journal: `message_threads`, `agent_messages`, deliveries, settings; retention; bounded | M | M1 | small | review |
| **M3** | Message service in the daemon host: routing and the per-recipient policy (`inter-agent-communication.md` §4), excerpts through review containment, limits and hop guard (§7), secret scan (H9-scan, merged), audit events (§8), pause and resume; import-allowlist test that it cannot reach minters | L | M2, G3 | large | review |
| **M4** | Composer participation: `send_message` and `read_messages` broker tools, turn-boundary delivery with labels and escaping, the taint rule IAC-T and the approval-card provenance list | L | M3, C1, C8 | large | review |
| **M5** | Thread view, unread counts, mute, Pause messaging; approval cards visually distinct from messages | M | M3, E1 | small | UI review |
| **M6** | CLI endpoint: per-run socket or pipe, per-run token, revoke on run end, the PTY-5 amendment and test, rate limits | L | M3, B9, H10 (merged), R3 approved | large | review |
| **M7** | `axis-messages` stdio shim (two tools over the endpoint), packaging, user-facing setup copy; refusal for permission-bypass entries (M-3) | M | M6 | large | review |
| **M8** | 2a messaging gate evidence (`inter-agent-communication.md` §11) | M | M4 to M7 | large | gate review |
| **T1** | Tasks journal and `axis.tasks/1`; agent task tools (tier 1, audited) | M | G3 | small | review |
| **T2** | Tasks UI and dashboard section; "Start" shows the full prompt and the source | M | T1, D1 | small | UI review |
| **Q1** | Pages store, versions and `axis.pages/1`; agent `read_page` and approved `write_page` | M | R7, G3 | small | review |
| **Q2** | Page renderer (sanitised Markdown, EL-5 links, no remote images) and the pages UI; Export to repository through diff review | M | Q1 | large | review (renderer) |

## 5. Phase 4a: plugins and integrations

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **K1** | `plugin:*` principal: attestation by main, identity step, policy rows, coverage check | L | R5 | large | review |
| **K2** | Plugin manifest schema, permissions, contribution points; install with SHA-256 pinning, signature check, permission diff on update | L | K1 | large | review |
| **K3** | P1 frame host and renderer plugin broker (sandbox, CSP, message port, per-call schema) | L | K1, K2 | large | review |
| **K4** | Contribution points: page, dashboard section, side-panel tab, task provider, message participant | M | K3, D1, V2, T1, M3 | small | UI review |
| **K5** | Plugin contract tests (the existing Phase 4 gate item) | M | K4 | small | gate review |
| **N1** | Credential proxy `axis.integrations/1` in the daemon: vault-held credentials, origin allowlist, redirect refusal, address checks, caps, closed errors | L | R6, C6 (vault wiring) | large | review |
| **N2** | OAuth (device-code first; one-shot loopback as a recorded NET-1 exception) | M | N1 | large | review |
| **N3** | First token-based integration (per D-8 and D-9), read-only | M | N1, N2 | small | review |
| **N4** | 4a gate evidence (`extensibility.md` §9) | M | K5, N3 | large | gate review |

## 6. Dependency order and critical path

- **Before any of this:** the Phase 0 gate (IDE view criterion 1, ADR 0004 validation), Phase 1a gate and Phase 1b gate. v2 tickets do not replace or jump them.
- **Docs wave (can start now):** R1, then R2, R3 and R7 in parallel; R4 after R3; R5 and R6 can wait for 4a planning.
- **1c wave 1:** G1 → G2 → G3; V0 in parallel with G1 (no dependency on daemon work).
- **1c wave 2:** G4, D3, D4 (small), D2 (after B9 and X1), V1 and D1 (after E1), V2 (after V0, A5); then V3, then V4.
- **2a:** M1 → M2 → M3, then M4 and M5 in parallel, then M6 → M7, M8 last; T1, T2, Q1, Q2 in parallel with messaging (only T2 and K4 cross over).
- **4a:** K1 → K2 → K3 → K4 → K5; N1 → N2 → N3; N4 last.
- **Critical path to 1c:** E1 and B9 merged, then G1 to G3, V0, V2, D1, V4. The side-panel editor (V0, V2) carries the most uncertainty.

Shared-file note: G3, M3, T1 and Q1 each add a contract, policy rows and a registry line; the registry file and the policy table are the shared files (one line per ticket), and the coverage check catches an omission (the daemon-host plan's merge-conflict note applies).

## 7. Effort summary (rough, uncertain)

| Block | Tickets | Large | Small | Comment |
|---|---|---|---|---|
| Docs | R1–R8 | 6 | 2 | R3, R5, R6 decide most of the security shape |
| 1c | G1–G4, D1–D4, V0–V4 | 7 | 6 | V0 can change V2's size by a lot |
| 2a | M1–M8, T1, T2, Q1, Q2 | 7 | 5 | M6 and M7 depend on the PTY-5 amendment being accepted |
| 4a | K1–K5, N1–N4 | 6 | 3 | plugins with code wait for the Phase 3 sandbox |

These counts are not a schedule. Each "Review" ticket has historically taken several review rounds before merge (trust-boundary packages so far needed between two and twelve review rounds); plan for that.

## 8. ADRs to write (updated list)

| ADR | Title | Changes | Ticket |
|---|---|---|---|
| 0006 | Agent home information architecture | amends ADR 0004 (landing surface, row unit, terminology) | R1 |
| 0007 | Inter-agent messaging | amends ADR 0004 implication 3 (PTY-5: two admitted variables for messaging runs); notes a new local listener next to NET-1 | R3 |
| 0008 | Axis plugins | amends ADR 0003 (new `plugin` principal kind and its attestation) | R5 |
| 0009 | Integrations and the credential proxy | revisits ADR 0004 decision 9's "no forge credentials" (D-9); records the OAuth NET-1 exception | R6 |
| 0010 | Pages | new | R7 |
| (design section, not an ADR) | Side-panel editor embedding, in `axis-agent-shell.md` | after V0 | V0 |
| (existing, still to write) | Hooks placement (`composer-runtime.md` C12, ROADMAP 1b "Hooks placement") | unchanged by v2 | C12 |
