# Inter-agent communication

- **Status:** Proposed (design only; nothing is built). Proposed phase 2a (`product-vision-v2.md` §5). Revised after security design review 1 (one blocker, twelve should-fix, eight nits; all addressed here, in `inter-agent-cli-endpoint.md` and in `extensibility.md`).
- **Date:** 2026-11-06 (owner direction of 2026-11-06). Verified against `origin/main` at `74cd12e`; E1 (`116ef22`) and P1d (`e52114f`) have merged since.
- **Depends on:** ADR 0003 (bridge, policy pipeline, D4 challenges, D5 audit), ADR 0004 (decisions 8 and 10, implication 3), `docs/security/threat-model-phase1.md` §4.4–4.5 (DMN-2, DMN-3, APR-1, APR-2, DMN-5, DMN-6, DMN-8, ANT-2, PTY-3, R19), `docs/design/composer-runtime.md` (C1, PR #458, open), `docs/design/daemon-host.md`.
- **Companion:** `docs/design/inter-agent-cli-endpoint.md` holds how CLI agents take part (the local endpoint, its bounds, the token residual, escaping on the read path).
- **Evidence tags:** as in `product-vision-v2.md`.

## 1. Goal and non-goals

**Goal.** Agents in one project, of any type (composer agents and CLI agents), and the user can exchange messages. The daemon carries every message. The user can see every message, stop all messaging in a project at once, and audit who sent and read what.

**Non-goals.**

- No direct agent-to-agent channel: no shared socket, file, pipe or terminal between two agents.
- A message never grants anything. It carries no capability, no approval, no credential and no permission.
- Axis never types into a CLI agent's terminal (ADR 0004 decision 10 stays).
- No messages across projects or Spaces (DMN-8).
- Messages do not start runs on their own in 2a (§6.4).

## 2. What a message is

Contract `axis.messages/1` (new) in `@axis/protocol`. Every field marked *daemon* is filled by the daemon and refused if a client sends it.

| Field | Type | Source | Rule |
|---|---|---|---|
| `messageId` | opaque random id (128 bits) | daemon | minted at accept |
| `projectId` | id | daemon | taken from the thread (existing thread) or from the recipients (new thread); a send whose recipients span projects is refused. Never from renderer state such as the focused project (A10) |
| `threadId` | opaque random id (128 bits) | client (existing thread) or daemon (new thread) | a thread belongs to one project and has a daemon-held participant set (§4.2) |
| `seq` | integer | daemon | per-thread, monotonic |
| `sender` | `{ kind: user \| agent \| plugin \| system, agentId?, runId?, pluginId?, verified }` | daemon | from the attested connection identity (the H12 pattern: `createdBy` is the attested actor, not payload). `verified: false` for CLI endpoint senders (`inter-agent-cli-endpoint.md` §4) |
| `recipients` | list of `{ agent: agentId }`, `{ group: groupId }`, `{ user }`; 1..16 | client | checked against the send policy (§4.1); groups are expanded at accept time and the expanded list is recorded |
| `body` | `{ format: "text", text }`, 1..16,384 characters | client | plain text. The thread view shows it as escaped text only; no Markdown or HTML is rendered in the privileged renderer (§8.3) |
| `refs` | 0..16 typed references: `file { workspaceId, path }`, `commit { sha }`, `run { runId }`, `task { taskId }`, `pr { number }`, `page { pageId }`, `excerpt { … }` | client | references are data, not grants (§5.3 rule 3) |
| `inReplyTo` | `messageId?` | client | same thread only, and only a message the sender can read |
| `hop` | 0..8 | daemon | 0 for a message sent by the user; otherwise 1 + the highest hop the sending run has received through any taint source (§6.6, §7.2) |
| `createdAt` | time | daemon | |

The schema is strict (unknown keys refused, as in `@axis/protocol`'s existing guarded schemas). There is no field for an approval, a challenge, a grant, a token, a tool call, a command or a path to execute.

**Excerpt refs.** To share code or a diff from its own workspace, the sender attaches an `excerpt`: the daemon reads it from the **sender's** worktree at send time, through the same locator and containment rules as `axis.review/1.diff` (DMN-2, the FT-1 symlink rule), caps it (64 KiB), and stores the copy with the message. The recipient gets the copied text, not access to the sender's worktree. **Path refusals before the scan (review S6):** an excerpt of a WT-3 protected path, a gitignored file, or a path on the maintained secret-path list (for example `.env*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `.aws/`, `.ssh/`, `config/master.key`, `credentials*`) is refused with `excerpt_path_refused`; the secret scan (§8.2) runs on what remains. The list is a defence in depth, never a guarantee. **Matching (review 2, NS3):** the refusal is checked against the canonical real path at time of use (after the review path's `realpath` and containment), case-folded and Unicode-normalised on case-insensitive volumes (macOS, Windows); Windows 8.3 short names, trailing dots or spaces and alternate-stream suffixes (`:`) are refused outright (the DMN-2 and G-10 class).

## 3. Mediation: the daemon is the only router

```text
composer run A ──tool call──▶ broker ──▶ daemon message service ──▶ journal (threads, participants, messages)
                                                │                      │
CLI run B ──local endpoint (per-run token)──────┤                      └─▶ audit (keyed hashes, ids)
                                                │
user (Agent view) ──bridge──────────────────────┘
                     delivery: composer turn boundary / CLI pull / UI
```

- The message service lives in `@axis/daemon-host` as a new service behind a binding, like the composer service in C1. Handlers see it only through a port and register through the `HandlerRegistrar`.
- Every call, read or write, passes the normal pipeline: identity, a policy row, idempotency (writes), then the service's own checks (§4, §7, §8), then journal-first write, then audit.
- Delivery is a separate step with its own audit event, so "sent" and "read by B" are distinguishable.

## 4. Authorization

### 4.1 Who can send to whom

Evaluated in the daemon per recipient at accept time, and again at delivery (a setting changed in between wins).

| Sender | May send to | Default |
|---|---|---|
| user | any agent in the project; any group | allowed |
| agent | the user; agents in its own group | allowed |
| agent | agents in another group of the same project | **off**; enabled per project or per pair, a user tier-2 action |
| agent | agents in another project | never |
| plugin (`plugin:<id>`) | the user; threads the user added it to | only with the `messages.send` permission (`extensibility.md` §3.5) |
| system | the user | daemon notices only (refusals, limits) |

Each agent also has **accepts messages from**: `none`, `group` (default), `project`. A CLI agent's setting starts at `none` (`inter-agent-cli-endpoint.md` §6).

Settings that widen messaging (cross-group, an agent accepting from `project`, enabling a CLI agent) are user actions at tier 2, held by the daemon, never repository settings (the CFG-1 rule).

### 4.2 Thread participants and read authorization (review B1)

- **Participant set.** Each thread has a daemon-held participant set of principals (the user, agent ids, plugin ids). It is fixed at creation from the sender and the policy-checked, expanded recipients. It grows only (a) by a user action ("add to thread"), or (b) when a send to the thread names a recipient that the send policy (§4.1) allows for that sender; the new participant sees messages from the moment it joined, not the history, unless the user adds it with history.
- **Reads.** `thread`, `threads`, `read` (the composer tool `read_messages` and the CLI endpoint's read) and `markRead` return only threads where the caller is a participant, and within them only messages addressed to the caller or sent after it joined. Thread lists never include ids of other threads.
- **Posting into a thread.** `send` with a `threadId` requires the sender to be a participant; the recipients must be a subset of the participants plus targets the send policy allows the sender. **Participation is necessary, not sufficient:** every recipient, participant or not, passes §4.1 (including the recipient's `accepts from`) at accept and again at delivery; a participant the policy no longer allows stays a reader of the history only (review 2, NS1).
- **No existence oracle.** A thread that exists but is not visible to the caller answers with the same closed `not_found`, same shape and same timing class, as a thread that does not exist. Ids are random (§2), never sequential.
- **The user.** The user (actor `user`) can read every thread of the project; that is the visibility guarantee in §10.
- **Policy rows.** Every read method has its own policy row (actors, tier 0 or 1); a read by an actor without a row is `E_POLICY_DENIED`. The coverage check (the H6 pattern) covers them.
- **Audit.** A refused read or post writes `message.read.refused` or `message.send.refused` with the caller's ids and the requested thread id (never content).

## 5. DMN-3 and capabilities

### 5.1 The invariant

**An agent can never resolve an approval: its own, another agent's or the user's. A message cannot carry, transfer or imply an approval or a capability.**

### 5.2 Why it holds with the existing mechanism

- `axis.approvals/1.resolve` is a user-only policy row; the handler refuses any other actor; `ChallengeManager.resolve` refuses a non-user resolver (three layers, C1 design §4) [V for the manager, B for the composer rows].
- A challenge is consumed only by the same requester on the same connection, bound to the request digest, once (APR-1) [V, `@axis/challenge`]. A challenge id or digest copied into a message is useless to the recipient: it cannot resolve it (not a user) and cannot consume it (wrong requester and connection).
- Grants given to the broker are built inside `consume` and never leave the daemon (C1 "Minters"). There is no bearer token for a model to copy.
- The renderer is the user's client (A10), so anything agent-authored that could run script in the renderer could resolve as the user. That is why agent-authored content never renders as HTML in the privileged renderer (§8.3, `extensibility.md` §5).

### 5.3 Rules the message service adds

1. **Mints nothing.** The message service mints no principal, no challenge and no grant. Its outputs are message records, deliveries and notices. The test targets the **transitive** walk of what its binding can reach (the staging minter-reachability walk), not only its direct imports, and asserts that no minter of `@axis/challenge`, `daemon-principal` or `daemon-attestation` is reachable.
2. **Never a policy input.** No rule reads a message body. "Approved" in a body means nothing to the daemon.
3. **A ref is never an access grant.** A `file` ref into another agent's worktree is display data; the recipient's broker still applies WT-1 to its own worktree. "Not a new grant" is the precise claim: all worktrees of a project share one object store (R19), so a CLI agent can already read a referenced commit with its own git; a ref does not change that, and a composer's broker gives it no git access to other worktrees.
4. **The recipient stays under its own governance:** a composer under its broker policy, approvals and the taint rule (§6.6); a CLI under its own permission model. Messaging adds no tool and no shortcut to either.
5. **Approval cards are not messages.** They are different components, rendered only from `axis.approvals/1.pending`. A message cannot render a button, a form or anything resembling an approval (APR-2 applied to messages; IAC-4).

## 6. How each agent type takes part

### 6.1 Composer agents

- Two broker tools: `send_message { recipients, body, refs, threadId? }` and `read_messages { threadId?, afterSeq? }`. Both are Axis-state tools; `read_messages` is governed by §4.2.
- **Delivery at turn boundaries only**, never in the middle of a tool call. New messages reach the model as **structured content blocks** produced by the loop (a dedicated block type, or a boundary carrying a per-turn random nonce that the body cannot know), with sender name, type, `verified` and the label "untrusted, not from the user"; the body inside is escaped. A body that imitates the label cannot close the block (review N3). The model's system instructions state that such blocks are data [I: this lowers but does not remove prompt-injection risk; the taint rule is the control].
- Budgets: a turn caused by a message spends the recipient run's budget (PRV-6).
- A message to a composer agent with no active run is queued; the agent's row shows "unread N". The user starts a run.

### 6.2 CLI agents

Pull-only, through a per-run local endpoint the CLI calls itself under its own permission model; never typed into its terminal. Design, bounds, token residual, escaping and the bypass-configuration rules are in `inter-agent-cli-endpoint.md`.

### 6.3 The user and plugins

- The user can post into any thread of the project and start a thread with any agent or group. User messages are labelled as the user's and are not a taint source.
- A plugin can send only with the `messages.send` permission and only to the user or threads the user added it to. Its messages are a taint source.

### 6.4 No automatic wake in 2a

A message never starts a run in 2a. Starting a run stays a user action (`axis.cli-runs/1.start` and `axis.runs/1.start` are user-only rows). An opt-in "wake on message" is a later decision (M-4); if it ever ships, the taint rule applies to the woken run from its first call (§6.6).

### 6.5 What "side-effecting" means for the taint rule

Every broker tool except pure reads of the run's own worktree and of Axis state the run may read: file writes and deletes, commands, broker git, `send_message`, task create and update, `write_page`, any run request, and any plugin or integration operation that writes. Reads (`read_file`, `read_messages`, `read_page`, task reads) are not side-effecting, but their results can be **taint sources**.

### 6.6 The taint rule IAC-T (review S1)

- **A sticky, daemon-held, per-run flag.** Once set it is never cleared for that run. The broker sets it **before** the tool result or delivery that carries tainted content is returned to the model, so a later call in the same model reply is already covered (16 calls per reply is the C1 cap).
- **Effect.** While set, every side-effecting call (§6.5) of the run needs a user approval, whatever its usual floor. The broker records the tier at challenge issue and re-checks the flag at consume, so a challenge issued before taint and consumed after it is re-tiered to need the user's approval of the tainted state (the C1 and H5 lesson: decide from the state at issue, verify at use). The approval card lists the taint sources the run has received (type, sender or author, time, a link).
- **Closed source list:**
  1. a delivered message from an agent, a plugin or a CLI endpoint sender;
  2. the result of `read_messages` that contains such a message;
  3. an excerpt received in such a message;
  4. `read_page` of a page whose current content contains text from any non-user revision, unless the user has explicitly marked that version reviewed (a later user edit elsewhere does not clear it; review 2, NS2);
  5. a run started from a task whose title or body has any non-user revision, or whose `source` is not `user` (Start is a user action, but the text is not the user's);
  6. plugin output of any kind delivered to the run;
  7. integration data (issue bodies, PR comments, chat text) delivered to the run.
  8. a task read result (any task tool) that includes a task with any non-user revision or a `source` other than `user` (review 2, NS2).
  A new source is added to this list (and gets a gate line) before it can reach a model.
- **Precedence.** IAC-T overrides every standing grant, auto mode, "always allow" rule or future wake grant (M-4). Nothing disables it in 2a (M-2).
- **Separate ticket.** The taint core (flag, sources, broker decision hook, approval-card list) is ticket PV-M0, which PV-M4, PV-Q1 and PV-T1 depend on, so no source ships before the rule exists.

## 7. Limits

### 7.1 Size and rate

Values are proposed defaults; each is enforced in the daemon, and each refusal is a closed reason with an audit event (aggregated when repeated, §8.1).

| Limit | Default | Refusal reason |
|---|---|---|
| Body size | 16,384 characters; refs at most 16; excerpt at most 64 KiB | `too_large` |
| Recipients per message (after group expansion) | 16 | `too_many_recipients` |
| Sends per agent | 30 per minute, 500 per run | `rate_limited` |
| Sends per project | 300 per minute | `rate_limited` |
| Reads per caller | 60 per minute; a read returns at most 50 messages and 256 KiB | `rate_limited` |
| Hop depth | 8 | `hop_limit` |
| Messages per thread kept | 2,000 (older ones archived, still in the journal until retention) | n/a |
| Retention | 30 days, user-configurable; audit events keep only keyed hashes | n/a |

### 7.2 Recipient queues (review S2)

- Each recipient's undelivered queue holds at most 200 messages, split into **per-sender quotas** (at most 50 from any one agent or plugin sender).
- **User and system messages are never evicted** and do not count against agent quotas.
- **When a sender's quota or the queue is full, the new message is refused** (`queue_full` to the sender) and the user gets one notice per sender and recipient pair. Nothing already queued is dropped.

### 7.3 Loops

`hop` is derived by the daemon from what the sending run received through any taint source in §6.6. Two agents replying to each other stop at hop 8 with a user notice. Pages and tasks carry the highest hop of the run that wrote each non-user revision, so a page or task relay counts too (review N4). Budgets (PRV-6) remain the final bound on cost: a relay that escapes hop counting still spends each run's budget.

### 7.4 Memory

Every in-memory structure (per-run inboxes, per-thread rings, read cursors) is bounded and evicts with a counted drop, following the bounded-ring pattern of C1's activity store. Queues follow §7.2 (refuse, never silent drop).

## 8. Audit (DMN-5), redaction (DMN-6) and rendering

### 8.1 Audit events

| Event | Fields |
|---|---|
| `message.send` | `messageId`, `threadId`, `projectId`, `sender` (`kind`, `agentId`, `runId`, connection id, `verified`), resolved `recipients` (agent ids, group ids and their expansion), `bodyLength`, `bodyMac`, `refsCount`, `hop`, outcome `accepted` |
| `message.send.refused` | the same ids, closed reason; no `bodyMac` when the reason is a scan or path refusal |
| `message.deliver` | `messageId`, recipient `agentId`, recipient `runId` or `ui`, channel (`composer-turn`, `cli-pull`, `ui`) |
| `message.read.refused` | caller ids, requested `threadId`, closed reason (§4.2) |
| `message.taint` | `runId`, source type (§6.6), source id |
| `message.settings` | who changed which messaging setting, before and after |
| `message.pause` / `message.resume` | actor (user), scope (project, group, agent) |
| `message.endpoint` | CLI endpoint created, revoked, auth failures aggregated (`inter-agent-cli-endpoint.md` §3) |

- **Keyed hashes (review N2).** `bodyMac` is an HMAC-SHA-256 with a per-install key held by the daemon, not a plain SHA-256, so a short body cannot be confirmed by guessing. For refusals by the scanner or the path list, no hash is recorded.
- Bodies are stored in the journal's message table, not in the audit log.
- Errors returned to the sender are closed codes with fixed text; nothing from the recipient, the journal or the scanner is echoed.

### 8.2 Secret scan

`@axis/secret-scan` (PSH-1) runs over the body and every excerpt before accept, after the path refusals of §2. Default `refuse`. `warn` is a user setting **only for messages whose recipients are all composer agents or the user**; a message to a CLI agent or a plugin is always `refuse` (M-6). A finding is reported by rule name only.

### 8.3 Rendering

- Bodies and names go through the existing display rules (`displayTextSchema`, `toDisplayPath`): C0 and C1 controls (except newline and tab), invisible and bidirectional characters are escaped in the thread view, in composer delivery and on the CLI read path (`inter-agent-cli-endpoint.md` §5).
- **No HTML from message content in the privileged renderer (review S7).** The thread view shows bodies as escaped plain text. An optional rendered-Markdown view uses the isolated page frame of `extensibility.md` §5 (opaque origin, no bridge port). Links are never auto-opened; EL-5 applies.

## 9. New threats and controls

| ID | Threat | Control | Phase |
|---|---|---|---|
| IAC-1 | **Confused deputy:** a low-privilege composer (read a hostile README) asks a CLI agent, which has the user's credentials and can push, to run a command | Messaging to CLI agents off by default and pull-only; refused for bypass entries and warned for repository CLI config (`inter-agent-cli-endpoint.md` §6); provenance label; the CLI's prompts remain the gate. **Residual:** a CLI set to auto-approve is exposed | 2a |
| IAC-2 | **Prompt injection relay:** a message steers a composer into a harmful tool call | IAC-T over the closed source list (§6.6), approval card lists sources, C8 content preview, WT-1, WT-3 | 2a |
| IAC-3 | **Approval laundering:** A asks B to request an action; the user approves believing it is B's own plan | Approval cards show the run's taint sources and hop; DMN-3 unchanged (§5) | 2a |
| IAC-4 | **UI spoofing:** text formatted to look like an approval, a system notice or the user | Distinct components; escaped plain text; structured delivery blocks; sender badge from the daemon only | 2a |
| IAC-5 | **Message storms and cost loops** | Hop limit through messages, pages and tasks; rate limits; per-sender quotas; budgets; no auto-wake | 2a |
| IAC-6 | **Impersonation:** a client claims another sender | Sender from the attested connection; CLI senders token-bound and labelled unverified. **Residual:** any program the CLI runs, including repository scripts, inherits the token (`inter-agent-cli-endpoint.md` §4) | 2a |
| IAC-7 | **Exfiltration through messages** | Excerpt path refusals, secret scan (refuse for CLI and plugin recipients), size caps, audit. **Residual:** unknown secret formats; a CLI can exfiltrate over the network anyway | 2a |
| IAC-8 | **Cross-project or cross-group leakage on send** | Project from the thread or recipients, never renderer state; groups expanded at accept; delivery re-checks policy; DMN-8 tests | 2a |
| IAC-9 | **Daemon memory and journal growth** | Bounded queues, rings and reads; retention purge; `E_BACKPRESSURE` | 2a |
| IAC-10 | **Endpoint abuse by another local process** | `inter-agent-cli-endpoint.md` §2–4 | 2a |
| IAC-11 | **Excerpt path tricks** (symlink, `..`, secret files) | Review-path containment, sender's own worktree id, path refusal list | 2a |
| IAC-12 | **Kill switch race** | Pause checked under the delivery lock; queued messages stay queued; running turns get nothing more | 2a |
| IAC-13 | **Read without authorization:** an agent reads or posts into another group's thread by id | Participant sets, participant-only reads, `not_found` without an existence oracle, read policy rows, `message.read.refused` (§4.2) | 2a |
| IAC-14 | **Terminal escapes through the CLI read path** (OSC 52 clipboard, OSC 8 links, title or cursor tricks) | Daemon escaping on every endpoint response; shim label (`inter-agent-cli-endpoint.md` §5) | 2a |
| IAC-15 | **Endpoint DoS and audit flooding** | Connection, framing, pre-auth, read-rate and size bounds; aggregated auth-failure audit (`inter-agent-cli-endpoint.md` §3) | 2a |
| IAC-16 | **Queue eviction erases the user's instructions** | Per-sender quotas; user and system never evicted; refuse when full (§7.2) | 2a |

TSK-2 (task text laundering taint) and PAG-3 (page script reaching the bridge) are in `extensibility.md` §8.

## 10. User visibility and the kill switch

- **Thread view:** every message, sender and recipient type badges, `verified` state, provenance labels, refusals and limit notices as system lines. The user can read every thread.
- **Kill switch:** **Pause messaging** per project (and per group and agent), a user-only tier-2 call. The daemon refuses every send, every delivery and every endpoint call in that scope with `paused`, for agent, CLI and plugin senders alike; queued messages stay queued. **Resume** is also user-only. The UI copy says plainly that Pause **stops new deliveries only: a message a CLI or a composer has already read cannot be recalled** (review N8). Stopping runs is the separate existing action.
- **Mute:** per agent, the user can stop seeing an agent's messages in the attention block without changing delivery.

## 11. Proposed gate lines (for Phase 2a; not added to `ROADMAP.md`)

1. A composer agent's `send_message` to an agent in another group is refused by default; the refusal is audited with sender and recipient ids.
2. A body containing a challenge id, a digest or the word "approved" changes no approval; an agent connection calling `axis.approvals/1.resolve` is denied (DMN-3 re-run with messaging on).
3. After a composer run receives an agent message, its next side-effecting call raises an approval whose card lists that message (IAC-T, source 1).
4. Two composer agents replying to each other stop at hop 8 with a user notice; no further provider request is made for that hop; a relay through a page or a task carries the hop.
5. A planted secret pattern in a body or excerpt is refused and appears nowhere in the audit log, journal audit fields or logs (canary); an excerpt of `.env`, a gitignored file or a WT-3 path is refused before the scan. Case and alias variants (`.ENV`, `Config/Master.KEY`, an NFD-decomposed name, `ENV~1`, `.env.`, `.env::$DATA`) and a symlink alias to `.env` are refused too.
6. CLI endpoint lines are in `inter-agent-cli-endpoint.md` §7.
7. Pause blocks sends, deliveries and endpoint calls in its scope within one request, including plugin senders; resume restores them; both are audited.
8. Control and bidirectional characters in a body are escaped in the thread view, in composer delivery and on the CLI read path.
9. No message crosses a project, including through a group id or thread id from another project, and a send whose recipients span projects is refused.
10. **Read authorization (B1):** an agent of group 1, and a CLI token of an agent in group 1, reading or posting into a group-2 thread id get `not_found`, identical to an unknown id, audited as `message.read.refused` or `message.send.refused` with both ids; `threads` lists only the caller's threads.
11. **Taint, one line per source:** a `read_messages` result followed by `write_file` in the **same** model reply needs approval; `read_page` of a page with an agent revision, a run started from an agent-edited or imported task, plugin output and integration data each set the flag; a user edit after an agent revision of a page still leaves `read_page` tainting; a task read of an agent-edited task taints; a standing "always allow" does not bypass it.
12. **Queues:** a flood from one sender is refused at its quota; the user's earlier message to the same recipient is still delivered; the user gets one notice.
13. **Minter walk:** the transitive reachability test fails if any minter becomes reachable from the message binding.
14. **Delivery re-check:** a message accepted under a cross-group setting is not delivered after the user turns the setting off. A send after the setting is turned off, into a thread created while it was on, is refused for the recipient the policy no longer allows; a recipient with `accepts from: none` gets nothing inside an existing thread.
15. **Bounds:** with limits lowered in a test build, rings, inboxes and read responses stay at their caps and count drops.
16. **Retention:** a message older than the retention period is purged from the journal; its audit events remain with keyed hashes only.
17. **Keyed hash:** the audit holds no plain SHA-256 of any body; a scan-refused send has no body hash.
18. **Taint at consume:** a challenge issued before a run became tainted and consumed after it is re-checked and needs the user's approval under IAC-T; the consume of the old grant alone is refused.

## 12. Open questions for the owner

| # | Question | Recommended default |
|---|---|---|
| M-1 | Cross-group messaging inside a project | Off; per pair or per project, user tier 2 |
| M-2 | Taint rule IAC-T | On, not disableable, over the closed source list in §6.6 |
| M-3 | CLI entries that bypass the CLI's prompts | Refused; warn and require a second confirmation when a known CLI project-config file exists in the worktree (`inter-agent-cli-endpoint.md` §6) |
| M-4 | Wake on message | Not in 2a |
| M-5 | CLI participation in 2a | Yes, after composer-to-composer, and only with the endpoint bounds, token rules and escaping of `inter-agent-cli-endpoint.md` built (PV-M6, PV-M7) |
| M-6 | Secret scan mode on messages | `refuse`; `warn` only when every recipient is a composer agent or the user |
| M-7 | Retention of message bodies | 30 days, user-configurable; audit keeps keyed hashes |
| M-8 | Plugins as senders | Only with `messages.send`, only to the user and threads the user added the plugin to |
| M-9 | Thread model | Participant set fixed at creation; grows by user action or a policy-allowed recipient; invisible means `not_found` |
| M-10 | Queue full | Per-sender quota; refuse new messages; never drop user or system messages |
| M-11 | Rendering of message bodies | Escaped plain text in the thread view; rendered Markdown only in the isolated page frame |
