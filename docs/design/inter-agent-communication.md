# Inter-agent communication

- **Status:** Proposed (design only; nothing is built). Proposed phase 2a (`product-vision-v2.md` §5).
- **Date:** 2026-11-05. Verified against `origin/main` at `ffbcaad`.
- **Depends on:** ADR 0003 (bridge, policy pipeline, D4 challenges, D5 audit), ADR 0004 (decisions 8 and 10, implication 3), `docs/security/threat-model-phase1.md` §4.4–4.5 (DMN-2, DMN-3, APR-1, APR-2, DMN-5, DMN-6, DMN-8, ANT-2), `docs/design/composer-runtime.md` (branch `feat/composer-runtime`, C1, not merged), `docs/design/daemon-host.md`.
- **Evidence tags:** as in `product-vision-v2.md`.

## 1. Goal and non-goals

**Goal.** Agents in one project, of any type (composer agents and CLI agents), and the user can exchange messages. The daemon carries every message. The user can see every message, stop all messaging in a project at once, and audit who sent what to whom.

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
| `messageId` | opaque id | daemon | minted at accept |
| `projectId` | id | daemon | derived from the sender's agent or the user's focused project; never from the payload |
| `threadId` | id | client (existing thread) or daemon (new thread) | a thread belongs to one project |
| `seq` | integer | daemon | per-thread, monotonic |
| `sender` | `{ kind: user \| agent \| plugin \| system, agentId?, runId?, pluginId? }` | daemon | from the attested connection identity (the H12 pattern: `createdBy` is the attested actor, not payload) |
| `recipients` | list of `{ agent: agentId }`, `{ group: groupId }`, `{ user }`; 1..16 | client | checked against the policy (§4); groups are expanded at accept time and the expanded list is recorded |
| `body` | `{ format: "text", text }`, 1..16,384 characters | client | plain text; rendered as escaped text with a small Markdown subset (no HTML, no images, no auto-opening links) |
| `refs` | 0..16 typed references: `file { workspaceId, path }`, `commit { sha }`, `run { runId }`, `task { taskId }`, `pr { number }`, `page { pageId }`, `excerpt { … }` | client | references are data. A ref never lets the recipient read anything it could not read already (§5.3) |
| `inReplyTo` | `messageId?` | client | same thread only |
| `hop` | 0..8 | daemon | 0 for a message sent by the user; otherwise 1 + the highest hop of messages the sending run received before it sent (§7) |
| `createdAt` | time | daemon | |

