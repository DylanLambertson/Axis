# `axis.terminals/1`: plain terminals and the grant of a terminal to a data connection (DC-3a)

- **Status:** Proposed with its first slice (DC-3a). Security review.
- **Builds on:**
  - the pty process's existing `grant`, `attach` and credit flow (PTY-7);
  - the PTY-5 environment builder (`buildPlainTerminalEnv`);
  - the project trust gate (`project-registration-and-trust.md` section 5.4);
  - the worktree manager's registered workspaces (DMN-2).
- **Not here:** main's side, a pty-data broker that hands a window a data port, is DC-3b (wave B). The terminal module in the shell is OS-16.

## 1. Methods and tiers

All four methods are the user's own desktop connection's alone:
- the policy rows are user rows;
- none is in `WEB_ALLOWED`;
- the contract is on the plugin deny list;
- no worker is ever offered them;
- the handlers refuse every other caller again with `not_found`.

| Method | Side effect, tier | Trust | Idempotency |
|---|---|---|---|
| `open { workspaceId, cols, rows }` gives `{ terminal }` | write, **2** | `per-start` | required |
| `list { workspaceId? }` gives `{ terminals }` | read, 0 | none | none |
| `close { terminalId }` gives `{ closed }` | write, **2** | none | required |
| `attach { terminalId, conn }` gives `{ attached }` | write, **2** | none | none |

**Why `open` is tier 2 with per-start trust.** A plain shell in a worktree has the same power as starting a CLI there (`axis.cli-runs/1.start`, `userRule(2, "per-start")`, the reference):
- It is an interactive process with the user's own credentials.
- Its environment can run repository code, for example an rc file or a directory hook that reads the worktree.
- It is the user's explicit act, and it grants nothing beyond what the user then types. So it is tier 2, not 4, with no native confirmation.
- The project's run trust gates it at every start, through the same project trust gate and ticket as a CLI start, so an untrusted project gets no shell.

**Why `close` is tier 2**, like `axis.cli-runs/1.stop`: killing a shell can lose the user's work.

**Why `attach` is tier 2:** it gives a data connection a live shell's input and output.

## 2. Which workspace, and which shell

- **The workspace is one the worktree manager registered, and READY (DMN-2).** It is resolved from the journal, and the worktree path is the managed one, never a path from the request. An unknown, foreign or not-READY workspace is `not_found`, before anything is spawned, and is checked again under the project mutex.
- **The shell is `$SHELL` of the daemon's environment, for now.** It must be:
  - an absolute path;
  - an existing regular file that is executable;
  - listed in `/etc/shells`.

  Otherwise `/bin/sh` is used if it is listed and executable; otherwise `open` is refused with the closed reason `shell_unavailable`. Windows is refused with the same reason in this slice.
- **Follow-up (OS-4):** a user-scope shell setting through main's settings store, read as `axis.cliAgents` is.

## 3. What an interactive shell inherits

- **The environment** comes from `buildPlainTerminalEnv` over the daemon's environment, the same PTY-5 deny-list as CLI runs:
  - the editor's and the daemon's own names are removed;
  - names that look like secrets are removed;
  - `AXIS_MESSAGES_ENDPOINT` and `AXIS_MESSAGES_TOKEN` are never set, because a plain terminal has no messaging endpoint;
  - no daemon token or attestation key is in it.
- **What it does not prevent:** repository code can still run through the user's own typing, or through the shell's own start-up files. That is the user's act in a trusted project, as in any terminal.

## 4. Who may see, close or attach a terminal

- **The daemon's registry.** The daemon keeps an in-memory registry of the terminals it opened: id, workspace, `plain`. It also records the terminals of the CLI runs it started: id, workspace, `cli-run`, run id. `list`, `close` and `attach` act only on terminals in that registry. An id the daemon did not open or start is `not_found`, even if the pty process knows it. Terminals do not survive a daemon restart, matching the pty process.
- **Who may attach a CLI run's terminal:** only the user's desktop connection, the same caller as every method here. No worker, plugin or web client may attach any terminal, its own run's included.
- **`close` of a CLI run's terminal** is refused (`not_found`). A run is stopped with `axis.cli-runs/1.stop`, which also records the run's end. `close` is for plain terminals.
- **Bounds:** at most 8 plain terminals per workspace, inside the pty process's own `maxTerminals`.

## 5. The grant (PTY-7), and its residual

- `attach { terminalId, conn }` calls the pty process's `grant(terminalId, conn)`. Only the data connection named `conn` may then read and write that terminal. A re-grant to another `conn` moves it, and the old owner's flow is dropped.
- **The test proves** that only the named `conn` gets data, and that another `conn` gets none.
- **Residual until DC-3b:** in DC-3a the `conn` is a name the caller gives. DC-3b makes main mint it, for a port it hands to the window that asked, and check the sender. Until then a caller that may attach could name any data connection it knows. That caller is only the user's own desktop connection.

## 6. Audit

- `terminal.open` and `terminal.close` rows carry ids only: the terminal, the workspace and the project. Never the shell's path, the environment or any data.
- `attach` writes a `terminal.attach` row with the terminal id and the `conn` name, never data.

## 7. Refusals

A closed set, under the contract's codes:
- `not_found`: an unknown or foreign workspace or terminal, or a caller that is not the user's desktop connection;
- `shell_unavailable`;
- `too_many_terminals`;
- `needs_attention`, as a CLI start.

The trust gate's own refusals pass through as they do for a CLI start.

## 8. What the code adds (for the review of the plan)

- **The daemon's pty port does not carry the grant today.** `grant(terminalId, conn)` and a handle's `terminalId` exist on the pty process's own port (`PtyProcessPort`), but not on the daemon's `PtyPort` or its control slot. DC-3a adds them there as optional members: a terminal port with `spawn` giving a handle with `terminalId`, and `grant`. The host serves `axis.terminals/1` only when the port has both, and otherwise answers `not_found`.
- **CLI run terminals.** The composition wraps the runs' pty port, as the endpoint wrapper does, to record `runId` against `terminalId` when a CLI run spawns, and drops the record at the run's exit. `list` and `attach` read that record. Nothing else in the run path changes.
- **Tests use a fake pty port.** They cover:
  - an unregistered, foreign, not-READY and removed workspace, each refused before a spawn;
  - the untrusted project refused by the gate;
  - the shell rule (relative, missing, not executable, not in `/etc/shells`, the fallback, none);
  - the environment passed to the spawn (no `AXIS_MESSAGES_*` names, the deny-list applied);
  - the grant reaching only the named `conn`;
  - web, plugin and worker callers refused, by the policy and again by the handler;
  - `close` killing the terminal's group, and refusing a CLI run's;
  - the 8-terminal bound.

  Each has a mutant.
