# Inter-agent communication: the CLI agent endpoint

- **Status:** Proposed (design only; nothing is built). Companion to `docs/design/inter-agent-communication.md` ("the main design"); split out after security design review 1 (items S3, S4, S5, S11, N5) to keep both files short.
- **Date:** 2026-11-06. Verified against `origin/main` at `74cd12e`; E1 (`116ef22`) and P1d (`e52114f`) have merged since.
- **Depends on:** ADR 0004 decisions 8 and 10 and implication 3 (PTY-5), `docs/security/threat-model-phase1.md` (PTY-3, PTY-5, NET-1, A10, assumption on same-user processes), `docs/design/daemon-host-plan.md` §3 Q16 (permission-bypass entries), B9 (pty process, branch `feat/pty-process`).
- **Evidence tags:** as in `product-vision-v2.md`.

## 1. Constraints that do not change

- Axis does not read a CLI's private files, does not parse undocumented output and never writes into a CLI agent's terminal (ADR 0004 decisions 8 and 10).
- So a CLI agent takes part only through **an interface it calls itself**, under its own permission model, and only by **pulling**. The dashboard shows "unread N" on its row; the UI offers **Copy message** to the clipboard, never a paste into the terminal.
- Everything the main design says about read authorization (§4.2), the taint rule (§6.6, for the composer side), limits (§7) and audit (§8) applies to endpoint callers too.

## 2. Endpoint and transport

- **Lifetime.** For a CLI run whose agent has messaging enabled (§6), the daemon creates one endpoint at run start and removes it when the run leaves RUNNING. At most one endpoint per run, and at most as many endpoints as live CLI runs.
- **Not a TCP listener.** The NET-1 gate line ("no loopback listener") still holds, but this is a new listener and ADR 0007 records it.
- **Unix (Linux, macOS).** A Unix domain socket in a **short, user-owned runtime directory**: `$XDG_RUNTIME_DIR/axis/` on Linux when set, otherwise `/tmp/axis-<uid>/`; on macOS `$TMPDIR/axis/` (per-user). Socket file names are short random ids. Reason: `sun_path` is limited to 104 bytes on macOS and 108 on Linux, and paths under the app data directory can exceed it (review N5) [I: measure the worst-case `$TMPDIR` length]. The daemon creates the directory with mode `0700`; if it exists, the daemon refuses to use it unless it is a real directory (not a symlink) owned by the user with mode `0700`.
- **Windows.** A named pipe with a random name (at least 128 bits), created with `FILE_FLAG_FIRST_PIPE_INSTANCE` so a pre-created (squatted) pipe makes creation fail, `PIPE_REJECT_REMOTE_CLIENTS`, and an explicit DACL granting only the current user's SID (review S4) [I: Node `net` does not expose these flags or the DACL; a small native helper, or hosting the pipe in the pty process with its native code, is needed and must be verified].
- **Peer checks (defence in depth).** On accept, the daemon reads the peer's credentials (`SO_PEERCRED` on Linux, `getpeereid` and `LOCAL_PEERPID` on macOS, `GetNamedPipeClientProcessId` on Windows), refuses another uid, and refuses a peer process that is not a descendant of the run's pty process tree. Descendant checks are best-effort (a double-forked or re-parented child fails them; the check fails closed) [I: Node does not expose peer credentials; same native-helper caveat].
- **Shim checks before sending the token.** On Unix the `axis-messages` shim checks that the socket's directory is owned by the user with mode `0700` and that the socket is owned by the user. On Windows it checks the server process id (`GetNamedPipeServerProcessId`) and that the server runs as the user. It never sends the token otherwise.

## 3. Bounds (review S3)

