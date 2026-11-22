# ADR 0007: Inter-agent messaging

- **Status:** Proposed. Becomes Accepted when the Phase 2a messaging gate passes (ticket PV-M8; validation criteria below). The owner decisions it records (M-1 to M-11) are decided; the engineering decisions it adds are decided and revisable.
- **Date:** 2026-11-21.
- **Decision owner:** Dylan Lambertson. The owner delegated every open decision to the project lead on 2026-11-21; the decisions are recorded in `docs/design/owner-decisions-2026-11-21.md` §3, and the owner can reverse any of them there.
- **Depends on:** ADR 0003 (bridge, policy pipeline, D4 challenges, D5 audit), ADR 0004 (decisions 8 and 10, implication 3, PTY-5), ADR 0006 (agents and groups as stored principals). All Proposed.
- **Amends:** ADR 0004 implication 3 and amendment item 6 (PTY-5): two admitted variables for runs with messaging enabled (section "Amendment to ADR 0004" below). **Keeps** ADR 0003 D1.1 and threat model DMN-4 ("the daemon opens no listening socket or port in Phases 1–3"): the CLI endpoint is not a daemon listener (decision 7.1).
- **Related:** `docs/design/inter-agent-communication.md` ("the design"), `docs/design/inter-agent-cli-endpoint.md` ("the endpoint design"), `docs/design/messages-contract.md` ("the contract doc"), `docs/design/product-vision-v2-tickets.md` (PV-M0 to PV-M8, PV-R4), `docs/security/threat-model-phase1.md` (DMN-2, DMN-3, DMN-4, DMN-5, DMN-6, DMN-8, APR-1, APR-2, PTY-3, PTY-5, NET-1, A10).
- **Detail:** this file holds the decisions. `docs/adr/0007-inter-agent-messaging-code.md` maps each built claim to its code and records every divergence between the design and the code.
- **Evidence tags:** **[V]** verified in the code on `origin/main` at `f540b60` (the file and symbol are named); **[D]** decided here or in the design, not built yet; **[I]** inferred, not verified.

## Context

### Owner direction

On 2026-11-06 the owner asked that agents of any type in one project, and the user, can talk to each other (`product-vision-v2.md` §1). The design (revised after two security design reviews) answers how; on 2026-11-21 its eleven open questions were decided as the recommended defaults (owner decisions §3).

### What exists on main

- **The contract** `axis.messages/1` is served: nine methods, strict schemas, closed refusals [V, `packages/protocol/src/messages.ts` `messagesMethods`, `packages/protocol/src/messages-wire.ts`].
- **The message service, slice 1**: participant sets, participant-only reads, the send policy at accept, limits, settings, Pause and audit, for the user's own desktop connection only [V, `packages/daemon-host/src/messages/`, `src/handlers/messages.ts`].
- **Delivery into composer runs, slice 2**: at turn boundaries, re-checked at delivery, at most once per run, as the first taint producer [V, `messages/delivery.ts` `createMessageDelivery`]. It delivers nothing in production yet, because no run is bound to an agent until PV-G4 [V, `messages/binding.ts` `agentOf` defaults to none].
- **The taint core** (PV-M0): a sticky, journaled per-run flag and a broker decision hook [V, `packages/daemon-host/src/composer/taint.ts` `createRunTaint`, `packages/broker/src/policy.ts` `DecisionHook`].
- **Not built**: agents and groups (PV-G3), so every agent recipient is refused today [V, `messages/policy.ts` `journalDirectory`]; the composer tools (PV-M4); the CLI endpoint and shim (PV-M6, PV-M7); excerpts, `bodyMac`, retention purge, user notices, "add to thread" and the minter walk (PV-M3 later slices). The code map lists each.

## Options

The shape of messaging (daemon-mediated, no capabilities, taint) was settled by the design and its reviews; it is recorded below as decided. One question was still open and conflicts with an earlier ADR: **where the CLI endpoint listens.**

