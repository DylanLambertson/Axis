# The `axis-messages` shim (PV-M7 slice 2): design note

- **Status:** Proposed shim; no `packages/axis-messages` package is merged. PV-M7's enable rules and user-controlled CLI endpoint switch are built (`packages/daemon-host/test/messages-enable-check.test.ts`, `messages-cli-switch.test.ts`, `packages/journal/test/migration-v20.test.ts`). Setup copy and the full Phase 2a gate review remain open.
- **Builds on:** `inter-agent-cli-endpoint.md` (sections 2 to 6), `messages-contract.md` (sections 12 to 14) and ADR 0007 section 7.6.
- **Off by default.** Nothing here turns messaging on by itself.
- **Scope:** the stdio program a CLI starts to reach its run's endpoint, the user's setup of it, and the one way messaging is switched on in production (decision 2 of 2026-11-27).

## 1. What it is

A small Node program, `axis-messages`, that a CLI starts as an MCP server over stdio.

- It reads `AXIS_MESSAGES_ENDPOINT` and `AXIS_MESSAGES_TOKEN` from its own environment. The pty process sets both for a run with messaging on (`messages-contract.md` section 13).
- It offers the CLI exactly two tools, `read_messages` and `send_message`, and relays each call as one frame to the endpoint.
- It holds no state between calls and writes no file. Its only socket is the client connection to its own run's endpoint.

## 2. Package layout and what it imports (review 1 S1)

