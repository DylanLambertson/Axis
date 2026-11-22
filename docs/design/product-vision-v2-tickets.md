# Product vision v2: ticket breakdown and ADRs to write

- **Status:** Plan, approved with the phase proposal on 2026-11-21 (owner decision O-7, `docs/design/owner-decisions-2026-11-21.md`). Companion to `docs/design/product-vision-v2.md`; PV-R1 is ADR 0006.
- **Date:** 2026-11-06 (owner direction of 2026-11-06). Verified against `origin/main` at `74cd12e`; E1 (`116ef22`) and P1d (`e52114f`) have merged since.

## 1. Conventions

- Style follows `docs/design/daemon-host-plan.md` §2: **S** under half a day, **M** one to two days, **L** several days. "Review" marks trust-boundary code that goes to an independent security review before any PR.
- **Builder:** **large** means a long session that owns a design and its security reasoning (the master's development builders); **small** means a short, non-architectural job for a secondary builder (docs, schemas over an agreed design, UI wiring, tests).
- **Namespace:** every new ticket id starts with `PV-` (product vision), because bare letters already mean other things in tracked documents: Q1 to Q16 are open questions in `daemon-host-plan.md` §3, R-numbers are risk ids, G-numbers are review-core threat rows and shell rebrand blocks, D1 to D7 are ADR 0003 decisions, M-numbers are milestones, and A, B, C, H, P, J, E, X, W and FU are existing tickets. Groups: **PV-G** agents and groups, **PV-D** dashboard, **PV-V** views, **PV-M** messaging, **PV-T** tasks, **PV-Q** pages, **PV-K** plugins, **PV-N** integrations, **PV-X** cross-cutting prerequisites, **PV-R** ADRs and threat-model docs. Decision ids with a hyphen and no prefix (O-1, M-1, D-1) are owner decisions in the design files, not tickets.
- Dependencies on existing tickets use their existing ids: E1 (server events, merged after this plan was first verified, `116ef22`), B9 (pty process, branch `feat/pty-process`), X1 (daemon entry, merged, #454), C1 to C12 and J2 (`composer-runtime.md` §5; C1 is PR #458, the rest unbuilt), P1d (merged, `e52114f`), the 1a threat-model revision (PR #459), A5 (shell Changes view, `axis-agent-shell.md` §8.1, unbuilt, no branch), H10 (merged, #430), H9-scan (merged, #425).

## 2. Docs first

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **PV-R1** | ADR 0006 "Agent home information architecture": Space, Project, Agent, Agent group, project home; agent to workspace rules; amendment to ADR 0004 (landing surface, row unit, terminology per O-1) | M | owner decisions O-1 to O-8 | large | design review |
| **PV-R2** | Apply the approved §6 edits of `product-vision-v2.md` to `ROADMAP.md`, `PRODUCT.md`, `UX.md`, including whether ROADMAP's "first usable release target is the Phase 1 slice" still holds once 1c exists | S | PV-R1 approved | small | docs review |
| **PV-R3** | ADR 0007 "Inter-agent messaging": daemon mediation, no capabilities, thread participant sets and read authorization, the sticky taint rule and its closed source list, per-sender queue quotas, the CLI endpoint (bounds, token residual, Windows pipe and Unix directory rules, read-path escaping, bypass configuration) as a new local listener next to NET-1, and the PTY-5 amendment. **Written:** `docs/adr/0007-inter-agent-messaging.md` (with a code map); the endpoint listens in the pty process, not the daemon (ADR 0003 D1.1 kept) | M | PV-R1 | large | security review |
| **PV-R4** | Threat-model revision for 2a: IAC-1 to IAC-16, PAG-1 to PAG-3, TSK-1, TSK-2 and the gate lines of `inter-agent-communication.md` §11, `inter-agent-cli-endpoint.md` §7 and `extensibility.md` §9, on top of the 1a revision. **Written:** `docs/security/threat-model-phase2a.md`, the numbered gate lines in `threat-model-phase2a-gates.md` and register rows RR-31 to RR-55 | M | PV-R3; the 1a revision merged | large | security review |
| **PV-R5** | ADR 0008 "Axis plugins": separate from Code OSS extensions; execution tiers; the P1 host (a sandboxed view per plugin, navigation and WebRTC blocked, header CSP) and the `plugin:*` principal attested by main per view (ADR 0003 change); permissions and dangerous combinations; signed curated list with rollback protection; update diff; extraction rules | L | PV-R1, owner D-1 to D-4, D-12 | large | security review |
| **PV-R6** | ADR 0009 "Integrations and the credential proxy": vault, request composition and URL pattern checks, egress rules (IP literals, proxy variables, mapped and NAT64 ranges), OAuth flow, user-only connect and the NET-1 exception, scope refusal, no inbound webhooks, D-9 | M | PV-R5, owner D-7 to D-11, D-14 | large | security review |
| **PV-R7** | ADR 0010 "Pages": storage (D-5), format (D-6), rendering rules, agent access | S | PV-R1 | small | design review |
| **PV-R8** | Threat-model revision for 4a: PLG-1 to PLG-9, INT-1 to INT-6 and gate lines. **Slice 1 (plugins) written:** `docs/security/threat-model-phase4a.md` (PLG-1 to PLG-17, 4a/L1 to L28, RR-56 to RR-74); slice 2 (integrations) after ADR 0009, in review, merges | M | PV-R5, PV-R6 | large | security review |

## 3. Phase 1c: agent home

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **PV-G1** | Journal migration: `agents` (id, project, name, kind `composer`/`cli`, launch config ref: `axis.cliAgents` entry id or connection, model and default mode; home workspace id; group id; archived; created by) and `agent_groups` (id, project, name, order); `agent_runs.agent_id`. **Built** as journal schema version 12 (`packages/journal/src/schema-agents.ts`), after the project trust binding's version 11 | M | PV-R1 | small (schema over the ADR) | review |
| **PV-G2** | Protocol `axis.agents/1` (`create`, `update`, `archive`, `list`, `get`) and `axis.agent-groups/1` (`create`, `rename`, `reorder`, `delete`, `assign`); policy rows, user-only writes; no path, command or credential in any payload. **Built as planned contracts** (`docs/design/agents-contract.md`; served by PV-G3) | M | PV-G1 | small | review |
| **PV-G3** | Daemon-host: agents service and handlers; `create` composes `axis.worktrees/1.create` under the project mutex with idempotency; archive never removes a workspace (remove stays tier 4); runs record `agent_id`; coverage check | M | PV-G2, H8 (merged) | large | review |
| **PV-G4** | Run start by agent: the shell starts CLI and composer runs from an agent (the daemon resolves the agent's workspace and launch entry; the caller still cannot supply a command) | S | PV-G3, C1 | small | review |
| **PV-D1** | Project home part in the shell: sections of `product-vision-v2.md` §3.4, empty states, keyboard order, polled then E1 | L | PV-G3, E1 | large | UI review |
| **PV-D2** | PR list (`docs/design/forge-pr-list.md`): `axis.forge/1.pullRequests { projectId, trigger }` runs the user's `gh pr list --author=@me` in the pty process from a typed `forge-list` message (closed template, allow-listed environment, generated configuration and fresh data directory per call), user-confirmed repository pin, two-stage parse with the fork filter first, display escaping, visible-or-asked refresh with an auth latch, closed states. Slice 2b: the pin in journal v13 (after v11 and v12; slice 2 keeps it in memory) | M | B9, X1; slice 2 needs PV-X1 | large | review (untrusted output of a user binary) |
| **PV-X1** | Production `ExecFn` for the pty process, POSIX and Windows, shared by H9-hooks push and `forge-list`: `pty-process/exec-node.ts` `createNodeExec(programs, platform)`, one instance per consumer, with the exact `argv[0]` allow-list (`gitPath` for git, `ghPath` for `gh`) checked in that file, `shell: false`, per-stream caps (`maxOutput`, `maxStderr`), timeout, real kill (POSIX process group tested with a pipe-holding grandchild; Windows job object, or `unsupported_platform` until then), the `git` and forge configuration in `PtyEntryDeps` and `axisPtyMain.ts` (programs resolved from main's resolved shell environment), the daemon entry's pty port, the ADR 0005 amendment and the `daemon-host.md` 2.1 rows (`forge-pr-list.md` §1, §9). Not to be confused with X1 (the daemon entry). Split (2026-11-21): **PV-X1a** (packages: the exec function, the exec contract, the pty entry's `AXIS_PTY_*` hand-over, the daemon entry's `pty-control` port; `docs/design/pty-exec-node.md`) and **PV-X1b** (main: resolve and hand over the programs, fork and supervise the pty process, one control channel to both processes, patch 0200; `pty-exec-node.md` §6) | L | B9, X1 | large | security review |
| **PV-X1w** | The pty process's exec on Windows: a kill that ends the whole tree (a job object, through the native pty binding or a small addon; `taskkill /T` is refused, being a second program by value), so `createNodeExec` can run there instead of throwing `unsupported_platform` before anything starts. Until then git exec, scratch, hooks, push and `forge-list` answer `unsupported_platform` on Windows (`pty-exec-node.md` §1, §3) | M | PV-X1a | large | security review |
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
| **PV-M0** | Taint core (`inter-agent-communication.md` §6.5, §6.6): the sticky per-run flag set before tainted content is returned, the closed source list as a typed enum, the broker decision hook (tier recorded at issue, flag re-checked at consume), precedence over any standing grant, the `message.taint` audit event and the approval-card source list; one test per source. **Built** on `feat/pv-m0-taint` (in review): the core only, with no producer, and the flag recorded in the journal (schema version 8) so a resumed run starts tainted; §6.7 of the design maps each source to the ticket that wires it (PV-M4: 1 to 3, PV-Q1: 4, PV-T1: 5 and 8, PV-K4: 6, PV-N1: 7) | M | C1, C8 | large | review |
| **PV-M1** | Protocol `axis.messages/1` (`send`, `thread`, `threads`, `read`, `markRead`, `pause`, `resume`, `settings`), strict schemas without capability fields, opaque random ids, closed refusal reasons; **policy rows for every read method** (B1). **Built as a planned contract** (`plannedContracts`, planned policy rows under the coverage check; served by PV-M3), with `updateSettings` split from the `settings` read: `docs/design/messages-contract.md` | M | PV-R3 | small | review |
| **PV-M2** | Journal: `message_threads`, `agent_messages`, deliveries, settings; retention; bounded | M | PV-M1 | small | review |
| **PV-M3** | Message service in the daemon host: send policy and **thread participant sets with participant-only reads, posting rules and `not_found` without an existence oracle** (`inter-agent-communication.md` §4), project derived from thread or recipients, excerpts with path refusals and review containment, limits, read caps, per-sender queue quotas and refuse-when-full, hop guard incl. pages and tasks (§7), secret scan (H9-scan, merged), keyed-hash audit events incl. `message.read.refused` (§8), pause and resume; transitive minter-walk test. **Slice 1 built** (with PV-M2's tables, journal schema version 9): the served contract, participant sets and reads, the send policy at accept and the delivery hook, limits, settings and Pause, audit (`messages-contract.md` section 8); **slice 2 built**: delivery into composer runs at turn boundaries, re-checked at delivery, at most once (journal schema version 10), the first taint producer (source 1, `messages-contract.md` section 9); excerpts, notices, retention and the minter walk follow | L | PV-M2, PV-G3 | large | review |
| **PV-M4** | Composer participation: `send_message` and `read_messages` broker tools, turn-boundary delivery as structured blocks with escaping, the taint sources 1 to 3 wired into PV-M0. **Built, inert until PV-G4** (`messages-contract.md` section 10): both tools, the attested sender, source 2 and the run's received hop (raised by delivery and reads), tested on a fake directory; no run is offered them until PV-G3's directory and PV-G4's run agent are wired in `compose.ts`; source 3 waits for excerpts | L | PV-M0, PV-M3, C1, C8 | large | review |
| **PV-M5** | Thread view, unread counts, mute, Pause messaging; approval cards visually distinct from messages | M | PV-M3, E1 | small | UI review |
| **PV-M6** | CLI endpoint (`inter-agent-cli-endpoint.md` §2 to §4): short user-owned runtime directory or hardened Windows pipe, peer checks, connection, framing, pre-auth and read bounds, aggregated auth-failure audit, revocation that closes open connections, per-run token and the PTY-5 amendment and test, "unverified writer" label, **daemon-side escaping of everything the endpoint returns** (`inter-agent-cli-endpoint.md` §5, gate 5) | L | PV-M3, B9, H10 (merged), PV-R3 approved | large | review |
| **PV-M7** | `axis-messages` stdio shim: two tools over the endpoint, directory or server-process checks before sending the token, the label wrapper with a per-response boundary (§5; the escaping itself is in PV-M6), packaging, setup copy; enable rules for bypass entries and repository CLI configuration (§6, M-3) | M | PV-M6 | large | review |
| **PV-M8** | 2a messaging gate evidence (`inter-agent-communication.md` §11, `inter-agent-cli-endpoint.md` §7) | M | PV-M4 to PV-M7 | large | gate review |
| **PV-T1** | Tasks journal and `axis.tasks/1` with revisions (author, hop); agent task tools (side-effecting under IAC-T, audited); Start marks non-user text and taints the run (source 5) | M | PV-G3, PV-M0 | small | review |
| **PV-T2** | Tasks UI and dashboard section; "Start" shows the full prompt and the source | M | PV-T1, PV-D1 | small | UI review |
| **PV-Q1** | Pages store, versions with author and hop, and `axis.pages/1`; agent `read_page` (taint source 4) and approved `write_page` | M | PV-R7, PV-G3, PV-M0 | small | review |
| **PV-Q2** | Isolated page view (opaque origin, no bridge port, header CSP, Trusted Types, pinned sanitizer), raster-only sniffed attachments, the pages UI; Export to repository through diff review; mXSS corpus test | M | PV-Q1 (PV-K3 later reuses this isolated view host) | large | review (renderer) |

## 5. Phase 4a: plugins and integrations

| ID | Ticket | Size | Depends on | Builder | Review |
|---|---|---|---|---|---|
| **PV-K1** | `plugin:*` principal: main mints one connection per plugin view bound to its `webContents` id; daemon identity step, policy rows, coverage check; the user connection never carries plugin calls; test: a plugin-started composer run has initiator, `createdBy` and audit actor `plugin:<id>`, is tainted with `plugin_output` before its first model call, and its tier-3 challenge shows the full prompt, project, workspace, mode, provider and model (ADR 0008 decision 6; otherwise `runs.start` is not in 4a) | L | PV-R5 | large | review |
| **PV-K2** | Plugin manifest schema, permissions, contribution points, dangerous-combination wording; install with SHA-256 pinning, publisher signature, signed curated list (embedded key, version, expiry, rotation, revocation), update diff over tier, permissions, origins, contributions and integrations; extraction rules | L | PV-K1 | large | review |
| **PV-K3** | P1 host: sandboxed `WebContentsView` per plugin, own session partition, deny-all permission handlers, navigation and window-open denied, WebRTC removed, header CSP from the protocol handler | L | PV-K1, PV-K2 | large | review |
| **PV-K4** | Contribution points: page, dashboard section, side-panel tab, task provider, message participant; wires plugin output into PV-M0 as taint source 6 | M | PV-K3, PV-D1, PV-V2, PV-T1, PV-M3, PV-M0 | small | UI review |
| **PV-K5** | Plugin contract tests (the existing Phase 4 gate item) | M | PV-K4 | small | gate review |
| **PV-N1** | Split into slices in §5.1. Credential proxy `axis.integrations/1` in the daemon: vault-held credentials, fixed method and path templates with typed encoded segments and a final URL pattern check, origin allowlist, IP literals refused, proxy variables ignored, redirect refusal, address checks incl. mapped and NAT64, caps, scope refusal, closed errors; wires integration data into PV-M0 as taint source 7; per ADR 0009: the daemon entry refuses `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_USE_ENV_PROXY`, `integration:<id>` vault entries with each purpose bound to its entry kind, and the integrations binding as the second allowed `@axis/vault` importer | L | PV-R6, C6 (vault wiring), PV-M0 | large | review |
| **PV-N2** | Split into slices in §5.1. OAuth, device-code flow only (ADR 0009 decision 6: the one-shot loopback is deferred to its own decision, so a service without a device flow does not ship in 4a) | M | PV-N1 | large | review |
| **PV-N3** | D-9 as taken (ADR 0009 decision 9) allows a read-only token from 4a, so this is built in 4a. Originally: only if the owner reverses D-9: first token-based integration (GitHub, read-only, behind the credential proxy). If D-9 stays, the first integration is the `gh`-based PR list (PV-D2) and PV-N3 is dropped; PV-N4 then evidences PV-N1 and PV-N2 with a test service | M | PV-N1, PV-N2 | small | review |
| **PV-N4** | 4a gate evidence (`extensibility.md` §9) | M | PV-K5, PV-N3 | large | gate review |

### 5.1 PV-N1 and PV-N2 in slices (ADR 0009)

One reviewable PR each, in this order unless a row says otherwise. Each slice names the ADR 0009 validation criterion (C1 to C10) it must prove; "review" is the independent security review before any PR, with mutation testing of the refusal paths.

| ID | Slice | Size | Depends on | Builder | Proves | Review |
|---|---|---|---|---|---|---|
| **PV-N0** | Main's secret broker over the privileged port (ADR 0003 D1.6): `secrets.decrypt` with `safeStorage`, a `SecretBackend` the daemon entry passes to the composition, PRV-1 backend report. Prerequisite for any production credential (the Anthropic key included) | M | PV-X1b | large | the vault reads a stored secret in a built app; nothing reaches a renderer | review |
| **PV-N1a** | Protocol: `axis.integrations/1` (`list`, `status`, `connect`, `disconnect`, `request`) and `axis.net/1.request` as planned contracts; strict schemas with no URL, header, cookie or credential field at any depth; closed refusal reasons; planned rows (`connect`, `disconnect` user-only) under the coverage check | S | ADR 0009 merged | small | schema walk test (no credential field); coverage | review |
| **PV-N1b** | Daemon entry: refuse `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_USE_ENV_PROXY` at start, like `NODE_OPTIONS` | S | none | small | C3 (start refusal half) | review; built on `fix/daemon-entry-refuse-tls-proxy-env`, in review |
| **PV-N1c** | Vault: `integration:<id>` entries, the three integration purposes, each purpose bound to its entry kind (mismatch refused and audited); the integrations binding as the second allowed `@axis/vault` importer (import test, stage scan, the providers note) | S | PV-N1a | small | C10 | review |
| **PV-N1d** | Egress client: `node:https` with a dedicated agent and a checking `lookup` (first item: the pinning test with `autoSelectFamily` at Node 24.22.1; if it fails, stop and report), WHATWG host parse, IP literals and trailing dots refused, the range lists and embedded-IPv4 rule, `rejectUnauthorized: true`, no proxy, `3xx` closed error, identity encoding only, caps, integer `Retry-After` | L | PV-N1b | large | C2, C3 (routing half), C5 | review |
| **PV-N1e** | Request composition: operation templates, typed encoded segments, the refusals before encoding, the final URL pattern check before the credential; `axis.net/1` method set and path refusals | M | PV-N1a | large | C4 | review |
| **PV-N1f** | The credential proxy service: connector registry (built-in only until PV-K), `request` handler with the two audit rows, redactor registration and echo refusal, scope recording and refusal, disconnect (vault entry, memory token, in-flight cancel), served rows, taint source 7 producer | L | PV-N1c, PV-N1d, PV-N1e, PV-M0; PV-N0 for production | large | C1, C6 (scope and permission half), C8, C9 (disconnect half) | review |
| **PV-N2a** | Device-code flow in the daemon: start, poll with `interval` and `slow_down` (cap 60 s), `expires_in` cap 15 min, verification host within declared origins, token-endpoint redaction first and fixed error text, refresh rotation stored before the old token is dropped ("needs reconnect" on failure) | M | PV-N1f | large | C6 (flow half), C9 (rotation half), C7 | review |
| **PV-N2b** | Main: the native code dialog (code and verification host, built by main) and the system-browser open under EL-5; `connect` user-only end to end | M | PV-N2a, PV-X1b | large | C6 (dialog), C7 | review |

PV-N3 then builds the GitHub read-only connector on PV-N1f and PV-N2b; PV-N4 collects C1 to C10 with the design's §9 lines. A service without a device flow is out of 4a (ADR 0009 decision 6).

## 6. Dependency order and critical path

- **Before any of this:** the Phase 0 gate (IDE view criterion 1, ADR 0004 validation), Phase 1a gate and Phase 1b gate. v2 tickets do not replace or jump them.
- **Docs wave (can start now):** PV-R1, then PV-R2, PV-R3 and PV-R7 in parallel; PV-R4 after PV-R3; PV-R5 and PV-R6 can wait for 4a planning.
- **1c wave 1:** PV-G1 → PV-G2 → PV-G3; PV-V0 in parallel with PV-G1 (no dependency on daemon work).
- **1c wave 2:** PV-G4, PV-D3, PV-D4 (small), PV-X1 (production pty exec, as X1a packages, X1b main and overlay, X1w Windows after X1a; H9-hooks S4 push in production needs X1a and X1b), PV-D2 (after B9 and X1; its slice 2 after PV-X1), PV-V1 and PV-D1 (after E1), PV-V2 (after PV-V0, A5); then PV-V3, then PV-V4.
- **2a:** PV-M0 first (PV-M4, PV-T1 and PV-Q1 depend on it); PV-M1 → PV-M2 → PV-M3, then PV-M4 and PV-M5 in parallel, then PV-M6 → PV-M7, PV-M8 last; PV-T1, PV-T2, PV-Q1, PV-Q2 in parallel with messaging (only PV-T2 and PV-K4 cross over).
- **4a:** PV-K1 → PV-K2 → PV-K3 → PV-K4 → PV-K5; PV-N0 and PV-N1a to PV-N1f (§5.1) → PV-N2a → PV-N2b → PV-N3; PV-N4 last.
- **Critical path to 1c:** E1 (merged, `116ef22`) and B9, J2 for usage, A5 (unbuilt shell Changes view, needed by PV-V2), then PV-G1 to PV-G3, PV-V0, PV-V2, PV-D1, PV-V4. **Critical path to 4a integrations:** C6 (vault wiring, behind C1 to C5 and C8) before PV-N1. The side-panel editor (PV-V0, PV-V2) carries the most uncertainty.

Shared-file note: PV-G3, PV-M3, PV-T1 and PV-Q1 each add a contract, policy rows and a registry line; the registry file and the policy table are the shared files (one line per ticket), and the coverage check catches an omission (the daemon-host plan's merge-conflict note applies).

## 7. Effort summary (rough, uncertain)

| Block | Tickets | Large | Small | Comment |
|---|---|---|---|---|
| Docs | PV-R1–PV-R8 | 6 | 2 | PV-R3, PV-R5, PV-R6 decide most of the security shape |
| 1c | PV-G1–PV-G4, PV-D1–PV-D4, PV-V0–PV-V4 | 7 | 6 | PV-V0 can change PV-V2's size by a lot |
| 2a | PV-M0–PV-M8, PV-T1, PV-T2, PV-Q1, PV-Q2 | 8 | 5 | PV-M6 and PV-M7 depend on the PTY-5 amendment being accepted |
| 4a | PV-K1–PV-K5, PV-N1–PV-N4 | 6 | 3 | plugins with code wait for the Phase 3 sandbox |

These counts are not a schedule. Each "Review" ticket has historically taken several review rounds before merge (trust-boundary packages so far needed between two and twelve review rounds); plan for that.

## 8. ADRs to write (updated list)

| ADR | Title | Changes | Ticket |
|---|---|---|---|
| 0006 | Agent home information architecture | amends ADR 0004 (landing surface, row unit, terminology) | PV-R1 |
| 0007 | Inter-agent messaging | amends ADR 0004 implication 3 (PTY-5: two admitted variables for messaging runs); notes a new local listener next to NET-1, in the pty process (keeps ADR 0003 D1.1 and DMN-4) | PV-R3 |
| 0008 | Axis plugins | amends ADR 0003 (new `plugin` principal kind and its attestation) | PV-R5 |
| 0009 | Integrations and the credential proxy | revisits ADR 0004 decision 9's "no forge credentials" (D-9); records the OAuth NET-1 exception | PV-R6 |
| 0010 | Pages | new | PV-R7 |
| (design section, not an ADR) | Side-panel editor embedding, in `axis-agent-shell.md` | after PV-V0 | PV-V0 |
| (existing, still to write) | Hooks placement (`composer-runtime.md` C12, ROADMAP 1b "Hooks placement") | unchanged by v2 | C12 |