| | Option | Main problem |
|---|---|---|
| A | The daemon listens (the endpoint design §2 as written) | Breaks ADR 0003 D1.1 and DMN-4: the daemon, which holds the journal, the challenges and the policy pipeline, would accept connections from any same-user process. It would need its own ADR and a threat-model change |
| B | **The pty process hosts the listener and relays frames to the daemon over its existing control channel**; the daemon checks the token and answers | A new relay message on the pty control channel; the pty process gains a listener. It holds no secrets and already spawns the CLI and holds its environment, so it learns nothing new |
| C | No CLI participation in 2a | Reverses M-5 |

## Decision

### 1. The daemon is the only router

- No direct channel between two agents: no shared socket, file, pipe or terminal. Every message goes through the daemon's message service, which journals it, audits it and delivers it [V, `messages/service.ts` `createMessageService`; design §3].
- Axis never types into a CLI agent's terminal (ADR 0004 decision 10 unchanged). A CLI agent only **pulls**, through the endpoint (decision 7).
- No message crosses a project (DMN-8). A thread's project comes from the thread, or for a new thread from the attested sender (agent) or the one project of every named recipient (user); recipients that span projects are refused, and never from renderer state (A10) [V, `messages/policy.ts` `newThreadProject`].
- A message never starts a run in 2a (M-4). Starting a run stays a user action.
- **The caller is attested, never a payload.** The service takes a `MessageCaller` (user, agent with run and `verified`, plugin) from its binding [V, `messages/policy.ts` `MessageCaller`]. Today the only binding is the bridge, whose rows admit only `user` and whose handlers refuse any other actor or a web client with `not_found` [V, `packages/daemon-host/src/policy/rules.ts` `axis.messages/1.*` `userRule`, `src/handlers/messages.ts`]. The broker (PV-M4) and the endpoint relay (decision 7) each build their caller from their own attested state.

### 2. No capabilities (DMN-3)

**An agent can never resolve an approval, its own, another agent's or the user's. A message cannot carry, transfer or imply an approval or a capability.**

- No request or response field, at any depth, names an approval, challenge, digest, grant, token, capability, credential, command, tool or actor; a contract test walks every schema and fails on such a name; bodies have one format, `text` [V, `packages/protocol/src/messages.ts` header; the contract doc §3].
- No method is above tier 2, so no request takes an approval [V, `messagesMethods`].
- `axis.approvals/1.resolve` stays a user-only row [V, `policy/rules.ts`]; a challenge is consumed only by its requester on its connection, once (APR-1).
- The message service mints no principal, challenge or grant [D: the transitive minter-reachability test is not built yet; design §5.3 rule 1, gate line 13].
- No rule reads a body; a ref is display data, never an access grant; approval cards are separate components rendered only from `axis.approvals/1.pending` (design §5.3).

### 3. Thread participants and read authorization (M-9)

- Each thread has a daemon-held participant set, fixed at creation from the sender and the checked, expanded recipients. It only grows (journal triggers refuse update and delete), at most 64 members [V, `packages/journal/src/schema.ts` version 9, `MAX_THREAD_PARTICIPANTS`].
- A caller other than the user reads only threads it participates in, and within them only messages addressed to it or sent after it joined [V, `packages/journal/src/message-store.ts` `VISIBLE`, `visibleAfter`].
- Posting into a thread needs participation, and **every** recipient, participant or not, passes the send policy (decision 3.1) at accept and again at delivery [V, `messages/service.ts` `accept`, `deliverable`].
- **No existence oracle.** For any caller but the user a thread is resolved by ONE participant-scoped lookup, so a hidden thread and an unknown one are the same miss: the same `not_found`, the same audit row, the same path. The claim is structural identity, not equal latency [V, `messages/service.ts` `resolve`]. A refusal's details are exactly `{ reason }` from a closed set, under one fixed message [V, `messages-wire.ts` `MESSAGES_REFUSALS`, `MESSAGES_REFUSAL_MESSAGE`]. Ids are 128 random bits [V, `encodeMessagingId`].
- The user reads every thread of a project (the visibility guarantee). Every read method has its own policy row (review B1) [V, `policy/rules.ts`].

#### 3.1 Who may send to whom (M-1, M-8)

