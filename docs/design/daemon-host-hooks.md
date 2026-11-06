# Commit and push hooks for Axis git operations (ticket H9-hooks)

Status: DESIGN ONLY (revision 2, after design review 1). Nothing here is built; the headless slice still asserts that an Axis commit runs no hook. Sources: ADR 0004 §4 and its amendment of 2026-11-04, `docs/design/axis-agent-shell-policies.md` §6.1, `docs/packages.md` "Commit hooks", `docs/design/daemon-host.md` §6.4, `docs/design/pty-process.md` (open question 1), ROADMAP lines 28, 40, 49 and 80, threat model GIT-3 and PTY-5, residual register RR-4 and RR-29.

## 1. What is true today (verified in the tree)

- `@axis/git-ops` `executeCommit` builds the commit with `commit-tree` and moves the branch with a compare-and-swap `update-ref`. Neither runs `pre-commit`, `commit-msg`, `post-commit` or `reference-transaction`. `runHooks` changes only push (`--no-verify`).
- The daemon runner (`context: "daemon"`) always carries an empty `core.hooksPath`; `daemonGitFor` refuses a daemon call without the hardened options. Worktree create, status and remove use `@axis/worktrees`' own hardened runner. Planted-hook tests for those exist (`packages/worktrees/test/lifecycle.test.ts`, `rereview-filters.test.ts`, `packages/git-ops/test/real.test.ts`), each with a control that plain git DOES run the hook.
- `createGitPort` takes an optional `ptyRunner`; absent, every `pty`-context command is `E_UNAVAILABLE`. No production code supplies one: `@axis/pty-process` has `spawn`, `kill`, `resize`, `write` and `grant` and no way to run a bounded, non-interactive git command. `docs/design/pty-process.md` leaves exactly this to this ticket. So `commit-tree` and `push` have no real runner either; the slice uses a fake.
- The PTY-5 deny-list (`packages/pty-policy/src/names.ts`) refuses `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE` and every `AXIS_*` name (`git-redirect`, `axis-internal`), and the pty service re-checks it on every spawn.
- The `axis.git/1` commit reply is `{ commit, tree }`. Nothing says the commit was made without its hooks (RR-4).

## 2. Invariants (each has a test in §9)

