# The pty process's exec on Windows (ticket PV-X1w)

- **Status:** design, revision 1. Nothing is built. Follows PV-X1a (`docs/design/pty-exec-node.md`), whose exec function throws `unsupported_platform` on `win32` before anything starts.
- **Scope:** a kill that ends the whole process tree of one exec run on Windows, so `createNodeExec` can run git (and `gh`, PV-D2) there. The same primitive is what Windows CLI terminals lack (`pty-process.md` decision 1: ConPTY through node-pty gives no job object). Terminals are discussed in §6 and are not in this ticket.
- **Evidence key:** **[doc]** is from the Win32 or Node/libuv documentation and has not been run here; **[U]** must be verified on Windows before the slice that depends on it is built. No claim here was run on Windows: this host is Linux, and CI has no Windows job (`ci.yml` runs Ubuntu and macOS; `code-oss-build.yml` is Linux only).

## 1. What POSIX gives that Windows does not

On POSIX the exec child leads its own process group, and `kill(-pgid, SIGKILL)` ends every member. `exec-node.ts` relies on three properties:

1. **The whole tree:** every descendant is in the group unless it leaves on purpose (`setsid`, the accepted same-user residual).
2. **No escape window:** the child is in the group from its first instruction (the group is set between fork and exec).
3. **A hard kill:** SIGKILL cannot be caught.

Windows has no process groups in this sense. A console process group (`CREATE_NEW_PROCESS_GROUP`) only routes Ctrl+Break and is not a kill target. The Windows object with properties 1 to 3 is the **job object**:

