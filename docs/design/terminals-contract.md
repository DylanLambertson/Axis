# `axis.terminals/1`: plain terminals and the grant of a terminal to a data connection (DC-3a)

- **Status:** Proposed with its first slice (DC-3a). Security review. Reviews 1 to 3 folded.
- **DC-3c, needed before a terminal opens:** trust-registry revocations reaching terminals (section 2 step 5). Until it lands, `open` is refused by a capability check, so a demo cannot open a terminal before DC-3c.
- **The DC-3a code includes a pty-process change** (sections 4 and 5): a per-terminal grant revocation, and tracking a spawn whose answer arrives after the client's timeout. That change needs its own security review.
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
3. **The final admission is synchronous (review 2 B1).** After the LAST awaited step (the trust gate, then the locator and binding check repeated), one synchronous step does all of this, with no await between them and the dispatch:
   - **Re-read the live state:**
     - the project's current trust and its binding identity, the journal's record now, not the gate's earlier answer;
     - the trust registry's revocation;
     - the workspace's READY state and lock identity;
     - the request's cancellation.
   - **Consume the scoped ticket.**
   - **Dispatch the spawn,** with the locator's canonical path as `cwd`.

   The ticket's own check (its brand, spent state, time and scope) does not re-check trust: it was minted before. So the live re-read above is what refuses an untrust or a revocation that lands between the gate and the spawn.
4. **An untrust or a binding loss reaches plain terminals (DC-3a).** Project untrust and binding loss call the project's stop hook (`onRevoked(projectId)`). Today that hook stops only the project's CLI and composer runs, so DC-3a fans it out to the plain-terminal registry too. The CLI and composer path is kept, and a failure in one fan-out never stops the other. On that event, for the project:
   - **Pending opens:** each is marked abandoned SYNCHRONOUSLY, before any cleanup queued behind the project mutex. Its operation identity and slot are kept until the spawn is definitively settled (section 4), and its handle, if one is reported later, is never published or granted.
   - **Live terminals:** each is closed: its state becomes `closing` (section 4), its grant is revoked (section 5), and its group is killed.
   - **Late groups:** a group reported late is killed and tracked.

   **Cancellation is logical abandonment.** The control client's `spawn(spec)` takes no cancellation signal. A pending open is abandoned in the daemon, and the pty process's answer, whenever it arrives, goes through the definitive-outcome and late-group channel of section 4.
5. **A trust-REGISTRY revocation reaching terminals is DC-3c, and `open` is refused until it exists.** The trust registry's revocations, by window and by workspace, are a separate event source: `InMemoryTrustRegistry.set` has no event and no project identity, and running runs are not touched by it today. Routing them to the affected pending and live terminal operations is ticket **DC-3c** (`own-shell-plan.md`). It needs:
   - an event on the trust registry;
   - a defined window, workspace and project mapping, failing closed when the mapping saturates;
   - the same synchronous abandonment, never-publish and kill-and-track rules as step 4.

   **The refusal is a capability check, not a flag.** The host registers the `axis.terminals/1` handlers only when the registry-revocation routing is present, under the same all-or-nothing rule as the terminal port (section 8). Without it, `open` is `not_found` before any spawn. A test pins that a composition without the routing refuses `open`, and a mutant that drops the check fails.

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
  - **Kept until the spawn is definitively settled (review 2 S2).** A settled promise does not prove that no process can appear. The pty client's response timeout rejects the spawn, yet a late `spawned` answer can still arrive. Today the client then kills that unknown group but never tracks it. So the pty client is changed in two ways:
    - it tells its own response timeout apart from a definitive outcome;
    - it keeps the operation's identity through a late answer, and hands a late group to the daemon.

    A slot is released only on a definitive "no spawn" (the pty process's `spawn-failed`), or when a group it reported is confirmed gone.
  - **Late handles.** A group that appears after the open was abandoned or timed out is reported, killed, and tracked like any other. Its slot stays charged until the group is gone.
  - **Unknown stays charged.** A liveness check that throws or cannot answer keeps the slot charged. A slot can then stay held until the daemon restarts, within the 8-terminal bound.
  - **Released only when the group is gone.** A slot is freed when the terminal's process group is known gone (`groupAlive` false, the runs binding's pattern), not at the shell's own exit. A leader can exit while a child of the group survives (the pty process tells the leader's exit from the group's emptying).
  - **A monotonic lifecycle (review 3 S1).** A terminal goes `open`, then `closing`, then `closed` or `exited`, never back.
    - Only an `open` terminal may be granted or attached. `closing`, `closed` and `exited` always refuse (`not_found`), though the slot's accounting stays charged until the group is gone.
    - `close` sets `closing` FIRST, then revokes the grant (section 5), then kills the group. A kill that throws leaves the terminal `closing`, and nothing can grant it again.
    - A repeated `close` keeps the state: it is idempotent.
    - **At the service boundary too:** a stale grant already in flight to the pty process cannot reactivate a terminal that has ended there.
    - While a terminal is `open`, normal transfer between the user's data connections stays allowed.

