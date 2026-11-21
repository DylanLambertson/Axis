# Pull request list through the user's `gh` (ticket PV-D2)

- **Status:** design, revision 2 (after design review 1: SF-1 to SF-9, N1 to N8). Nothing is built. Phase 1c, dashboard item "Pull requests" (`product-vision-v2.md` §4 row 7, the data-source table, O-5).
- **Scope:** `axis.forge/1.pullRequests { projectId, trigger }` returns the open pull requests of this project's confirmed GitHub repository whose head is an `axis/*` branch of that same repository, opened by the user. For each row: number, title, branch, author, draft, checks state, review state. Read-only. The dashboard UI is PV-D1.
- **Constraints carried in:**
  - ADR 0004 decision 9 and D-9 stand: Axis stores, reads, logs and forwards **no forge credential**, and never writes the user's keyring.
  - `gh` runs under the user's own login.
  - Its output is untrusted: a pull request title is written by anyone who can open one.
- **Accepted decisions (review 1):**
  - the configuration directory is generated, fresh per call (§4);
  - GitHub Enterprise is out of v1. When added, it gets its own user-confirmed `forgeHosts` list, never the compare-URL `allowedHosts` (§3);
  - proxy and certificate variables are forwarded (§4);
  - no agent visibility in v1 (§5).
- **Probed facts (gh 2.46, review 1):**
  - with `--repo`, `gh pr list` makes no `git` call;
  - `GH_CONFIG_DIR` and `XDG_DATA_HOME` are honoured;
  - an extension at `<XDG_DATA_HOME>/gh/extensions/gh-pr/gh-pr` **does** take over `pr`; an alias does not;
  - missing auth with `GH_HOST` set exits **1** (`HTTP 401`), not 4;
  - a `config.yml` without `version` plus a `hosts.yml` host entry triggers the multi-account migration on every call.

## 1. Where `gh` runs: the pty process, through one allow-listed exec function

`gh` is a user binary, so it runs where user binaries run: in the pty process under the PTY-5 environment rules. The daemon never starts it.

**What exists.** The pty process has a bounded exec path, built for git (`packages/pty-process/src/git-exec.ts`, `docs/design/daemon-host-hooks.md` §4). It:
- runs the program set at start (`gitPath`), never one taken from a message;
- builds the environment itself;
- checks a closed argument list;
- caps output and time;
- runs each child in its own process group.

The process start goes through the injected `ExecFn`.

**The forge message.** A typed message `forge-list` `{ req, host, owner, repo }`. It carries **no argv, no env, no cwd and no flags.**
- `host` must equal `github.com` (§3).
- `owner` and `repo` are re-validated in the pty process by the same exported validator the daemon uses (`vetOwnerRepo`, see §2), which includes the `repo !== "." && repo !== ".."` rule.
- The pty process composes the whole command from a closed template:

  ```
  <ghPath> pr list --repo=github.com/<owner>/<repo> --state=open --author=@me --limit=50
           --json=number,title,headRefName,author,isDraft,isCrossRepository,headRepositoryOwner,reviewDecision,statusCheckRollup,updatedAt
  ```

  Each value is joined to its flag (`--repo=...`), so nothing can be read as a flag.
- **`--author=@me`** narrows the window on the server to the user's own pull requests. Axis opens its pull requests under the user's login, through the user's `gh` or the compare URL. So up to 50 fork or outside PRs cannot push the user's `axis/*` PRs out of the 50-row window (review SF-4b). It is a constant, so the template stays closed. If exactly 50 rows come back, the reply says `incomplete: true`.
  - **Gate check:** confirm `@me` resolution on the supported `gh` versions, and whether a fixed `--search` qualifier for the `axis/` prefix narrows further.

**Per-call directories (review SF-3, N4).** Before each call the pty process creates a **fresh** directory with a random name and mode 0700 under its private root. Three subdirectories, all fresh:
- `cwd/`, empty;
- `config/`, holding the generated files (§4);
- `data/`, empty, used as `XDG_DATA_HOME`.

