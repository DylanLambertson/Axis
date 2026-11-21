# Exec on Windows with a tree kill (ticket PV-X1w)

- **Status:** design, revision 2 (after design review 1: SF-1 to SF-7, N-1 to N-4). Nothing is built. **Lands after PV-X1a**: `exec-node.ts`, `docs/design/pty-exec-node.md` and the exec contract it extends are on `feat/pv-x1a` until that merges.
- **Scope:** a kill that ends the whole process tree of one git (or `gh`) run on Windows, for the pty process's exec function and, as a second slice, the daemon's own git runner (§4). Windows CLI terminals need the same property and are not in this ticket (§7).
- **Evidence key:** **[doc]** is from the Win32 or Node/libuv documentation and was not run here; **[U]** must be verified on Windows before the slice that depends on it. Nothing in this note was run on Windows: this host is Linux, and CI has no Windows job (`ci.yml` runs Ubuntu and macOS; `code-oss-build.yml` is Linux only).

## 1. What POSIX gives and Windows lacks

PV-X1a (`pty-exec-node.md` §3) relies on a process group:

1. **the whole tree** is in it, unless a process leaves on purpose (`setsid`, an accepted same-user residual);
2. there is **no escape window** (the group is set between fork and exec);
3. the kill is **hard** (SIGKILL);
4. the **order:** the group is killed at the leader's exit, then `done` waits for both pipes to close.

Windows has no process group in that sense: a console process group only routes Ctrl+Break. The object with properties 1 to 3 is the **job object** [doc]:
- `TerminateJobObject` ends every process in the job, hard;
- a child of a process in the job is in the job, unless the job allows breakaway (`BREAKAWAY_OK` with `CREATE_BREAKAWAY_FROM_JOB`, or `SILENT_BREAKAWAY_OK`);
- jobs nest (Windows 8 and later);
- `KILL_ON_JOB_CLOSE` ends the job when its last handle closes;
- a completion port reports `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`.

The job is signalled by **handle**, never by id, so the pgid-reuse problem of PV-X1a review 1 SF-2 does not exist.

**No escape window:** the process must start inside the job, either through `PROC_THREAD_ATTRIBUTE_JOB_LIST` (Windows 10 and Server 2016 or later) or by creating it suspended, assigning it, then resuming. Both need the code that calls `CreateProcessW`; Node's `spawn` exposes neither.

**Residuals (review 1 N-1).** A job without breakaway keeps every descendant created the ordinary way. A process running as the user can still start one outside it through another creator: Task Scheduler, WMI `Win32_Process.Create`, a COM or service broker, or `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` naming a process outside the job [doc, U]. This is the Windows equivalent of the `setsid` residual: same-user, closed only by the Phase 3 sandbox. It is not "impossible".

## 2. Options

| | Option | Tree (1) | Window (2) | Hard (3) | Verdict |
|---|---|---|---|---|---|
| A | `taskkill /T /F` | walks parent pids at kill time: a reparented or detached descendant is missed, a reused pid is hit | n/a | yes | **Refused.** A second program given by value, and a pid walk. |
| B | ConPTY for exec, kill by closing the pseudoconsole | console-attached processes only | yes | no: `CTRL_CLOSE_EVENT` can be handled [doc] | **Refused.** Not hard, and stdout and stderr merge. |
| C | `node.exe -e <script>` as a per-run helper, relying on libuv's global job | only if libuv's job has no silent breakaway [U] | yes [U] | yes | **Refused.** A general-purpose interpreter as an allowed program, and a dependency on a libuv detail. |
| D | Node spawns git as today, then native code adopts the pid into a fresh job | yes, after the adoption | **no:** a short window between libuv's resume and the adoption | yes | **Refused for exec.** Weighed against E and F (N-4): it keeps native code in the process and still leaves a window, so it has the cost of E or F without the guarantee. Kept as a possible answer for terminals (§7). |
| E | An **in-process N-API addon** that calls `CreateProcessW` in a job and hands the pipes back to Node | yes | yes | yes | **Not chosen.** C++ inside the credentialed pty process, where a memory-safety bug reaches the push approval. Electron ABI and node-gyp coupling. Anonymous pipes are synchronous: as fds they block one libuv threadpool thread per stream, so the default pool of 4 starves with two concurrent runs (SF-6). Overlapped named pipes would fix that, at more native code. |
| F | An **out-of-process helper EXE**, `axis-exec.exe`. Node spawns it with ordinary pipes; it starts git in a fresh job with exactly those three handles and ends the job when git exits | yes | yes | yes (Node's `kill` is `TerminateProcess` on the helper, which closes the job's last handle) | **Recommended** (§3). |

