# `axis.terminals/1`: plain terminals and the grant of a terminal to a data connection (DC-3a)

- **Status:** Proposed with its first slice (DC-3a). Security review. Review 1 folded.
- **Builds on:**
  - the pty process's existing `grant`, `attach` and credit flow (PTY-7);
  - the PTY-5 environment builder (`buildPlainTerminalEnv`);
  - the project trust gate (`project-registration-and-trust.md` section 5.4);
  - the shared worktree locator (DMN-2).
- **Not here:**
  - **DC-3b (wave B):** main's side, a pty-data broker that hands a window a data port bound to its sender.
  - **OS-16:** the terminal module in the shell. It owns what a terminal's output may do there:
    - untrusted output;
    - escape and OSC sequences;
    - links and clipboard effects;
    - the rule that output never becomes an app command or an approval.
- **A deliberate change of trust policy (review 1 N1).** `project-registration-and-trust.md` (the line on plain terminals) and ADR 0011 (its plain-terminal line) both say plain terminals stay ungated by project trust. This contract supersedes that exception: a plain terminal is gated per start, and it consumes the project trust gate's ticket as a CLI start does. The two statements are updated with the implementation.

## 1. Methods and tiers

All four methods are the user's own desktop connection's alone:
- the policy rows are user rows;
- none is in `WEB_ALLOWED`;
- the contract is on the plugin deny list;
- no worker is ever offered them;
- the handlers refuse every other caller again with `not_found`.

| Method | Side effect, tier | Trust | Idempotency |
|---|---|---|---|
| `open { workspaceId, cols, rows }` gives `{ terminal }` | write, **2** | `per-start` (ticket consumed) | required |
| `list { workspaceId? }` gives `{ terminals }` | read, 0 | none | none |
| `close { terminalId }` gives `{ closed }` | write, **2** | none | required |
| `attach { terminalId, conn }` gives `{ attached }` | write, **2** | none | none |

**What a shell can do (review 1 S1), so the tier is chosen with that in view.** An interactive shell has the user's full authority:
- It can read and write the home directory, including the journal's and the vault's backing files.
- It can use the SSH agent and other sockets, the credential helpers, and the network, and it can run any program.
- Its start-up files, and any directory hook, can run repository code before the first keystroke.
- An attached CLI run's terminal can answer that CLI's own prompts. Its input is not audited; the attach is (section 6).

**Why tier 2, and not 4.**
- Code in a compromised renderer can call a tier-2 method without a human click. That is accepted here: tier 2 is not justified by "the user's explicit act".
- It is justified by the bounds:
  - only the user's desktop connection reaches it;
  - only a registered workspace, checked against the shared locator immediately before the spawn (section 2);
  - the per-start project trust gate and its ticket, the same as `axis.cli-runs/1.start` (`userRule(2, "per-start")`), which grants a CLI the same authority in the same place;
  - the bound on terminals (section 4).
- The shell's authority is the user's own, as any terminal's is. A native confirmation per terminal would add a dialog to every shell without narrowing what the shell can do once it exists.

**Why `close` is tier 2**, like `axis.cli-runs/1.stop`: killing a shell can lose the user's work.

**Why `attach` is tier 2:** it gives a data connection a live shell's input and output.

## 2. Which directory: the managed worktree, checked at the spawn (review 1 B2)

The journal's READY state and the project mutex alone do not prove the directory. A registered directory replaced by a link to another worktree of the same repository stays READY. So `open` does all of this under the project mutex, and repeats the last checks after every awaited step (the trust gate), immediately before the spawn:

1. **Resolve the workspace through the shared worktree locator**, never a path from the request or the journal row alone. The locator checks all of these:
   - the canonical real path equals the recorded canonical path;
   - it is contained under the real managed worktree root, with the root and every parent resolved, so a replaced root or parent is refused;
   - it is bound to the project's own repository: its `.git` is a worktree of that repository's common directory.

   A local checkout, another project's worktree, a linked or replaced directory, and a removed workspace are each `not_found`.
2. **The trust gate admits the start and returns its ticket.**
3. **After the gate's await, and immediately before the spawn**, the workspace's identity and state, the locator's answer and the ticket are checked again. The spawn's `cwd` is the canonical path the locator returned.

**Residual RR-99 (check to exec).** The `cwd` is checked, then handed to the pty process, which changes into it at exec. A process of the same user that swaps the directory, or one of its parents, in that window gives the shell another directory. A descriptor-pinned working directory at exec is not built in DC-3a. Until then this is a same-user residual, recorded as RR-99 (the next number free on main and the open branches). DC-3a does not claim DMN-2 is closed for this case.

## 3. The shell, and what it inherits (review 1 B1)

- **The shell is `$SHELL` of the daemon's environment, for now.** It must be:
  - an absolute path;
  - an existing regular file that is executable;
  - listed in `/etc/shells`.

  Otherwise `/bin/sh` is used if it is listed and executable; otherwise `open` is refused with the closed reason `shell_unavailable`. Windows is refused with the same reason in this slice. **Follow-up (OS-4):** a user-scope shell setting through main's settings store.
- **The environment is exactly** `buildPlainTerminalEnv(daemonEnv, { stripSecretNames: true, platform })`:
  - the daemon's own environment, with no `userEnv`;
  - no shell integration;
  - no `envPassthrough` exemptions;
  - no repository-provided environment;
  - no endpoint injection, so `AXIS_MESSAGES_*` is never set.

  This is deliberately stricter than CLI runs, which leave secret-name filtering off (`pty-policy` `launch.ts`, `runs` `copy.ts`).