The pty process checks `cwd/` and `data/` are empty immediately before the exec and removes the whole directory after the call. Nothing is reused between calls, so a planted extension (`data/gh/extensions/gh-pr/`), a file a misbehaving `gh` left behind, or a rewritten config cannot reach the next call. **Residual:** a process running as the user can race the window between creation and exec. That is the same same-user class as a planted binary on PATH, closed only by the Phase 3 sandbox (§8).

**The reply.** Either `forge-result { req, code, stdout, truncated }` or `forge-failed { req, code }`. The failure codes form a closed set: `spawn_failed`, `timeout`, `capacity`, `bad_request`, `no_control`, `unsupported_platform`. The pty process classifies stderr into one closed value (§7); the stderr text never leaves the pty process.

**Bounds (review SF-8, N1).**
- Timeout 20 s.
- stdout cap 4 MiB, stderr cap 64 KiB. These need a separate stderr cap in the exec contract: slice 1 adds `maxStderr` to `ExecRequest` (`ports.ts`), with the default equal to `maxOutput`, so the git exec path is unchanged. The exec function stops reading each stream at its own cap, so 4 MiB of hostile stderr is never held.
- Process-group kill on timeout and on control close.
- Concurrency is enforced at two points:
  - **The daemon** runs at most one `forge-list` per project (single flight).
  - **The pty process** runs at most 2 `forge-list` calls at once across all projects. That cap is separate from the git exec cap, and the third concurrent call gets `capacity`.

**The exec function and its allow-list (review SF-6).**
- Production has **no `ExecFn` today**. `axisPtyMain.ts` passes a terminal `spawn` only, `entry.ts` calls `createPtyService` without the `git` configuration, and the daemon entry passes no pty port. So the git `exec`, `scratch-*`, `hook` and the H9-hooks S4 push are all unreachable in production.
- This is a prerequisite of PV-D2 slice 2 and of production push, and it is its own ticket, **PV-X1** (§9).
- What PV-X1 must provide for this design:
  - **A new file `packages/pty-process/src/exec-node.ts`.** It is the only new `SPAWN_FILES` entry: `spawn`, program by value, held to #506's rules.
  - **One export,** `createNodeExec(programs: ReadonlySet<string>, platform)`. The `ExecFn` it returns **throws before `spawn`** unless `argv[0]` is exactly one of the absolute paths fixed at construction (`gitPath`, `ghPath`), compared as an exact string with no prefix and no case folding.
  - **Fixed spawn options:** always `shell: false`, `detached: true` on POSIX, `windowsHide: true`, three pipes, stdin ended after the optional input.
  - **Nothing else exposed:** no spawn function is exported and nothing in the module is injectable.
- **Tests:**
  - the real factory refuses another absolute path, a relative name, `gitPath` with a trailing space, and a different case; a sentinel program that would create a file is never started;
  - a unit test reads `egress-rules.mjs` and asserts the entry's `runs` text, `"git or gh: exactly the configured gitPath or ghPath, checked in this file before the call"`, so the documentation cannot drift.
- **Static versus runtime:** the lint can check the call shape but not a program given by value. The runtime check in the listed file, plus its tests, is the enforceable part.
- **ADR 0005 amendment.** `egress-rules.mjs` requires an amendment for a new file and a new program. PV-X1 makes it. Draft wording for ADR 0005 D3, the built-ins sentence:

  > `node:child_process` is also loaded by `pty-process/exec-node.ts` (`spawn`), the pty process's one exec function: its program is one of the absolute `gitPath` and `ghPath` fixed when the process starts, checked in that file before every call; no shell; the process group (POSIX) or job object (Windows) is killed on timeout and close.

  PV-X1 also adds the matching row to the `daemon-host.md` 2.1 spawn-file table and the PTY-2 boundary note.
- **Windows (review SF-7).** Windows has no process group, and `taskkill /T` would be a third program given by value, which the allow-list refuses. Until PV-X1 provides a job-object kill on Windows, through the native pty binding or a small addon, `forge-list` (and the git exec path) reply `unsupported_platform` on Windows. That gives the state `unsupported_platform` (§7).

