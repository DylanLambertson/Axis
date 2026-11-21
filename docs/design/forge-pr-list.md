# Pull request list through the user's `gh` (ticket PV-D2)

- **Status:** design for review (nothing built). Phase 1c, dashboard item "Pull requests" (`product-vision-v2.md` §4 row 7, the data-source table, O-5).
- **Scope:** `axis.forge/1.pullRequests { projectId }` returns the open pull requests of this project's GitHub repository whose head is an `axis/*` branch of that same repository: number, title, branch, author, draft, checks state, review state. Read-only. The dashboard UI (PV-D1) is a separate ticket.
- **Constraints carried in:** ADR 0004 decision 9 and D-9 stand: Axis stores, reads, logs and forwards **no forge credential**. `gh` runs under the user's own login. Its output is untrusted (a pull request title is written by anyone who can open one).

## 1. Where `gh` runs: the pty process's exec path, as a second fixed program

`gh` is a user binary, so it runs where user binaries run: in the pty process with the PTY-5 environment rules, not in the daemon. The daemon never starts it.

**What exists.** The pty process already has a bounded exec path, built for git (`packages/pty-process/src/git-exec.ts`, `docs/design/daemon-host-hooks.md` §4). It:
- runs the program set at start (`gitPath`, never taken from a message);
- builds the environment itself (`exec-env.ts`);
- checks a closed argument list (`exec-argv.ts`);
- caps output and time, and runs each child in its own process group, killed on timeout or close;
- limits how many execs run at once.

The process start goes through the injected `ExecFn`, since the package imports no `node:child_process`.

**What is added.** A second program uses the same machinery:
- **`ghPath`** in the pty process configuration: absolute, set at start, never from a message. Main resolves it the way the git path is resolved (the trusted resolver, which skips workspace and repository directories). No `gh` found means the `gh_missing` state.
- **A typed message `forge-list`** `{ req, host, owner, repo }`. It carries **no argv, no env, no cwd and no flags.** The pty process composes the whole command itself from a closed template:

  ```
  <ghPath> pr list --repo=github.com/<owner>/<repo> --state=open --limit=50
           --json=number,title,headRefName,author,isDraft,isCrossRepository,headRepositoryOwner,reviewDecision,statusCheckRollup,updatedAt
  ```

  `host` must equal `github.com` (§3). `owner` and `repo` are re-validated in the pty process with the same patterns the daemon uses (§2). Each one is a single argument joined to its flag (`--repo=...`), so neither can be read as a flag.
- **The reply.** Either `forge-result { req, code, stdout, truncated }` or `forge-failed { req, code }`, with a closed code set: `spawn_failed`, `timeout`, `capacity`, `bad_request`, `no_control`. Exit code 4 and stderr are not forwarded as text; the pty process classifies them (§4).
- **`cwd`:** a private empty directory owned by the pty process, never a repository. `gh pr list --repo` needs no checkout, so `gh` never reads a worktree's `.git/config`.
- **Bounds:** one `forge-list` at a time per process, on top of the shared exec limit. Timeout 20 s; output cap 4 MiB on stdout and 64 KiB on stderr. The process group is killed on timeout and on control close, as for git.

