# Commit and push hooks for Axis git operations (ticket H9-hooks)

Status: DESIGN ONLY. Nothing here is built; the headless slice still asserts that an Axis commit runs no hook. Sources: ADR 0004 §4 and its amendment of 2026-11-04, `docs/design/axis-agent-shell-policies.md` §6.1, `docs/packages.md` "Commit hooks", `docs/design/daemon-host.md` §6.4, `docs/design/pty-process.md` (open question 1), ROADMAP lines 28, 40, 49 and 80 (GIT-ENV-1, WT-2, hooks placement), threat model GIT-3, residual register RR-4 and RR-29.

## 1. What is true today (verified in the tree)

- `@axis/git-ops` `executeCommit` builds the commit with `commit-tree` and moves the branch with a compare-and-swap `update-ref`. Neither runs `pre-commit`, `commit-msg`, `post-commit` or `reference-transaction`. `runHooks` changes only push (`--no-verify`).
- The daemon runner (`context: "daemon"`) always carries `core.hooksPath=<empty>`; `daemonGitFor` refuses a daemon call without the hardened options. Worktree create, status and remove use `@axis/worktrees`' own hardened runner (`/dev/null` hooks path, or the guarded empty file on Windows). Planted-hook tests for those already exist (`packages/worktrees/test/lifecycle.test.ts`, `rereview-filters.test.ts`, `packages/git-ops/test/real.test.ts`), each with a control that plain git DOES run the hook.
- `createGitPort` takes an optional `ptyRunner`; absent, every `pty`-context command is `E_UNAVAILABLE`. No production code supplies one: `@axis/pty-process` has `spawn`, `kill`, `resize`, `write` and `grant` on its control channel and no way to run a bounded, non-interactive git command and read its result. `docs/design/pty-process.md` leaves exactly this ("a separate control message family") to this ticket.
- So today `commit-tree` and `push` have no real runner either; the slice uses a fake.
- The `axis.git/1` commit reply is `{ commit, tree }`. Nothing tells the client, or the audit log, that the commit was made without its hooks (RR-4).

## 2. Invariants (all must hold; each has a test in §8)

H-1. The daemon never executes a repository hook, a filter driver, a credential helper or an editor. It only sends closed, validated messages to the pty process.
H-2. A hook planted in `$GIT_COMMON_DIR/hooks` (or in an in-worktree `core.hooksPath` target) never runs during worktree create, status, remove, restore, snapshot or diff. Only Axis commit and push, through the pty context, can run one.
H-3. Hooks run only under the project mutex and the workspace lock, after the CLI-run refusal and a GIT-SNAP-1 re-take, and a second GIT-SNAP-1 re-take runs after the last hook and before `commit-tree`. A hook that edits `hooks/`, `config` or an effective `core.hooksPath` target therefore makes the commit `git_drift`, and nothing is committed.
H-4. Axis commits exactly the reviewed tree. A hook can only veto. A hook that changes a file, stages a file, creates a tracked-looking file or rewrites the message does not change what is committed: the commit is refused (§5).
H-5. No silent bypass. With `axis.git.runHooks` on, an Axis commit either runs every applicable hook and reports so, or is refused. A missing pty process, a missing runner, a timeout or a protocol error is a refusal, never a hook-less commit.
H-6. The reply and the audit event say what happened to each hook (`ran`, `absent`, `off`), so "made without hooks" is a recorded fact (closes RR-4).
H-7. Hook output goes to the user's terminal and never into the daemon, the journal, the audit log or an error text. The daemon sees an exit status and a closed reason.
H-8. `axis.git.runHooks` is read from the user, application or machine scope only (CFG-1). A repository setting cannot switch it.

## 3. Components and who does what

| Step | Where | Why |
|---|---|---|
| Validate the request, take the mutex and lock, CLI-run refusal, drift re-take, freshness checks, journal, audit | daemon host (existing H9 handler and git-ops) | policy and state, no user code |
| Decide which hooks apply: resolve the hooks directory, test for the file | pty process, via `exec` (§4.1) | resolving needs `git rev-parse --git-path hooks`, which reads user config; the answer is only a path |
| Materialise the scratch checkout and the temporary indexes | pty process, via `exec` | reads the object store with filters (user code) possible |
| Run the hook | pty process, via `spawn` into a user-visible terminal (§4.2) | the hook is user-controlled code and its output is for the user |
| Compare the result against the reviewed tree, decide | daemon host, from the exit code and tree ids the `exec` calls return | the decision must not be made by the process that ran the hook |
| `commit-tree`, `update-ref`, `push` | pty process through the same `exec` runner (existing git-ops commands) | credentials and signing live there |

