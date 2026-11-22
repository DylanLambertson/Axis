# Threat model: Phase 2a revision (messaging, pages, tasks) and the 1c surfaces it rests on

- **Status:** Draft for review (ticket PV-R4). It extends the Phase 1 model; it replaces none of it.
- **Date:** 2026-11-22. **Code baseline:** `origin/main` at `0addd58` (ADR 0007 merged, #573; S1a, journal schema v11; PV-G1, schema v12).
- **Builds on:** `threat-model-phase1.md` (the "model"), `threat-model-phase1-controls.md` (the "controls file"), `threat-model-phase1-revision-1a.md` (the "1a revision", merged; N-1 to N-15, TB12, TB13) and `threat-model-phase1-residual-register.md` (the "register"). Where this file and those disagree about a Phase 2a or 1c surface, this file wins; for everything else they win.
- **Sources:** ADR 0006 (agent home), ADR 0007 (messaging, the CLI endpoint) and its code map, ADR 0010 (pages), `docs/design/inter-agent-communication.md` (the "messaging design"), `docs/design/inter-agent-cli-endpoint.md` (the "endpoint design"), `docs/design/messages-contract.md`, `docs/design/extensibility.md` §5, §6, §8, §9, `docs/design/project-registration-and-trust.md` (the "trust design"), `docs/design/owner-decisions-2026-11-21.md`.
- **Companions:** `threat-model-phase2a-gates.md` (every 2a gate line, numbered, with the ticket that must prove it and the threats it covers); the register §1.3 (RR-31 to RR-55, one row per stated residual).
- **Evidence tags:** as in the 1a revision. **[M]** built and merged on main (file and symbol named, or the ADR 0007 code map row); **[D]** decided in an ADR or design, nothing built; **[I]** inferred. **Built** means code exists, not that a gate line passes.
- **Decisions.** This file makes none of its own. Six threats needed one; the project lead decided them, and section 6 records them.

## 1. What 1c and 2a add

1c (ADR 0006) turns agents and groups into stored records; 2a lets agents, plugins and the user exchange messages and adds pages and tasks. Before 2a, everything a composer model read was either the user's prompt, its own worktree or tool output it asked for. From 2a on, **text written by another model, a CLI, a repository script holding an endpoint token, an imported issue or a plugin reaches a model as ordinary input.** The one control for that class is the taint rule IAC-T (ADR 0007 decision 4); every other control in this file bounds, labels, attributes or escapes.

Messaging is the only part with code on main: the contract, the message service for the user's own connection, delivery into composer runs and the taint core [M, ADR 0007 "What exists on main"]. Agents and groups, the composer tools, the endpoint, pages and tasks are [D].

## 2. Actors

| Actor | Introduced by | Trust | Notes |
|---|---|---|---|
| Agent (composer or CLI) as a principal | ADR 0006 §4; ADR 0007 decision 1 | Untrusted content source; identity is the daemon's record | Created, grouped and archived by the user only (ADR 0006 implication 3), so no agent mints a principal or widens its own scope. Addressed by opaque id (`message_participants.principal`) [M] |
| Agent group | ADR 0006 §6 | Not a security boundary | Read by the send policy, so membership is a user-only write. An agent in no group shares a group with nobody [M, `messages/policy.ts` `mayAddress`] |
| CLI endpoint caller | ADR 0007 §7.5 | **Unverified** (`verified: false`) | Anyone holding the run's token: the CLI, **and every program it runs, including the repository's scripts** |
| Plugin (`plugin:<id>`) | `extensibility.md` §3.5 | Untrusted | 4a; no plugin caller exists. **Refused by the send and read policy in 2a** (section 6, O-6); the 4a policy is PV-R8's |
| System sender | messaging design §4.1 | Axis | Notices to the user only (delivery failures today [M]; hop and queue notices [D]) |
| Page author, task author | ADR 0010 §1; `extensibility.md` §6 | User or agent per revision | Every non-user revision is a taint source and carries the writer's hop |
| Imported task source | `extensibility.md` §6 | Untrusted | `source: integration`; 4a for the integration, 2a for the rule |

The user, the renderer (A10), main, the daemon and the pty process are as in the model; this revision changes what the pty process holds (section 4, TB15).

## 3. Assets

| Asset | Where | Why it matters |
|---|---|---|
| Message bodies, refs, threads, participant sets, read cursors | journal schema 9 [M] | Confidentiality between groups (IAC-13); integrity of who said what (IAC-6) |
| Deliveries and quarantine | journal schema 10 [M] | At-most-once delivery and the taint that goes with it |
| Messaging settings and Pause state | journal schema 9 [M] | Widen or stop messaging; user-only writes |
| The taint flag `composer_runs.tainted` | journal schema 8 [M] | Clearing it would remove the only injection control |
| Endpoint tokens (256 bits per run) | daemon memory; the spawn message; the pty process; the CLI's environment [D] | Bearer identity of a CLI agent for `send` and `read` |
| The per-install HMAC key for `bodyMac` | a `0600` file in the Axis data directory, never the journal (section 6, O-1) [D] | Keyed hashes in audit; until it exists no body hash is written [M] |
| Pages, versions, attachments, "reviewed" marks | Axis data directory per project [D, ADR 0010] | Agent-readable text that can steer runs; the reviewed mark lowers taint |
| Task records and revisions | journal [D, PV-T1] | Start turns task text into a run's prompt |
| Agent and group records | journal schema v12 [M, `packages/journal/src/schema-agents.ts`]; no service or handler yet [D, PV-G2, PV-G3] | The send policy reads them |
| The run-trust record | journal schema v11 and `setProjectTrust` [M, `packages/journal/src/schema-v11.ts`, `records.ts`]; the gate is not built [D, S1b] | Gates every run, so every endpoint |

## 4. Trust boundaries added

TB1 to TB13 stand (model §2, 1a revision §1).

| ID | Boundary | Control |
|---|---|---|
| TB14 | **A CLI process tree to the endpoint listener** (a Unix socket in a `0700` directory, or a named pipe with a user-only DACL), authenticated by the run's token | ADR 0007 §7.2 to §7.5; endpoint design §3 [D] |
| TB15 | **The pty process to the daemon, over a new relay message** on the existing pty control channel. The daemon does not trust the relay's state: it checks the token, maps the endpoint id it minted to the run's binding, tracks authentication per relay connection id and bounds relays in flight at 4 | ADR 0007 §7.1 [D] |
| TB16 | **Untrusted text to a composer model**: delivered messages, `read_messages`, excerpts, pages, task text, plugin output, integration data | IAC-T over the closed source list; framed, escaped delivery blocks [M for messages, D for the rest] |
| TB17 | **Page content to the isolated page view** (opaque origin, no bridge port, header CSP, Trusted Types), and from it to the host renderer only as a link hand-off | ADR 0010 §3 [D] |
| TB18 | **Main's native trust dialog to the run-trust record**: the only writer of `trusted` | The daemon side is built: `projects.inspect`, `projects.register` and `projects.trust` over main's control channel, and the record refuses a grant not made `via` the dialog [M, `daemon-host/src/projects/control.ts`, `journal/src/records.ts` `setProjectTrust`]; main's dialog (S2) and the gate (S1b) [D] |

**What moves.** The pty process held no Axis secret (model, TB9). With ADR 0007 it **receives every live endpoint token** and hosts the endpoint listeners. The daemon still opens no listener (ADR 0003 D1.1, DMN-4 unchanged). NET-1 ("no loopback listener") stays true for TCP; the endpoint is a second local, non-TCP listener next to the opt-in web host entry, which is also outside the daemon.

## 5. Threats and controls

State words as in the 1a revision: **Built**, **Partial**, **Not built**. Gate line numbers are `threat-model-phase2a-gates.md`'s.

### 5.1 Messaging (IAC-1 to IAC-16, messaging design §9)

| ID | Threat | Control | State | Tickets | Gates |
|---|---|---|---|---|---|
| IAC-1 | Confused deputy: a composer that read a hostile file asks a CLI agent, which holds the user's credentials, to act | CLI messaging off by default, pull-only, refused for bypass entries, warned and confirmed twice for repository CLI config (M-3); provenance label; the CLI's prompts stay the gate | **Partial:** `cliMessaging: true` is refused for every agent (`bypass_entry`) [M, `messages/settings.ts`]; the in-repository list with unknown entries refused (O-3) and the rest [D] | PV-M7 | 2a/L28, L35, L52 |
| IAC-2 | Prompt-injection relay steers a composer into a harmful call (files and git a tainted run or a CLI wrote are not sources: RR-55) | IAC-T: sticky flag, every call above `read` needs the user, flag bound at issue and re-read at consume, card lists the sources | **Partial:** the core and source 1 [M, `composer/taint.ts`, `broker/src/policy.ts` `DecisionHook`, `gate/run-approvals.ts`, `messages/delivery.ts`]; sources 2 to 8 [D] | PV-M0 (built), PV-M4, PV-Q1, PV-T1 | 2a/L3, L11, L18, L19, L54 |
| IAC-3 | Approval laundering: A asks B to request an action the user then approves as B's own plan | The card lists the run's taint sources and their hop; DMN-3 unchanged | **Partial:** card schema and sources [M, `approvalPreviewSchema.taint`]; the UI and the approval cap of 20 per tainted run (O-5) [D] | PV-M0, PV-M4, PV-M5 | 2a/L2, L3, L54 |
| IAC-4 | UI spoofing: a body that looks like an approval, a notice or the user | Approval cards render only from `axis.approvals/1.pending`; escaped plain text; delivery blocks framed by a per-block nonce with every body line prefixed; sender badge from the daemon | **Partial:** escaping and the delivery frame [M, `messages-wire.ts` `toMessageText`, `messages/delivery.ts`]; thread view [D] | PV-M5 | 2a/L8, L32 |
| IAC-5 | Message storms and cost loops | Hop limit 8 through messages, pages, tasks and CLI reads; rates; per-sender quotas; budgets; no wake (M-4) | **Partial:** rates, quotas and the reply-chain hop [M, `messages/limits.ts`, `messages/policy.ts` `hopOf`]; raising a run's received hop from what it reads (composer and CLI), hop on pages and tasks, the hop notice [D] | PV-M4, PV-M6, PV-Q1, PV-T1, PV-M3 later | 2a/L4, L33 |
| IAC-6 | Impersonation of a sender | Sender from the attested caller, never the payload; CLI senders token-bound and `verified: false` | **Partial:** attested caller, user-only bridge [M, `handlers/messages.ts`, `messages/policy.ts` `MessageCaller`]; endpoint [D] | PV-M6 | 2a/L29, L36 |
| IAC-7 | Exfiltration through messages | Excerpt path refusals, secret scan (refuse for CLI and plugin recipients, M-6), size caps, audit | **Partial:** body scan and caps [M, `messages/service.ts` `accept`]; every excerpt refused until the excerpt slice [M]; excerpt containment, path list and the keyed-hash key file (O-1) [D] | PV-M3 later | 2a/L5, L17, L50 |
| IAC-8 | Cross-project or cross-group leakage on send | Project from the thread or the attested sender, never renderer state; groups expanded at accept; delivery re-checks | **Built** in the service, tested with attested agent callers [M, `newThreadProject`, `expandRecipients`, `deliverable`]; no agent can reach it until PV-G3 and PV-M4 | PV-G3, PV-G4 | 2a/L1, L9, L14 |
| IAC-9 | Daemon memory and journal growth | Bounded queues, counters, replies; `E_BACKPRESSURE`; retention | **Partial:** bounds [M]; retention purge and the archive clean-up (O-2) [D] | PV-M3 later, PV-G3 | 2a/L15, L16, L51 |
| IAC-10 | Endpoint abuse by another local process | `0700` directory or user-only pipe, token, shim checks before sending it | **Not built** | PV-M6, PV-M7 | 2a/L26, L27 |
| IAC-11 | Excerpt path tricks | Review-path containment, sender's own worktree, path refusal list with case and alias forms | **Not built** (every excerpt refused [M]) | PV-M3 later | 2a/L5 |
| IAC-12 | Kill-switch race | Pause re-checked at delivery, queued messages stay queued | **Partial:** sends and delivery [M, `senderPaused`, `recipientPaused`, `deliverable`]; endpoint [D] | PV-M5, PV-M6 | 2a/L7, L21 |
| IAC-13 | Read without authorization | Participant sets, one participant-scoped lookup, `not_found` with no existence oracle, read rows, `message.read.refused` | **Built** [M, `messages/service.ts` `resolve`, `message-store.ts` `VISIBLE`] | PV-M6 (endpoint reads) | 2a/L10 |
| IAC-14 | Terminal escapes through the CLI read path | Daemon-side `toMessageText` on every endpoint answer; label with a per-response boundary and a prefix on every line ending at LF | **Partial:** the escaping function [M]; its use on the endpoint and the shim [D] | PV-M6, PV-M7 | 2a/L24, L32 |
| IAC-15 | Endpoint DoS and audit flooding | Connection, framing, pre-auth, read and size bounds; per-peer backoff in the pty process; one auth per relay connection id; aggregated audit | **Not built** | PV-M6 | 2a/L22, L23 |
| IAC-16 | Queue eviction erases the user's words | Per-sender quotas, refuse when full, user and system messages never counted or evicted | **Built** [M, `messages/service.ts` `accept`, `message-store.ts` `queued`]; the user notice and releasing an archived agent's queue (O-2) [D] | PV-M3 later, PV-G3 | 2a/L12, L51 |

### 5.2 The CLI endpoint as built by ADR 0007 (new rows)

| ID | Threat | Control | State | Tickets | Gates |
|---|---|---|---|---|---|
| IAC-17 | **Forged or stale relay frames.** A frame on an unauthenticated or closed relay connection id, for a stopped run or a revoked token, from another channel, with an endpoint id the daemon did not mint, or a flood of relays | The daemon accepts relays only from the supervised pty control channel, maps its own endpoint ids to bindings, tracks auth per relay connection id, refuses a second auth after a failure, bounds relays in flight at 4 | **Not built** [D, ADR 0007 §7.1] | PV-M6 | 2a/L37 |
| IAC-18 | **The pty process holds every endpoint token.** A compromised pty process sends and reads as any messaging-enabled CLI agent of any project, within each binding and send policy, including messages the CLI never pulled | Accepted residual: `verified: false`, taint for composer recipients, `send` and `read` only, no approval or grant (DMN-3) | Accepted [D] | none | 2a/L29 |
| IAC-19 | **The two messaging variables leak into a run that should not have them, or arrive by the spawn's environment** | PTY-5 unchanged in the daemon and the pty process; the pty process adds exactly two exact-case names only for a `messagesEndpoint` request | **Not built**; today every `AXIS_*` name is refused at spawn [M, `pty-process/src/service.ts` `handleSpawn`] | PV-M6 | 2a/L20, L38 |
| IAC-20 | **An endpoint for an untrusted project, or outliving trust** | A CLI run starts only through the trust gate; untrust or `binding_lost` stops the project's runs, which removes their endpoints and revokes the tokens | **Not built** [D, ADR 0007 §7.1, trust design §5.4] | S1b of the trust design, PV-M6 | 2a/L40 |

### 5.3 Pages and tasks (`extensibility.md` §8; ADR 0010)

| ID | Threat | Control | State | Tickets | Gates |
|---|---|---|---|---|---|
| PAG-1 | Script or tracking in a page | CommonMark subset, no raw HTML, sanitizer, raster attachments only by sniffing, EL-5 links opened from main on a click | **Not built** [D, ADR 0010 §2, §3] | PV-Q2 | 2a/L41, L43 |
| PAG-2 | Page content steers an agent | `read_page` taints when current content holds non-user text not marked reviewed; `write_page` needs approval, is attributed and carries the hop | **Partial:** `page` is source 4 of `TAINT_SOURCES` [M]; the producer and the main-drawn confirmation for marking reviewed (O-4) [D] | PV-Q1, PV-Q2 | 2a/L11, L45, L46, L53 |
| PAG-3 | Page script reaches the bridge and resolves an approval as the user | Isolated view with an opaque origin and **no bridge port**, header CSP, Trusted Types, own session, WebRTC off, no SVG | **Not built** [D, ADR 0010 §3] | PV-Q2 | 2a/L42, L43 |
| TSK-1 | Imported issue text becomes an instruction | Start is a user action showing the full prompt and source; the run is tainted (source 5) | **Not built** [D]; the 4a import part is PV-N | PV-T1, PV-T2 | 2a/L44 |
| TSK-2 | An agent rewrites a task so the user's Start launders injected text | Revisions with author and hop; Start marks non-user text; source 5 at start and source 8 on reads | **Not built** [D] | PV-T1, PV-T2 | 2a/L11, L44 |

### 5.4 The agent home and project trust (1c rows that 2a depends on)

| ID | Threat | Control | State | Tickets | Gates |
|---|---|---|---|---|---|
| HOME-1 | A non-user actor creates an agent, joins a group or widens `acceptsFrom`, minting a principal or a messaging scope | Agent, group and assignment writes are user-only and audited; messaging settings are user tier-2 writes held by the daemon, never repository settings | **Partial:** messaging settings [M, `messages/settings.ts`]; schema-level controls [M, `journal/src/schema-agents.ts`]: `created_by` is always `user`, id, project, kind and home are fixed at insert, rows are inserted once and never deleted, composite foreign keys keep an agent, its home and its group in one project, and a home that is no longer live archives its agents. Not built: the agents service and handlers that make writes user-only on the wire, their audit, and archive ending an agent's messaging (O-2) [D, PV-G2, PV-G3] | PV-G2, PV-G3 | 1c gate lines 2 and 3 (`ROADMAP.md`); 2a/L1, L51 |
| HOME-2 | Agent and group names, or run reasons carrying agent text, spoof UI | Escaped display with control and bidirectional characters visible (ADR 0006 implication 5) | **Not built** [D] | PV-D1 | `ROADMAP.md` 1c lines |
| HOME-3 | Delivery to a run of another project or of no agent | Delivery only to a RUNNING run bound to an agent; PV-G4 must check that the run's project is the agent's | **Partial:** no run is bound in production, so nothing is delivered [M, `messages/binding.ts` `agentOf`]; the project check [D] | PV-G4 | 2a/L14 |
| TRU-2 (amended) | Stale or widened trust | "Trusted" is T1 to T4 of the trust design §2: the main-owned record **and** Workspace Trust, the binding, no revoke; a renderer-written model alone never yields trusted; untrust and `binding_lost` stop live runs | **Partial:** S1a is built: the binding (`common_dir`, `git_dir_id`, set once), every pre-v11 row reset to untrusted, `setProjectTrust` granting only `via` the dialog, and main's control messages [M, `journal/src/schema-v11.ts`, `records.ts`, `daemon-host/src/projects/`]. Not built: the gate `requireProjectTrust` with its ticket at the side effect and stopping runs on a revoke (S1b), main's dialog (S2) [D] | trust design S1b, S2 | `ROADMAP.md` 1c line 1; trust design §9 |

## 6. Decided items (were open items O-1 to O-6)

These six threats needed a decision no document had taken. The project lead decided them on 2026-11-22 under the owner's delegation (`owner-decisions-2026-11-21.md`); each is conservative and reversible by a new row there. The ids are this file's own (not the product-vision O-1 to O-8) and stay stable. Nothing here is built; each decision is a ticket item and has a gate line.

| # | Decided | Reflected in |
|---|---|---|
| O-1 | **The `bodyMac` key.** 32 random bytes per install, generated by the daemon at first need, stored in a **file** in the Axis data directory (directory `0700`, file `0600`, created with `O_EXCL` and written atomically: temporary file, fsync, rename). **Never in the journal**, never exported or backed up with a journal export. Read once at start and kept in memory; no OS keyring prompt. Losing the file only makes **old** keyed hashes incomparable: the audit keeps the hashes it stored. A same-UID process can read the file (A10). | IAC-7; gate 2a/L50; RR-42, RR-53; ticket item for PV-M2 or PV-M3 |
| O-2 | **Archiving an agent** (1) cancels every pending or queued delivery to it, marked undeliverable, releasing its senders' quota slots; (2) makes it unaddressable: a send naming it is `recipient_refused` (live agents only); (3) revokes its endpoint and stops its live runs; (4) keeps its threads **readable by the user** and closed to agents; (5) keeps its messaging settings for a restore. | IAC-9, IAC-16, HOME-1; gate 2a/L51; RR-46; PV-G3 with PV-M3 |
| O-3 | **The CLI bypass-flag list** lives in this repository, as one file in the pty-process or daemon-host adapter code with unit tests, changed only by a reviewed pull request (every CLI adapter change is a security-review item). An **unknown CLI entry is treated as bypassing** (messaging refused unless the entry is known safe: fail closed). No remote list. | IAC-1; gate 2a/L52; RR-35; PV-M7 |
| O-4 | **Marking a page version reviewed** (which lowers taint) needs a **native confirmation drawn by main**, as trusting a project does; a renderer-only click is not enough (A10). | PAG-2; gate 2a/L53; RR-48; PV-Q1, PV-Q2 |
| O-5 | **Approval cap under IAC-T.** The cap is a daemon constant of 20: the **21st approval request (approved or denied) of any side-effecting call in one tainted run ends the run** with a closed reason instead of asking; a setting can lower the cap, never raise it. The count is stored with the run record in the journal and survives a resume and a daemon restart (a restart does not give 20 more); no journal field exists yet, so adding it is a requirement on the ticket that builds the cap. The user may start a fresh run. Fatigue below the cap stays a residual. | IAC-2, IAC-3; gate 2a/L54; RR-36; PV-M4 (or PV-M0 follow-up) |
| O-6 | **No plugin principal in 2a.** Plugins arrive in 4a, so a caller of kind `plugin` is **refused** by the send and read policy in 2a, addressing nobody, the user included, until PV-R8 and the PV-K tickets. Today `mayAddress` lets a plugin caller address the user (unreachable: no plugin binding exists); that gap is closed by this item. | Actor row "Plugin"; gate 2a/L55; RR-54; PV-M3 follow-up |

## 7. What this revision does not change

- R22 (an unbrokered CLI with the user's credentials) is still the main residual. Messaging gives a CLI a new input, not a new privilege; IAC-1 states the exposure for a CLI set to auto-approve.
- The original risk scores stand. IAC-T reduces the impact of injected text on composers; it detects nothing and prevents nothing a CLI does.
- The phase tags of the controls file §8 stand; this file adds the 2a rows above.
