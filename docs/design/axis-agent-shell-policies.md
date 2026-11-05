# Axis agent-first shell: policies

- **Status:** Draft, a companion to `docs/design/axis-agent-shell.md` (the "design"). The design owns the architecture, the tasks and the footprint. This document owns the policies those tasks implement:
  - the items ADR 0004 defers to the design (§1–§3);
  - the terminal environment, including the shell-integration set (§4);
  - shell integration (§5);
  - Axis git operations, the GIT-SNAP-1 snapshot set and the GIT-ENV-1 environment (§6);
  - snapshot refs (§7);
  - shortcuts (§8);
  - status wording (§9).
- **Date:** 2026-11-02. Aligned with ADR 0004 as merged on `main` (`a0cb0a3`, amended in this branch for D-13).
- **Conventions:** as in the design. **[V]** means verified in the Code OSS `1.144.0` source (`2c33b50`); **[I]** means inferred. `D-n` labels are design-local decisions (design §9.2). ADR 0004 decisions are cited by number.

## 1. Reuse of `vs/sessions` and decision D8 (ADR 0004 deferred item 1)

- **Approach.** Axis re-implements the sessions architecture as option (i) (design §2.3). It adapts four small pieces, each with an `Adapted from <path>@2c33b50` header:
  - the folder manager (`sessions/contrib/workspace/browser/workspaceFolderManagement.ts`);
  - the Files view (`sessions/contrib/files/**`). The adaptation drops its `AGENT_HOST_SCHEME` import from `platform/agentHost` (`files.contribution.ts:14`) [V];
  - the terminal background/foreground pattern (`sessionsTerminalContribution.ts:689-760`, `showBackgroundTerminal` `:749`, `moveToBackground` `:756`) [V];
  - the per-owner working-set rules (`sessions/contrib/layout/**`).
- **D8 stays.** The Agents Window entry points and window type are removed in range `1500–1999` (`axis-shell.md` D8). Axis uses none of them at runtime. The sessions sources stay in the tree, unbundled, as the source of the adapted copies.

## 2. How IDE view follows the focused workspace (deferred item 2), and trust (ADR 0004 decision 12)

- **One window per project.** The window opens an Axis-written, per-project Code OSS workspace in the `WORKSPACE` state.
- **Folder swap.** Focusing a workspace replaces its single folder in **one** `updateFolders(0, 1, [new])` call.
  - In the `WORKSPACE` state, that call goes to `doUpdateFolders`, not `enterWorkspace`, so the extension host is not restarted (`abstractWorkspaceEditingService.ts:127-176,205-226`; `workspaceEditingService.ts:178-213`) [V].
  - It is never split into a remove followed by an add. A delete-only call that leaves the window as a single-folder workspace goes to `createAndEnterWorkspace` (`:236`) [V].
- **Per-workspace state.** Editors (working sets) and terminals are swapped on focus change (design §3.6, §4.4).
- **Reserves against design R1:** a multi-root fallback, and the in-memory workspace hook P2b.
- **Trust, per ADR 0004 decision 12.**
  - When the daemon creates a worktree, it records the source repository. On mount, the renderer reads the source repository's trust with `getUriTrustInfo` and applies the same value to the worktree path only, with `setUrisTrust([worktree], trusted)` (`platform/workspace/common/workspaceTrust.ts:60-61`) [V].
  - **Who decides.** The main process owns the trust state that decides runs and attests it on the window-verified run-start call (the ADR 0003 D1 checks). The daemon requires that attestation and refuses a run-start call without it. A trust claim made by the renderer alone is advisory (a compromised renderer can write trust) and never gates a run. How main reads the workbench trust store is settled in task B6.
  - An untrusted source repository means the worktree opens in Restricted Mode in IDE view, shown read-only with a "Trust to run" action. **No CLI or agent run starts in it** (threat model TRU-2). Trust is re-derived from the source repository at each mount and at each run start, so a later revocation takes effect.
  - The worktree root under app data is **never** trusted as a parent folder.
  - Worktrees Axis did not create (external) do not inherit trust; upstream trust prompts apply as usual.

## 3. Drift and concurrency (deferred items 3 and 4; ADR 0004 decision 10)

### 3.1 Writers and guarantees