**Egress lint (#499, #506).** With PV-X1 the forge path adds no spawn site: it reaches `gh` through `createNodeExec`, whose file is the one listed entry. Without PV-X1 nothing in production can start `gh`.

## 2. Which repository: derived by the daemon, confirmed by the user

The request names a `projectId` only. The repository never comes from request content.

1. **Read.** The daemon runs `git remote get-url origin` on the project's main checkout with its own pinned git (`daemonGitFor`, the H9 path `compareUrl` uses: no hooks, isolated config, `--` before the name). `get-url` applies `url.*.insteadOf`, so the list names the same repository pushes go to (review N3).
2. **Vet.** The URL is vetted by the H9 rules, through the exported `parseRemote` and `vetOwnerRepo` from `git-ops` `compareUrl.ts` (one implementation, review N2):
   - https on port 443, `git@` ssh on port 22, or the scp form;
   - an ASCII host, with no IDN and no punycode;
   - `owner` and `repo` patterns, `.git` stripped, `repo` not `.` or `..`;
   - no query, fragment, password or whitespace.

   `pty-process` uses `vetOwnerRepo` too. If the package boundary keeps it from importing `git-ops`, it carries a copy, and a parity test runs both over the same corpus.
3. **Confirm, including the first time (review SF-9).** No repository is used until the user confirms it.
   - **First use.** The state is `repository_unconfirmed`, with the vetted `host/owner/repo` and the note "from this checkout's `origin` remote". The PR section header (PV-D1) shows it with a **Use this repository** action, a **user-only** write `axis.forge/1.pinRepository { projectId, host, owner, repo }`. The daemon accepts it only if those values equal what it just displayed for that project. Until then no `gh` runs.
   - **Later reads.** The daemon re-reads and re-vets the remote. If it differs from the pin, the state is `remote_changed` and nothing runs. The dialog shows old and new values side by side and says: "A run in this project can change this setting. Only switch if you changed the remote yourself." Accepting is the same `pinRepository` write.
   - **Display.** The pinned `host/owner/repo` is always shown next to the list (a PV-D1 acceptance item).
4. **Which rows.** Only rows with `isCrossRepository === false`, `headRepositoryOwner.login` equal (case-insensitively) to the pinned owner, and `headRefName` starting with `axis/` are kept.
   - `isCrossRepository === false` is the decisive check; the owner check is defence in depth.
   - Fork PRs named `axis/...` are dropped, never shown.

## 3. Hosts

- **github.com only.** The template passes `--repo=github.com/...`, the pty process pins `GH_HOST=github.com`, and the generated configuration names no other host.
- **Other hosts.** A remote on any other host is `other_forge`. A GitHub Enterprise host is `unsupported_host` in v1. When supported, the host comes from a separate user-confirmed `forgeHosts` list: the compare-URL `allowedHosts` was approved for building links, not for sending the user's credential.
- **Links.** The `url` field is not requested. A row's link is built by the daemon as `https://github.com/<owner>/<repo>/pull/<number>`, from vetted values, and opened only on a user click through the opener (EL-5).

## 4. `gh` as a hostile-environment program

`gh` can run code that the user, or anything running as the user, installed: extensions (executables), aliases (`gh alias set --shell`), and a pager, browser or editor. It also reads environment variables, its configuration directory and the OS keyring. The exec closes each of these.

**Environment: built from an allow-list, never filtered.** The pty process builds the environment from nothing. Its own startup environment is main's and PTY-5 clean, so a run cannot change it. From it the pty process copies:

| Copied from the startup environment | Why |
|---|---|
| `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_*` | basic process setup. `HOME` is a fallback only for directories that are all pinned, and the macOS keychain needs it |
| `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` (Linux) | to reach the user's keyring |
| `SYSTEMROOT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP` (Windows) | process setup and Credential Manager |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and their lower-case forms, `SSL_CERT_FILE`, `SSL_CERT_DIR` | the user's network setup, as in their terminal (accepted decision) |

The pty process then sets:
- `GH_CONFIG_DIR=<call>/config`, `XDG_DATA_HOME=<call>/data`, and `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under `<call>/`;
- `GH_HOST=github.com`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `NO_COLOR=1`, `CLICOLOR=0`.

Everything else is absent by construction, including:
- **tokens:** `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`;
- **a repository or path override:** `GH_REPO`, `GH_PATH`;
- **interactive programs:** `GH_PAGER`, `PAGER`, `GH_BROWSER`, `BROWSER`, `GH_EDITOR`, `EDITOR`, `VISUAL`, `GIT_EDITOR`;
- **debug and terminal switches:** `GH_DEBUG`, `DEBUG`, `GH_FORCE_TTY`, `CLICOLOR_FORCE`;
- **runtime and loader variables:** `GODEBUG`, `GOFLAGS`, `LD_PRELOAD`, `DYLD_*`.

A user whose only login is an environment token gets `not_logged_in`, with copy that says to run `gh auth login`. Stdout and stderr are pipes, never a TTY.

**Configuration: generated, fresh per call, migration-proof (review SF-1).**
- `config.yml` holds exactly:
  - `version: "1"`;
  - `git_protocol: https`;
  - `prompt: disabled`;
  - empty `pager`, `browser` and `editor`;
  - no `aliases`, no `http_unix_socket`.
- `hosts.yml` holds exactly `github.com:` with `git_protocol: https`. It has **no `user`, `users` or `oauth_token` key**, so `gh` reads the token from the keyring's active-account entry itself.
- The `version` key stops the multi-account migration, which would otherwise call the API, **write a keyring entry** and rewrite `hosts.yml` on every call.
- Axis never reads the user's `hosts.yml` or keyring, never sees a token and never needs the login name.
- **No fallback to the user's directory.** If the gate below shows `gh` cannot find the keyring login with this configuration, the state is `auth_unsupported`. The user's directory would bring back `http_unix_socket` (all API traffic, token included, through a socket of the config's choosing), host entries and migration writes.
- **Plaintext storage:** a login stored in plaintext in the user's own `hosts.yml` is also `auth_unsupported`, because using it would mean copying the token.

**Verification gate (slice 2, recorded per platform and `gh` version).** Run with the real `ExecFn` and a real `gh`:
- the call succeeds with a keyring login;
- the keyring was **not written**: the item list is diffed before and after (`secret-tool search`, `security dump-keychain` metadata, `cmdkey /list`);
- no `git` process is started;
- `@me` narrowing works.

The minimum `gh` version is the first that reads `version: "1"` without migrating (expected 2.40.0, confirmed here). `gh --version` runs once per pty process start under the same bounds and is parsed strictly; below the minimum the state is `gh_too_old`.

**Prompts and dialogs (review SF-5).**
- `GH_PROMPT_DISABLED` covers only `gh`'s own terminal prompts, which are already moot with pipes.
- It does **not** cover OS credential dialogs:
  - a locked GNOME Keyring or KWallet collection asks to be unlocked;
  - on macOS, a Keychain access prompt can appear after `gh` is upgraded (go-keyring runs `/usr/bin/security` as a child).
- Axis never runs `gh auth login`, so no browser login starts.
- Because a dialog can appear, `gh` runs only when the user is looking or asked (§6), and after an authentication or keyring failure it does not run again until the user presses **Refresh**.
- The UX copy says that a system dialog asking to unlock the keyring for `gh` comes from this action.

## 5. Output: two-stage parse, bounded and escaped (review SF-4a)

The parse happens in the daemon, from `forge-result.stdout`. `truncated` gives `output_too_large`.

1. **Outer, strict.** The whole stdout must be one JSON array of at most 50 objects. Anything else is `output_invalid`.
2. **Per row, lax: the filter first.** From each object only `isCrossRepository` (must be the boolean `false`), `headRepositoryOwner.login` (a string equal, case-insensitively, to the pinned owner) and `headRefName` (a string starting with `axis/`) are read. A row that does not pass is dropped silently, whatever else it contains. One fork row with an odd branch name or an oversized title cannot deny the list.
3. **Kept rows, strict.** Each kept row is checked by a strict schema. A kept row that fails is dropped and counted (`invalidRows`), never fatal.

| Field | Rule |
|---|---|
| `number` | integer from 1 to 2^31 |
| `title` | string of at most 1,024 UTF-16 units on input |
| `headRefName` | git ref name rules (`safeRef`), at most 255 |
| `author.login` | GitHub login pattern; bots as `app/<slug>` (gh's form for apps; confirmed at the gate) |
| `isDraft` | boolean |
| `reviewDecision` | one of `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, empty; anything else is `unknown` |
| `updatedAt` | ISO 8601, at most 40 characters |

- `statusCheckRollup` is reduced to one closed value: `passing`, `failing`, `pending`, `none` or `unknown`. At most 200 entries per row are **read**, the rest ignored; `gh` requests at most 100.
- **Display text.** Title, branch and logins are prepared in the daemon:
  - NFC;
  - then removal of C0 and C1 controls (including ESC, so ANSI and OSC 8 sequences lose their introducer), bidi overrides and isolates (U+202A to U+202E, U+2066 to U+2069), `\p{Cf}`, and line and paragraph separators;
  - truncation with an ellipsis, to 200 code points for a title and 120 for a branch.
- **Rendering.** The renderer shows these as **plain text only**. The closed badges (draft, checks, review) sit in a fixed column, visually apart from the title, and title text is never placed where a state is shown (review N6: a title such as "✅ Approved · checks passing" must not pass for a badge).
- **Who sees it.** The user's dashboard only. The policy row allows the `user` principal. In v1 no agent or model context receives the list. If a later ticket opens it to agents, they get only the closed scalars (number, draft, checks, review, branch-is-axis), as PV-M0-tainted data with a named source, never titles or logins.

## 6. When it runs: visible or asked, cached, latched after auth failures (review SF-5)

The request carries `trigger`: `"view"` or `"user"`.

- **`view`.** Sent by the renderer only while the PR section is visible (a PV-D1 acceptance item). It returns the cache when fresh (under 60 s). When the cache is older it starts one refresh, unless the project is latched or busy.
- **`user`.** The **Refresh** button. It ignores the 60 s freshness, but within 15 s of the last exec it returns the cache with `retryAfterMs`.
- **No timer in the daemon.** The daemon never refreshes on its own, so no `gh` (and no keyring dialog) runs while the dashboard is hidden.
- **Latch.** After `not_logged_in`, `keyring_unavailable`, `auth_unsupported` or `timeout` (a pending OS dialog can look like a timeout), the project is latched: `view` returns the cached state, and only `user` runs `gh` again.
- **Failure cache.** Other failure states are cached for 15 s.
- **Single flight and caps.** One exec per project (daemon side); two in flight across projects (pty process). A list older than 10 minutes is marked `stale`.
- **Clock.** The cache time comes from the injected clock.

## 7. Closed states and errors

`axis.forge/1.pullRequests` replies with `{ state, repository?, candidate?, rows?, incomplete?, invalidRows?, fetchedAt?, stale?, retryAfterMs? }`.

- `state` is one of the closed values below.
- No free text from `gh` (stderr or stdout) reaches the reply, the log or the audit.
- Stderr is classified **in the pty process** against a fixed marker set and then discarded. The marker set is versioned with the gate, and the first match wins.

| State | When |
|---|---|
| `ok` | list parsed (possibly empty) |
| `repository_unconfirmed` | no pin yet; `candidate` holds the vetted value (§2) |
| `remote_changed` | the remote differs from the pin; `candidate` holds the new value (§2) |
| `no_remote` | no `origin`, or it is not readable |
| `remote_invalid` | the remote fails the H9 vetting |
| `other_forge` | vetted, but the host is not github.com or a GitHub host |
| `unsupported_host` | a GitHub Enterprise host (v1) |
| `gh_missing` | no `ghPath`, or the spawn reports ENOENT |
| `gh_too_old` | version below the minimum |
| `not_logged_in` | exit 1 with `HTTP 401`, or exit 4 |
| `keyring_unavailable` | stderr names a keyring failure (Secret Service unavailable, keyring timeout, `couldn't find oauth token`, migration refusal) |
| `auth_unsupported` | the gate shows the generated configuration cannot reach the login, or the login is plaintext only (§4) |
| `repo_not_found` | `Could not resolve to a Repository` (no access, renamed or deleted) |
| `network_unavailable` | stderr matches the fixed connection-failure markers |
| `gh_failed` | any other non-zero exit |
| `timeout` | 20 s passed |
| `output_too_large` | the output cap was reached |
| `output_invalid` | the outer array was refused |
| `busy` | the concurrency cap was hit |
| `unsupported_platform` | Windows until PV-X1 provides a job-object kill |
| `unavailable` | no pty process connected |

**Audit.** The policy row's `rpc.execute` event records `projectId`, `trigger`, `state`, the row count and `invalidRows`, as allow-listed scalars. It never records a title, branch, login, URL or stderr. `pinRepository` is audited with the old and new `host/owner/repo`, which the daemon vetted.

**Logs.** Only the state and the exit code.

**Journal.** Only the pin (a schema bump in slice 2). The list is never persisted.

## 8. Threat checklist

| Threat | Handled by |
|---|---|
| Hostile PR title or branch (bidi, controls, ANSI or OSC 8, markup, very long) | §5 escaping, plain-text rendering, truncation |
| Title imitating a state badge | fixed badge column, never title text in a state position (§5) |
| Fork PR named `axis/...` | `isCrossRepository` and head-owner filter (§2) |
| Outsider denies the list (one odd row, or flooding the 50-row window) | two-stage parse with the filter first (§5); `--author=@me` and `incomplete` (§1) |
| Run rewrites the remote before the first or a later refresh | user-confirmed first pin, `remote_changed` with old and new side by side (§2) |
| Flag or URL injection into `gh` | typed `forge-list`, closed template, joined `--flag=value`, shared validator in the pty process (§1) |
| Extension or alias named like a core command | fresh empty `data/` per call, checked empty before the exec (§1). Residual: a same-user race until Phase 3 |
| `gh` configuration migration writing the keyring | `version: "1"`, no user keys in `hosts.yml`, gate diffs the keyring (§4) |
| `http_unix_socket`, hosts, pager, browser, editor, update check | generated configuration, environment allow-list, pipes, notifier switches (§4) |
| Unprompted OS credential dialogs | visible or user trigger only, no daemon timer, latch after auth, keyring and timeout failures (§6) |
| Token exposure through Axis | no token variable forwarded; Axis never reads `hosts.yml` or the keyring; nothing from `gh` logged (§4, §7) |
| Token exposure to runs | **not protected before Phase 3:** any process running as the user can ask the keyring for the `gh` token itself. Axis adds no exposure |
| A program other than `gh` or git through the exec function | exact `argv[0]` allow-list inside `exec-node.ts`, tested (§1, PV-X1) |
| Talking to a host other than github.com | `--repo=github.com/...`, `GH_HOST`, no user host configuration (§3, §4) |
| Resource exhaustion | per-stream caps, 20 s, process-group (POSIX) or job-object (Windows, PV-X1) kill, `--limit=50`, cache, concurrency caps (§1, §6) |
| A planted `gh` on PATH | the trusted resolver skips workspace directories. Residual: same-user replacement of a binary in a user-writable PATH directory until Phase 3 (same as git) |

## 9. Slices, tickets and test plan

**PV-X1 (separate prerequisite ticket):** production `ExecFn` for the pty process, POSIX and Windows. It blocks PV-D2 slice 2 and production push (H9-hooks S4). Its acceptance:
- `exec-node.ts` with `createNodeExec` and the exact `argv[0]` allow-list (§1);
- per-stream caps (`maxOutput`, `maxStderr`) enforced while reading, timeout, stdin;
- real kill:
  - POSIX: the process group, verified with a grandchild that holds the pipes and ignores SIGTERM (`done` settles; `kill -0` shows no survivor);
  - Windows: a job object, or `unsupported_platform` until one exists;
- the environment passed exactly as given;
- the `git` and forge configuration (`gitPath`, `ghPath`, `hooksOff`, `scratchParent`, `baseEnv`) in `PtyEntryDeps` and `axisPtyMain.ts`. Main resolves both programs with the trusted resolver from main's resolved shell environment, so a Finder-started app finds `/opt/homebrew/bin/gh` (review N7);
- the daemon entry's pty port;
- the ADR 0005 amendment and the `daemon-host.md` 2.1 rows (§1).

**Slice 1 (no real network):**
- **pty process:**
  - the `forge-list` message, the closed template, the environment builder, the per-call directory lifecycle, the generated configuration, the stderr classifier and the reply codes;
  - `maxStderr` in the exec contract.
- **daemon:**
  - the `axis.forge/1` schema (`pullRequests`, `pinRepository`) and policy rows (user only);
  - the forge binding: repository read and vetting, confirmation states, two-stage parse, reduction, escaping, cache, trigger, latch;
  - all over a fake pty port and a temporary git repository.
- **Shared validator:** `vetOwnerRepo` exported from `git-ops`, with the parity test if the pty process carries a copy.
- **Hostile fake `gh` through `pipeExec`.** One case each:
  - the generated `config.yml` has `version: "1"` and `hosts.yml` has no user or token key;
  - invalid JSON; a 51-row array; a bot `app/x` author; a fork row with a non-ASCII branch and a 5,000-unit title next to a valid `axis/` row (the list is `ok` with that row);
  - stderr `HTTP 401` (`not_logged_in`), a keyring failure (`keyring_unavailable`), the migration text, `Could not resolve to a Repository` (`repo_not_found`);
  - 5 MiB on stdout and 1 MiB on stderr (`output_too_large`, memory bounded by the per-stream caps);
  - ANSI, OSC 8, bidi and C1 in titles (escaped);
  - a hang (`timeout` on the injected clock);
  - a file written into its cwd (gone; the next call's cwd is empty);
  - **its whole environment dumped to a file outside its cwd.** The test compares the dump to the exact expected map, with every forbidden name, `GODEBUG`, `LD_PRELOAD` and a random `AXIS_CANARY_<n>` planted in the startup environment and absent;
  - a planted `gh-pr` extension in a pre-existing data directory never runs (sentinel file absent);
  - latch behaviour: after `not_logged_in`, `view` does not exec and `user` does.
- **Mutants to kill:**
  - drop `version`;
  - reuse the data or cwd directory;
  - skip the emptiness check;
  - validate before filtering;
  - forward stderr text;
  - drop `GH_HOST`;
  - copy `GH_TOKEN`;
  - drop `--author=@me`;
  - swap the stdout and stderr caps;
  - remove the latch;
  - let `view` bypass the freshness;
  - accept `pinRepository` values that differ from the displayed candidate.

**Slice 2:**
- the pin in the journal and the composition wiring;
- the hostile-`gh` suite rerun through the real `ExecFn` (from PV-X1), including the grandchild kill case;
- the §4 verification gate with a real `gh`, recorded per platform.

**Slice 3:** the dashboard section, with PV-D1 owning the frame. Its acceptance:
- the pinned repository always shown;
- the confirm and change dialogs of §2;
- the badge column of §5;
- `trigger: "view"` only while visible.

## 10. Open questions

1. **`--author=@me` and a `--search` prefix qualifier:** exact semantics on the supported `gh` versions (gate). If `@me` is unavailable, the fallback is `incomplete` with the plain window.
2. **Minimum `gh` version:** the first that reads `version: "1"` without migrating (gate).
3. **Windows job object:** the native pty binding or a small addon (PV-X1).
