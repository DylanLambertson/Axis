# The `axis-messages` shim (PV-M7 slice 2): design note

- **Status:** Proposed, for review before any code. Builds on `inter-agent-cli-endpoint.md` (sections 2 to 6) and `messages-contract.md` (sections 12 to 14). Off by default; nothing here turns messaging on by itself.
- **Scope:** the stdio program a CLI starts to reach its run's endpoint, the user's setup of it, and the one way messaging is switched on in production (decision 2 of 2026-11-27).

## 1. What it is

A small Node program, `axis-messages`, that a CLI starts as an MCP server over stdio. It reads `AXIS_MESSAGES_ENDPOINT` and `AXIS_MESSAGES_TOKEN` from its own environment (the pty process sets both for a run with messaging on, `messages-contract.md` section 13). It then offers the CLI exactly two tools, `read_messages` and `send_message`, and relays each call as one frame to the endpoint.

It holds no state between calls, writes no file and opens no TCP socket.

## 2. Package layout

- **Package.** A new package, `packages/axis-messages`.
  - Its only runtime dependency is `@axis/protocol`, for the endpoint frame and reply schemas, so the shim and the daemon cannot disagree on a shape.
  - **Nothing from the daemon's internals:** no `@axis/daemon-host`, `@axis/pty-process`, journal or broker import. An import lint rule enforces it, the same kind of rule as the pty-process client boundary.
  - It has no MCP SDK: the server side of MCP over stdio is small (initialize, `tools/list`, `tools/call`, JSON-RPC framing), and a hand-written one keeps the supply chain at zero.
- **Files.**
  - `src/stdio.ts`: MCP framing, a bounded line reader, one request at a time.
  - `src/endpoint.ts`: the socket client, the checks of section 4, auth, one frame per call.
  - `src/label.ts`: section 5.
  - `src/main.ts`: the `bin` entry.
- **Ships with the app** as a single bundled file. It is not published to a registry.
- **Bounds.** It refuses a frame or a reply over the endpoint's bounds before sending (64 KiB per frame, a 1 MiB reply). Every failure answers a fixed message naming its closed reason.

## 3. The two tools