| Writer | Count per workspace | Controlled by Axis? |
|---|---|---|
| User: IDE editors, Axis review actions, user terminals | 1 | Axis review actions go through the daemon (§6). Editors and terminals do not |
| Composer run | at most 1 | Yes: every write goes through the broker |
| CLI agent run | any number | No: observed only |
| User through the SCM view or a terminal `git` | any | No: outside Axis's guarantees (§6.3) |

All are allowed at the same time. Axis blocks only the composer.

### 3.2 State the daemon keeps per workspace

The run base, the drift ledger and the indicator are Phase 1a (design task B11), for CLI runs. Observed hashes, advisory locks and everything in §3.3–3.4 are Phase 1b (task C5).

- **Run base.** At every run start (composer or CLI), the daemon writes `refs/axis/runbase/<runId>` (§7). It points at a commit of HEAD plus the whole worktree, tracked and untracked but **not ignored**, built with a temporary index, `add -A`, `write-tree` and `commit-tree`. It is kept for 7 days after the run ends.
- **Observed hashes**, per composer run: the content hash the run last saw for each path it read or wrote.
- **Advisory user locks.** The renderer reports, as the `user` actor, the paths with unsaved editors (`axis.worktrees/1.setUserEditing`). They are cleared on save or close.
- **Authority.** The diff against the run base is authoritative for what changed, at run end and at commit. The watcher only feeds the live indicator, because watchers can drop events.
- **Drift ledger**, per run: the paths changed while the run was active, other than by the run itself. It comes from a daemon file watcher on the worktree; `@parcel/watcher` is an upstream dependency (`package.json:115`) [V].

### 3.3 Composer writes: compare-and-swap

Every broker write, delete or rename of a path P carries the hash the run last observed for P.

1. Under the per-workspace write lock (shared with Axis git operations, §6.1), the daemon writes the new content to a temporary file in P's directory.
2. It re-hashes P, and compares the result with the observed hash and with the user locks.
3. If either fails, the temporary file is removed and the call returns **`E_CONFLICT`**. The tool result lists the changed paths and tells the agent to read them again. Axis never merges or overwrites.
4. Otherwise the daemon renames the temporary file over P (an atomic replace), or deletes or renames P.
5. **Residual window.** A writer outside the lock (an editor, a CLI) can still change P between step 2 and step 4. That change is lost, but the watcher records it in the ledger and the run summary flags "possible lost change", which can be undone from the run base (§3.6). The window is one hash plus one rename [I].

### 3.4 Notifications and pauses (composer only)

- **Before each model turn**, the daemon adds a drift notice to the run's context: the paths changed outside the run since its last step, with no content.
- **HEAD moved** (commit, checkout or reset by anyone): a drift notice is sent, and observed hashes are re-validated on the next write.
- **The branch moved away from `axis/<slug>`, or the worktree is missing:** the run pauses until the user confirms in the workspace view.
- **CLI agent runs receive no notification.** Axis never types into, or answers for, a CLI's terminal (ADR 0004 decisions 8 and 10).

### 3.5 User edits

- User edits are never blocked.
- The header and dashboard row show "N files changed outside the agent". It opens a multi-diff of those paths from the run base.
- A composer write to a file that is open but not dirty reloads the editor from disk. A dirty file is protected by its advisory lock.

### 3.6 CLI runs: shown, not prevented

- A path a CLI changes after the composer last saw it fails the composer's next compare-and-swap. **The composer never silently overwrites a CLI change.**
- The reverse cannot be prevented. A change made during a CLI run to a path the composer or the user wrote is recorded as "changed during CLI run <label>". Attribution is by time window, not by writer (design R12).
- **Recovery.** In diff review, for 7 days, "Restore from before this run" (`axis.worktrees/1.restoreFromRunBase { runId, paths }`) first writes a backup ref (§7), then restores the paths from `refs/axis/runbase/<runId>`.
- **UX label.** The dashboard and the Changes view say "CLI agents can overwrite other changes; Axis shows this but does not prevent it". This wording is proposed to the `UX.md` owner.

### 3.7 Review and commit while runs are active