- **A new package, `packages/axis-messages`.**
  - It has a staging-compatible `src/index.ts` (the package's `exports["."]`), a root `tsconfig` reference and its entry in `docs/packages.md`.
  - It has no MCP SDK: the server side of MCP over stdio (initialize, `tools/list`, `tools/call`, JSON-RPC framing) is small, and a hand-written one keeps the supply chain at zero.
  - Its files:
    - `src/stdio.ts`: framing, a bounded line reader, one request at a time.
    - `src/endpoint.ts`: the socket client, section 4's checks, auth, one frame per call.
    - `src/framing.ts`: section 5, re-exported from `@axis/protocol`.
    - `src/main.ts`: the `bin` entry.
- **It imports only `@axis/protocol`, and nothing from the daemon's internals** (no `daemon-host`, `pty-process`, journal or broker). An import-lint rule for this package enforces it. Three things move into `@axis/protocol` so both sides consume one definition:
  - the endpoint's frame schema and its reply schemas (today `endpointFrame` and the reply shapes live in `daemon-host/src/messages/endpoint.ts`);
  - the closed endpoint and shim refusal reasons;
  - the pure framing functions of section 5 (today `framed` and `prefixed` in `daemon-host/src/messages/delivery.ts`).
- **One narrow socket exception.** The repository allows `node:net` only in the pinned pty listener template (`web-rules.mjs` rule 1, RR-89). The shim needs an outbound Unix-socket client:
  - a second pinned template, `axis-messages/src/endpoint-connect.ts`, hash-pinned the same way, that only connects to an absolute path;
  - the existing listener rule stays as it is, and is not weakened globally;
  - the desktop daemon and main bundles must not contain the shim (a bundle-graph check, like the one that keeps the listener template out of them).
- **Shipped as part of the app:** a single bundled file with a launcher the setup command points at. It is not published to a registry.
- **Bounds.** It refuses a frame or a reply over the endpoint's bounds before sending (64 KiB per frame, a 1 MiB reply). Every failure answers a fixed message naming its closed reason.

## 3. The two tools

| Tool | Input | Endpoint frame | Output to the model |
|---|---|---|---|
| `read_messages` | optional `threadId`, `afterSeq`, `limit` (the contract's bounds) | `{ op: "read", id, ... }` | the messages framed by section 5, oldest first, and `more` |
| `send_message` | `recipients` (agents or groups by id), `body` (text, the contract's bound), optional `threadId`, `inReplyTo` | `{ op: "send", id, ... }` | the new message's ids and hop, or the closed refusal |

- No other tool, no resources, no prompts.
- The tool descriptions are fixed text. They never include anything from a message or from the daemon.

## 4. Checks before the token leaves (Unix), and what they do not prove (review 1 B2)

- **Before connecting.**
  - `lstat` the endpoint's directory: it must be a real directory (not a link), owned by the shim's uid, with mode exactly `0700`.
  - The socket file must be owned by the same uid.
  - The path must lie inside the runtime directory the endpoint design names.
  - If any check fails, the shim refuses with no connection and no token sent (`endpoint_untrusted`).
- **Then it authenticates.** The shim connects, sends `{ op: "auth", token }` once, then the call's frame. One connection serves one tool call and is closed after the reply, so a connection never outlives a revocation.
- **What these checks do NOT prove.**
  - They keep other users out: the directory is `0700` and theirs.
  - They do not prove which process is listening. A process of the same user can replace the socket in that directory, by renaming the real one and binding its own at the path, and so receive the token. Node exposes no peer credentials on either side.
  - This is the accepted residual RR-90. Endpoint gate line 8 stays a recorded skip.
  - A server proof over a nonce does not close it, because a same-user intermediary can relay the challenge to the real listener. The earlier proposal of one is withdrawn.
  - A stronger session, one that never releases a reusable token to an intermediary, would be a separate reviewed design.
- **Windows.** No endpoint exists there in 2a (decision 8): the daemon's mint refuses on win32, so no run gets the variables. The shim, if started anyway, answers `endpoint_unavailable`.

## 5. Framing what the model reads (review 1 B1)

The shim frames a `read_messages` result with **the same framing contract as the composer's delivery** (ADR 0007 section 7.6, gate 2a/L32). That is the pure `framed` function, moved into `@axis/protocol` (section 2):

- **A fresh nonce per response.** A 128-bit nonce (`crypto.randomBytes(16)`) is drawn for each response.
- **Fixed frame lines.** An opening line, then per message a header line Axis writes (`[axis-message <n> <nonce>] from <name> (<kind>), untrusted, not from the user`, with `(unverified)` for an endpoint sender), the body, an end line, and a closing line.
- **Every body line prefixed.** Every LF-delimited body line starts with `| `, including an empty line, a line that already starts with `| `, and a line that looks like a header or a boundary. So no body line can begin like a frame line, even if the nonce were known.
- **No decoding.** The shim splits only on LF and never decodes. The body arrives already escaped by the daemon (endpoint design section 5), where CR, NEL, VT, FF, U+2028 and U+2029 are already visible escapes. Names and thread titles are escaped by the daemon too.

## 6. Setup: registering it with a CLI (review 1 B4)

Axis writes no CLI configuration. Repository CLI files are protected (`CLI_PROJECT_CONFIG`), and a user's own CLI configuration is not Axis's to write.

- **The enable flow shows a command.** It shows the user the CLI's own add-server command, at user scope, naming `axis-messages` and the launcher path.
- **The exact command lines** per CLI and version, with the probe below, are kept as evidence outside this tracked note, not in the design.
- **No secrets in the registration.** The token and endpoint are NOT put in it; the shim reads them from its environment at each start.

**What the enable flow shows when the rule refuses.** These are the closed reasons of `messages-contract.md` section 14. The shell turns each into fixed words, never daemon prose:

- **`bypass_entry`:** the entry is marked as bypassing prompts or uses a bypass flag, **or** the launch could not be checked at all (no launch entry from main, no check installed) (review 1 N2). Its words name both: "this entry bypasses prompts, or could not be checked".
- **`unknown_flag`:** the entry uses a flag outside the safe list; change it, or keep messaging off.
- **`config_unparsed`, `wrapper_unparsed`, `env_assignment`, `config_home`:** the launch cannot be judged.
- **`real_path_unresolved`:** the executable cannot be found as given.
- **`too_many_repo_files`:** more CLI configuration files in the repository than one confirmation can list.
- **`empty_argv`:** the entry is empty.
- **The two-step's warnings:** each CLI configuration file found, for the second confirmation. `repo_config_unacknowledged` is a mint audit rule, not an enable answer.

**Open, verify before code:** does each CLI pass its own environment (the run's `AXIS_MESSAGES_*`) to a stdio MCP server it starts? Each CLI's add-server command takes explicit environment values, but its help does not say whether the parent environment is inherited.

- **The probe.** In a scratch home, with no login and the network routed to a dead proxy, register a tiny server that reports its environment, then start the CLI with the variables set. It runs only after this note is approved.
- **If a CLI does not pass it,** the setup for that CLI names the two variables to pass through, at user scope; the token is never written to a file.

## 7. Switching messaging on in production (decision 2; review 1 B3 and S2)

Production stays off. The one way on is a user-scope setting, turned on through a tier 4 natively confirmed action. Two methods, because one method cannot carry two tiers:

- **`axis.messages/1.enableCliEndpoint`** is user-only, tier 4, side effect `privileged`, and takes an `approval`. Main's native dialog content is bound to this action (it names what turning it on allows: CLI runs whose workers are enabled one by one get an endpoint).
- **`axis.messages/1.disableCliEndpoint`** is user-only, tier 1 (it only lowers privilege), with no dialog.
- **Who may call them.** Both are desktop only, absent from the web and plugin allow-lists. Negative tests cover a worker, a plugin and a web caller. Native proof and replay tests cover the enable.

**Decided 2026-11-27 (delegated, reversible), as built in the contract slice:**

- **Side effect `write`**, as `axis.plugins/1.grant`: the method table has no `privileged` side effect; the privilege is carried by tier 4 and main's native confirmation.
- **Residual (audit B F4): the switch row has no integrity of its own.** The token and the writer rule are in-process controls. A process of the same user that can write the journal file can set the row directly (`UPDATE messaging_cli_endpoint ...`), and the next mint reads it as on, with no dialog. Same-user file access is the trusted base, as for every journal row (the plugin grants' second-journal residual is the same).
- **A single-use write token for turning it on**, as plugin grants have. The journal hands its switch mint out once. The host composition passes it straight into the approved enable action, the only code that can switch on. Turning off needs no token. A static writer rule keeps `switchOn` to that action, `switchOff` to the disable handler, and the mint to the composition.
- **What the switch turns on, exactly and only:** the CLI endpoint's relay, its own run-to-worker lookup (separate from `agentOf`), and minting for a CLI run whose worker has `cliMessaging` on. Delivery into runs and the composer's send and read tools stay with `messaging.enabled` (PV-G4, PV-M8). A test pins that with the switch on and `messaging.enabled` off, no composer run gets a message tool or a delivery.
- **In two parts.** The contract slice reads the switch at start, and the relay reads it at every mint and every relayed message, so after a disable nothing is minted and every endpoint is revoked at its next message. The next slice adds the live turning on, the eager revocation of every endpoint, and the pty process's endpoint configuration.

**Where the setting lives.** A singleton journal row, written only by the user, with an audited update and absent meaning off. It needs a new forward-only migration at the next free version (20 at this baseline; 19 is the tasks keep trigger). `journal/src/schema.ts` is at 496 lines, so the migration goes in its own module, and `schema.ts` is split first in its own tiny PR before it.

**A live switch, not a startup flag.** Today `wireCliEndpoints` is decided once at composition, `hostMessagingDeps.agentOf` returns nothing while messaging is off, and the production pty process is never given the listener configuration (`messagesEndpoints`); only tests are. So the slice must make all of these true:

- **At start:** the row is read; with it on, the relay, the worker lookup and the pty listener are wired.
- **Turning it on:** this is a committed live update. The next CLI run started gets an endpoint without a restart. The wiring is built so it can go from off to on in a running session, and the production pty process gets its runtime directory and uid configuration.
- **Turning it off:** every live endpoint is revoked at once, through the same path as a worker's setting turned off, and the mint refuses from then on (a backstop that reads the current state, not only a notification).
- **Unchanged:** the per-worker enable (`cliMessaging`, its rule, the fresh mint re-check and the second acknowledgement) stays as it is, and only matters while the switch is on.

## 8. Acceptance for gate lines 5, 6 and 7

- **Gate line 5: escaped, then framed.**
  - **The test:** a message holding `ESC ] 52`, `ESC ] 8` and a bidirectional override goes from a send through the relay to a `read_messages` result. Those characters show as visible escapes. Every body line starts with `| `. The body sits inside one frame whose nonce it does not contain.
  - **Vectors:** an empty body line, a line already starting with `| `, a forged `[axis-message ...]` header, and a body containing a deliberately known nonce. Each stays prefixed inside its block.
  - **Mutants:** the prefix removed; a fixed nonce; the shim skipping the framing; the daemon not escaping. Each must fail the test.
- **Gate line 6: the token canary, the shim's half (review 1 S3).**
  - **What the shim may emit:** the shim process emits only fixed closed failures. It never logs the token, the auth frame, its environment or a raw error. Its fatal paths print a fixed line, never Node's default stack.
  - **The test:** a token generated for the test goes through successful calls, invalid and oversized input and replies, a refused auth, disconnects, and injected crash, error and cause paths. Some failure and crash evidence must appear, and the token, or any part of it, must not appear on the shim's stderr, stdout or crash output.
  - **Mutants:** a diagnostic log of the auth frame; Node's default crash output left in place. Each must fail.
- **Gate line 7, Unix: a bad socket directory is refused by the daemon and by the shim.**
  - **The daemon half** exists (PV-M6 slice 2).
  - **The shim half:** with a `0755` directory, a directory of another owner, a linked directory, a socket of another owner, or a path outside the runtime directory, the shim refuses before connecting, and a fake listener never receives a token.
  - **Mutants:** each check removed; the token sent before the checks. Each must fail.
- **Gate line 8:** a recorded skip (section 4).

## 9. Other tests the slice will carry

- **Shim unit tests (no CLI needed):** the MCP framing with an oversized line, an unknown method and a second request in flight; a reply over the bounds refused.
- **End to end over the real pty process and relay** (the PV-M6 slice 2 rig): auth, send, read, the framing, and revocation at run end.
- **The section 6 probe**, recorded as evidence.
- **The switch:**
  - the enable is tier 4 with native confirmation, and the disable is tier 1;
  - a live enable from an off session, then a run that gets an endpoint without a restart;
  - the disable revoking live endpoints, then the mint refusing;
  - production composition and the pty entry reading the row and its configuration.
- **Imports and bundles:** the import-lint rule refuses a daemon import from the shim; the bundle check keeps the shim out of the desktop daemon and main bundles; the connect template's pin.

## 10. Not here

- Windows (decision 8).
- Messaging while BLOCKED (decided: revoked).
- The shell's enable dialog and its display of unverified senders (shell tickets OS-31 and OS-32).
- PV-M8's gate evidence.
- A process-bound session for the shim (section 4).