H-1. The daemon never executes a repository hook, a filter driver, a credential helper or an editor. It sends closed, validated messages to the pty process.
H-2. A hook planted in `$GIT_COMMON_DIR/hooks` (or an in-worktree `core.hooksPath` target) never runs during worktree create, status, remove, restore, snapshot or diff. Only Axis commit and push, through the pty context, can run one.
H-3. Hooks run only under the project mutex and the workspace lock, after the CLI-run refusal and a GIT-SNAP-1 re-take. A second re-take runs after the last hook and BEFORE any git call that reads the repository again (§5 step 9), and again before `commit-tree`.
H-4. Axis commits exactly the reviewed tree. A hook can only veto: a hook that changes a file, stages a file, adds a file or rewrites the message makes the commit refused.
H-5. No silent bypass. With `axis.git.runHooks` on, an Axis commit either runs every applicable hook and reports so, or is refused. A missing pty process or runner, a timeout, a protocol error or an unseen hook path is a refusal.
H-6. The reply and the audit event say what happened to each hook (`ran`, `absent`, `off`) (closes RR-4).
H-7. Hook and push output goes to the user's terminal, never into the daemon, the journal, the audit log or an error text. The daemon sees an exit status and a closed reason.
H-8. `axis.git.runHooks` comes from the user, application or machine scope only (CFG-1).
H-9. PTY-5 is not weakened. The git redirectors (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`) exist in a child's environment only when the pty SERVICE put them there for a bound attempt (§4.3). No caller-supplied environment, on any message, may carry them.
H-10. Hook output and the hook terminal's input cannot satisfy an approval. The push challenge is spent before `pre-push` runs, commit approval is never read from a terminal, and the exit status is the only signal the daemon reads.

## 3. Components and who does what

| Step | Where | Why |
|---|---|---|
| Validate the request, mutex and lock, CLI-run refusal, drift re-takes, freshness, journal, audit | daemon host (H9 handler, git-ops) | policy and state, no user code |
| Resolve the hooks directory (`git rev-parse --git-path hooks`) | pty process, bound `exec` | reads user config |
| `lstat`, `realpath` and set membership of the hook file | daemon, filesystem reads only | no code runs; GIT-SNAP-1 already reads these |
| Scratch checkout, temporary index, verification | pty service (§4.3) | filters and config are user code territory |
| Run the hook | pty service, `hook` message, into a user-visible terminal (§4.2) | user-controlled code, output for the user |
| Decide | daemon, from closed replies | the decision is not made by the process that ran the hook |
| `commit-tree`, `update-ref`, `push` | pty process | credentials and signing live there |

The pty process holds no vault secret but runs as the user with the user's credential environment (RR-29); unchanged here and re-decided with the vault in 1b (D5).

## 4. Pty process surface (new control-channel messages)

The control channel stays the only channel that can start a process (PTY-7). Every new message has a strict schema, the existing `LIMITS`, and is unreachable from a data channel.

### 4.1 `exec`: a bounded, non-interactive command

`{ t: "exec", req, argv, cwd, env, stdin?, timeoutMs, maxOutput, bind? }` answered by `{ t: "exec-result", req, code, signal, stdout, stderr, truncated, raw? }` or `{ t: "exec-failed", req, code }` (`env_denied`, `bad_argv`, `bad_bind`, `capacity`, `timeout`, `spawn_failed`, `no_control`).

- `argv[0]` must equal the one absolute git path the pty process was started with (set at startup, never from a message), enforced IN the pty service as well as in the host adapter, so `exec` is not a general launcher. `cwd` absolute, no NUL, own process group killed on timeout, channel close or dispose, at most 8 outstanding, every one settles within its timeout.
- The caller's `env` is checked against the PTY-5 deny-list exactly as `spawn` does; a `GIT_DIR` in it is `env_denied`, with or without `bind`.
- No TTY; stdout and stderr captured up to `maxOutput` (`truncated` beyond it); `raw` returns one character per byte.
- `createPtyGitRunner(port)` adapts it to git-ops' `GitRunner` for `context: "pty"`; it refuses every other context. Its output is `ptyRunner` of `createGitPort`.
- Every decision input read from an `exec` result (`write-tree`, `rev-parse`, `ls-tree`) is validated against the strict object-id pattern; other text is never parsed for a decision.

### 4.2 `hook`: a hook run in a user-visible terminal

`{ t: "hook", req, runId, attempt, bind, hook, hookPath, expectSha256, message?, env, cols, rows }`, `hook` one of `pre-commit`, `commit-msg`, answered like `spawn` (`spawned`, `spawn-failed`, then `exit`, `group-empty`).

- The service does what a hook needs and nothing else: it builds the child environment itself (§4.3), writes `message` (commit-msg only) to its own `<attempt>.msg`, passes that path as the only argument, and spawns `argv = [hookPath, ...]` with `cwd` = the scratch tree.
- Immediately before the spawn the service re-checks `hookPath` (regular file after `realpath`, executable bit), reads it and compares its SHA-256 with `expectSha256`; a mismatch is `spawn-failed` with code `hook_changed` and nothing runs (S-1). The remaining window between that read and `exec` is a recorded residual (R-H1).
- The terminal is granted (`grant`) to the workspace's terminal and attached BEFORE the spawn so early output is not dropped (`pty-process.md` drops output before the first attach); if the UI is absent the output may be lost, which does not change the verdict.
- The daemon waits for `exit` under a timeout and a cancel signal; either sends `kill SIGKILL` and refuses `hook_timeout` or `E_CANCELLED`. After the exit it asks `groupAlive()`; a survivor refuses the commit (`hook_failed`). A process that `setsid`s out of the group is invisible (known limit, R-H2).

### 4.3 The closed pty-set exception for git redirectors (H-9)

A hook and the scratch git calls need `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`. They are NOT taken from any message's `env`. A `bind` is `{ gitDir, index: 1 | 2 }` and:

- `gitDir`: absolute, no NUL, a directory that holds `HEAD` and a `commondir` or `objects` entry, and equal to the `gitDir` the daemon registered for this `attempt` in `scratch-begin` (below). It names a repository the daemon already knows; the pty process trusts the daemon for WHICH repository exactly as it does for `cwd`, and nothing else in the message can redirect git.
- `GIT_WORK_TREE` is always `<scratchRoot>/<attempt>/tree` and `GIT_INDEX_FILE` always `<scratchRoot>/<attempt>/index<n>`, both derived by the service from its own scratch root and the validated `attempt` id (`^[a-z0-9_-]{8,64}$`). No path comes from the message.
- Only `exec` with `bind` and `hook` get this; `spawn`, plain `exec`, `grant` and every data message cannot. The service also injects, in front of every bound git call and not from the caller, `-c core.hooksPath=<empty> -c core.fsmonitor=false -c core.attributesFile= -c core.pager=cat` and `GIT_OPTIONAL_LOCKS=0`; hooks themselves get none of these (they are the user's code).
- No `AXIS_HOOK` marker: `AXIS_*` stays denied. The variable set a hook sees is PTY-5 environment, the three redirectors and the identity variables git would set for a commit.

Scratch lifecycle messages, same schema rules: `scratch-begin { attempt, gitDir, tree }` (creates `<scratchRoot>/<attempt>` mode 0700 under a 0700 `hook-scratch/` parent, fills it, §5 step 5), `scratch-verify { attempt }` (§5 step 8) and `scratch-end { attempt }` (removes everything). At most 2 attempts exist; the whole root is swept at service start and on channel close.

## 5. The commit sequence with hooks

All under the existing mutex and lock. New steps are marked.

1. Request validation, journal branch, reviewed-tree lookup, `prepare`, `handoff`. Unchanged.
2. CLI-run refusal, then GIT-SNAP-1 re-take (`git_drift` on unacknowledged change). Unchanged. The snapshot also yields a content SHA-256 for every file in `hooks/` and every file under an in-worktree `core.hooksPath` target.
3. **(new)** `runHooks` false: record `off` for both hooks and skip to step 10.
4. **(new)** Resolve each hook: bound `exec` of `rev-parse --git-path hooks` (honours `core.hooksPath`; a relative result is made absolute against the REAL worktree, never the scratch). The daemon `lstat`s the candidate; no file or not executable is `absent`. Otherwise `realpath` it; BOTH the path and its realpath must lie in the GIT-SNAP-1 set (common-dir `hooks/` or an in-worktree `core.hooksPath` target) or the commit is refused `hook_path_unseen`: a symlink out of the set, a `..` escape or a hooks directory outside the worktree and common dir never runs. `expectSha256` is that file's hash from the step 2 snapshot.
5. **(new)** `scratch-begin`: the service fills `<scratch>/tree` from `reviewedTreeHash` WITHOUT any filter: `ls-tree -r -z` for modes and ids, `cat-file --batch` for the raw blobs it writes itself (regular files with the recorded executable bit, symlinks as symlinks, gitlinks as empty directories), and `read-tree` into `index1`. No `checkout-index`, so no clean, smudge or eol conversion can run or change bytes (D3). It records a manifest (path, mode, blob id).
6. **(new)** `pre-commit` via `hook` with `bind.index = 1`: git's own environment for a commit (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, identity) so `git diff --cached` inside the hook sees the reviewed tree against HEAD.
7. **(new)** `commit-msg` via `hook` with the normalised message git-ops computes; the service reads the file back.
8. **(new)** `scratch-verify`: the service answers `{ staged: <tree id>, files: "same" | "changed", message: "same" | "changed" }`. `staged` is `write-tree` of `index1`. `files` hashes every manifest path with `hash-object --no-filters --stdin-paths` and compares mode and id, and ANY path under the tree that is not in the manifest counts as changed, whatever the ignore rules say (no git ignore logic is involved, so `info/exclude` and `core.excludesFile` cannot hide a file; a formatter cache in the tree is refused, D3). The daemon requires `staged == reviewedTreeHash`, `files == same`, `message == same`, else `hook_modified_files` or `hook_changed_message`. A hook exit status other than 0 is `hook_failed` (an integer, never output).
9. **(new)** `scratch-end`. THEN the second GIT-SNAP-1 re-take (before any other git call that reads the repository: a hook may have just written `core.fsmonitor` or a filter into the config, and the bound calls above already ran with those pinned off), then `assertReviewFresh`. Either failing refuses (`git_drift`, `stale`).
10. `commit-tree` with the original message, in the pty context (existing).
11. Verify the object (one parent, the reviewed tree), re-check HEAD, branch and operation state (existing).
12. Compare-and-swap `update-ref` (existing).
13. Reply `{ commit, tree, hooks }` and the audit event (§6).

`post-commit`, `reference-transaction`, `prepare-commit-msg` and every other hook are not run in 1a.

### 5.1 Why the message is refused instead of adopted

The decision of 2026-11-04 says a rewritten message is shown before it is committed. That needs a second round trip `axis.git/1` does not have. Slice default (D2): refuse `hook_changed_message`. The audit event records the SHA-256 and length of the message that was committed, which equals the one the user typed.

### 5.2 Push

Push runs as a terminal-bound run, not through `exec`: `git push <remote> <explicit refspec>` with the argv git-ops builds, the PTY-5 environment and `GIT_TERMINAL_PROMPT=0`, spawned into the workspace terminal, so git's and `pre-push`'s output goes to the user and the daemon reads only the exit status (H-7). The challenge is spent before this runs (H-10). Before the spawn the host resolves the `pre-push` file as in step 4 (path and realpath in the set, else `hook_path_unseen`). Git resolves the hook itself, so the hash check of §4.2 cannot be applied to it: a swap between the last re-take and git's exec runs the hook once and the push is refused after the fact. This is residual R-H1 and the reason ROADMAP line 49 needs its wording amended (§8). A `pre-push` that exits non-zero is `hook_failed` with the challenge already spent; the client says "your pre-push hook blocked the push". S4 confirms git-ops' push reads only the exit status; if it reads stdout, that read moves to a separate bound `exec`.

## 6. Reporting and audit (contract additions)

All additive inside `axis.git/1` (ADR 0003 D2, no version bump).

- `gitCommitResponseSchema` gains `hooks: { preCommit: HookState, commitMsg: HookState }`, `HookState = "ran" | "absent" | "off"`; required in what the new handler produces, optional in the schema so an older reply validates. The push reply gains `hooks: { prePush: HookState }`.
- `GIT_COMMIT_REFUSALS` gains closed reasons only: `E_CONFLICT`: `hook_failed`, `hook_modified_files`, `hook_changed_message`, `hook_timeout`, `hook_path_unseen`, `hook_changed`; `E_UNAVAILABLE`: `hooks_unavailable`. The protocol-copies test compares both directions with the source, so a git-ops reason and its protocol copy land in one commit.
- The `git.commit` audit event adds the three hook states, for a refused hook the hook name and exit code, and the SHA-256 and length of the committed message. Never output, a path or message text. `host-audit-allowlist.test.ts` pins the fields.

## 7. GIT-ENV-1: the planted hook, per path

| Path | Expected behaviour | Test |
|---|---|---|
| `worktrees.create`, `status`, `remove`, restore, snapshot, diff | no hook runs, control shows plain git runs it | exists in worktrees; host-level copy added in S3 |
| Axis commit, `runHooks` off | no hook runs, reply `off` | S3 |
| Axis commit, `runHooks` on, planted `pre-commit` | runs in the pty process, never the daemon (the test runner records context and cwd), reply `ran` | S3 |
| hook planted after the drift baseline | refused `git_drift`, hook not run | S3 |
| hook swapped after the re-take, before the spawn | `hook_changed`, hook not run | S1 |
| hook that edits `hooks/` or writes `core.fsmonitor` | refused `git_drift` after the hook; the fsmonitor command never runs | S2 |
| hook is a symlink out of the set; `core.hooksPath` with `..` | `hook_path_unseen`, not run | S2 |
| pty runner absent | `hooks_unavailable`, branch unchanged, index restored | S3 |
| generic `spawn` or `exec` (or `hook`) with `GIT_DIR` in `env` | `env_denied` (PTY-5 intact after S1) | S1 |

## 8. Gate lines and documentation follow-ups

- **New gate line PTY-5-HOOK:** `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` appear in a pty child only for a bound attempt and are derived by the service; a mutation that adds an allow-flag to `spawn`, or reads the redirectors from a message, must fail a named test.
- **ROADMAP line 49** ("a hook swapped after the re-take but before git executes does not run") is met for commit hooks as "a hook whose content differs from the re-taken hash does not run; a swap inside the hash-to-exec window is detected after and the commit refused", and for `pre-push` as "may run once, then the push is refused". The line is amended in S3 to say so (R-H1).
- **ROADMAP line 40** stays open until S1 to S3 merge.
- S3 also amends, in wording only: ADR 0004 amendment and policies §6.1 and `docs/packages.md` "Commit hooks" (a rewritten message is refused, not shown; the audit event records its hash and length), and RR-4 closes with S3 (push half S4).

## 9. Slices and tests (each must fail on mutation)

- **S1: `exec`, `hook`, `scratch-*` in `@axis/pty-process`**, plus `createPtyGitRunner`. Tests: schemas and bounds; the `argv[0]` equals the startup git path; the deny-list on `env` with and without `bind`; derived scratch paths (a message with `../` in `attempt` is refused); `gitDir` equal to the registered one; hash mismatch is `hook_changed`; timeout kills the group; output cap; capacity; a data channel cannot send any of them; channel close removes scratch; scratch 0700; raw blob fill preserves bytes with an `eol` or `filter` attribute in the tree. Mutations: drop the env re-check, add a spawn allow-flag, take `GIT_INDEX_FILE` from the message, skip the hash compare, skip the cap, use `checkout-index`.
- **S2: git-ops hook step** (`hooks.ts`, steps 3 to 9) over an injected executor. Real repository tests: modifying, `add`ing, file-creating (including a path hidden by `info/exclude`), message-rewriting, failing, timing-out hooks; `absent`, `off`; the symlink and `..` cases; the hook that writes `core.fsmonitor`. Mutations: skip the second re-take, run it after `write-tree`, drop the new-file rule, treat a missing executor as `off`, resolve the hooks path against the scratch.
- **S3: host wiring and contract** (binding supplies the executor over the pty runner; protocol, handler, audit; the §7 table; slice step 5 updated; the CFG-1 test that a repository setting cannot switch `runHooks`, for H-8; the §8 wording changes).
- **S4: push** (terminal-bound run, `pre-push` path check, `hooks.prePush`).
- **S5: UI** (the terminal and Agent-view row), on the shell track.

Every slice also shows: scratch removed on every exit path including a throw and an abort; no listener, timer or child left; a hook that prints a marker never appears in any error, log line or audit event; the gate is green on any git version (tests use the repository's own git and skip with a reason when a capability is missing).

## 10. Decisions

OPEN means it needs the master's answer before code.

- **D1 (OPEN).** With `runHooks` on and no pty runner an Axis commit is refused (`hooks_unavailable`). Until S1 and S3 merge a real host cannot commit with the default setting; the slice keeps its fake runner.
- **D2 (OPEN).** A message-rewriting `commit-msg` refuses (§5.1). Stricter than the 2026-11-04 text.
- **D3 (OPEN).** The scratch tree is raw (no filters, no eol) and ANY new file refuses, ignored or not (§5 steps 5 and 8). A repository whose hooks need smudged content, or whose formatter writes ignored caches into the tree, gets `hook_failed` or `hook_modified_files`. Strict and git-version independent.
- **D4.** Hook timeout 300 seconds, because the project mutex is held throughout; other git operations of that project wait. A user-scope setting later.
- **D5.** RR-29 stays: hooks see the user's credential environment. The 1b vault decision (ROADMAP line 80) must say whether a hook may ever see vault-backed credentials; assumed no.
- **D6.** A hook path outside the GIT-SNAP-1 set is refused, symlinks by realpath.

Residuals, to enter the register with S3: **R-H1** the hash-to-exec window (commit) and the stat-to-exec window (`pre-push`); **R-H2** a hook child that `setsid`s or double-forks is invisible to `groupAlive` and could change the config between the last re-take and `commit-tree`; **R-H3** the pty process trusts the daemon for which repository a `bind` names.

## 11. Why this ticket stops at the design

The work spans `@axis/pty-process` (new process-launching messages), `@axis/git-ops` (the commit sequence), the daemon-host binding, handler and audit allow-list, and `@axis/protocol`. It touches the commit trust boundary (reviewed-tree binding, drift gate, audit) and PTY-5 itself (§4.3). Each slice needs independent security review, and D1 to D3 need an answer before code.