The pty process holds no vault secret, but it runs as the user with the user's credential environment (RR-29); that exposure is unchanged by this ticket and is re-decided with the vault in 1b (ROADMAP line 80, §9 D5).

## 4. Pty process surface (new, two additions to the control channel)

The control channel stays the only channel that can start a process (PTY-7). Both additions are daemon-to-pty messages with strict schemas and the existing `LIMITS`; neither is reachable from a data channel.

### 4.1 `exec`: a bounded, non-interactive command

`{ t: "exec", req, argv, cwd, env, stdin?, timeoutMs, maxOutput }` answered by `{ t: "exec-result", req, code, signal, stdout, stderr, truncated, raw? }` or `{ t: "exec-failed", req, code }` (`env_denied`, `bad_argv`, `capacity`, `timeout`, `spawn_failed`, `no_control`).

- Same checks as `spawn`: `argv[0]` and `cwd` absolute, no NUL, the PTY-5 deny-list re-checked on the environment, the child in its own group, killed with its group on timeout, channel close or dispose.
- No TTY, stdout and stderr captured up to `maxOutput` (`truncated` set beyond it), `stdin` written once and closed. `raw` returns stdout one character per byte, as `GitRunRequest.raw` already requires.
- A host `createPtyGitRunner(port)` adapts it to git-ops' `GitRunner` for `context: "pty"`. It refuses any other context and any request whose `argv[0]` is not the host's one absolute `gitPath`. That runner is `ptyRunner` of `createGitPort`; with it, `commit-tree` and `push` run in the pty process, where they were designed to.
- At most 8 execs are outstanding; every one settles within its timeout (same bug class as review 2 N4).

### 4.2 Hook runs reuse `spawn`

A hook runs as an ordinary `spawn` with a `runId` of the form `hook-<commit attempt id>`, `argv = [<absolute hook path>, ...hook args]`, `cwd` = the scratch checkout, the PTY-5 environment plus the hook variables of §5.3, and the terminal granted (`grant`) to the workspace's terminal so the user sees the output. The daemon waits for the `exit` reply under a timeout and a cancel signal; on either it sends `kill SIGKILL` and refuses `hook_timeout` or `E_CANCELLED`. After the exit it asks `groupAlive()`: a hook that leaves a process behind refuses the commit (`hook_failed`), because a survivor could still write the scratch tree or the git directory.

No new family is needed for the visible part. The Agent-view row for the commit shows "running pre-commit" from the run status the host already emits as an event; the terminal itself is the user's.

## 5. The commit sequence with hooks

All of it under the existing mutex and lock. Steps 1 to 4 and 11 to 14 are today's `check()` and `runBound`. New steps are marked.