- `TerminateJobObject` ends every process in the job, hard **[doc]**.
- A process created by a process in a job is in that job, unless the job allows breakaway (`JOB_OBJECT_LIMIT_BREAKAWAY_OK` together with `CREATE_BREAKAWAY_FROM_JOB`, or `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`) **[doc]**. A job without those limits has no breakaway, so even a deliberate escape like `setsid` is impossible. That is stronger than POSIX.
- Jobs nest (Windows 8 and later), so a run's job can sit inside the job Electron or libuv already put the pty process in **[doc]**.
- Signalling is by **handle**, not by id: `TerminateJobObject` on Axis's own handle can never hit another process, so the pgid-reuse problem of review 1 SF-2 does not exist on Windows.
- `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ends the job when its last handle closes, so a crash of the pty process ends every run (it closes the PV-X1a residual N-8 on Windows) **[doc]**.
- A completion port associated with the job reports `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` when the last process exits. That is the "group empty" event `ChildGroup { kind: "job" }` and `onGroupEmpty` already expect (`ports.ts`) **[doc]**.

**Escape window.** A process is in the job only once it is assigned. Two ways close the window:
- create the process suspended (`CREATE_SUSPENDED`), then `AssignProcessToJobObject`, then `ResumeThread`;
- or pass the job in `PROC_THREAD_ATTRIBUTE_JOB_LIST` (Windows 10 and Server 2016 or later), so the process starts in the job **[doc]**.

Either needs the code that calls `CreateProcessW`. Node's `child_process.spawn` does not expose either.

## 2. Options

| | Option | Whole tree (1) | No window (2) | Hard (3) | Verdict |
|---|---|---|---|---|---|
| A | **`taskkill /T /F`** | by parent pid, at kill time: a reparented or detached descendant is missed, and a reused pid is hit | n/a | yes | **Refused.** A second program given by value, which breaks the exact `argv[0]` allow-list of `exec-node.ts`. It also walks a pid tree, which has the pid-reuse problem the job handle avoids. |
| B | **ConPTY for exec, kill by closing the pseudoconsole** | only console-attached processes; a `DETACHED_PROCESS` or GUI child escapes | yes | no: `CTRL_CLOSE_EVENT` can be handled, and the system kills a handler only after a timeout **[doc]** | **Refused.** Not a hard kill. It also merges stdout and stderr, which loses the separate stream caps (PV-X1a §2). |
| C | **A helper process per run** (`node.exe` with a fixed script that spawns git), killed with `TerminateProcess` so its libuv job ends the tree | only if libuv's job lacks silent breakaway. libuv's Windows process code sets breakaway limits on its global job **[U: read `src/win/process.c` at the pinned Node]**; if they include `SILENT_BREAKAWAY_OK`, git's own children are not in it | yes (libuv assigns suspended **[U]**) | yes | **Rejected unless [U] shows no silent breakaway.** It adds a second program (`node.exe -e`), which is broad, and depends on a libuv detail Axis does not control. |
| D | **Adopt after spawn:** Node spawns as today, then a small native call puts the new pid in a fresh job | yes, after the adoption | **no:** between libuv's resume and the adoption the child can start processes outside the job. The window is short (the adoption runs in the same tick, before git has loaded), but it is not closed | yes | **Fallback only.** Acceptable for terminals if §6 chooses it, with the window documented as a residual. |
| E | **A small native addon that spawns in a job:** `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_JOB_LIST` (or suspended, assign, resume) and the three pipes, behind the same `ExecFn` contract | yes | yes | yes | **Recommended** (§3). |
| F | **Patch node-pty** (the native pty binding Code OSS ships) to create each spawn in a job and expose terminate and empty | yes | yes | yes | **Terminals only** (§6): exec uses pipes, not a pseudoconsole. It is a Code OSS patch on a native module and drifts with upstream. |

## 3. Recommendation: option E

**Where it lives.** ADR 0005 keeps native modules out of `packages/*`: they are reached only from overlay entries through injected functions (`pty-process.md` decision 1, how node-pty is used). So:
- the addon is built in the overlay's native-module pipeline, as Code OSS builds node-pty;
- `axisPtyMain.ts` loads it on `win32` only and passes a `WinJobSpawn` function into `runPtyEntry`;
- `createNodeExec` keeps its POSIX path unchanged. On `win32` it calls the injected function instead of throwing `unsupported_platform`, and throws `unsupported_platform` only when none was injected.

**The addon's surface, closed and small:**
```ts
type WinJobSpawn = (req: {
  program: string;                 // already checked by exec-node.ts against the exact allow-list
  args: readonly string[];         // quoted by the addon with the CommandLineToArgvW rules; no shell, no cmd.exe
  cwd: string;
  env: Readonly<Record<string, string>>;  // the null-prototype copy of PV-X1a; the block is built from it only
}) => {
  stdin: number; stdout: number; stderr: number;   // CRT fds over anonymous pipe handles (see [U] below)
  terminate(): void;                                // TerminateJobObject on this run's job handle; idempotent
  onExit(listener: (code: number) => void): void;   // the leader's exit code
  onEmpty(listener: () => void): void;              // ACTIVE_PROCESS_ZERO from the job's completion port
  close(): void;                                    // closes the job handle (KILL_ON_JOB_CLOSE ends anything left)
};
```
- **Job limits:** `KILL_ON_JOB_CLOSE`, and no `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`; one job per run, never reused. `UI_LIMITS` are not needed.
- **Mapping to the PV-X1a contract:**
  - `done` settles after the leader exited, both pipes closed, and the job was terminated (the same order as POSIX §3);
  - `kill()` maps to `terminate()`;
  - there is no latch: the handle cannot be reused, so nothing is ever signalled by id;
  - start failures map to the same closed codes (`ERROR_FILE_NOT_FOUND` and `ERROR_PATH_NOT_FOUND` to `not_found`, `ERROR_ACCESS_DENIED` to `not_permitted`, the rest to `start_failed`).
- **Program check stays in `exec-node.ts`:** the exact `argv[0]` comparison runs before the injected function is called. The addon checks nothing itself and is never exported to anything but the pty entry. The lint (`SPAWN_FILES`) sees `node:child_process` only, so a native spawn is outside its reach. The ADR amendment names the addon as the one other spawn site, enforced by review and by the overlay import rule that only `axisPtyMain.ts` loads it.
- **Pipes [U]:** handing anonymous pipe handles back to Node as stream-capable fds (`_open_osfhandle`, then `net.Socket({ fd })` or `fs.createReadStream(null, { fd })`) must be proven on the pinned Electron's Node. If it fails, the addon reads the pipes itself on a thread and delivers chunks with the per-stream caps applied in C++. That is larger, so the spike decides between the two.
- **Command line [U]:** Windows passes one string, and each program parses it. Git for Windows uses the MSVCRT and `CommandLineToArgvW` rules; the addon quotes with those rules and the tests round-trip hostile arguments (quotes, backslashes before quotes, `%`, `^`, a trailing backslash). No `cmd.exe` is ever in the path, so `%` and `^` are literal. A `.cmd` or `.bat` `gitPath` is refused at the entry check, because it would run under `cmd.exe`.

**Cost and governance.**
- **New native code:** an ADR 0005 amendment (D4 runtime dependencies: an Axis-owned native addon, built from source in the overlay pipeline, no third-party code) and a security review.
- **Build:** a Windows build of Code OSS does not exist yet (only Linux). The addon's build lands with the first Windows build ticket, not before it.

## 4. Until then: what `unsupported_platform` means for a user

There is no Windows build to ship today, so this is the stated behaviour for the first one, if it comes before PV-X1w:
- **Works:** everything that runs in the daemon's own git context: status, diff, review, the journal and worktrees.
- **Unavailable, refused before anything starts:**
  - every pty-process git step: **commit** (`commit-tree` and the commit-signing read run in the `pty` context whatever `axis.git.runHooks` says, git-ops `commit.ts`), the hook scratch steps, **push** (H-7 keeps push out of the daemon, so there is no fallback);
  - the PR list (`forge-list`);
  - CLI terminals (the node-pty spawn already refuses `win32`).
- **What the UI shows:** a closed state, "Not available on Windows yet", with no retry and no partial run. The daemon answers `E_UNAVAILABLE` with reason `unsupported_platform`, and nothing is spawned. The user can still commit and push from their own terminal outside Axis. Without commit, the review flow ends at an approved diff on Windows; that is the largest user-visible gap and the reason PV-X1w should land before a Windows release.
- **No silent fallback:** Axis never runs git or `gh` on Windows through a path without a tree kill (options A to D), even if asked to.

## 5. Test plan

**Runner.** Add a `windows-2025` GitHub-hosted job to `ci.yml` for the pty-process package and the addon. Hosted Windows minutes are billed at a higher rate for private repositories; run it on pull requests that touch `pty-process` or the addon. Until that job exists, every Windows claim stays **[U]** and the Windows path stays `unsupported_platform`.

**Spike first (one day, before the slice).** Settle the three [U] items on the runner:
1. Do libuv's global job limits include silent breakaway (option C)?
2. Can pipe handles be handed back to Node as fds (§3)?
3. Does an exec in a nested job work when the pty process itself is in Electron's or libuv's job?

**Acceptance tests (on Windows, against the real addon):**
- **Tree kill:**
  - a leader starts a child that starts a grandchild, each ignoring Ctrl+C and Ctrl+Break;
  - `kill()` ends all three, which the job's process list confirms empty and `OpenProcess` on each pid confirms.
- **No escape:**
  - a child started with `CREATE_BREAKAWAY_FROM_JOB` fails to start, or stays in the job;
  - a `DETACHED_PROCESS` child and a `CREATE_NEW_PROCESS_GROUP` child are both ended by `kill()`.
- **Crash:** the pty process is killed with `TerminateProcess`; every run's processes end (`KILL_ON_JOB_CLOSE`).
- **Settle order:** `done` settles only after `ACTIVE_PROCESS_ZERO` and both pipes closed. A late writer outside the leader but inside the job is read to the end, then killed.
- **Same assertions as POSIX:**
  - the PV-X1a `exec-node.test.ts` cases (exact program, env exactly as given with a prototype canary, caps per stream, start-failure codes, stdin ended);
  - plus hostile command-line arguments round-tripped through a real `git.exe` (`git rev-parse --sq-quote`).
- **Refusals:** a `.cmd` or `.bat` program, a relative program, and an unsupported Windows version (no `JOB_LIST` attribute and no suspended path) all answer before anything starts.
- **End to end:** the PV-X1a child-process push test on Windows, with git through the addon.

**Mutants:** breakaway allowed; no `KILL_ON_JOB_CLOSE`; assign after resume (option D); settle on the leader's exit; `terminate` of the leader only; `cmd.exe` quoting.

## 6. Terminals (not in this ticket)

CLI terminals on Windows need the same property for the node-pty spawn (`ChildGroup { kind: "job" }` already exists for it). Two ways:
- **F**, patch node-pty to pass `PROC_THREAD_ATTRIBUTE_JOB_LIST` (no window, but a Code OSS native patch);
- **D**, adopt after spawn with this addon's job primitive (no patch, but a documented escape window).

That choice belongs to the ticket that brings Windows terminals, and the owner decides it. It should reuse this addon's job code either way.

## 7. Open questions

1. The three [U] items of the spike (§5).
2. Whether the first Windows build ships before PV-X1w. If it does, §4 is the user-facing behaviour, and the release notes say so.
3. The minimum Windows version. `PROC_THREAD_ATTRIBUTE_JOB_LIST` needs Windows 10 or Server 2016. The suspended, assign, resume path covers older versions at the cost of one more failure mode. Recommendation: Windows 10 and later only.