| Sender | May address | Default |
|---|---|---|
| user | any agent or group of the project | allowed |
| agent | the user; agents of its own group (an agent in no group shares a group with nobody, so it reaches other agents only through a cross-group setting) | allowed |
| agent | agents of another group of the project | **off**; on per project or per group pair, a user tier-2 setting (M-1) |
| agent | another project's agents | never |
| plugin | the user, in a thread the user added it to; cannot open a thread (M-8) | with `messages.send` only [D: no plugin caller exists] |

Each recipient's `acceptsFrom` (`none`, `group`, `project`) also applies; a CLI agent starts at `none` [V, `messages/policy.ts` `mayAddress`, `defaultAgentSettings`, `DEFAULT_PROJECT_SETTINGS`]. Settings that widen messaging are user tier-2 writes held in the journal, never repository settings (CFG-1) [V, `messages/settings.ts`].

### 4. The taint rule IAC-T (M-2)

- **Sticky, daemon-held, per run.** Set before the tainted content is returned to the model, never cleared, recorded in `composer_runs.tainted` (journal version 8; a trigger refuses clearing it) so a resumed run starts tainted [V, `composer/taint.ts` `createRunTaint`; `packages/journal/src/schema.ts` version 8].
- **Effect.** While set, every call above `read` needs the user's approval, whatever its floor; the hook can only raise a call and a failing hook denies [V, `packages/broker/src/policy.ts` `PolicyOptions.hook`]. The flag is bound into the challenge at issue and re-read at consume, so a challenge issued before taint no longer matches after it [V, `packages/daemon-host/src/gate/run-approvals.ts` `args.tainted`].
- **The closed source list**, a typed enum the daemon refuses to extend at runtime [V, `packages/protocol/src/taint.ts` `TAINT_SOURCES`]: (1) a delivered message from an agent, a plugin or a CLI endpoint sender; (2) a `read_messages` result containing one; (3) an excerpt received in one; (4) `read_page` of a page with non-user text not marked reviewed; (5) a run started from a task with non-user text or source; (6) plugin output; (7) integration data; (8) a task read with non-user text or source. A new source joins this list, with a gate line, before it can reach a model.
- **Wired today:** source 1, at delivery, in one transaction with the delivery row [V, `messages/delivery.ts`]. Sources 2 and 3 are PV-M4's, 4 PV-Q1's, 5 and 8 PV-T1's, 6 PV-K4's, 7 PV-N1's [D].
- **Precedence (M-2).** On, not disableable. It overrides every standing grant, auto mode, always-allow rule or future wake grant; any such grant must be built as an input to `ToolPolicy.decide`, never a path around it, so the hook still runs last (design §6.7).
- **Scope.** IAC-T governs composer runs. A CLI agent stays under its own permission model; a message from it is a taint source for any composer that receives it (sender kind `cli`).

### 5. Limits and per-sender queue quotas (M-10)

- Per agent or plugin sender: 30 sends a minute, 500 per run; per project 300 sends a minute; 60 reads a minute per agent or plugin caller; 2,000 messages per thread; 10,000 threads per project; every counter bounded at 4,096 keys [V, `messages/limits.ts` `DEFAULT_MESSAGING_LIMITS`]. The per-minute counters refuse a new key while all are live (`WindowCounter`); the per-run count forgets the longest idle run's count past 4,096 runs (`TotalCounter`), so that run could send another 500. The residual is low: runs are user-started (M-4), and the per-minute and per-project limits still hold for it (code map, divergence 12).
- **Queues (M-10).** Each recipient holds at most 200 unread messages from agents and plugins, at most 50 from one sender. When either is full the new message is **refused** (`queue_full`), never dropped, and nothing queued is evicted. The user's messages never count against a quota and are never refused for a full queue [V, `messages/service.ts` `accept`, `message-store.ts` `queued`]. The user's own inbox is a recipient like any other, so a flood from one agent to the user is bounded at 50 [V].
- **Hop.** 0 for the user; otherwise one past the larger of the run's received hop and the hop of the message replied to; past 8 is `hop_limit` [V, `messages/policy.ts` `hopOf`, `MAX_HOP = MAX_TAINT_HOP`]. Raising a run's received hop is [D]: for composer runs from what they are delivered or read (PV-M4); for CLI runs, an endpoint `read` raises the CLI run's daemon-held received hop to the highest hop it returns (PV-M6, with a gate line and a test), so a composer → CLI → new thread relay keeps counting instead of restarting at 1. Until both are built the hop bounds reply chains only, and budgets (PRV-6) remain the final bound.
- **Replies** are capped at 32 messages and 204,800 UTF-16 units of text, `threads` at 32 threads, so the worst reply fits the protocol's 1 MiB message walk [V, `messages-wire.ts` `MAX_READ_MESSAGES`, `MAX_READ_TEXT`, `MAX_THREADS_LIST`, pinned by `packages/protocol/test/contracts-messages-bounds.test.ts`].