- **Changes view grouping** is by observed attribution: composer run, during CLI run X, user or unknown. It is informational; every path is reviewed the same way.
- **Axis Commit while a composer run is active** needs a confirmation. It takes the write lock (§6.1), so it never captures a half-applied composer write. The run then gets a HEAD-moved notice.
- **Discarding a composer-written path** makes the composer's next write to it fail compare-and-swap.
- **Run end** stores the paths the run wrote, its ledger and any "possible lost change" flags with the run in `agent_runs`.

### 3.8 Tests (design tasks B11 and C5)

Each scenario must end with no silent overwrite, or with a flagged and restorable one, plus the expected notice or pause:

1. the user edits P during a composer run;
2. P is dirty in an editor;
3. a CLI writes P during a composer run;
4. a CLI commits during a composer run;
5. the branch is switched in a terminal;
6. the user discards a composer-written path;
7. a CLI overwrites a user-written path (Phase 1a) or a composer-written path (Phase 1b), and it is restored from the run base in diff review;
8. **a commit from the SCM view during drift**: the §6.3 banner is shown, the commit succeeds (it is a user path), the composer gets a HEAD-moved notice, and the run summary lists the commit;
9. the user edits P during a CLI run: the indicator shows P as "changed during CLI run X" (Phase 1a, no composer).

## 4. Terminal environment (PTY-5)

### 4.1 Scope

- **Phase 1a (decided).** PTY-5 applies to **every Axis workspace terminal**: CLI agent runs, `gh` launches, and plain user terminals.
- **How.** All of them are spawned by the Axis pty process (design §4.4) and attached through `customPtyImplementation` (`platform/terminal/common/terminal.ts:568`) [V]. The daemon builds their environment and sends it with the spawn. The upstream pty host is not involved.
- **Setting scope.** `axis.cliAgents`, `axis.terminals.scrubEnvironment`, `axis.git.runHooks` and `axis.worktrees.root` are user, application or machine scope (never workspace or folder). Workspace and folder values are ignored and a warning is surfaced (threat model CFG-1).
- **Opt-out.** `axis.terminals.scrubEnvironment` (default `true`). When it is `false`, plain user terminals use the upstream pty host and inherit the upstream environment. CLI agent runs always use PTY-5.
- **Phase 0 residual risk** (no daemon). Workspace terminals are upstream terminals. They carry:
  - `VSCODE_GIT_IPC_HANDLE`, which the git extension injects unconditionally (`extensions/git/src/ipc/ipcServer.ts:110-116`) [V];
  - `VSCODE_IPC_HOOK_CLI`, which upstream keeps (`workbench/contrib/terminal/common/terminalEnvironment.ts:295`) [V].

  D-6 (`git.terminalAuthentication: false`) removes only the askpass variables (`askpass.ts:168`) [V]. Phase 0 launches no CLI agents. A CLI the user starts by hand gets no scrub.

### 4.2 Building the environment

1. **Source.** The resolved login-shell environment. Main already resolves it with `getResolvedShellEnv` (`platform/shell/node/shellEnv.ts:32`) [V] and hands it to the daemon over the privileged port at start-up [I]. The daemon's own `process.env` (inherited from main) is never used.
2. **User terminal settings** (plain terminals only): the profile's `env` and `terminal.integrated.env.*`, resolved in the renderer and sent with the request.
3. **NODE_OPTIONS restore.** If `VSCODE_NODE_OPTIONS` is set, it becomes `NODE_OPTIONS`, as the upstream terminal does (`terminalEnvironment.ts:281-283`) [V].
4. **`envPassthrough[]`** (per CLI agent): extra variables copied from the source. Their only purpose is to add variables that exist in the source environment.
5. **The PTY-5 deny-list wins over steps 1–4.** It removes:
   - `VSCODE_*`, including `VSCODE_GIT_ASKPASS*`, `VSCODE_GIT_IPC_HANDLE`, `VSCODE_IPC_HOOK_CLI` and `VSCODE_GIT_EDITOR_*`;
   - `ELECTRON_*`;
   - the git variables that redirect git or inject configuration: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_PREFIX`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*` and `GIT_CONFIG_PARAMETERS`. **`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM` are kept by an explicit exemption:** they are the user's own environment (see section 6.5);
   - the shell-integration variables of section 4.3 that are not a user's own (`VSCODE_*` is already covered): `USER_ZDOTDIR` always, and `ZDOTDIR` only when it points inside Axis's shell-integration directory (passed in as an option; otherwise it is kept);
   - Axis-internal `AXIS_*` variables;
   - `GIT_ASKPASS`, `SSH_ASKPASS*`, `GIT_EDITOR`;
   - every variable that extension `environmentVariableCollection`s would add.

   Collections are never merged into Axis ptys in the first place. The rule also covers a passthrough, setting or source variable with the same name.