The schema is strict (unknown keys refused, as in `@axis/protocol`'s existing guarded schemas). There is no field for an approval, a challenge, a grant, a token, a tool call, a command or a path to execute.

**Excerpt refs.** To share code or a diff from its own workspace, the sender attaches an `excerpt`: the daemon reads it from the **sender's** worktree at send time (through the same locator and containment rules as `axis.review/1.diff`, DMN-2), caps it (64 KiB), scans it (§8) and stores the copy with the message. The recipient gets the copied text, not access to the sender's worktree.

## 3. Mediation: the daemon is the only router

```text
composer run A ──tool call──▶ broker ──▶ daemon message service ──▶ journal (messages)
                                                │                      │
CLI run B ──local endpoint (per-run token)──────┤                      └─▶ audit (hash, ids)
                                                │
user (Agent view) ──bridge──────────────────────┘
                     delivery: composer turn boundary / CLI pull / UI
```

- The message service lives in `@axis/daemon-host` as a new service behind a binding, like the composer service in C1. Handlers see it only through a port and register through the `HandlerRegistrar`.
- Every send passes the normal pipeline: identity, policy row, idempotency key (a retry does not duplicate a message), then the service's own checks (§4, §7, §8), then journal-first write, then audit.
- Delivery is a separate step with its own audit event, so "sent" and "seen by B" are distinguishable.

## 4. Who can send to whom

The policy is evaluated in the daemon per recipient at accept time, and again at delivery (a setting changed in between wins).

| Sender | May send to | Default |
|---|---|---|
| user | any agent in the project; any group | allowed |
| agent | the user; agents in its own group | allowed |
| agent | agents in another group of the same project | **off**; enabled per project (setting) or per pair |
| agent | agents in another project | never |
| plugin (`plugin:<id>`) | the user; threads the user added it to | only with the `messages.send` permission (`extensibility.md` §3.4) |
| system | the user | daemon notices only (refusals, limits) |

Each agent also has **accepts messages from**: `none`, `group` (default), `project`. A CLI agent's setting starts at `none` (§6.3).

Settings that widen messaging (cross-group, an agent accepting from `project`, enabling a CLI agent) are user actions at tier 2, user scope or project scope held by the daemon, never repository settings (the CFG-1 rule: a repository's `.vscode/settings.json` cannot widen it).

## 5. DMN-3 and capabilities

### 5.1 The invariant

**An agent can never resolve an approval: its own, another agent's or the user's. A message cannot carry, transfer or imply an approval or a capability.**

### 5.2 Why it holds with the existing mechanism

- `axis.approvals/1.resolve` is a user-only policy row; the handler refuses any other actor; `ChallengeManager.resolve` refuses a non-user resolver (three layers, C1 design §4) [V for the manager, B for the composer rows].
- A challenge is consumed only by the same requester on the same connection, bound to the request digest, once (APR-1) [V, `@axis/challenge`]. A challenge id or digest copied into a message is therefore useless to the recipient: it cannot resolve it (not a user) and cannot consume it (wrong requester and connection).
- Grants given to the broker are built inside `consume` and never leave the daemon (C1 "Minters"). There is no bearer token for a model to copy.

### 5.3 Rules the message service adds

1. The message service mints no principal, no challenge and no grant. Its only outputs are message records, deliveries and notices. A coverage test asserts that its binding does not import `@axis/challenge`, `daemon-principal` or `daemon-attestation` (the import-allowlist pattern in `test/packages/imports.test.mjs`).
2. A message is never an input to policy. No rule reads a message body. "Approved" in a message body means nothing to the daemon.
3. A ref is never an access grant. A `file` ref into another agent's worktree is display data; the recipient's broker still applies WT-1 to its own worktree, and a CLI agent's file access is whatever the user's OS allows (unchanged, ADR 0004 implication 3).
4. A recipient's actions stay under the recipient's own governance: a composer under its broker policy and approvals; a CLI under its own permission model. Messaging adds no tool and no shortcut to either.
5. Approval cards and message bubbles are different components, and approval cards are rendered only from `axis.approvals/1.pending`. A message cannot render a button, a form or anything resembling an approval (APR-2 applied to messages; §9 IAC-4).

## 6. How each agent type takes part

### 6.1 Composer agents

- Two broker tools: `send_message { recipients, body, refs, threadId? }` and `read_messages { threadId?, afterSeq? }`. Both are Axis-state tools (no file or process side effect); `send_message` is tier 1 by default, raised by the taint rule below.
- **Delivery at turn boundaries only**, never in the middle of a tool call: before the next provider request, the loop appends new messages as a block labelled `message from <agent name> (<type>), untrusted, not from the user`, with the body escaped. The model's system instructions state that such blocks are data, not instructions [I: this lowers but does not remove prompt-injection risk].
- **Taint rule (new control IAC-T, recommended default on).** From the first turn that received a message from another agent or a plugin, every side-effecting tool call of that run needs a user approval, whatever its usual floor, and the approval card lists the messages the run has received (sender, time, a link). Messages from the user do not taint.
- Budgets: a turn caused by a message spends the recipient run's budget (PRV-6); nothing is free.
- A message to a composer agent with no active run is queued; the agent's row shows "unread N". The user starts a run.

### 6.2 CLI agents

Constraints that do not change: Axis does not read CLI private files, does not parse undocumented output, and does not write into the CLI's terminal (ADR 0004 decisions 8 and 10). So CLI agents take part only through **an interface the CLI calls itself**, under its own permission model.

- **Local endpoint (new).** For a CLI run whose agent has messaging enabled, the daemon creates a per-run endpoint: a Unix domain socket in a directory with mode `0700` under the Axis data directory (a named pipe with a user-only ACL on Windows) [I: Windows ACL detail to verify]. It is not a TCP listener, so the "no loopback listener" gate line (NET-1) still holds, but it is a new listener and needs ADR 0007.
- **Per-run token.** 256 random bits, bound to `{ projectId, agentId, runId }` and to the methods `send` and `read` only; revoked when the run leaves RUNNING; never written to the journal or audit (hash only).
- **How the CLI reaches it.** A small Axis-shipped stdio program (`axis-messages`), registered by the user in the CLI's own tool configuration (for example as an MCP server, if the CLI supports that), exposes two tools, `send_message` and `read_messages`, and forwards to the endpoint with the token. The CLI asks the user before calling it, or not, according to its own permission settings; Axis cannot see or change that.
- **PTY-5 amendment needed.** The endpoint path and token reach the shim through two variables set in the CLI's environment after the deny-list (`AXIS_*` is denied today). The amendment admits exactly those two names, only for runs with messaging enabled, and the PTY-5 gate test is extended to assert they are absent otherwise.
- **Pull only.** The CLI reads when it calls `read_messages`. The dashboard shows "unread N" on the CLI agent's row. The UI offers **Copy message** to the clipboard; it never pastes into the terminal.
- **Sender identity is weaker for CLI agents.** A message from the endpoint is attributed to "agent X via CLI endpoint". Axis cannot tell whether the CLI's model, the user typing in that terminal, or another same-user process holding the token wrote it. Same-user processes are out of scope (threat model §1), so this is a documented residual (§9 IAC-6).

### 6.3 CLI agents with permission-bypass launch flags

A CLI entry whose arguments turn off the CLI's own prompts (plan Q16 already flags these as "autonomous runs") would act on another agent's message without anyone seeing it first. **Recommended default:** Axis refuses to enable messaging for an `axis.cliAgents` entry the user has marked, or Axis detects by a maintained flag list, as bypassing permissions [I: detection by flag list is incomplete by nature, so the user's own marking is the primary signal]. Owner decision M-3.

### 6.4 No automatic wake in 2a

A message never starts a run in 2a. Starting a run stays a user action (`axis.cli-runs/1.start` and `axis.runs/1.start` are user-only rows). An opt-in "wake on message" is a later decision (M-4): it would be a standing user grant with its own budget, rate limit and audit, and it needs the planner work of Phase 3.

### 6.5 The user and plugins

- The user can post into any thread and start a thread with any agent or group. User messages are labelled as the user's and do not taint.
- A plugin can send only with the `messages.send` permission and only to the user or threads the user added it to. Its messages taint like an agent's.

## 7. Rate, size and loop limits

Values are proposed defaults; each is enforced in the daemon and each refusal is a closed reason with an audit event.

| Limit | Default | Refusal reason |
|---|---|---|
| Body size | 16,384 characters; refs at most 16; excerpt at most 64 KiB | `too_large` |
| Recipients per message (after group expansion) | 16 | `too_many_recipients` |
| Sends per agent | 30 per minute, 500 per run | `rate_limited` |
| Sends per project | 300 per minute | `rate_limited` |
| Hop depth | 8 | `hop_limit` |
| Messages per thread kept | 2,000 (oldest archived, still in the journal until retention) | n/a |
| Undelivered queue per recipient | 200; then the oldest are dropped with a notice to the user | `queue_full` |
| Retention | 30 days, user-configurable; audit events keep only hashes | n/a |

**Loop guard.** `hop` is derived by the daemon from what the sending run has received, so two agents replying to each other reach 8 hops and stop; the user is shown a "loop stopped" notice. A run's received-hop high-water mark is kept per run; a new run starts at 0 only if it was started by the user.

**Memory.** Every in-memory structure (per-run inboxes, per-thread rings) is bounded and evicts with a counted drop, following the bounded-ring pattern of C1's activity store and the review lessons on unbounded memory.

## 8. Audit (DMN-5) and redaction (DMN-6)

Audit events, all in the hash-chained log:

| Event | Fields |
|---|---|
| `message.send` | `messageId`, `threadId`, `projectId`, `sender` (`kind`, `agentId`, `runId`, connection id), resolved `recipients` (agent ids, group ids and their expansion), `bodyLength`, `bodySha256`, `refsCount`, `hop`, outcome `accepted` or `refused` with a closed reason |
| `message.deliver` | `messageId`, recipient `agentId`, recipient `runId` or `ui`, channel (`composer-turn`, `cli-pull`, `ui`) |
| `message.settings` | who changed which messaging setting, before and after |
| `message.pause` / `message.resume` | actor (user), scope (project, group, agent) |
| `message.endpoint` | CLI endpoint created and revoked, with run id, never the token |

- Bodies are stored in the journal's message table, not in the audit log; the audit log holds length and SHA-256 (the DMN-6 content rule).
- **Secret scan on send.** `@axis/secret-scan` (PSH-1) runs over the body and every excerpt before accept. Default `refuse` (like push refuse mode); `warn` as a user setting shows the finding by rule name only, never the matched text.
- Display: bodies and names go through the existing display rules (`displayTextSchema`, `toDisplayPath`): control, invisible and bidirectional characters are escaped in the thread view and in composer delivery.
- Errors returned to the sender are closed codes with fixed text; nothing from the recipient, the journal or the scanner is echoed.

## 9. New threats and controls

| ID | Threat | Control | Phase |
|---|---|---|---|
| IAC-1 | **Confused deputy:** a low-privilege composer (read a hostile README) asks a CLI agent, which has the user's credentials and can push, to run a command | Messaging to CLI agents is off by default and pull-only; refused for permission-bypass entries (§6.3); provenance label on every delivered message; the CLI's own prompts remain the gate. **Residual:** a user who has set the CLI to auto-approve is exposed; Axis cannot prevent it | 2a |
| IAC-2 | **Prompt injection relay:** a message steers a composer into a harmful tool call | Taint rule IAC-T (every side-effecting call needs approval after a message), approval card lists received messages, the content preview of C8 for writes, WT-1 and WT-3 unchanged | 2a |
| IAC-3 | **Approval laundering:** A asks B to request an action; the user approves believing it is B's own plan | Approval cards show the run's received messages and the hop; DMN-3 is unchanged (§5) | 2a |
| IAC-4 | **UI spoofing:** message text formatted to look like an approval, a system notice or the user | Distinct components; escaped text; no HTML, images or buttons; sender badge from the daemon only | 2a |
| IAC-5 | **Message storms and cost loops** | Hop limit, rate limits, queue caps, budgets charged to the recipient run, no auto-wake | 2a |
| IAC-6 | **Impersonation:** a client claims another sender | Sender from the attested connection; CLI senders bound to a per-run token. **Residual:** same-user processes can read the token from the CLI's environment (out of scope, threat model §1) | 2a |
| IAC-7 | **Exfiltration through messages:** a contained composer gets a CLI agent to read and send back secrets | Secret scan refuse-by-default, size caps, audit. **Residual:** the scanner misses unknown formats, and a CLI can exfiltrate over the network anyway | 2a |
| IAC-8 | **Cross-project or cross-group leakage** | Routing scoped by project id from identity; groups expanded at accept time; delivery re-checks policy; DMN-8 tests | 2a |
| IAC-9 | **Daemon memory and journal growth** | Bounded queues and rings, retention, `E_BACKPRESSURE` | 2a |
| IAC-10 | **Endpoint abuse:** another local process connects to a CLI run's socket | `0700` directory, per-run token, methods limited to send and read for that agent, revoke at run end, rate limits | 2a |
| IAC-11 | **Excerpt path tricks:** an excerpt ref uses a symlink or `..` to copy a file outside the sender's worktree | Excerpts read through the review path's containment (DMN-2, the FT-1 symlink rule) and the sender's own worktree id | 2a |
| IAC-12 | **Kill switch race:** messages delivered after the user pressed Pause | Pause flag checked under the same lock as delivery; queued messages stay queued; composer turns already running finish their current tool call and receive nothing more | 2a |

## 10. User visibility and the kill switch

- **Thread view:** every message, sender and recipient type badges, provenance labels, refusals and limit notices as system lines. Nothing is hidden from the user.
- **Kill switch:** **Pause messaging** per project (and per group and agent). A user-only tier-2 call. Effect: the daemon refuses every send and every delivery in that scope with `paused`, the CLI endpoints of that scope answer `paused`, queued messages stay queued. **Resume** is also user-only. A separate existing action stops runs.
- **Mute:** per agent, the user can stop seeing an agent's messages in the attention block without changing delivery.

## 11. Proposed gate lines (for Phase 2a; not added to `ROADMAP.md`)

1. A composer agent's `send_message` to an agent in another group is refused by default; the refusal is audited with sender and recipient ids.
2. A message whose body contains a challenge id, a digest or the word "approved" does not change any approval; an agent connection calling `axis.approvals/1.resolve` is denied (DMN-3, re-run with messaging on).
3. After a composer run receives an agent message, its next side-effecting tool call raises an approval whose card lists that message (IAC-T).
4. Two composer agents replying to each other stop at hop 8 with a user notice; no further provider request is made for that hop.
5. A planted secret pattern in a body or excerpt is refused in `refuse` mode and never appears in the audit log, journal audit fields or any log (canary test).
6. A CLI run without messaging enabled has neither endpoint variable in its environment (PTY-5 test extended); with it enabled, a second process using a revoked token after the run ends is refused.
7. Pause messaging blocks sends, deliveries and endpoint calls in its scope within one request; resume restores them; both are audited.
8. Control and bidirectional characters in a body are escaped in the thread view and in composer delivery.
9. No message crosses a project, including through a group id or thread id from another project.

## 12. Open questions for the owner

| # | Question | Recommended default |
|---|---|---|
| M-1 | Cross-group messaging inside a project | Off by default, enabled per project or per pair |
| M-2 | Taint rule IAC-T | On, and not user-disableable in 2a |
| M-3 | Messaging for CLI entries that bypass the CLI's prompts | Refused |
| M-4 | Wake on message | Not in 2a; revisit with the Phase 3 planner |
| M-5 | CLI participation at all in 2a | Yes, but after composer-to-composer ships (ticket order in `product-vision-v2-tickets.md`) |
| M-6 | Secret scan mode on messages | `refuse`, `warn` as a user setting |
| M-7 | Retention of message bodies | 30 days, user-configurable; audit keeps hashes indefinitely per the audit retention rule |
| M-8 | Plugins as senders | Only with `messages.send`, only to the user and to threads the user added the plugin to |