### 6. Audit, scanning and rendering (DMN-5, DMN-6, M-6, M-11)

- Audit rows carry ids, kinds, counts and closed reasons, never text; a rate refusal is recorded once per caller and minute [V, `messages/audit.ts` `MESSAGES_PAYLOAD_ALLOWLIST`, `messages/service.ts`]. No hash of a body is recorded until the per-install key for `bodyMac` (HMAC-SHA-256) is stored somewhere decided; a plain hash is never written [V, `messages/audit.ts` header].
- The secret scan runs before accept; `refuse` by default; `warn` only when every recipient is a composer agent or the user (M-6); a scan that cannot finish refuses [V, `messages/service.ts` `accept`].
- **Text out is escaped in one place.** Bodies are stored as written and escaped on every way out by `toMessageText`: every control character except tab and line feed (so ESC, CR and C1: no OSC 52, OSC 8, title or cursor sequence), bidi, zero-width, invisible characters and lone surrogates become visible `\u{…}`, and a backslash becomes `\\`; response schemas refuse unescaped text [V, `messages-wire.ts` `REFUSED_MESSAGE_TEXT`; `daemon-host/src/messages/wire.ts`]. The bridge, the broker and the endpoint share it.
- **Rendering (M-11).** Escaped plain text in the thread view; rendered Markdown only in the isolated page frame (`extensibility.md` §5), never in the privileged renderer.
- **Composer delivery** is one block per turn boundary, framed by a per-block 16-byte nonce drawn after the bodies are stored, every body line prefixed `| `, labelled untrusted data that grants nothing, at most 8 messages and 65,536 escaped units [V, `messages/delivery.ts`; `composer/loop.ts` system text].

### 7. The CLI endpoint (M-3, M-5)

M-5: CLI agents take part in 2a, after composer-to-composer, and only with everything in this section built (PV-M6, PV-M7). Until then enabling it is refused (`bypass_entry`) for every agent [V, `messages/settings.ts`].

#### 7.1 A new local listener, outside the daemon (Option B)