| Tool | Input | Endpoint frame | Output to the model |
|---|---|---|---|
| `read_messages` | optional `threadId`, `afterSeq`, `limit` (the contract's bounds) | `{ op: "read", id, ... }` | each message wrapped by section 5, oldest first, and `more` |
| `send_message` | `recipients` (agents or groups by id), `body` (text, the contract's bound), optional `threadId`, `inReplyTo` | `{ op: "send", id, ... }` | the new message's ids and hop, or the closed refusal |

- No other tool, no resources, no prompts.
- The tool descriptions are fixed text. They never include anything from a message or from the daemon.

## 4. Checks before the token leaves (Unix)

- **Before connecting.** `lstat` the endpoint's directory. It must be a real directory (not a link), owned by the shim's uid, with mode exactly `0700`. The socket file must be owned by the same uid. The path must lie inside the runtime directory the endpoint design names. If any check fails, the shim refuses with no connection and no token sent (`endpoint_untrusted`).
- **The server proves itself first (the server-process check).** Node exposes no peer credentials, on either side (RR-90), so the server is checked by what it knows instead of by its pid:
  1. The shim connects and sends `{ op: "hello", nonce }`, a fresh 128-bit nonce.
  2. The daemon answers `{ proof: HMAC-SHA256(key = SHA-256(token), nonce) }`. It already holds only the token's digest, and that digest is the key.
  3. The shim computes the same value. Only if it matches does it send `{ op: "auth", token }`.

  A listener that is not the daemon which minted this endpoint (a squatted socket, another same-user process) cannot answer, and never sees the token. This adds one frame type to the relay, a small daemon change in this slice: `hello` is accepted only as a connection's first frame and answers only the proof.
- **One connection per call.** After `auth` the shim sends the call's frame. The connection serves one tool call and is closed after the reply, so a long-lived connection never outlives a revocation.
- **Windows.** No endpoint exists there in 2a (decision 8): the daemon's mint refuses on win32, so no run gets the variables. The shim, if started anyway, answers `endpoint_unavailable`.

## 5. The label wrapper

- **Per response.** For each response the shim draws a random 128-bit boundary (`crypto.randomBytes(16)`, hex) and wraps every message body as below. The body arrives already escaped by the daemon (endpoint design section 5). The shim does not escape again, and it never decodes.

  ```
  <<message boundary=B>> from <name> (<kind>), untrusted, not from the user
  <body>
  <<end boundary=B>>
  ```

- **Same rule as the composer.** This is the label and the per-response boundary the composer's delivery block uses, so a body cannot close its own block: it cannot know B. Names and thread titles come escaped by the daemon too.
- **Unverified sender.** An endpoint message's sender is marked unverified by the daemon (`verified: false`). The label carries `(unverified)` for it.

## 6. Setup: how a user registers it per CLI

Axis writes no CLI configuration. Repository CLI files are protected (`CLI_PROJECT_CONFIG`), and writing a user's own CLI configuration is not Axis's to do. The enable flow instead shows the user one command to run, for user scope:

- **Claude Code (2.1.332):** `claude mcp add --scope user axis-messages -- <path to axis-messages>`.
- **Codex (0.166.0):** `codex mcp add axis-messages -- <path to axis-messages>`.

The token and endpoint are NOT put in that registration; the shim reads them from its environment at each start.

**What the enable flow shows when the rule refuses** (the closed reasons of `messages-contract.md` section 14, which the shell turns into words, never prose from the daemon):

- **`bypass_entry`:** the entry is marked as bypassing prompts, or uses a bypass flag.
- **`unknown_flag`:** the entry uses a flag outside the safe list; change it, or keep messaging off.
- **`config_unparsed`, `wrapper_unparsed`, `env_assignment`, `config_home`:** the launch cannot be judged.
- **`real_path_unresolved`:** the executable cannot be found as given.
- **`too_many_repo_files`:** more CLI configuration files in the repository than one confirmation can list.
- **`empty_argv`:** the entry is empty.
- **The two-step's warnings:** each CLI configuration file found, for the second confirmation.

**Open, verify before code:** does each CLI pass its own environment (the run's `AXIS_MESSAGES_*`) to a stdio MCP server it starts? Both CLIs take explicit `--env` values for a server, but their help does not say whether the parent environment is inherited.

- **The probe.** In a scratch home, with no login and the network routed to a dead proxy, register a tiny server that reports its environment, and start each CLI with `AXIS_MESSAGES_ENDPOINT` set.
- **If one CLI does not pass it,** the setup for that CLI names the two variables to pass through. Its config file format (user scope only) decides how; the token itself is never written to a file.

## 7. Switching messaging on in production (decision 2)

Production stays off. The one way on is a user-scope setting flipped through a **tier 4, natively confirmed** action:

- **A new method.** `axis.messages/1.setCliEndpointEnabled { enabled }`.
  - It is user-only, tier 4, side effect `privileged`, with an `approval`.
  - Its native dialog names what turning it on allows: CLI runs whose workers are enabled one by one get an endpoint.
  - Turning it off is tier 1 (it only lowers privilege) and needs no dialog.
- **Where it lives.** A single journal row, `messaging_cli_endpoint` (user writer, insert once and then update, audited). It is read at daemon start in place of today's composition flags, which always pass false.
- **Turning it off takes effect at once.** Every live endpoint is revoked, the same path as a worker's setting turned off.
- **Turning it on takes effect for runs started afterwards.**
- **The per-worker enable** (`cliMessaging`, its rule and its second step) stays as it is, and only matters while this switch is on.

## 8. Acceptance for gate lines 5 and 7

- **Gate line 5** (escaped through the endpoint and wrapped in the label). A message holding `ESC ] 52`, `ESC ] 8` and a bidirectional override goes end to end, from a send through the relay to a `read_messages` result. The result shows those characters as visible escapes, inside one block whose boundary the body does not contain. A body that contains a forged `<<end boundary=...>>` stays inside its block.
  - **Mutants:** the shim skipping the wrapper; a fixed boundary instead of a random one; the daemon not escaping. Each must fail the test.
- **Gate line 7** (Unix: a bad socket directory is refused by the daemon and by the shim). The daemon half exists (PV-M6 slice 2). The shim half: with a `0755` directory, a directory of another owner, a linked directory, a socket of another owner, or a path outside the runtime directory, the shim refuses before connecting, and a fake listener never receives a token. A listener that cannot answer `hello` never receives the token either.
  - **Mutants:** each check removed; the token sent before the proof is checked; the proof compared without the nonce. Each must fail.

## 9. Other tests the slice will carry

- **Shim unit tests (no CLI needed):**
  - the 0700 and owner checks refuse a `0755` directory, a link and another owner, before any connect;
  - the token is sent only after the checks pass;
  - the label wraps every body, and a body containing a forged end marker stays inside;
  - a reply over the bounds is refused;
  - MCP framing handles an oversized line, an unknown method and a second request in flight.
- **End to end over the real pty process and relay** (the PV-M6 slice 2 rig): auth, send, read, the label, and revocation at run end.
- **The section 6 probe**, recorded with its versions.
- **The switch:** tier 4 with native confirmation on, tier 1 off, off revoking live endpoints, and production composition reading the row.

## 10. Not here

- Windows (decision 8).
- Messaging while BLOCKED (decided: revoked).
- The shell's enable dialog and its display of unverified senders (shell tickets).
- PV-M8's gate evidence.