1. Request validation, journal branch, reviewed-tree lookup, `prepare` (staging the reviewed tree), `handoff`. Unchanged.
2. CLI-run refusal, then drift re-take (`git_drift` on unacknowledged change). Unchanged.
3. **(new)** If `runHooks` is false: record `off` for both hooks, skip to step 11.
4. **(new)** Resolve the hooks directory in the pty context: `git rev-parse --git-path hooks` (honours `core.hooksPath`; relative results are made absolute against the work tree). For each of `pre-commit` and `commit-msg`: `absent` when no regular file exists, otherwise the candidate path. The path is compared with the GIT-SNAP-1 set (`hooks/` of the common dir, or the in-worktree `core.hooksPath` target). A hook path outside both is refused `hook_path_unseen`: only hooks the user could have reviewed may run. A non-executable file counts as `absent` (git's own rule, `hint:` is not printed).
5. **(new)** Scratch directory: a new empty directory under the host's scratch root (`<data root>/hook-scratch/<attempt id>`, created by the pty process with mode 0700, the daemon never writes into it), removed on every exit path, and swept at startup.
6. **(new)** Materialise the reviewed tree there, never the user's worktree or index: `GIT_INDEX_FILE=<scratch>.idx git read-tree <reviewedTreeHash>`, then `git checkout-index -a --prefix=<scratch>/`, with filters off (§9 D3). The tree id is the one the review recorded, not "whatever is staged".
7. **(new)** `pre-commit`: `GIT_DIR=<the workspace git dir>`, `GIT_WORK_TREE=<scratch>`, `GIT_INDEX_FILE=<scratch>.idx`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` as the identity check established, `cwd=<scratch>`, no arguments. This is what git itself does for `git commit`, so `git diff --cached` inside the hook sees the reviewed tree against HEAD.
8. **(new)** `commit-msg`: the message (the normalised text git-ops already computes) is written by the pty process to `<scratch>.msg`; the hook gets that path as its only argument and the same variables. Its exit status and the file are read back.
9. **(new)** Compare, in the daemon from `exec` results:
   - the temporary index's `write-tree` still equals `reviewedTreeHash`, and a SECOND index built with `git add -A` over the scratch tree (honouring the tree's own ignore rules) also writes `reviewedTreeHash`; any difference is `hook_modified_files` (a formatter that rewrote or `git add`ed a file, or created a new one);
   - the message file is byte-identical to what was written, else `hook_changed_message`;
   - the hook exited 0, else `hook_failed` (the exit code is carried as an integer, never any output).
10. **(new)** Remove the scratch directory and indexes. Re-take GIT-SNAP-1 (H-3), then run `assertReviewFresh` again. Either failing refuses the commit as it does today (`git_drift`, `stale`).
11. `commit-tree` with the original message, in the pty context (existing).
12. Verify the object (one parent, the reviewed tree), re-check HEAD, branch and operation state (existing).
13. Compare-and-swap `update-ref` (existing).
14. Reply `{ commit, tree, hooks }` and write the audit event with the same `hooks` facts (§6).

`post-commit`, `reference-transaction`, `prepare-commit-msg`, `pre-merge-commit` and every other hook are not run in 1a (decided 2026-11-04).

### 5.3 Hook environment

PTY-5 environment (deny-list applied, `GIT_ASKPASS` and `GIT_EDITOR` dropped), `GIT_TERMINAL_PROMPT=0`, plus exactly: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` as git sets them for a commit, and `AXIS_HOOK=1` so a hook can tell. Nothing derived from the request: the paths are the host's, the identity is what git reported.

### 5.4 Why the message is refused instead of adopted

The decision of 2026-11-04 says a rewritten message is shown before it is committed. Showing it needs a second round trip (an approval or a second request) that `axis.git/1` does not have, and committing text nobody saw is the failure the decision wanted to avoid. Slice default (§9 D2): refuse with `hook_changed_message`. The rewrite flow is a later protocol addition, not a gap in safety.

## 6. Reporting and audit (contract additions)

All additive inside `axis.git/1` (ADR 0003 D2, no version bump).

- `gitCommitResponseSchema` gains `hooks: { preCommit: HookState, commitMsg: HookState }` with `HookState = "ran" | "absent" | "off"`. It is required in the reply the new handler produces and optional in the schema, so an older host's reply still validates.
- `GIT_COMMIT_REFUSALS` gains, closed and reasons only (no text, no output): `E_CONFLICT`: `hook_failed`, `hook_modified_files`, `hook_changed_message`, `hook_timeout`, `hook_path_unseen`; `E_UNAVAILABLE`: `hooks_unavailable` (runHooks on and the pty process or its runner is not there). The protocol-copies test compares both directions with the source, so a new git-ops reason must be added on both sides in one commit.
- The `git.commit` audit event adds the same two states plus, for a refused hook, the hook name and the exit code. Never output, never a path, never the message. The audit allow-list test (`host-audit-allowlist.test.ts`) pins the new fields.
- Push: `pushPlan` and the `push` reply gain `hooks: { prePush: HookState }`. `pre-push` already runs inside `git push` in the pty context; what is missing is the report, and a `--no-verify`/hooks-off record when `runHooks` is false. Push keeps its explicit refspec and its own scan; a `pre-push` that exits non-zero is `hook_failed` after the challenge was spent, which the client must show as "the push was blocked by your pre-push hook".

## 7. GIT-ENV-1: the planted hook, per path

| Path | Hook behaviour | Test |
|---|---|---|
| `worktrees.create`, `status`, `remove`, restore, snapshot, diff | no hook runs, with a control that plain git runs it | exists (worktrees); add one at the host level in S3 |
| Axis commit, `runHooks` off | no hook runs, reply says `off` | S3 |
| Axis commit, `runHooks` on, planted `pre-commit` | runs in the pty process (the test runner records the context and the cwd) and never in the daemon; reply says `ran` | S3 |
| Axis commit, hook planted AFTER the drift baseline | refused `git_drift`, hook not run | S3 |
| Axis commit, hook swapped between the re-take and the run (the ROADMAP line 49 race) | the second re-take refuses; the CLI-run refusal and the lock bound the window | S3 |
| Axis commit, pty runner absent | refused `hooks_unavailable`, branch unchanged, index restored | S3 |

## 8. Slices and tests (each must fail on mutation)

This is more than one slice. The pieces below can be reviewed and merged one at a time, in this order.

- **S1: `exec` in `@axis/pty-process`** (protocol, service, client port, `createPtyGitRunner`). Tests: bounds and schema; deny-list refusal; timeout kills the group; output cap sets `truncated`; capacity; a data channel cannot send `exec`; channel close settles outstanding execs. Mutations: drop the env re-check, the timeout, the cap, the context check.
- **S2: git-ops hook step** (`hooks.ts`, called from `executeCommit` between the identity check and `commit-tree`; steps 3 to 10). Runs against an injected `HookExecutor` so git-ops stays free of process code. Tests with a real repository and the node runner standing in for the pty runner: a modifying hook, an `add`ing hook, a message-rewriting hook, a failing hook, a hook that edits `hooks/`, a hook that times out, `absent`, `off`. Mutations: skip the second index, skip the post-hook drift re-take, run on the real worktree, treat a missing executor as `off`.
- **S3: host wiring and contract** (`bindings/git.ts` supplies the executor over the pty runner and the spawn path; protocol additions; handler passes `hooks` through; audit fields; slice step 5 updated from "hook does NOT run" to the §7 table). Tests: the planted-hook table above; the allow-list; protocol-copies.
- **S4: push report** (`hooks.prePush`, hooks-off record). Small, after S3.
- **S5: UI** (the terminal and Agent-view row). Belongs to the shell track, not the daemon.

Each slice must also show: scratch removed on every exit path including a throw and an abort; no listener, timer or child left; no hook output in any error string (a test that makes the hook print a marker and greps every error, log line and audit event); the gate green on a machine with no particular git version (tests use the repository's own git and skip with a reason when a capability is missing).

## 9. Decisions (conservative defaults, recorded for the master)

- **D1. Commit with `runHooks` on and no pty runner is refused** (`hooks_unavailable`), not committed hook-less. Needed for H-5. Consequence: until S1 and S3 merge, a real host cannot commit with the default setting. The headless slice keeps its fake runner and the interim assertion, labelled as such.
- **D2. A message-rewriting `commit-msg` hook refuses** (§5.4) instead of committing the rewritten text. Stricter than the 2026-11-04 text; the flow that shows the message is deferred.
- **D3. Filters are off when materialising the scratch tree** (`filter.*` cannot run during `checkout-index`), so a hook sees the stored bytes, not smudged ones. A repository that needs smudge for its hooks to pass gets `hook_failed` and a clear reason. Running filters is a separate decision because a filter driver is user code that would run while materialising, outside the hook the user expects.
- **D4. Hook timeout 300 seconds** (a setting at user scope later), because the project mutex is held throughout. Other git operations of that project wait; user cancel kills the group.
- **D5. RR-29** stays: hooks in the pty process see the user's credential environment. The 1b vault decision (ROADMAP line 80) must say whether hooks may ever see vault-backed credentials; the answer assumed here is no.
- **D6. Hooks outside the GIT-SNAP-1 set are refused** (`hook_path_unseen`), e.g. a `core.hooksPath` pointing at a directory outside the worktree and the common dir, which the user never reviewed.

## 10. Why this ticket stops at the design

The work spans `@axis/pty-process` (a new control message), `@axis/git-ops` (the commit sequence), the daemon-host binding, handler and audit allow-list, and `@axis/protocol` (reply and refusal sets). It touches the commit trust boundary (the reviewed-tree binding, the drift gate, the audit event) and adds a process-launching message to the pty process. That needs independent security review per slice and a decision on D1 to D3 before code, so no code is written under this ticket yet.
