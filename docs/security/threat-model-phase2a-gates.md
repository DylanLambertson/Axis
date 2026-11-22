# Threat model: Phase 2a gate lines, numbered, with the ticket that proves each

- **Status:** Draft for review (ticket PV-R4). Companion to `threat-model-phase2a.md`.
- **Date:** 2026-11-22. **Code baseline:** `origin/main` at `9ddc55b`.
- **What this is.** The 2a gate (`docs/ROADMAP.md`, Phase 2a) is "the gate lines in `inter-agent-communication.md` §11, `inter-agent-cli-endpoint.md` §7 and `extensibility.md` §9 (2a items) pass". ADR 0007 and ADR 0010 add validation criteria that are security gate lines too. This file numbers them all once as **2a/Ln**, so the threat rows and the register can cite them, and names the ticket whose tests must prove each line. The wording of a line is its source's; where this file shortens it, the source wins.
- **Numbering.** L1 to L19 keep the numbers of the messaging design §11; L20 to L29 are the endpoint design §7 lines 1 to 10; L30 to L40 are ADR 0007's (validation criteria and the decisions they test); L41 to L49 are the pages and tasks lines of `extensibility.md` §9 and ADR 0010. New lines are appended, never renumbered.
- **State** is what exists on `9ddc55b`: **Evidence** (a merged test already covers the daemon half; the line still needs its full run), **Partial** or **Open**. PV-M8 collects the evidence for the whole gate.

## 1. Messaging (messaging design §11)

| Line | Gate line (short) | Threats | Proved by | State |
|---|---|---|---|---|
| 2a/L1 | A composer's `send_message` to another group is refused by default and audited with both ids | IAC-8, HOME-1 | PV-M4 (tool), PV-M3 (policy) | Partial: the service refuses it for an attested agent caller [`daemon-host/test/messages-send.test.ts`]; no agent reaches the service until PV-G3 and PV-M4 |
| 2a/L2 | A body holding a challenge id, a digest or "approved" changes no approval; an agent connection calling `axis.approvals/1.resolve` is denied | IAC-3 | PV-M8 (DMN-3 re-run with messaging on) | Open |
| 2a/L3 | After a composer run receives an agent message, its next side-effecting call needs approval and the card lists the message | IAC-2, IAC-3 | PV-M3 slice 2, PV-M4 | Partial: delivery taints the run [`messages-delivery.test.ts`] |
| 2a/L4 | Two composers replying to each other stop at hop 8 with a user notice and no further provider request; a page or task relay carries the hop | IAC-5 | PV-M4, PV-Q1, PV-T1, PV-M3 later (notice) | Partial: `hop_limit` on reply chains |
| 2a/L5 | A planted secret in a body or excerpt is refused and appears nowhere (canary); excerpts of `.env`, a gitignored file, a WT-3 path and their case, alias, NFD, 8.3, trailing-dot, stream and symlink forms are refused before the scan | IAC-7, IAC-11 | PV-M3 later (excerpts) | Partial: body scan |
| 2a/L6 | (pointer) The endpoint lines are 2a/L20 to L29 | | | |
| 2a/L7 | Pause blocks sends, deliveries and endpoint calls in its scope within one request, plugins included; resume restores; both audited | IAC-12 | PV-M3, PV-M6 | Partial: sends and deliveries |
| 2a/L8 | Control and bidirectional characters are escaped in the thread view, in composer delivery and on the CLI read path | IAC-4, IAC-14 | PV-M5, PV-M6 | Partial: `toMessageText` and delivery [`contracts-messages-text.test.ts`] |
| 2a/L9 | No message crosses a project, through a group id or thread id either; recipients spanning projects are refused | IAC-8 | PV-M3, PV-G3 | Partial: in the service [`messages-send.test.ts`] |
| 2a/L10 | An agent and a CLI token of group 1 reading or posting into a group-2 thread get `not_found` identical to an unknown id, audited; `threads` lists only the caller's | IAC-13 | PV-M3 (built for the service), PV-M4, PV-M6 | Partial: structural identity [`messages-read.test.ts`] |
| 2a/L11 | Taint, one line per source: `read_messages` then `write_file` in the same reply; `read_page` of an agent-revised page (also after a later user edit); a run started from an agent-edited or imported task; a task read; plugin output; integration data; an always-allow does not bypass it | IAC-2, PAG-2, TSK-2 | PV-M4, PV-Q1, PV-T1 (2a); PV-K4, PV-N1 (4a sources) | Partial: the core per source through `taintSources` |
| 2a/L12 | A flood from one sender is refused at its quota; the user's earlier message is still delivered; one user notice | IAC-16 | PV-M3 (notice later) | Partial: refuse at quota |
| 2a/L13 | The transitive minter walk fails if a minter is reachable from the message binding | DMN-3 | PV-M3 later | Open |
| 2a/L14 | A message accepted under a cross-group setting is not delivered after it is turned off; a send into an old thread is refused for the recipient no longer allowed; `accepts from: none` gets nothing | IAC-8, HOME-3 | PV-M3 slice 2, PV-G4 | Partial: delivery re-check |
| 2a/L15 | With lowered limits, rings, inboxes and replies stay at their caps and count drops | IAC-9 | PV-M3 | Partial [`messages-delivery-limits.test.ts`] |
| 2a/L16 | A message past retention is purged; its audit events remain with keyed hashes only | IAC-9 | PV-M3 later | Open |
| 2a/L17 | The audit holds no plain hash of a body; a scan-refused send has no body hash | IAC-7 | PV-M3 later; open item O-1 | Holds trivially (no hash is written) |
| 2a/L18 | A challenge issued before taint and consumed after it needs the user's approval under IAC-T | IAC-2 | PV-M0 | Evidence [`daemon-host/test/composer-taint.test.ts`] |
| 2a/L19 | A tainted run taken up again needs approval for its first side-effecting call with no new receipt | IAC-2 | PV-M0, PV-M4 | Partial: recorded flag seeds the run |

