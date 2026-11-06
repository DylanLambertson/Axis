# Product vision v2: ticket breakdown and ADRs to write

- **Status:** Proposed plan. Companion to `docs/design/product-vision-v2.md`. Nothing here is scheduled until the owner approves the phase proposal (`product-vision-v2.md` §5–§7).
- **Date:** 2026-11-06 (owner direction of 2026-11-06). Verified against `origin/main` at `74cd12e`.

## 1. Conventions

- Style follows `docs/design/daemon-host-plan.md` §2: **S** under half a day, **M** one to two days, **L** several days. "Review" marks trust-boundary code that goes to an independent security review before any PR.
- **Builder:** **large** means a long session that owns a design and its security reasoning (the master's development builders); **small** means a short, non-architectural job for a secondary builder (docs, schemas over an agreed design, UI wiring, tests).
- **Namespace:** every new ticket id starts with `PV-` (product vision), because bare letters already mean other things in tracked documents: Q1 to Q16 are open questions in `daemon-host-plan.md` §3, R-numbers are risk ids, G-numbers are review-core threat rows and shell rebrand blocks, D1 to D7 are ADR 0003 decisions, M-numbers are milestones, and A, B, C, H, P, J, E, X, W and FU are existing tickets. Groups: **PV-G** agents and groups, **PV-D** dashboard, **PV-V** views, **PV-M** messaging, **PV-T** tasks, **PV-Q** pages, **PV-K** plugins, **PV-N** integrations, **PV-R** ADRs and threat-model docs. Decision ids with a hyphen and no prefix (O-1, M-1, D-1) are owner decisions in the design files, not tickets.
- Dependencies on existing tickets use their existing ids: E1 (server events, PR #457), B9 (pty process, branch `feat/pty-process`), X1 (daemon entry, merged, #454), C1 to C12 and J2 (`composer-runtime.md` §5; C1 is PR #458, the rest unbuilt), P1d (PR #456), the 1a threat-model revision (PR #459), A5 (shell Changes view, `axis-agent-shell.md` §8.1, unbuilt, no branch), H10 (merged, #430), H9-scan (merged, #425).

## 2. Docs first

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **PV-R1** | ADR 0006 "Agent home information architecture": Space, Project, Agent, Agent group, project home; agent to workspace rules; amendment to ADR 0004 (landing surface, row unit, terminology per O-1) | M | owner decisions O-1 to O-8 | large | design review |
| **PV-R2** | Apply the approved §6 edits of `product-vision-v2.md` to `ROADMAP.md`, `PRODUCT.md`, `UX.md`, including whether ROADMAP's "first usable release target is the Phase 1 slice" still holds once 1c exists | S | PV-R1 approved | small | docs review |
| **PV-R3** | ADR 0007 "Inter-agent messaging": daemon mediation, no capabilities, taint rule, CLI endpoint and the PTY-5 amendment, NET-1 note for the local socket | M | PV-R1 | large | security review |
| **PV-R4** | Threat-model revision for 2a: IAC-1 to IAC-12, PAG-1, PAG-2, TSK-1 and the gate lines, on top of the open 1a revision (PR #459) | M | PV-R3; the 1a revision merged | large | security review |
| **PV-R5** | ADR 0008 "Axis plugins": separate from Code OSS extensions; execution tiers; `plugin:*` principal (ADR 0003 change); permissions; install, signature, update | L | PV-R1, owner D-1 to D-4 | large | security review |
| **PV-R6** | ADR 0009 "Integrations and the credential proxy": vault, egress rules, OAuth flow and the NET-1 exception, no inbound webhooks, D-9 | M | PV-R5, owner D-7 to D-11 | large | security review |
| **PV-R7** | ADR 0010 "Pages": storage (D-5), format (D-6), rendering rules, agent access | S | PV-R1 | small | design review |
| **PV-R8** | Threat-model revision for 4a: PLG, INT rows and gate lines | M | PV-R5, PV-R6 | large | security review |

## 3. Phase 1c: agent home

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **PV-G1** | Journal migration: `agents` (id, project, name, kind `composer`/`cli`, launch config ref: `axis.cliAgents` entry id or connection, model and default mode; home workspace id; group id; archived; created by) and `agent_groups` (id, project, name, order); `agent_runs.agent_id` | M | PV-R1 | small (schema over the ADR) | review |
| **PV-G2** | Protocol `axis.agents/1` (`create`, `update`, `archive`, `list`, `get`) and `axis.agent-groups/1` (`create`, `rename`, `reorder`, `delete`, `assign`); policy rows, user-only writes; no path, command or credential in any payload | M | PV-G1 | small | review |
| **PV-G3** | Daemon-host: agents service and handlers; `create` composes `axis.worktrees/1.create` under the project mutex with idempotency; archive never removes a workspace (remove stays tier 4); runs record `agent_id`; coverage check | M | PV-G2, H8 (merged) | large | review |
| **PV-G4** | Run start by agent: the shell starts CLI and composer runs from an agent (the daemon resolves the agent's workspace and launch entry; the caller still cannot supply a command) | S | PV-G3, C1 | small | review |
| **PV-D1** | Project home part in the shell: sections of `product-vision-v2.md` §3.4, empty states, keyboard order, polled then E1 | L | PV-G3, E1 | large | UI review |
| **PV-D2** | PR list: `axis.forge/1.pullRequests { projectId }` runs the user's `gh pr list` with JSON output in the pty-process context (PTY-5 environment), strict schema, size and count caps, display escaping, cache and minimum refresh; no `gh` and other-forge states | M | B9, X1 | large | review (untrusted output of a user binary) |
| **PV-D3** | Usage and cost rows per agent and project from J2, budget remaining (PRV-6); CLI rows "not available" | S | J2, PV-G3 | small | none |
| **PV-D4** | Needs-attention summary over approvals pending, failed runs, quiet CLI runs, drift flags, unread messages (unread added in 2a) | S | PV-G3 | small | none |
| **PV-V0** | **Spike:** embed the Code OSS editor widget in an Axis part with the shared text model; measure focus routing and the ADR 0002 criterion 2 footprint; recommend embed or the split-half fallback | M | A1 (merged, #429) | large | design review |
| **PV-V1** | All-agents surface: one lane per agent (state, step, waiting reason, changes), density at 5, 20, 50 agents | L | PV-G3, E1 | large | UI review |
| **PV-V2** | Side panel: Agents tab (groups tree, New agent, New group, bulk stop) and Code tab (file tree, Changes, editor per PV-V0); Restricted Mode read-only; local-checkout switch | L | PV-V0, PV-G3, A5 | large | UI review |
| **PV-V3** | Hand-off rules: side-panel editor to IDE view in all three modes; `axis.sidePanel.toggle`; announcements; keybinding check against the pin | M | PV-V2 | small | a11y review |
| **PV-V4** | 1c gate evidence: the proposed gate line in `product-vision-v2.md` §6 item 1 as automated and manual checks | M | PV-D1 to PV-D4, PV-V1 to PV-V3 | large | gate review |

## 4. Phase 2a: collaboration

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **PV-M1** | Protocol `axis.messages/1` (`send`, `thread`, `threads`, `markRead`, `pause`, `resume`, `settings`), strict schemas without capability fields, closed refusal reasons | M | PV-R3 | small | review |
| **PV-M2** | Journal: `message_threads`, `agent_messages`, deliveries, settings; retention; bounded | M | PV-M1 | small | review |
| **PV-M3** | Message service in the daemon host: routing and the per-recipient policy (`inter-agent-communication.md` §4), excerpts through review containment, limits and hop guard (§7), secret scan (H9-scan, merged), audit events (§8), pause and resume; import-allowlist test that it cannot reach minters | L | PV-M2, PV-G3 | large | review |
| **PV-M4** | Composer participation: `send_message` and `read_messages` broker tools, turn-boundary delivery with labels and escaping, the taint rule IAC-T and the approval-card provenance list | L | PV-M3, C1, C8 | large | review |
| **PV-M5** | Thread view, unread counts, mute, Pause messaging; approval cards visually distinct from messages | M | PV-M3, E1 | small | UI review |
| **PV-M6** | CLI endpoint: per-run socket or pipe, per-run token, revoke on run end, the PTY-5 amendment and test, rate limits | L | PV-M3, B9, H10 (merged), PV-R3 approved | large | review |
| **PV-M7** | `axis-messages` stdio shim (two tools over the endpoint), packaging, user-facing setup copy; refusal for permission-bypass entries (M-3) | M | PV-M6 | large | review |
| **PV-M8** | 2a messaging gate evidence (`inter-agent-communication.md` §11) | M | PV-M4 to PV-M7 | large | gate review |
| **PV-T1** | Tasks journal and `axis.tasks/1`; agent task tools (tier 1, audited) | M | PV-G3 | small | review |
| **PV-T2** | Tasks UI and dashboard section; "Start" shows the full prompt and the source | M | PV-T1, PV-D1 | small | UI review |
| **PV-Q1** | Pages store, versions and `axis.pages/1`; agent `read_page` and approved `write_page` | M | PV-R7, PV-G3 | small | review |
| **PV-Q2** | Page renderer (sanitised Markdown, EL-5 links, no remote images) and the pages UI; Export to repository through diff review | M | PV-Q1 | large | review (renderer) |

## 5. Phase 4a: plugins and integrations

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **PV-K1** | `plugin:*` principal: attestation by main, identity step, policy rows, coverage check | L | PV-R5 | large | review |
| **PV-K2** | Plugin manifest schema, permissions, contribution points; install with SHA-256 pinning, signature check, permission diff on update | L | PV-K1 | large | review |
| **PV-K3** | P1 frame host and renderer plugin broker (sandbox, CSP, message port, per-call schema) | L | PV-K1, PV-K2 | large | review |
| **PV-K4** | Contribution points: page, dashboard section, side-panel tab, task provider, message participant | M | PV-K3, PV-D1, PV-V2, PV-T1, PV-M3 | small | UI review |
| **PV-K5** | Plugin contract tests (the existing Phase 4 gate item) | M | PV-K4 | small | gate review |
| **PV-N1** | Credential proxy `axis.integrations/1` in the daemon: vault-held credentials, origin allowlist, redirect refusal, address checks, caps, closed errors | L | PV-R6, C6 (vault wiring) | large | review |
| **PV-N2** | OAuth (device-code first; one-shot loopback as a recorded NET-1 exception) | M | PV-N1 | large | review |
| **PV-N3** | Only if the owner reverses D-9: first token-based integration (GitHub, read-only, behind the credential proxy). If D-9 stays, the first integration is the `gh`-based PR list (PV-D2) and PV-N3 is dropped; PV-N4 then evidences PV-N1 and PV-N2 with a test service | M | PV-N1, PV-N2 | small | review |
| **PV-N4** | 4a gate evidence (`extensibility.md` §9) | M | PV-K5, PV-N3 | large | gate review |

## 6. Dependency order and critical path

- **Before any of this:** the Phase 0 gate (IDE view criterion 1, ADR 0004 validation), Phase 1a gate and Phase 1b gate. v2 tickets do not replace or jump them.
- **Docs wave (can start now):** PV-R1, then PV-R2, PV-R3 and PV-R7 in parallel; PV-R4 after PV-R3; PV-R5 and PV-R6 can wait for 4a planning.
- **1c wave 1:** PV-G1 → PV-G2 → PV-G3; PV-V0 in parallel with PV-G1 (no dependency on daemon work).
- **1c wave 2:** PV-G4, PV-D3, PV-D4 (small), PV-D2 (after B9 and X1), PV-V1 and PV-D1 (after E1), PV-V2 (after PV-V0, A5); then PV-V3, then PV-V4.
- **2a:** PV-M1 → PV-M2 → PV-M3, then PV-M4 and PV-M5 in parallel, then PV-M6 → PV-M7, PV-M8 last; PV-T1, PV-T2, PV-Q1, PV-Q2 in parallel with messaging (only PV-T2 and PV-K4 cross over).
- **4a:** PV-K1 → PV-K2 → PV-K3 → PV-K4 → PV-K5; PV-N1 → PV-N2 → PV-N3; PV-N4 last.
- **Critical path to 1c:** E1 (PR #457) and B9 merged, J2 for usage, A5 (unbuilt shell Changes view, needed by PV-V2), then PV-G1 to PV-G3, PV-V0, PV-V2, PV-D1, PV-V4. **Critical path to 4a integrations:** C6 (vault wiring, behind C1 to C5 and C8) before PV-N1. The side-panel editor (PV-V0, PV-V2) carries the most uncertainty.

Shared-file note: PV-G3, PV-M3, PV-T1 and PV-Q1 each add a contract, policy rows and a registry line; the registry file and the policy table are the shared files (one line per ticket), and the coverage check catches an omission (the daemon-host plan's merge-conflict note applies).

## 7. Effort summary (rough, uncertain)

| Block | Tickets | Large | Small | Comment |
|---|---|---|---|---|
| Docs | PV-R1–PV-R8 | 6 | 2 | PV-R3, PV-R5, PV-R6 decide most of the security shape |
| 1c | PV-G1–PV-G4, PV-D1–PV-D4, PV-V0–PV-V4 | 7 | 6 | PV-V0 can change PV-V2's size by a lot |
| 2a | PV-M1–PV-M8, PV-T1, PV-T2, PV-Q1, PV-Q2 | 7 | 5 | PV-M6 and PV-M7 depend on the PTY-5 amendment being accepted |
| 4a | PV-K1–PV-K5, PV-N1–PV-N4 | 6 | 3 | plugins with code wait for the Phase 3 sandbox |

These counts are not a schedule. Each "Review" ticket has historically taken several review rounds before merge (trust-boundary packages so far needed between two and twelve review rounds); plan for that.

## 8. ADRs to write (updated list)

| ADR | Title | Changes | Ticket |
|---|---|---|---|
| 0006 | Agent home information architecture | amends ADR 0004 (landing surface, row unit, terminology) | PV-R1 |
| 0007 | Inter-agent messaging | amends ADR 0004 implication 3 (PTY-5: two admitted variables for messaging runs); notes a new local listener next to NET-1 | PV-R3 |
| 0008 | Axis plugins | amends ADR 0003 (new `plugin` principal kind and its attestation) | PV-R5 |
| 0009 | Integrations and the credential proxy | revisits ADR 0004 decision 9's "no forge credentials" (D-9); records the OAuth NET-1 exception | PV-R6 |
| 0010 | Pages | new | PV-R7 |
| (design section, not an ADR) | Side-panel editor embedding, in `axis-agent-shell.md` | after PV-V0 | PV-V0 |
| (existing, still to write) | Hooks placement (`composer-runtime.md` C12, ROADMAP 1b "Hooks placement") | unchanged by v2 | C12 |