- **Where.** The **pty process** (`docs/design/pty-process.md`) creates the endpoint for a CLI run it spawns, when the daemon's `spawn` carries a schema-bounded `messagesEndpoint { token }` request (no path: the pty process chooses the socket path or pipe name), and removes it when the run leaves RUNNING or when the daemon revokes it. At most one endpoint per run. The daemon mints the token. The daemon opens no listener (ADR 0003 D1.1 and DMN-4 hold).
- **Trusted projects only.** A CLI run starts only in a project that passes the trust gate (`docs/design/project-registration-and-trust.md`), so an endpoint exists only for runs of trusted projects. An untrust or a lost binding stops the project's live runs (same document, "On a revoke or a lost binding"), and a run that leaves RUNNING has its endpoint removed and its token revoked. Test line: after an untrust, an open endpoint connection and a new one with the old token are both refused.
- **Split of duties.** The pty process accepts connections, applies the transport bounds (7.4), reads peer credentials where the platform gives them, and relays each complete frame on a new, schema-bounded control-channel message tagged with the endpoint id and a relay connection id. The **daemon** checks the token in constant time, builds the caller from the endpoint's binding `{ projectId, agentId, runId }` (never from the frame) with `verified: false`, runs the message service, escapes the answer and sends it back for the pty process to frame. The token is not a pty-process decision.
- **The daemon does not trust the relay's state.** It accepts the relay message only from the supervised pty control channel. It tracks authentication per (endpoint, relay connection id) and refuses a request frame on a connection id that has not authenticated or that was closed, and any frame for an endpoint whose run is not RUNNING or whose token is revoked. It bounds the relays in flight per endpoint itself (the pty process's bound is not relied on). **Failure accounting is split:** the pty process holds the peer ids, so it keeps the per-peer backoff (7.4) and closes the connection; the daemon tells it each token failure on the relay reply, allows one `auth` attempt per relay connection id (a failure closes that connection id on the daemon's side too, so a pty process that ignored its backoff would still need a new connection per guess, under the connection bound), counts the failures per endpoint for the aggregated `message.endpoint` row, and never locks the whole endpoint, so another process cannot lock the shim out (endpoint design §3).
- **Why the pty process.** It spawns the CLI and puts the token into its environment, so it sees the token anyway; it knows the run's process group for the descendant check; and it is the planned home of the Windows native code. Until now it held no Axis secret; with this decision it **holds every live endpoint token**.
- **Residual, stated precisely.** One pty process serves every project and receives every endpoint token. A compromised pty process can therefore **send and read** as any messaging-enabled CLI agent in any project, within each endpoint's binding and that agent's send policy, including reading messages the user sent to a CLI agent that the CLI never pulled. It cannot approve, resolve or grant anything (decision 2), cannot act outside `send` and `read`, and every message it sends is labelled `verified: false` and taints composers that receive it. It can already write to those CLI terminals and kill them. Accepted.
- **NET-1.** It is not a TCP listener: "no loopback listener" in the NET-1 gate stays true for TCP. The threat-model revision (PV-R4) records the endpoint as a second local listener next to NET-1 (the first is the opt-in web host entry, which is also outside the daemon).
- **Revisit.** If PV-M6 finds the relay infeasible, moving the listener into the daemon needs a new ADR that amends ADR 0003 D1.1 and DMN-4; this ADR does not authorize it.

#### 7.2 Unix: the runtime directory

A Unix domain socket in a short, user-owned directory: `$XDG_RUNTIME_DIR/axis/` on Linux when set, else `/tmp/axis-<uid>/`; on macOS `$TMPDIR/axis/`. Short random socket names (22 characters of base64url, no extension), because `sun_path` holds 104 bytes on macOS and 108 on Linux, the terminating NUL included. **Bound:** the pty process creates the socket only when the full path is at most 100 bytes in UTF-8; when `$TMPDIR/axis/` (macOS) or `$XDG_RUNTIME_DIR/axis/` (Linux) would exceed it, it uses `/tmp/axis-<uid>/` under the same rules, and if that also exceeds it no endpoint is created and messaging is suspended for that run (fail closed, never a truncated path). [I: a usual macOS `$TMPDIR` (`/var/folders/<2>/<28>/T/`) is about 50 bytes, so the path is about 75; PV-M6 measures the worst case.] The directory is created `0700`; an existing one is used only if it is a real directory (not a symlink) owned by the user with mode `0700`, else the endpoint is not created. The shim checks the directory's owner and mode and the socket's owner before it sends the token.

**Peer checks.** Node exposes no peer credentials [I]. Decided: on Unix the `0700` directory is the access control, and PV-M6 ships without a native peer helper; the uid check and the best-effort descendant check are added where a helper exists, failing closed when present. The residual is a same-user process that finds the socket: it still needs the token, and same-user processes are outside the threat model's scope.

#### 7.3 Windows: the named pipe

A pipe name with at least 128 random bits, created with `FILE_FLAG_FIRST_PIPE_INSTANCE` (a pre-created pipe makes creation fail), `PIPE_REJECT_REMOTE_CLIENTS`, and an explicit DACL granting only the current user's SID. Node exposes none of these [I], so they need native code. Decided: **no endpoint on Windows without them.** Until the Windows native helper exists (owner decisions §6 items 2 and 3), enabling messaging for a CLI agent on Windows is refused. The shim checks the server process id (`GetNamedPipeServerProcessId`) and its user before it sends the token.

#### 7.4 Bounds

At most 4 concurrent connections per endpoint (the fifth is closed at accept); 4-byte length framing, a frame over the cap closes the connection; the first frame must be `auth`, at most 512 bytes, within 2 s; request frames at most 64 KiB, JSON depth at most 32; replies at the contract's caps (decision 5); 60 reads a minute per endpoint across its connections; sends at the per-agent limits; an idle authenticated connection closed after 10 minutes; every buffer bounded. Token failures are compared in constant time, counted only after the peer checks pass, backed off per peer process (5 failures, then 60 s) or per connection where no peer id exists, and audited as one aggregated `message.endpoint` row per endpoint per minute (endpoint design §3).

#### 7.5 The token and its residual

- 256 random bits, bound to `{ projectId, agentId, runId }` and to `send` and `read` only; never in the journal, the audit log or any log (canary). Revoked at run end, when a setting disables messaging, and at Pause of its scope: open connections close at once and later calls answer `revoked` or `paused`.
- It reaches the shim through two environment variables that the pty process adds after its PTY-5 check, from the spawn's `messagesEndpoint` request (see the amendment below).
- **Residual, stated plainly.** Every program the CLI runs inherits the environment, **including the repository's own scripts, hooks and tool servers**. The hostile repository is the main in-scope adversary, so such code can read this agent's inbox and send as this agent. The attribution proves only that the sender held the token; every endpoint message is labelled `verified: false` ("via CLI endpoint, unverified writer") and taints composers. Revisit when the OS sandbox (Phase 3) can scope child processes.

#### 7.6 The read path

Everything the endpoint returns is escaped by the daemon with `toMessageText` (decision 6), so terminal control sequences reach the CLI's terminal as inert text. The shim wraps each body in the "message from <agent> (<type>), untrusted, not from the user" label with a per-response random boundary the body cannot know, and prefixes **every** body line (as composer delivery's `| `), so no body line can begin like a header or boundary line even if the boundary leaked.