## 5. The grant (PTY-7), and its residual

- `attach { terminalId, conn }` calls the pty process's `grant(terminalId, conn)`. Only the data connection named `conn` may then read and write that terminal. A re-grant to another `conn` moves it, and the old owner's flow is dropped.
- **Revoking a grant is a new pty-process capability (review 2 S1).** The pty process's grant has no revocation today. An already attached data connection keeps attaching, resizing and receiving output after a close whose kill fails, or after a leader exit whose child survives.
  - **The change:** DC-3a adds a per-terminal revocation through the pty client, the control slot and the optional terminal port. It clears the grant and detaches the current owner. That connection then receives no more of that terminal's output, and its input, resize and attach for it are refused.
  - **When it runs:** on entry to closing (before the kill, so it holds even when the kill throws), and at the leader's exit. It is independent of the group's accounting.
  - **What it does not close:** the shared data connection itself, which would cut every other terminal it carries.
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

- **The pty process (its own security review):**
  - a `revoke` control message for one terminal: it clears the grant and detaches the owner, as section 5 describes;
  - spawn answers that arrive after the client's timeout: they are reported and tracked, not only killed (section 4).
- **The terminal-port capability contract, complete and all-or-nothing (review 3 S2).** The daemon's `PtyPort` and its control slot carry none of it today; only the pty process's own port has `grant` and a handle's `terminalId`. DC-3a adds an optional terminal port with all four parts:
  - `spawn`, giving a handle that carries its `terminalId`;
  - `grant(terminalId, conn)`;
  - the per-terminal revocation (section 5);
  - the definitive-outcome and late-spawn reporting (section 4).

  The host advertises the contract and registers its handlers only when every part is present, AND the registry-revocation routing of DC-3c exists (section 2 step 5). Any missing combination is refused before a spawn. Returned ids and handles are validated before anything is published. An ordinary CLI `PtyPort` keeps working without the terminal capability. A test weakens the predicate, and it must fail.
- **CLI run terminals.** The composition wraps the runs' pty port, as the endpoint wrapper does, to record `runId` against `terminalId` when a CLI run spawns, and drops the record when the run's group is gone.
- **Tests use a fake pty port.** Each line below has a mutant:
  - **Directory:**
    - an unregistered, foreign, not-READY and removed workspace;
    - a registered directory replaced by a link to another worktree of the same repository;
    - a local checkout;
    - a replaced root;
    - a swap timed between the trust gate and the spawn.

    Each is refused before the spawn.
  - **Trust:**
    - an untrusted project is refused, and the ticket consumed;
    - an untrust or a revocation during the final locator check, and one while the spawn is pending, each give no shell, or no group that survives;
    - removing each of the final live checks must let a spawn or a surviving group through, and so fail.
  - **Shell rule:**
    - a relative path;
    - a missing file;
    - a file that is not executable;
    - a path not in `/etc/shells`;
    - the `/bin/sh` fallback;
    - neither available.
  - **Environment:** exactly the specified invocation. No `AXIS_MESSAGES_*`, the secret names removed, the sockets kept.
  - **Grant:**
    - it reaches only the named `conn`;
    - with the real pty service and data channels, a viewer attached before a close (with a throwing kill) or a leader exit (with a surviving child) receives no later output, and cannot attach, write or resize;
    - another terminal on the same data connection is unaffected.
  - **Callers:** web, plugin and worker refused, by the policy and again by the handler.
  - **Slots:**
    - concurrent opens at 7 records;
    - an aborted open, and a late handle;
    - a natural exit;
    - a repeated close, and a throwing kill;
    - a leader that exits with a surviving child, whose slot stays reserved until the group is gone;
    - with the real pty client, a delayed `spawned` answer after the timeout, with a kill the group survives: the group is tracked and the slot stays charged. Releasing on the timeout, or not tracking the late group, must fail.
  - **CLI run terminals:** `close` refuses one.
  - **Lifecycle:**
    - a close with a throwing kill, then a daemon `attach`, then data attach, write, resize and output: all refused;
    - a re-grant after a natural exit: refused;
    - a repeated close.

    Removing the guard must reopen a terminal, and so fail.
  - **Project events:** project untrust and binding loss, each during the final lookup, during a pending reply and during live use. Removing each event's routing must let a late handle publish or a live terminal survive, and so fail.
  - **Capability:** a composition without the terminal port's parts, or without DC-3c's routing, refuses `open` before a spawn; the predicate weakened must fail.