6. **Kept:** `SSH_AUTH_SOCK` and the user's Git configuration. **Never added:** Axis vault values (PTY-2). Everything else the user's login environment sets also passes through, including `LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS` and `GIT_SSH_COMMAND`. These are the user's own environment, at the same trust level as the user's login, and PTY-5 targets only what Axis, the editor and extensions inject.
7. **SI-ENV, plain terminals only** (§4.3). This is the only thing set after the deny-list.
8. `PTY-2` (an allow-list) applies only to **broker tool processes** in Phase 1b, not to terminals.

### 4.3 The shell-integration set (SI-ENV)

- **What it is.** The variables upstream shell-integration injection needs. They are produced by `getShellIntegrationInjection` (`platform/terminal/node/terminalEnvironment.ts:52`) and applied inside `TerminalProcess` after the environment it is given (`terminalProcess.ts:213-242`) [V]:
  - `VSCODE_INJECTION` (`:88`), `VSCODE_NONCE` (`:92`), `VSCODE_SHELL_ENV_REPORTING` (`:100-103`), `VSCODE_A11Y_MODE` (`:110`), `VSCODE_STABLE` (`:122-193`), `VSCODE_SHELL_LOGIN` (`:128,150`), `VSCODE_PATH_PREFIX` (`:310`);
  - for zsh, `ZDOTDIR` and `USER_ZDOTDIR` (`:252-254`);
  - exactly what that function returns for the shell, and nothing else.
- **How it is applied.** The Axis pty process reuses `TerminalProcess`, so SI-ENV is added **after** the PTY-5 environment, for **plain workspace terminals only**.
- **Never in CLI runs.** CLI runs are spawned with shell integration disabled **and no nonce supplied at all**. Upstream sets `VSCODE_NONCE` even when injection fails, whenever a nonce is supplied (`terminalProcess.ts:238-242`) [V]. So the daemon must not pass a nonce for CLI runs, and the B10 test asserts that `VSCODE_NONCE` is absent.
- **The nonce** is visible to processes inside that shell. That is upstream's accepted trade-off, and Axis keeps it.

## 5. Shell integration and split cwd

- **Correction to the earlier design text.** `ShellIntegrationAddon` loads on **every** terminal (`workbench/contrib/terminal/browser/xterm/xtermTerminal.ts:339-340`) [V], including daemon-backed ones. Most OSC 633 sequences need no nonce. So a CLI's output can set command marks and the detected cwd (OSC 633 P `Cwd=`) [I from the addon]. With `terminal.integrated.splitCwd` (`terminalConfiguration.ts:512`) [V] set to `inherited`, that detected cwd steers where a split pane starts.
- **Rules:**
  - splitting a workspace terminal (CLI or plain) always starts the new pane in the **worktree root**, the cwd Axis knows, never the detected cwd. This is done through `ICreateTerminalOptions.cwd` (`terminal.ts:769`) [V];
  - command decorations in CLI terminals are presentation only. Axis derives no status from them (design §4.5);
  - plain workspace terminals get upstream shell integration (SI-ENV, §4.3). The daemon generates the nonce and passes it to the renderer as `shellIntegrationNonce` [I, verified in task B10].

## 6. Axis git operations

### 6.1 Commit and push: the daemon orchestrates, git runs in the pty process (decided)