**Why F over E (review 1 SF-2).**
- **Stdio stays libuv's.** libuv already creates the child's stdio as overlapped named pipes, so the helper inherits ordinary std handles and passes them on. There is no fd hand-back and no threadpool cost.
- **No native code in the pty process.** The helper is a separate process with a closed argv; a bug in it can corrupt only itself.
- **No Electron ABI coupling:** a plain Win32 console EXE.
- **Cost:** the spawned program is the helper, so `exec-node.ts` wraps the argv on Windows (§3). Plus a signed binary to build and ship (§5).

## 3. The helper `axis-exec.exe`

**How `exec-node.ts` uses it (Windows only):**
- **Check, then wrap.** The exact `argv[0]` check against the consumer's program set runs first, unchanged. Then the call becomes `spawn(helperPath, ["--", program, ...args], { windowsHide: true, shell: false, stdio: pipes, env, cwd })`.
- **`helperPath`** is fixed at construction. It comes from main's hand-over (`AXIS_PTY_EXEC_HELPER`) and is checked like `AXIS_PTY_GIT` (§3.2). It is never taken from a request.
- **`kill()`** is `cp.kill()`, which on Windows is `TerminateProcess(helper)`. That closes the job's only handle, so `KILL_ON_JOB_CLOSE` ends the tree.
- **The outcome mapping (SF-3):**
  - normally, `code` is git's exit code (the helper exits with it) and `signal` is `null`;
  - after `kill()`, `exec-node.ts` reports `code: null, signal: "SIGKILL"`, whatever exit code Windows gave the terminated helper, so callers see one shape on every platform;
  - a failure of the helper itself (bad argv, no job, the start failed) exits with a reserved code: `125` start failed, `126` not permitted, `127` not found. `exec-node.ts` maps those to `ExecStartError` (`start_failed`, `not_permitted`, `not_found`) only when the helper also wrote its one fixed marker line to stderr. Without the marker, the code is git's own.

**What the helper does, in order:**
1. **Parse its own command line** (`GetCommandLineW`, MSVCRT rules, N-3). It expects exactly `--`, then the program, then the arguments. Anything else is code 125 with no other effect.
2. **Check the program** (§3.2), positively.
3. **Create the job:** `CreateJobObjectW(NULL, NULL)`, non-inheritable, with `KILL_ON_JOB_CLOSE` and no `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`. Associate a completion port **before** any process exists.
4. **Start git:**
   - `CreateProcessW(lpApplicationName = program, lpCommandLine = quoted command line, bInheritHandles = TRUE, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, env = NULL (the helper's own environment, which is exec-node's copy), cwd = NULL (inherited))`;
   - with `STARTUPINFOEXW` carrying `PROC_THREAD_ATTRIBUTE_JOB_LIST` (the job) and **`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`** with exactly the three std handles (SF-4), so no other handle the helper holds can reach git, and no handle of a concurrent run can either (each run is its own helper);
   - on Windows older than 10, refuse (code 125) rather than fall back to suspend-and-assign (§8).
5. **Wait** on the completion port for git's process to exit.
6. **At git's exit:** `TerminateJobObject(job, 1)` ends what is left of the tree, the same moment POSIX kills the group (SF-3). Then close the handles and exit with git's code.

Node then sees the helper exit, and `done` settles when both pipes close. Every holder of the pipes was in the job and is gone, except a process that escaped through a §1 residual. Such a process keeps `done` pending until the service's timeout, as on POSIX.