| Bound | Default |
|---|---|
| Concurrent connections per endpoint | 4; the fifth is closed at accept |
| Framing | 4-byte length prefix; frames over the cap close the connection |
| Pre-authentication | the first frame must be `auth` with the token, at most 512 bytes, within 2 s; otherwise the connection is closed |
| Request frame | at most 64 KiB; JSON depth at most 32 |
| Response | a read returns at most 50 messages and 256 KiB (the main design §7.1) |
| Reads | 60 per minute per endpoint, shared by all its connections |
| Sends | the main design's per-agent limits |
| Authentication failures | compared in constant time; counted only **after** the peer checks of §2 pass (so another uid or a process outside the run's tree cannot lock the shim out); backoff is per peer process id (5 failures, then that peer is refused for 60 s), not for the whole endpoint; where peer checks are unavailable, the per-peer backoff uses the connection and the residual is stated (review 2, N-D); audited as one aggregated `message.endpoint` row per endpoint per minute (count, first and last time), never one row per attempt |
| Revocation | at run end, at a settings change that disables messaging, or at Pause of its scope: open connections are closed at once and later calls answer `revoked` or `paused` |

All per-connection buffers are bounded; an idle authenticated connection is closed after 10 minutes.

## 4. The token and its residual (review S4)

- 256 random bits, bound to `{ projectId, agentId, runId }` and to the methods `send` and `read`; never written to the journal, the audit log or any log (a canary test checks this); revoked as in §3.
- **How it reaches the shim.** The endpoint address and the token are set as two variables in the CLI's environment after the PTY-5 deny-list. **PTY-5 amendment needed:** `AXIS_*` is denied today [V, `packages/pty-policy/src/names.ts`]; the amendment admits exactly two names, only for runs with messaging enabled, and the PTY-5 test asserts they are absent otherwise.
- **Residual, stated honestly.** The environment is inherited by **every program the CLI runs, including the repository's own scripts** (tests, build scripts, hooks, tool servers the repository configures). The hostile repository is the main in-scope adversary, so this is not only a "same-user process" concern. Such code can read this agent's inbox and send as this agent. The added privilege is small (that code already runs as the user and can do more than send messages), but **the attribution proves only that the sender held the token**.
- **Labelling.** Every endpoint-originated message carries `verified: false`; the thread view and the audit show it as "via CLI endpoint, unverified writer". The taint rule treats it as a source like any agent message.
- **Alternatives considered.** A file passed by path has the same exposure. A token handed only to the shim through the CLI's own tool configuration would avoid the environment but would put a long-lived secret in a config file; not chosen. Revisit when the OS sandbox (Phase 3) can scope child processes.

## 5. Escaping the read path (review S5)

- The daemon escapes everything the endpoint returns with the display rules (`displayTextSchema`): C0 and C1 control characters except newline and tab, bidirectional controls and invisible characters become visible escapes. A body with `ESC ] 52` (clipboard write), `ESC ] 8` (hyperlinks), title sequences or cursor movement reaches the CLI, and so its terminal, as inert text.
- The shim wraps every body in the same "message from <agent> (<type>), untrusted, not from the user" label the composer uses, with a per-response random boundary the body cannot know.
- Names and thread titles are escaped the same way.

## 6. Enabling messaging for a CLI agent (review S11)

- Off by default; enabling is a user tier-2 action per agent.
- **Refused** for an `axis.cliAgents` entry the user marked as bypassing the CLI's prompts, or whose arguments match the maintained bypass-flag list (plan Q16) [I: a flag list is incomplete by nature; the user's marking is the primary signal].
- **CLI configuration can auto-approve too**, including configuration files **in the repository**. The enable dialog states: "This CLI may act on other agents' messages without asking you, depending on its own configuration, including files in this repository." When a known CLI project-configuration file exists in the worktree (these paths are already in the protected set), Axis shows a warning and requires a second confirmation (M-3); the file's presence is re-checked at each run start and messaging is suspended for that run until confirmed again if the file changed.
- The dashboard row of a CLI agent with messaging on says so in text.

## 7. Proposed gate lines (Phase 2a)

1. A CLI run without messaging enabled has neither endpoint variable in its environment (PTY-5 test extended).
2. After the run ends, an **already-open** shim connection and a new connection with the old token are both refused; Pause makes open connections answer `paused`.
3. A fifth concurrent connection is closed; a connection that sends no `auth` frame within 2 s, or a frame over the cap, is closed; a 64 KiB+ unframed write before authentication does not grow daemon memory beyond the frame cap.
4. A read loop is limited to 60 per minute and each response to the caps; 1,000 bad-token attempts produce at most one aggregated audit row per minute.
5. A message containing `ESC ] 52`, `ESC ] 8` and a bidirectional override is returned escaped through the endpoint and wrapped in the label.
6. The endpoint token appears nowhere in the journal, the audit log, daemon logs or crash output (canary).
7. Unix: a pre-existing socket directory with mode `0755`, another owner or a symlink is refused by the daemon and by the shim. Windows: a pre-created pipe of the same name makes endpoint creation fail, and a client of another user is refused.
8. A peer whose uid differs, or that is not in the run's process tree, is refused (where the platform check is available; skipped with a recorded reason otherwise).
9. Enabling messaging for a marked bypass entry is refused; with a known CLI project-configuration file in the worktree, enabling needs the second confirmation.
10. The thread view and the audit show endpoint messages as unverified.

## 8. Items for ADR 0007 and the threat-model revision

- Record the endpoint as a new local listener next to NET-1, and the PTY-5 amendment.
- Decide the native helper for peer credentials and Windows pipe flags (§2), or accept their absence with the residual stated.
- Threat rows: IAC-10, IAC-14, IAC-15 and the restated IAC-6 residual (main design §9).