#### 7.7 Bypass configuration (M-3)

Enabling messaging for a CLI agent is a user tier-2 action per agent and is off by default. It is **refused** for a launch entry the user marked as bypassing the CLI's prompts or whose arguments match the maintained bypass-flag list [I: a flag list is incomplete by nature; the user's marking is the primary signal]. When a known CLI project-configuration file is in the worktree, Axis warns ("this CLI may act on other agents' messages without asking you, including because of files in this repository") and requires a second confirmation; the file is re-checked at each run start and messaging is suspended for that run until confirmed again if it changed. The second confirmation may add a field to `updateSettings` (PV-M7).

### 8. The kill switch

Pause per project, group or agent is a user-only tier-2 call. The daemon refuses every send, delivery and endpoint call in scope with `paused`; queued messages stay queued; nothing already read is recalled, and the UI says so [V for sends and delivery, `messages/policy.ts` `senderPaused`, `recipientPaused`; D for the endpoint].

## Owner decisions recorded here

Decided on 2026-11-21 under the owner's delegation (`owner-decisions-2026-11-21.md` §3); each can be reversed by a new row there.

| # | Decision | Taken | Where above |
|---|---|---|---|
| M-1 | Cross-group messaging | Off; per project or per pair, user tier 2 | 3.1 |
| M-2 | IAC-T | On, not disableable, over the closed list | 4 |
| M-3 | Bypass entries | Refused; warn and confirm twice for repository CLI config | 7.7 |
| M-4 | Wake on message | Not in 2a | 1 |
| M-5 | CLI participation in 2a | Yes, after composer-to-composer, with section 7 built | 7 |
| M-6 | Secret scan mode | `refuse`; `warn` only for composer and user recipients | 6 |
| M-7 | Retention | 30 days, user-configurable; audit keeps keyed hashes only | code map, "Not built" |
| M-8 | Plugins as senders | `messages.send` only, to the user, in threads the user added them to | 3.1 |
| M-9 | Thread model | Participant set, grows by user action or allowed recipient; hidden is `not_found` | 3 |
| M-10 | Queue full | Per-sender quota; refuse; never drop user or system messages | 5 |
| M-11 | Rendering | Escaped plain text; Markdown only in the isolated page frame | 6 |

## Amendment to ADR 0004

ADR 0004's decisions are not rewritten; where wording differs, this section governs.