**3.2 The program and the command line (SF-5)**
- **Positive check at the entry,** for `AXIS_PTY_GIT`, `AXIS_PTY_GH` and `AXIS_PTY_EXEC_HELPER` on Windows (and in the helper again, for its program):
  - a drive-letter absolute path (`X:\`);
  - no `\\?\` or `\\.\` prefix, no UNC (git-ops `gitPath.ts` already refuses UNC on Windows);
  - no `:` after the drive (alternate data streams);
  - no segment ending in a dot or a space;
  - no `~` in a segment (8.3 short names);
  - it ends in `.exe`, case-insensitively.

  This replaces a `.cmd`/`.bat` denylist, which Win32 name normalisation bypasses (`x.bat.`, `x.BAT`, short names).
- **"Exact string" on Windows:** the allow-list compares the raw configured string. `c:\git\git.exe` against `C:\Git\git.exe` is refused, which fails closed. Safety rests on the positive check above and on main passing one resolved string to both sides (`pty-exec-node.md` §6.2a), not on the comparison.
- **`lpApplicationName`** is always the checked program, so there is no PATH or extension search and no `C:\Program.exe` trap for an unquoted path with a space.
- **The command line** is built with the MSVCRT quoting rules (N-3):
  - the first token is the program, quoted;
  - an argument is quoted when it contains a space, a tab or a quote, or is empty;
  - backslashes before a quote are doubled.

  The helper rejects any argument holding a NUL, and a command line over 32,767 UTF-16 units (code 125). `exec-argv.ts` already limits the argument grammar the pty process emits, which narrows the quoting surface. A hop through an MSYS program (ssh, sh) parses again with MSYS rules; git builds those command lines itself, which is git's surface, not Axis's.
- **The environment** stays `exec-node.ts`'s null-prototype copy. On Windows, names that differ only in case (`Path` and `PATH`) are a `start_failed`, not a silent fold, because Windows keeps one of them unpredictably.

## 4. Today and before PV-X1w lands (SF-1, N-4)

**The daemon's own git runner already runs on Windows with no tree kill.**
- `git-ops/src/nodeRunner.ts` sets `detached` only off Windows. On Windows a timeout or `kill` ends `git.exe` alone; its children (filters, submodule diffs, `ssh`, credential helpers) survive.
- Only status, diff, review reads and the journal's git use it, with hooks off. They run under the daemon's time bounds, but nothing ends a child that outlives them.
- Revision 1 said Axis never runs git on Windows without a tree kill. That was false.

**Policy:** slice 2 of this ticket routes the daemon runner's Windows spawn through the same helper. `nodeRunner.ts` is a `SPAWN_FILES` entry with its own program by value, and it gains the same wrap. Until then the gap is a stated residual of any Windows build. The alternative is to refuse daemon-context git on Windows, which would leave nothing working; the owner decides between the two before a Windows release (§8).

**The floor if no Windows work ships.** If a Windows build comes before PV-X1w:
- **Works, with the kill gap above:** the daemon-context reads: status, diff, review, the journal and worktrees.
- **Refused before anything starts** (`E_UNAVAILABLE` with reason `unsupported_platform`):
  - every pty-process git step, which includes **commit**: `commit-tree` and the `commit.gpgsign` read run in the `pty` context whatever `axis.git.runHooks` says (git-ops `commit.ts`);
  - the hook scratch steps and **push** (H-7 keeps push out of the daemon);
  - the PR list (`forge-list`);
  - CLI terminals (the node-pty spawn refuses `win32`).
- **What the user sees:** a closed state, "Not available on Windows yet", with no retry. The review flow ends at an approved diff, and the user commits and pushes from their own terminal. That gap is the reason PV-X1w should land before a Windows release.

## 5. Supply chain and native-code controls (SF-7)

- **Source and build:**
  - Axis-owned C, about 300 lines, no third-party code, linking `kernel32` only;
  - built in CI with a pinned MSVC toolset and Windows SDK version (named in the build script), `/Brepro` for a deterministic PE, and the build inputs hashed into the release notes.
- **Signing:**
  - Authenticode-signed with the same key and process as the Windows app;
  - the key holder is the owner (an open question until a Windows release process exists);
  - main checks the signature subject before handing the path over [U: the API main uses].
- **Load path:**
  - main passes the absolute path inside the app's install directory, and the entry checks it (§3.2);
  - a per-user install directory is writable by the user, so a same-user swap of the binary is the accepted same-user residual, as with git itself;
  - a per-machine install removes it.
- **Binary check in CI** (instead of the egress lint, which sees only `node:child_process`):
  - the built PE's import table must be a subset of an allow-list (`CreateJobObjectW`, `SetInformationJobObject`, `CreateIoCompletionPort`, `GetQueuedCompletionStatus`, `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `DeleteProcThreadAttributeList`, `CreateProcessW`, `TerminateJobObject`, `GetExitCodeProcess`, `CloseHandle`, `GetCommandLineW`, `GetStdHandle`, `WriteFile`, `ExitProcess` and the CRT start-up);
  - it must import no `ws2_32`, `winhttp`, `wininet`, `shell32` or `advapi32`.
  - A failing check fails the build.