**Egress lint (#499, #506).** The forge path adds **no spawn site of its own**: it reaches `gh` through the same injected `ExecFn` the git exec path uses. That `ExecFn` is **not wired in production yet**. The overlay entry `code-oss/overlay/src/vs/axis/pty/node/axisPtyMain.ts` passes `runPtyEntry` a terminal `spawn` only, and `PtyEntryDeps` has no `exec`. So the git exec path runs only under the test `pipeExec`. Production needs one real `ExecFn` (pipes, own process group, kill on timeout), shared by git and `gh`. There are two places for it:
- **(a) In the overlay entry.** It stays outside the staged packages, so outside `SPAWN_FILES`, and is covered by the overlay scan (`net-gate.md`).
- **(b) In `packages/pty-process/src`.** Then it is **one new `SPAWN_FILES` entry** (`pty-process/exec-node.ts`: `spawn`, program by value). It is held to #506's rules: a static named import, call only, `(program, [argv], { options })` with `shell: false`, and no injected default.

Recommended: (b). The rules of #506 then apply to it on the parse, and its program is constrained before the call. `argv[0]` must be the configured `gitPath` or `ghPath`, checked in the pty process before the `ExecFn` is called, and it is the PTY-2 boundary row of `daemon-host.md` 2.1. This wiring is a prerequisite of slice 2. It is shared with the H9-hooks pty git runner, which needs it too.

## 2. Which repository: derived and pinned by the daemon

The repository is never taken from request content. The request names a `projectId` only.

1. **Read the remote.** The daemon reads `remote.origin.url` of the project's main checkout with its own pinned git (`daemonGitFor`, the H9 path that `compareUrl` uses): no hooks, isolated config, `--` before the name.
2. **Vet it.** The URL is vetted by the H9 rules (`git-ops` `compareUrl.ts`, `parseRemote`):
   - https on port 443, or `git@` ssh on port 22, or the scp form;
   - an ASCII host, with no IDN and no punycode;
   - `owner` matching `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` and `repo` matching `^[A-Za-z0-9._-]{1,100}$`, with `.git` stripped;
   - no query, fragment, password or whitespace.

   The parser is exported for this use, so there is one implementation.
3. **Pin it.** The remote is attacker-influenced: a run can rewrite the shared `.git/config` from its worktree. So the first resolved `host/owner/repo` for a project is **pinned** in the project's daemon state.
   - On each refresh the daemon re-reads and re-vets the remote. If it differs from the pin, the result is `remote_changed`; no exec runs and no list is shown.
   - The UI offers "Use `<new owner/repo>`", a **user-only** write (`axis.forge/1.pinRepository`) that names the value the daemon displayed, not one from content.
   - The pin is shown next to the list, so the user always sees which repository the list is from.
4. **Which branches.** Only rows with `isCrossRepository === false`, `headRepositoryOwner.login` equal (case-insensitively) to the pinned owner, and `headRefName` starting with `axis/` are kept. Anyone can open a pull request from a fork whose branch is named `axis/...`; those rows are dropped, never shown.

## 3. Hosts

- **v1 talks to `github.com` only.** The template passes `--repo=github.com/...`, the pty process pins `GH_HOST=github.com`, and `gh`'s configuration is Axis's own (§4), so no configured host can redirect it.
- **Other hosts.** A remote on any other host is `other_forge` (for example GitLab, or a host that is not a forge). A GitHub Enterprise host, including one listed in the daemon's `allowedHosts` for compare URLs, is `unsupported_host` in v1 (open question 2).
- **No URL from `gh`.** The `url` field is not requested. The link a row opens is built by the daemon as `https://github.com/<owner>/<repo>/pull/<number>`, and opened only on a user click through the opener (EL-5).

## 4. `gh` as a hostile-environment program

`gh` reads environment variables, a configuration directory and the OS keyring, and it can run code the user (or anything running as the user) installed: aliases (`gh alias set --shell`), extensions (executables) and a pager, browser or editor. The exec closes each of these.

**Environment: built from an allow-list, never filtered.** The pty process builds the environment from nothing, then copies in a fixed list from its own startup environment, which is PTY-5 clean.

| Copied from the startup environment | Why |
|---|---|
| `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_*` | basic process setup |
| `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` (Linux) | to reach the user's keyring |
| `SYSTEMROOT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP` (Windows) | process setup and Credential Manager |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and their lower-case forms, `SSL_CERT_FILE`, `SSL_CERT_DIR` | the user's network setup, as in their terminal (open question 3) |

Set by the pty process:
- `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`, each pointing to a private Axis directory (below);
- `GH_HOST=github.com`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `NO_COLOR=1`, `CLICOLOR=0`.

Everything else is absent. In particular `gh` never sees:
- **tokens:** `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`;
- **a repository or path override:** `GH_REPO`, `GH_PATH`;
- **interactive programs:** `GH_PAGER`, `PAGER`, `GH_BROWSER`, `BROWSER`, `GH_EDITOR`, `EDITOR`, `VISUAL`, `GIT_EDITOR`;
- **debug and terminal switches:** `GH_DEBUG`, `DEBUG`, `GH_FORCE_TTY`, `CLICOLOR_FORCE`.

A token in the startup environment is therefore never forwarded. The user's login is what `gh` itself stored (`gh auth login`); a user whose only login is an environment token gets `not_logged_in`, with copy that says to run `gh auth login`. Stdout and stderr are pipes, never a TTY, so `gh` starts no pager or spinner.

**Configuration: Axis's own, so no alias, extension, socket or pager setting is honoured.** The pty process owns a private directory (mode 0700) and rewrites it before each call.
- `config.yml` has fixed contents: `git_protocol: https`, `prompt: disabled`, empty `pager`, `browser` and `editor`, no `aliases`, no `http_unix_socket`.
- `hosts.yml` lists `github.com` with **no token**. `gh` then reads the token from the OS keyring itself, where `gh auth login` stores it by default.
- `XDG_DATA_HOME` points at an empty directory, so no installed extension is visible.

Axis never reads the user's `hosts.yml` or keyring entry, and never sees a token.
- **Verification gate (before slice 2):** confirm, on the supported `gh` versions and platforms, that `gh` with this generated configuration finds the keyring login.
- **If it does not:** the fallback is the user's own configuration directory, read-only from `gh`'s side. It keeps `GH_HOST`, the empty `XDG_DATA_HOME` and the environment allow-list. Aliases and extensions cannot take over a built-in command (`pr list`), but `http_unix_socket` and host entries in the user's config would then apply; the ticket records which option shipped.
- **Plaintext storage:** a login stored in plaintext `hosts.yml` (insecure storage) is `auth_unsupported` under the main design, because Axis would have to copy the token.

**Version.** `gh --version` runs once per pty process start (same bounds) and is parsed strictly. Below the minimum (2.40.0, the multi-account keyring layout; to be confirmed with the gate above) the state is `gh_too_old`.

## 5. Output: strict, bounded and escaped

**Parsing.** The parse happens in the daemon, from `forge-result.stdout`. Any failure, including `truncated`, is `output_invalid` or `output_too_large`; no partial list is shown.

- The whole stdout must be one JSON array, at most 50 entries, matching a strict zod schema (unknown keys dropped, wrong types refused).
- **Fields kept:**

| Field | Rule |
|---|---|
| `number` | integer from 1 to 2^31 |
| `title` | string of at most 1,024 UTF-16 units on input |
| `headRefName` | git ref name rules (`safeRef`), at most 255 |
| `author.login` | GitHub login pattern; bots allowed as `login[bot]` |
| `isDraft`, `isCrossRepository` | boolean |
| `headRepositoryOwner.login` | as `author.login` |
| `reviewDecision` | one of `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, empty; anything else is `unknown` |
| `updatedAt` | ISO 8601, kept as text, at most 40 |

- `statusCheckRollup` is reduced in the daemon to one closed value: `passing`, `failing`, `pending`, `none` or `unknown`. Its entries are counted, never shown, and at most 200 entries per row are read.

**Display text.** Built in the daemon for title, branch and logins:
- NFC, then removal of C0 and C1 controls, bidi overrides and isolates (U+202A to U+202E, U+2066 to U+2069), zero-width and other invisible format characters (`\p{Cf}`) and line or paragraph separators;
- truncation to 200 code points for a title and 120 for a branch, with an ellipsis.

The renderer shows these as **plain text only**: never markdown, HTML or a link from content. The only link is the daemon-built pull request URL.

**Who sees it.** The list goes to the user's dashboard. In v1 it is not given to any agent or model context (the policy row allows the `user` principal only). If a later ticket hands it to a run, it is tainted content under PV-M0, and that ticket names its source.

## 6. Cache, refresh and concurrency

- **Cache:** one entry per project, holding the last result (list or state) and its time. The time comes from the injected clock, never compared with the wall clock in tests.
- **Refresh:** a read inside 60 s returns the cache. A read older than that starts a refresh, which is single-flight per project.
- **Minimum interval:** an explicit refresh (`refresh: true`) less than 15 s after the last exec returns the cache with `retryAfterMs`. A request never starts an exec by itself sooner than that.
- **Concurrency:** at most 2 `forge-list` execs in flight across all projects. Beyond that the state is `busy`, and the last cached value is shown with it.
- **Failures and staleness:** a failure state is cached for the same 15 s, so a failing `gh` is not run in a loop. A list older than 10 minutes is marked `stale` in the reply.

## 7. Closed states and errors

`axis.forge/1.pullRequests` replies with `{ state, repository?, rows?, fetchedAt?, stale?, retryAfterMs? }`. `state` is one of the closed values below. No free text from `gh` (stderr or stdout) ever reaches the reply, the log or the audit.

| State | When |
|---|---|
| `ok` | list parsed (possibly empty) |
| `no_remote` | no `origin`, or it is not readable |
| `remote_invalid` | the remote fails the H9 vetting |
| `other_forge` | vetted, but the host is not a GitHub host |
| `unsupported_host` | a GitHub Enterprise host (v1) |
| `remote_changed` | the remote differs from the pinned repository (§2) |
| `gh_missing` | no `ghPath`, or the spawn reports ENOENT |
| `gh_too_old` | version below the minimum |
| `not_logged_in` | `gh` exit code 4 (authentication required) |
| `auth_unsupported` | login only in plaintext storage (§4) |
| `network_unavailable` | exit 1, with stderr matching a fixed set of connection-failure substrings (classified in the pty process; the text is discarded) |
| `gh_failed` | any other non-zero exit |
| `timeout` | 20 s passed |
| `output_too_large` | the output cap was reached |
| `output_invalid` | the schema refused the output |
| `busy` | the concurrency cap was hit |
| `unavailable` | no pty process connected |

**Audit.** The policy row's `rpc.execute` event records `projectId`, `state` and the row count, as allow-listed scalars. It never records a title, branch, login, URL or anything from stderr. `pinRepository` is audited with the old and new `host/owner/repo`, which the daemon vetted.

**Logs.** Only the state and the exit code.

**Journal.** Only the pin, as a small table or project field (a schema bump in slice 2). The list itself is never persisted.

## 8. Threat checklist

| Threat | Handled by |
|---|---|
| Hostile PR title or branch (bidi, controls, markup, very long) | §5 schema, display escaping, plain-text rendering, truncation |
| Fork PR named `axis/...` | `isCrossRepository` and head-owner filter (§2) |
| Run rewrites `.git/config` to point at another repository | daemon-side vetting, pin and `remote_changed` (§2) |
| Flag or URL injection into `gh` | typed `forge-list` message, closed template, joined `--flag=value`, re-validation in the pty process (§1) |
| `gh` aliases, extensions, pager, browser, editor, unix-socket config, update check | Axis-owned config and data directories, environment allow-list, pipes, notifier switches (§4) |
| Token exposure | no token variable forwarded; Axis never reads `hosts.yml` or the keyring; nothing from `gh` is logged (§4, §7) |
| Talking to a host other than github.com | `--repo=github.com/...`, `GH_HOST`, no user host config (§3, §4) |
| Resource exhaustion | output and time caps, process-group kill, `--limit=50`, cache with minimum interval, concurrency cap (§1, §6) |
| A planted `gh` on the user's PATH | the trusted resolver skips workspace directories. Residual: before the Phase 3 sandbox, anything running as the user can replace a binary in a user-writable PATH directory (same residual as git) |

## 9. Slices

1. **Slice 1 (no real network).**
   - **pty process:** `ghPath`, the `forge-list` message, its closed template, the environment builder, the private configuration writer and the reply codes. Tests use a fake `ExecFn` and assert the exact argv, the exact environment (each forbidden name planted in the startup environment and shown absent) and the configuration files.
   - **daemon:** the `axis.forge/1` protocol schema and policy row (user only); the forge binding (parse, reduce, escape, filter, cache, states) over a fake pty port with hostile fixtures (bidi, controls, huge rollups, fork rows, truncation, wrong types).
   - **Repository:** resolution and vetting from a temporary git repository.
   - **Tests:** mutation-proof.
2. **Slice 2.**
   - the pin and `pinRepository` with its journal field, and composition wiring;
   - the verification gate of §4 with a real `gh` (manual, recorded) and the choice between the generated and the user's configuration directory;
   - main's `ghPath` resolution and the production `ExecFn` (§1, option (b), with its `SPAWN_FILES` entry).
3. **Slice 3.** The dashboard section (PV-D1 owns the UI frame).

## 10. Open questions

1. **Configuration directory.** Generated (§4) or the user's own? This depends on the verification gate. Generated is recommended, because it removes `http_unix_socket`, hosts and aliases from consideration.
2. **GitHub Enterprise.** Allow hosts from `allowedHosts` (the compare-URL list), passing `--repo=<host>/...` and `GH_HOST=<host>`? Out of v1.
3. **Proxy variables.** Forward the user's `HTTPS_PROXY` and `NO_PROXY` to `gh`, as their terminal does (recommended: `gh` is the user's binary under the user's login), or drop them? D-14 concerns the credential proxy for integrations, not this.
4. **Agent visibility.** Should agents ever read the list (for example "check the PR state")? Not in v1. If so, it goes through PV-M0 taint with a named source.