## 2. The CLI endpoint (endpoint design §7)

| Line | Gate line (short) | Threats | Proved by | State |
|---|---|---|---|---|
| 2a/L20 | A CLI run without messaging has neither endpoint variable (PTY-5 test extended) | IAC-19 | PV-M6 | Open (no variable exists) |
| 2a/L21 | After run end an open shim connection and a new one with the old token are refused; Pause makes open connections answer `paused` | IAC-12 | PV-M6 | Open |
| 2a/L22 | A fifth connection is closed; no `auth` within 2 s or an oversized frame closes; a 64 KiB unframed write before auth does not grow memory past the frame cap | IAC-15 | PV-M6 | Open |
| 2a/L23 | Reads limited to 60 a minute and replies to the caps; 1,000 bad tokens give at most one aggregated audit row a minute | IAC-15 | PV-M6 | Open |
| 2a/L24 | A body with `ESC ] 52`, `ESC ] 8` and a bidi override comes back escaped through the endpoint and inside the label | IAC-14 | PV-M6, PV-M7 | Open |
| 2a/L25 | The token appears in no journal, audit row, log or crash output (canary) | IAC-6 | PV-M6 | Open |
| 2a/L26 | Unix: a socket directory with mode `0755`, another owner or a symlink is refused by the pty process and the shim. Windows: a pre-created pipe makes creation fail; another user's client is refused | IAC-10 | PV-M6, PV-M7 | Open |
| 2a/L27 | A peer of another uid or outside the run's tree is refused where the check exists; skipped with a recorded reason otherwise | IAC-10 | PV-M6 | Open (no helper on Unix, ADR 0007 §7.2) |
| 2a/L28 | Enabling messaging for a marked bypass entry is refused; with a known CLI project-configuration file, enabling needs a second confirmation | IAC-1 | PV-M7 | Partial: enabling is refused for every agent |
| 2a/L29 | The thread view and the audit show endpoint messages as unverified | IAC-6, IAC-18 | PV-M5, PV-M6 | Open |

## 3. ADR 0007