- **What it guarantees, and only that:** no injected vault or daemon credentials. The daemon's own names (its attestation key, the messaging names) and the editor's are always removed. Names that look like secrets are removed: in the executed check, `PLUGIN_TOKEN`, `SERVICE_API_KEY`, `GH_TOKEN` and `AWS_SECRET_ACCESS_KEY`.
- **What it deliberately keeps:**
  - sockets and agents: `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `DOCKER_HOST`;
  - credential helpers and tool configuration: for example `NPM_CONFIG_USERCONFIG`, git's own configuration;
  - `HOME` and `PATH`.

  A shell needs them to do the user's work.
- **Name filtering is not secret detection.** A secret under an innocent name is passed. Repository code still runs, through the shell's start-up files or the user's typing (section 1).

## 4. Who may see, close or attach a terminal, and how long a slot lives (review 1 S2)

- **The daemon's registry.** The daemon keeps an in-memory registry:
  - the terminals it opened: id, workspace, `plain`;
  - the terminals of the CLI runs it started: id, workspace, `cli-run`, run id.

  `list`, `close` and `attach` act only on terminals in that registry. An id the daemon did not open or start is `not_found`, even if the pty process knows it. Terminals do not survive a daemon restart, matching the pty process.
- **Who may attach a CLI run's terminal:** only the user's desktop connection, the same caller as every method here. No worker, plugin or web client may attach any terminal, its own run's included.
- **`close` of a CLI run's terminal** is refused (`not_found`). A run is stopped with `axis.cli-runs/1.stop`, which records the run's end. `close` is for plain terminals.
- **At most 8 plain terminals per workspace,** counting pending and live together:
  - **Reserved before the spawn.** A slot is reserved atomically under the project mutex. With 7 records, two concurrent opens make 8, never 9.
  - **Kept until no process can appear.** A cancelled or timed-out open keeps its slot until the spawn has settled.
  - **Late handles.** A handle that arrives after the open was abandoned is killed and tracked like any other.
  - **Released only when the group is gone.** A slot is freed when the terminal's process group is known gone (`groupAlive` false, the runs binding's pattern), not at the shell's own exit. A leader can exit while a child of the group survives (the pty process tells the leader's exit from the group's emptying).
  - **`close` is idempotent.** It kills the group. A kill that throws still marks the terminal closing, and the slot waits for the group to be gone.
  - **Grants end with the terminal.** A terminal that closed or exited has its grant ended, and a later `attach` to it is `not_found`.

## 5. The grant (PTY-7), and its residual

- `attach { terminalId, conn }` calls the pty process's `grant(terminalId, conn)`. Only the data connection named `conn` may then read and write that terminal. A re-grant to another `conn` moves it, and the old owner's flow is dropped.
- **The test proves** that only the named `conn` gets data, and that another `conn` gets none.
- **Residual until DC-3b:** in DC-3a the `conn` is a name the caller gives. DC-3b makes main mint it, for a port it hands to the window that asked, and check the sender. Until then a caller that may attach could name any data connection it knows. That caller is only the user's own desktop connection.

## 6. Audit

All rows carry ids only, never the shell's path, the environment or any data:
- `terminal.open` and `terminal.close`: the terminal, the workspace and the project;
- `terminal.attach`: the terminal id and the `conn` name.

The input a data connection sends to a terminal is not audited (section 1).

## 7. Refusals

A closed set, under the contract's codes:
- `not_found`: an unknown or foreign workspace or terminal, a directory the locator does not take, or a caller that is not the user's desktop connection;
- `shell_unavailable`;
- `too_many_terminals`;
- `needs_attention`, as a CLI start.

The trust gate's own refusals pass through as they do for a CLI start.

## 8. What the code adds (for the review of the plan)

- **The daemon's pty port does not carry the grant today.** `grant(terminalId, conn)` and a handle's `terminalId` exist on the pty process's own port (`PtyProcessPort`), but not on the daemon's `PtyPort` or its control slot. DC-3a adds them there as optional members: a terminal port with `spawn` giving a handle with `terminalId`, and `grant`. The host serves `axis.terminals/1` only when the port has both, and otherwise answers `not_found`.
- **CLI run terminals.** The composition wraps the runs' pty port, as the endpoint wrapper does, to record `runId` against `terminalId` when a CLI run spawns, and drops the record when the run's group is gone.
- **Tests use a fake pty port.** Each line below has a mutant:
  - **Directory:**
    - an unregistered, foreign, not-READY and removed workspace;
    - a registered directory replaced by a link to another worktree of the same repository;
    - a local checkout;
    - a replaced root;
    - a swap timed between the trust gate and the spawn.

    Each is refused before the spawn.
  - **Trust:** an untrusted project refused, and the ticket consumed.
  - **Shell rule:**
    - a relative path;
    - a missing file;
    - a file that is not executable;
    - a path not in `/etc/shells`;
    - the `/bin/sh` fallback;
    - neither available.
  - **Environment:** exactly the specified invocation. No `AXIS_MESSAGES_*`, the secret names removed, the sockets kept.
  - **Grant:** it reaches only the named `conn`; it ends at close and exit.
  - **Callers:** web, plugin and worker refused, by the policy and again by the handler.
  - **Slots:**
    - concurrent opens at 7 records;
    - an aborted open, and a late handle;
    - a natural exit;
    - a repeated close, and a throwing kill;
    - a leader that exits with a surviving child, whose slot stays reserved until the group is gone.
  - **CLI run terminals:** `close` refuses one.