1. **PTY-5 (implication 3, amendment item 6).** `AXIS_*` stays denied in every CLI terminal, and both PTY-5 checks stay unchanged: the daemon builds the environment with the deny-list, removing any `AXIS_*` name in any letter case [V, `packages/pty-policy/src/names.ts` `canonical`, `classifyDeniedName`], and the pty process re-checks every spawn and refuses one whose environment holds a denied name (`env_denied`) [V, `packages/pty-process/src/service.ts` `handleSpawn`]. The variables are therefore **not** in the spawn's environment. For a CLI run whose agent has messaging enabled, and only then, the spawn message carries a separate, schema-bounded `messagesEndpoint { token }` request; the pty process runs its unchanged re-check on the environment, creates the endpoint (choosing its path or pipe name), and only then **adds** exactly two names, in exactly this case, to the child's environment: `AXIS_MESSAGES_ENDPOINT` (the path or pipe name) and `AXIS_MESSAGES_TOKEN`. The PTY-5 row of `docs/design/pty-process.md` is amended accordingly; the spawn-message schema change and these tests are PV-M6 items: both names absent from every run without the request; a spawn environment that carries either name, in any case, is still refused; with the request, exactly those two names are added with the endpoint's values.
2. **Decision 10 unchanged.** Axis still never writes into a CLI agent's terminal; the UI offers "Copy message" to the clipboard only.

## Security implications

1. **New surface:** one local listener per messaging-enabled CLI run, in the pty process. Its residuals are stated in 7.1 (compromised pty process), 7.2 (same-user process without a peer helper) and 7.5 (repository code inherits the token).
2. **No new privilege:** a message carries no capability (decision 2); the recipient stays under its own governance (composer: broker, approvals, IAC-T; CLI: its own prompts).
3. **IAC-1 (confused deputy) stays a residual** for a CLI configured to auto-approve; decision 7.7 refuses marked bypass entries and warns for repository configuration but cannot see every CLI configuration.
4. **Threat rows** IAC-1 to IAC-16 (design §9) and the endpoint rows IAC-10, IAC-14, IAC-15 with the restated IAC-6 residual go into the threat model with PV-R4, with the listener location of 7.1.

## Consequences

- **Positive:** one router and one escaping path for every participant; a hostile message can at worst cause a request for the user's approval; the daemon keeps no listener.
- **Negative:** a relay message on the pty control channel and endpoint code in the pty process; CLI messaging is unavailable on Windows until the native helper ships; agents' messages stay undeliverable until PV-G3 and PV-G4 land.
- **Product:** CLI agents only pull; the user sees "unread N" and copies a message by hand.

## Validation criteria

**Accept** this ADR when the 2a messaging gate passes (PV-M8): the design's §11 lines 1 to 19 and the endpoint design's §7 lines 1 to 10, plus:

1. A CLI run with messaging enabled shows no listening socket or port owned by the daemon process; the endpoint is owned by the pty process and removed at run end.
2. A frame relayed with a wrong token, or naming another run, is refused by the daemon, and the caller is never taken from a frame.
3. On Windows without the native helper, enabling messaging for a CLI agent is refused.
4. A spawn environment carrying `AXIS_MESSAGES_ENDPOINT` or `AXIS_MESSAGES_TOKEN`, in any case, is refused by the pty process; a spawn with the `messagesEndpoint` request gets exactly those two names added.
5. A composer message at hop h read by a CLI run through the endpoint, then relayed by that CLI into a new thread, carries hop h + 1; the chain stops at hop 8.
6. After the project is untrusted, the run is stopped and its endpoint refuses an open connection and the old token.

**Revisit** if PV-M6 cannot build the relay (a new ADR then, decision 7.1), if the owner reverses any of M-1 to M-11, or when the Phase 3 OS sandbox can scope the token to the shim (7.5).

## Rollback

Before 2a ships: revert this ADR; the built slices stay user-only and serve the thread view. After: Pause per project stops every send, delivery and endpoint call at once, and turning `cliMessaging` off revokes every endpoint; removing the endpoint code leaves composer messaging intact.

## Tickets this unblocks

PV-R4 (threat-model revision), PV-M6 (needs this ADR accepted as its "PV-R3 approved" dependency) and PV-M7; it constrains PV-M4 (sources 2 and 3, received hop) and PV-M3's later slices (code map, "Not built").