| Line | Gate line (short) | Threats | Proved by | State |
|---|---|---|---|---|
| 2a/L30 | A CLI run with messaging shows no listening socket or port owned by the daemon; the endpoint belongs to the pty process and is removed at run end | TB14, TB15 | PV-M6 | Open |
| 2a/L31 | A relayed frame with a wrong token, or naming another run, is refused by the daemon; the caller is never taken from a frame | IAC-6, IAC-17 | PV-M6 | Open |
| 2a/L32 | The shim's label has a per-response boundary and prefixes every body line (a line ends only at LF); a body line starting with `| ` or the boundary is prefixed again | IAC-4, IAC-14 | PV-M7 | Open |
| 2a/L33 | A composer message at hop h read by a CLI run and relayed into a new thread carries h + 1; the CLI run's received hop is per run and never lowered; the chain stops at 8 | IAC-5 | PV-M6 | Open |
| 2a/L34 | On Windows without the native helper, enabling messaging for a CLI agent is refused | IAC-10 | PV-M6 | Partial: refused everywhere today |
| 2a/L35 | The enable dialog states that the CLI may act on messages without asking; a changed CLI project-configuration file suspends messaging for the run until confirmed again | IAC-1 | PV-M7 | Open |
| 2a/L36 | An endpoint `send` is recorded with the endpoint's agent and run and `verified: false`, in the message and in `message.send` | IAC-6 | PV-M6 | Open |
| 2a/L37 | The daemon refuses: a frame on an unauthenticated or closed relay connection id; a frame for a run not RUNNING or a revoked token; a relay from any other channel; the fifth relay in flight; a second auth after a failed one; an endpoint id it did not mint | IAC-17 | PV-M6 | Open |
| 2a/L38 | A spawn environment carrying `AXIS_MESSAGES_ENDPOINT` or `AXIS_MESSAGES_TOKEN`, in any case, is refused; with the request exactly those two names are added | IAC-19 | PV-M6 | Partial: every `AXIS_*` name is refused [`env-scrub.test.ts`] |
| 2a/L39 | An endpoint path over 100 bytes falls back to `/tmp/axis-<uid>/`, then refuses; no path is ever truncated | IAC-10 | PV-M6 | Open |
| 2a/L40 | After the project is untrusted, the run is stopped and its endpoint refuses an open connection and the old token | IAC-20, TRU-2 | PV-M6 with trust design S1b | Open |

## 4. Pages and tasks (`extensibility.md` §9 2a; ADR 0010)

| Line | Gate line (short) | Threats | Proved by | State |
|---|---|---|---|---|
| 2a/L41 | A page with raw HTML, a script tag, an `onerror` attribute or a remote image renders inert; a `file:` link is refused (ADR 0010 criterion 1) | PAG-1 | PV-Q2 | Open |
| 2a/L42 | A mutation-XSS corpus page cannot reach the bridge: no port exists and a probe calling `axis.approvals/1.resolve` from the view fails; Trusted Types reports no violation in the host renderer (criterion 2) | PAG-3 | PV-Q2 | Open |
| 2a/L43 | An SVG attachment and a PNG-named file that sniffs as HTML are refused (criterion 3) | PAG-1, PAG-3 | PV-Q2 | Open |
| 2a/L44 | A task imported or written by an agent never reaches a run without the user's Start; Start of an agent-edited task taints the run; page and task writes by agents are audited with the agent id | TSK-1, TSK-2 | PV-T1, PV-T2, PV-Q1 | Open |
| 2a/L45 | `read_page` of a page with an agent revision taints the run, also after a later user edit; a version the user marked reviewed does not (criterion 4) | PAG-2 | PV-Q1 | Open |
| 2a/L46 | `write_page` needs approval, is attributed to the agent and records the hop (criterion 6) | PAG-2, IAC-5 | PV-Q1 | Open |
| 2a/L47 | Every page limit of ADR 0010 decision 1 is enforced; a write over it is refused (criterion 5) | IAC-9 | PV-Q1 | Open |
| 2a/L48 | Removing a project deletes its page store after the confirmation, audited (criterion 7) | | PV-Q1 | Open |
| 2a/L49 | No page file appears in a repository unless the user exports it (criterion 8) | | PV-Q1, PV-Q2 | Open |

## 5. Reading the gate against the register

A line is **ready for review** only when every register row that names it (register §1.3) is Accepted, Deferred or closed, and the open items of `threat-model-phase2a.md` §6 that name its threat are decided. L17 cannot be met as worded before open item O-1 is decided; L28, L35 and L44 depend on O-3 and on the UI tickets.