- **The daemon orchestrates commit and push; the git process runs in the Axis pty process.** They are started by the user: `axis.worktrees/1.commit { id, paths, message }` and `.push { id }`. The daemon validates the request, takes the lock, mutex and drift gate, writes the journal, and sends the exact git command over the pty-process control channel. Exit status and output return on that channel. The daemon holds the lock across the spawn. The pty process holds no secrets, so hooks and credential helpers never run in the daemon.
- **Lock and mutex.** Both run the git CLI in the worktree, under the per-project git mutex and the per-workspace write lock, so they are serialised with each other and with composer writes (§3.3).
- **Identity.** Commits use the user's Git identity (ADR 0004 security 6).
- **Commit is gated by the common-dir drift check.** If the GIT-SNAP-1 set (§6.4) differs from the baseline the user last acknowledged, commit is refused until the user reviews the change. GIT-SNAP-1 is re-taken immediately before each commit and each push. **Commit and push are also refused while a CLI run is active in that workspace**, meaning an Axis-launched CLI process is alive in that workspace's pty (an exited run, or a CLI the user started by hand in a terminal, does not count), so no CLI can change the set between the re-take and git executing a hook.
- **Commit binds the reviewed tree.** Diff review records the tree hash. The commit is built from that exact tree and refuses if the worktree or index differs. Hunk accept applies a daemon `applyPatch` to the reviewed state.
- **Argument safety.** Values from a request (workspace name, branch slug, base ref, remote) go after `--` or through `rev-parse --verify`; branch names pass `check-ref-format --branch` and must not start with `-`; remotes come from the journal; `ext::` and unlisted transports are refused.
- **Secrets in the pushed diff.** The diff to be pushed is scanned with the secret-pattern scanner; a match needs a confirmation. This does not stop a push made by a CLI or a terminal.
- **Hooks.**
  - Axis commit and push run the repository's configured hooks only while the common dir matches that acknowledged baseline, so only hooks the user has seen can run. **The hooks run in the Axis pty process context, which holds no secrets, never in the daemon** (threat model GIT-3). The daemon sends the exact git command over the control channel. `axis.git.runHooks` (default `true` in 1a) can turn hooks off; it is re-evaluated in 1b when the vault ships.
  - **Commit hooks (decided 2026-11-04).** The daemon never runs repository hooks. `@axis/git-ops` builds the commit with `commit-tree` and moves the branch with a compare-and-swap `update-ref`, and neither runs a hook. **NOT BUILT YET: today no commit hook runs; building the hook step is a named follow-up (ticket H9-hooks).** When built, with `axis.git.runHooks` on, the host runs the repository's `pre-commit` and `commit-msg` hooks in the pty process context; the sequence is all under the daemon's commit lock: first the CLI-run refusal and the GIT-SNAP-1 drift re-take, then the host runs `pre-commit` and `commit-msg` against a temporary index and scratch checkout of the reviewed tree (never the user's worktree or real index), then a freshness re-check, then `commit-tree` and the compare-and-swap. A hook that modifies files makes the commit refused with a hook-specific reason (the changes are discarded and the user is told to run the formatter and review again; Axis commits exactly the reviewed tree). A message rewritten by `commit-msg` is shown to the user before it is committed, and the message that is committed is recorded in the audit event. `post-commit`, `reference-transaction` and the other hooks are not run in 1a. Push still runs `pre-push` in the pty process. This amends ADR 0004 §4, decision Q-4 and GIT-3 (see the amendment there, and `docs/packages.md`, "Commit hooks").
  - Other daemon git calls (worktree, discard, snapshots, status) always use `core.hooksPath=/dev/null` (Windows: a daemon-owned empty regular file), `core.fsmonitor=false`, a timeout and GIT-ENV-1 (§6.5; design §5.3 invariant 4), and run only an exact allow-list of command shapes that cannot start a filter driver (`filter.*.clean`, `.smudge`, `.process`) or an editor; any other git command is refused. Snapshots read file content in the daemon (no symlink is followed and no FIFO is opened for reading) and store it with `hash-object --no-filters --stdin` and `update-index --index-info`, and dirty files are found without `git status`.
- **Push** is refused on unacknowledged GIT-SNAP-1 drift, as commit is (a planted `url.*.insteadOf`, `remote.*.pushurl` or `credential.helper` would otherwise redirect it). It runs `git push <remote> refs/heads/axis/<slug>:refs/heads/axis/<slug>`, with an explicit refspec, never `--mirror` or `--all`. It uses the PTY-5 environment with `GIT_TERMINAL_PROMPT=0`. If push needs interactive credentials, Axis offers to run the same command in a workspace terminal.
- **Signed commits.** With `commit.gpgsign` and a pinentry that needs a TTY, the commit fails without prompting. Axis does not offer a `git commit` fallback: a commit made in a terminal skips the reviewed-tree binding (§6.3). The user can sign in a terminal outside Axis, or fix the signing setup and commit again from the review.
- **Broker.** A composer push request is a default-deny tier.
- **Removed path.** `IGitService.commitFiles` is no longer used for Axis review actions. `IGitService` stays read-only for change state (design §4.3).

### 6.2 Open pull request

- On GitHub, Axis opens `https://github.com/<owner>/<repo>/compare/<base>...axis/<slug>` through `IOpenerService`, or runs `gh pr create --web` in a PTY-5 managed pty.
- Other forges show "not supported yet". Axis stores no forge credentials.

### 6.3 The SCM view is a user path outside these guarantees

- **What the SCM view does.** The IDE view's SCM view, and `git` in any terminal, commit and push through the git extension or the CLI directly. They do not take the daemon's lock or mutex, and they skip the drift gate.
- **What is scoped to Axis actions.** Invariants 5 and 7 (design §5.3) and the write-lock guarantee (§3.3, §3.7) apply only to Axis actions.
- **Banner, with no upstream patch.**
  - Axis registers a view in the SCM view container (`workbench.view.scm`, `contrib/scm/common/scm.ts:21`) [V] through `IViewsRegistry.registerViews`. It is shown only while the context key `axis.workspaceDrift` is true.
  - The view says "Git configuration or hooks changed since you last reviewed them", or "Agent run active", and links to the review.
  - A warning action in `MenuId.SCMTitle` (`platform/actions/common/actions.ts:167`) [V] carries the same message.

### 6.4 GIT-SNAP-1: the common-dir guard set

The set required by ADR 0004 security implication 3:

- `$GIT_COMMON_DIR/config`;
- every `config.worktree` file (`$GIT_COMMON_DIR/worktrees/*/config.worktree` and the main one);
- `hooks/`;
- `info/attributes`;
- the worktree's root `.git` file, and `$GIT_COMMON_DIR/worktrees/<name>/{gitdir,commondir}`;
- the contents of the target of an effective `core.hooksPath` that lies inside any worktree (for example a committed `.husky/` or `.githooks/`), because editing those files leaves `config` unchanged;
- the effective values of `filter.*`, `diff.*` (drivers), `core.hooksPath`, `core.fsmonitor` and `core.sshCommand`, as `git config --show-origin` reports them for the repository.

**When it is taken:**

- at worktree creation, as the baseline;
- before each CLI run's launch and after its exit;
- before each Axis commit and each Axis push;
- on status refresh.

It is stored as content hashes plus the full text, for the before/after diff. Changes outside the repository's Git directory (global config, home directory) are not detected, as ADR 0004 states.

### 6.5 GIT-ENV-1: the daemon git environment

- **Applies to** every daemon git call except commit and push.
- **Contents.** An allow-list taken from the resolved shell environment: `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TMPDIR`, plus `GIT_TERMINAL_PROMPT=0`. Every other `GIT_*` variable is removed.
- **Windows.** The allow-list also holds `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `HOMEDRIVE` and `HOMEPATH`, compared case-insensitively, because git does not run without them.
- **User-owned git config files.** `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM` are kept in CLI runs. They name files the user chose. When either of the first two resolves inside a managed worktree, Axis warns, because an agent can edit that file; the check is a pure helper over the environment and the worktree roots. GIT-ENV-1 itself drops them, as it drops every other `GIT_*` variable.
- **Distinct from PTY-2.** PTY-2 is the broker's tool environment. Commit and push use PTY-5 instead (§6.1), because they need the user's credentials and signing setup.

## 7. Snapshot refs

| Ref | Written by | Content | Retention |
|---|---|---|---|
| `refs/axis/runbase/<runId>` | Run start | HEAD plus tracked and untracked, not ignored | 7 days after the run ends |
| `refs/axis/backup/<id>/<ts>` | `discard`, `restoreFromRunBase`, dirty `remove` | Same | 30 days (D-8) |
| `refs/axis/archive/<id>` | `finalise` | The branch tip | Until the user deletes it (D-8) |

- **Ignored files are excluded.** Untracked, non-ignored files are included. These may hold secrets (for example a new `.env` that is not ignored), and they become objects in the shared common dir.
- **Disclosure.** The snapshot dialog and the workspace Settings page state that snapshots may hold untracked, non-ignored files, which can include secrets. Phase 1b scans snapshot trees for secret patterns before writing a snapshot.
- **Never pushed.** Axis never mirror-pushes. `git push --mirror` by the user, or a tool, would publish `refs/axis/*`. The dashboard's "Clean up snapshots" action and the retention job delete expired refs and run `git gc --prune` on the user's schedule, never automatically.
- **Repository growth.** Large untracked artifacts inflate the repository (design R13). Snapshots skip files larger than 50 MiB and list them in the run summary.

## 8. Shortcuts (D-7)

- **Status.** Adopted in `UX.md` on `main` (`a0cb0a3`).
- **Platforms.** `Mod` is Cmd on macOS and Ctrl on Windows and Linux.

| Command | macOS | Windows and Linux |
|---|---|---|
| `axis.view.toggle` (toggle Agent / IDE view; in split mode, focus the other half) | `Ctrl+Cmd+V` | `Ctrl+Shift+Alt+V` |
| `axis.dashboard.show` | `Ctrl+Cmd+0` | `Ctrl+Shift+Alt+0` |
| `axis.workspace.focus.1` … `.9` | `Ctrl+Alt+Cmd+1` … `9` | `Ctrl+Shift+Alt+1` … `9` |
| `axis.workspace.next` / `.previous` | `Ctrl+Cmd+]` / `Ctrl+Cmd+[` | `Ctrl+Shift+Alt+]` / `Ctrl+Shift+Alt+[` |
| Cycle parts across both views | `F6` / `Shift+F6` (upstream, kept) | same |
| `axis.split.collapseAgent` / `.collapseIde` | command only | command only |

**How each binding was verified [V]:**

- **Coverage.** Every `KeyMod`/`KeyCode` expression in non-test `src/vs/**/*.ts` was indexed by modifier set and key: 3,003 expressions, covering `primary`, `secondary`, the `mac`/`win`/`linux` overrides and both parts of `KeyChord`. So were the 100 `contributes.keybindings` entries in built-in `extensions/*/package.json`. Every chosen binding has zero matches.
- **Rejected candidates:**
  - `Mod+Alt+V` is editor dictation (`editorDictation.ts:69`);
  - on macOS, `Mod+Alt+0` is Toggle Editor Group Layout (`openEditorsView.ts:938`);
  - on macOS, `Ctrl+Cmd+1` and `Ctrl+Cmd+9` move the editor to the first and last group (`editorActions.ts:2220,2239`);
  - `Mod+Shift+A`, `Mod+Shift+Enter` and `Mod+Alt+Enter` each have 6 or more registrations;
  - `Ctrl+Cmd+F` and `Ctrl+Cmd+I` are taken, as are `Ctrl+Shift+Alt` with `A`, `C`, `G`, `I`, `L` or `O`.
- **Windows and Linux use `Ctrl+Shift+Alt`, not `Ctrl+Alt`,** because `Ctrl+Alt` is AltGr on many layouts. Upstream binds `Ctrl+Shift+Alt+G` on every platform with no override (`codeEditor/browser/accessibility/accessibility.ts:66`) [V].
- **Not covered by the scan [I]:**
  - OS-reserved shortcuts;
  - layouts where AltGr+Shift types characters with digits or brackets;
  - third-party extensions.

  Design task A7 checks these by hand on macOS, on one Linux desktop, and on Windows with a Polish and a Czech layout.

## 9. Status wording proposed to `UX.md` and ADR 0004

| Design term | Shown as | Note |
|---|---|---|
| CLI run quiet | "quiet (may be waiting for input)" | The honest form of ADR 0004 decision 8's "waiting for input". Axis cannot know that a CLI is waiting |
| Workspace finalised | "Done" | Matches `UX.md` and `PRODUCT.md` |
| Changes not yet committed | "Changes to review" | Replaces "needs review" |
| Commit or push refused because a CLI run is active | "Stop the agent run to commit" | Shown on the disabled Commit and Push actions (section 6.1) |