- **Memory safety:**
  - the command-line parser and quoter are one pure function pair, fuzzed in CI (round trip, against `CommandLineToArgvW` and a reference MSVCRT parser) under `/fsanitize=address`;
  - the release build keeps `/guard:cf`, `/DYNAMICBASE` and `/HIGHENTROPYVA`.

## 6. Test plan

**Runner.** A `windows-2025` GitHub-hosted job in `ci.yml` for the pty-process package and the helper, run on pull requests that touch either; hosted Windows minutes cost more for a private repository. Until it exists, every Windows claim stays [U] and the Windows path stays `unsupported_platform`.

**Spike first (one day):**
1. `JOB_LIST` when the helper itself is in libuv's or Electron's job (nesting).
2. libuv's stdio handles passed through `HANDLE_LIST`.
3. `TerminateProcess` of the helper ending a tree that ignores Ctrl+C and Ctrl+Break.
4. The completion-port message order (`EXIT_PROCESS` for git before `ACTIVE_PROCESS_ZERO`).

**Acceptance (on Windows, real helper, real `git.exe` where it matters):**
- **Tree kill:**
  - a leader, child and grandchild, each ignoring Ctrl+C and Ctrl+Break, are all gone after `kill()` (`OpenProcess` fails for each);
  - a `DETACHED_PROCESS` child and a `CREATE_NEW_PROCESS_GROUP` child are gone too;
  - a `CREATE_BREAKAWAY_FROM_JOB` child fails to start.
- **Order (SF-3):**
  - a member still writing when git exits is ended at that exit; the bytes it wrote before are read, and `done` settles after both pipes close;
  - the outcome is git's code with `signal: null`, and after `kill()` it is `code: null, signal: "SIGKILL"`.
- **Handles (SF-4):** two concurrent runs, the first ends while the second keeps running. The first `done` settles promptly (its EOF arrives) and the second is unaffected. Mutant: inherit all handles (the first hangs until its timeout).
- **Program and command line (SF-5):**
  - the positive check refuses `x.bat.`, `x.BAT`, an 8.3 name, `x.exe:s`, UNC, `\\?\` and a relative path;
  - hostile arguments round-trip through `git rev-parse --sq-quote` (quotes, backslashes before quotes, `%`, `^`, trailing backslash, empty);
  - a NUL and a 32,768-unit command line are refused;
  - `Path` with `PATH` is `start_failed`.
- **Crash:** `TerminateProcess` on the pty process ends every run's tree (each helper is in libuv's job with `KILL_ON_JOB_CLOSE`, and each git is in its helper's job) [U].
- **Reused PV-X1a cases:** exact program, environment exactly as given with a prototype canary, caps per stream, start-failure codes through the marker, stdin ended.
- **End to end:** the PV-X1a child-process push test on Windows.
- **Mutants:** breakaway allowed; no `KILL_ON_JOB_CLOSE`; terminate after the pipes instead of at git's exit; `lpApplicationName` NULL; the denylist instead of the positive check; no `HANDLE_LIST`; the marker not required for the reserved codes.

## 7. Terminals (not in this ticket)

CLI terminals on Windows need the same property for the node-pty spawn (`ChildGroup { kind: "job" }` exists for it). The options are:
- patch node-pty to pass `JOB_LIST`, a Code OSS native patch with no escape window;
- adopt after spawn (D), with a documented window;
- run the shell under this helper inside the pseudoconsole [U: ConPTY attaches the console through an attribute the helper would have to pass on].

The ticket that brings Windows terminals decides this, and should reuse the helper where it can.

## 8. Open questions

1. The four spike items (§6).
2. The daemon runner's Windows policy before slice 2: the stated kill gap, or refuse daemon-context git (§4). Owner's decision.
3. Who holds the Authenticode key, and how main verifies the signature (§5).
4. The minimum Windows version: Windows 10 or Server 2016 (`JOB_LIST`), recommended. Older versions are refused rather than given the suspend-and-assign path.
5. The exit-code and signal mapping (§3) is fixed here; confirm that callers never relied on a Windows-specific code.
