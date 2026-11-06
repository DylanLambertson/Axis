# H9-hooks slice S1, part 1: the pty-process side (implementation notes)

Status: BUILT in `@axis/pty-process`; nothing is wired into the daemon yet. Design: `docs/design/daemon-host-hooks.md` (§4, §5 steps 4, 5 and 8, §8 gate lines PTY-EXEC-1, PTY-5-HOOK and HOOK-REPLACE-1). This note records what part 1 builds, where it departs from the design text and why, and what slice S1 still owes.

## What is built

| Design item | Where | Test |
|---|---|---|
| `exec` message, `exec-result` / `exec-failed` replies (separate `execReply` union, so the spawn client is unchanged) | `src/messages.ts`, `src/git-exec.ts` | `exec-argv.test.ts` |
| `argv[0]` is the startup git path; closed subcommand list; exact-token option rule per subcommand (an abbreviation or a glued value is refused); no global option or alias after git | `src/exec-argv.ts` `checkExecArgv` | `exec-argv.test.ts` (PTY-EXEC-1 argv cases) |
| Fixed pin prefix on every exec, plain or bound; the one pinless read (`config --show-scope --get-all core.hooksPath`, or the scope-less form before git 2.26) drops only the hooks pin; `i18n.commitEncoding=utf-8` on `commit-tree` | `plainPrefix`, `boundPrefix` | `exec-argv.test.ts`, `exec-markers.test.ts` |
| Exec environment built from the startup environment plus an allow-list from the message (`env_denied` otherwise); `GIT_NO_LAZY_FETCH=1`; startup names that undo a pin (`GIT_ALLOW_PROTOCOL`, ...) dropped | `src/exec-env.ts` `buildExecEnv` | `exec-argv.test.ts` |
| Bound calls: redirectors derived from the service's scratch root and the attempt id, `--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`, user-level config isolated (`GIT_CONFIG_GLOBAL`/`SYSTEM` at an empty file from git 2.32; `GIT_CONFIG_NOSYSTEM` plus empty `HOME` and `XDG_CONFIG_HOME` on 2.24 to 2.31; refused below) | `buildExecEnv`, `git-exec.ts` | `hook-env.test.ts`, `scratch.test.ts`, `scratch-replace.test.ts` |
| `scratch-begin` raw fill: `ls-tree -r -z`, `cat-file --batch`, every component checked (`.git` in any case, NTFS trailing dots and spaces, `name:stream`, 8.3 `git~N`, HFS ignorable code points, `.`, `..`, separators), case-fold and NFC collisions refuse the whole tree, `O_CREAT|O_EXCL|O_NOFOLLOW` creates with each parent `lstat`ed, symlinks LAST, gitlinks as empty directories, `read-tree` into both scratch indexes | `src/scratch-tree.ts`, `git-exec.ts` | `scratch.test.ts`, `scratch-tree.test.ts` |
| `scratch-verify`: `write-tree` of both indexes, a walk from the root with `lstat` on every entry, regular files opened `O_NOFOLLOW|O_NONBLOCK` and re-checked with `fstat`, symlinks compared by `readlink` text, any unlisted entry is a change; message read back without following links | `verifyScratchTree`, `git-exec.ts` | `scratch.test.ts`, `hook-env.test.ts` |
| `scratch-end`; at most 2 attempts; root swept at start; every attempt removed when the control channel closes or the service is disposed; 0700 throughout | `git-exec.ts` | `scratch.test.ts` |
| `hook` message: attempt and `bind.gitDir` must match the registration, PTY-5 re-check of the message env, realpath under `<common dir>/hooks/` or the registered worktree, regular and executable, SHA-256 equal to `expectSha256` (else `hook_changed`), the realpath is what runs, cwd the scratch tree, `GIT_NO_REPLACE_OBJECTS=1` | `git-exec.ts` `prepareHook`, `service.ts` | `hook-env.test.ts` (PTY-5-HOOK, S-1, planted hooks) |
| Step 4's judgement of the pinless read against the snapshot's raw repository-level value (refuses `global`, `system`, `command`, a differing value and an empty raw value) | `src/hooks-scope.ts` `judgeHooksPathRead` | `hooks-scope.test.ts` (includes the `includeIf hasconfig` case) |

The package still imports no `node:child_process`: the exec function is injected (`ExecFn`), like the spawn function. `testing/exec.ts` is the POSIX reference used by the tests.

## Departures from the design text

1. **Filter drivers are pinned off on every exec (finding).** §4.1 says no allowed form can start a filter, but git compares a racily clean index entry with the work tree through the clean or process filter when it writes the index, and `write-tree` does that. With `filter.<name>.process` set and a matching attribute, a pinned `write-tree` started the driver (git 2.53). The service now reads the configured driver names (`config --null --name-only --get-regexp ^filter\.`, which starts nothing) with the same prefix and environment just before each non-`config` call and adds `-c filter.<name>.{clean,smudge,process}=` and `filter.<name>.required=false`, as git-ops already does daemon-side. A driver name a `-c` pair cannot carry exactly (`=`, newline) refuses the call. The design's mechanism is strengthened, not changed; the design doc should say so in S3.
2. **Verification hashes in-process.** §5 step 8 says `hash-object --no-filters --stdin` over bytes the service read. The service computes git's blob id itself (`blob <size>\0` plus the bytes, SHA-1 or SHA-256 by the id length): the same value, no process, no `--stdin-paths` possible.
3. **`bind` carries the attempt id** (`{ attempt, gitDir, index }`); the design's `{ gitDir, index }` cannot name the registration it must equal.
4. **Both scratch indexes are filled and checked.** `staged` reports whichever differs from the reviewed tree, so a hook bound to `index2` cannot stage unseen.
5. **Hook refusals use `spawn-failed`** with the new codes `hook_changed` and `bad_bind` (a realpath outside both roots is `bad_bind`). Scratch replies are `scratch-ready`, `scratch-verified`, `scratch-ended` and `scratch-failed` (`bad_bind`, `bad_tree`, `capacity`, `timeout`, `spawn_failed`); the design names none.
6. **A path that is not UTF-8 refuses the fill** (`bad_tree`): fail closed rather than write byte names.
7. **Stricter than listed:** `var` takes only `GIT_AUTHOR_IDENT` or `GIT_COMMITTER_IDENT`; `read-tree` takes exactly one object id; `rev-parse --git-path` only `hooks/<name>`; `rev-list` also allows `--objects` (the design's own marker case uses it).

## Left for the rest of S1 and later slices

- `createPtyGitRunner` (the strict adapter from git-ops' prefixed argv to `exec` with `repo`) and its S1 tests (GIT-4 mapping, encoding pin), and the host port methods for `exec`, `hook` and `scratch-*`.
- Host-side hook orchestration (§4.2: grant and attach before the spawn, timeout and cancel, `groupAlive` after exit) and the daemon's use of `judgeHooksPathRead` (S2), with `Snapshot` v3 storing the raw value (git-snapshot).
- The shipped entry must supply the `ExecFn` (a process-group launcher), the startup git path, git-ops' `hooksOffPath()` and the scratch parent. Windows is unverified (the hooks-off directory and modes).
- Open decisions D1 to D3 are unchanged; part 1 implements the D3 default (raw tree, any new file refuses).
