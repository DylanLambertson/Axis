# Project registration and the run-trust record

Status: design for review (security-relevant), revision 3, after design reviews 1 and 2. It is decided by `owner-decisions-2026-11-21.md` §5; this note specifies it and cuts the slices. Nothing here is built yet.

## 1. Why

`axis.projects/1` only lists, nothing in the app sends `projects.register`, and main's `trustSource` knows no project path, so `trust.check` is `false` for every project (`main-answers.md` §3.3). Worktree create, commit, push and every run start are therefore unreachable in the app. Two gaps close together:

- **Registration** grants a path to the daemon's privileged git path. A folder the user merely browsed must never become a project.
- **Run trust.** The Workspace Trust model (`content.trust.model.key`) is written by renderers through the storage channel. `main-answers.md` §3.3 makes it a gate line: before main registers projects, main owns the run-trust decision in a record renderers cannot write, set only from a prompt main shows.

Adopted, decisions unchanged (§11 amends their text only to name the mechanisms below): ADR 0004 decision 12 (Workspace Trust is inherited by worktrees and gates runs, re-derived at each mount and run start, attested by main); `daemon-host.md` §6.2 (`trust.check` per run start; the handler re-checks immediately before the side effect) and §7.4 (main registers projects over the control channel, never a renderer request); `main-answers.md` §3.2 (the native dialog and its bounds).

## 2. The rule

A project is **trusted** for a call when **all** of these hold at that call:

| | Condition | Checked by | Writable by a renderer? |
|---|---|---|---|
| T1 | The journal's run-trust record for the project is `trusted` | daemon | no (§3) |
| T2 | The record's binding still holds: the project folder is still the same repository (§5.2), and for a call on a workspace, that worktree belongs to the same repository (§5.4) | daemon | no |
| T3 | Main answers `trust.check` with `true`: the window is live in the broker's table, and the project path is equal to or inside a folder the Workspace Trust model marks trusted | main | the model, yes: T3 alone never grants |
| T4 | No revoke for the window or workspace is recorded in the `TrustRegistry` (unchanged from §6.2) | daemon | no |

This is the decided "`trust.check` stays `false` until both conditions hold". Main's `trust.check` answers the Workspace Trust half (T3), and the daemon ANDs it with the record half (T1, T2) at the same call, so no caller ever sees one half alone.

Fail closed: the call is untrusted on a missing row, a record set `false`, a broken binding, no answer from main within 2 s, an abort, or any throw. A newly registered project is untrusted unless the user chose "Add and trust to run" in main's dialog (§4.2).

Allowed while untrusted:
- the reads `worktrees.list` and `status`, `review.diff` and `content`, `git.pushPlan` and `compareUrl`, and the shell's `IGitService` reads;
- `review.complete` (tier 2: it records a review and runs no repository code);
- `worktrees.finalise`, `remove` and `setUserEditing` (§6.1).

**Terminals.** Plain terminals are the user's own shell. They stay ungated by project trust, as upstream Restricted Mode allows the terminal: nothing in them runs unless the user types it. The shell still opens a worktree's first terminal automatically only in a Workspace-Trusted window (`axisAgent.contribution.ts`, advisory). CLI and agent runs are gated (`cli-runs.start`, `runs.start`, §6.1).

## 3. The record

**Store:** the journal's existing `projects.trusted` column (schema v4). The journal is the daemon's database. `axis.projects/1` stays read-only (§6.3) and only main writes the control channel (the daemon's parent port), so the only writers of `trusted` are the control messages main sends (§4.3) and the daemon's own binding check (§5.2), which can only lower it.

**Journal migration v11:**
- Adds `common_dir TEXT` (the canonical git common directory, §5.2), with a unique index where it is not NULL, `git_dir_id TEXT` (`<dev>:<ino>` of `P/.git`, §5.2), and `trust_changed_at TEXT`.
- Sets every existing `trusted` to 0. No row was trusted through the dialog, because no writer existed.
- Adds two triggers: `path` never changes, and `common_dir` and `git_dir_id` are each **set once** (NULL to a value is allowed, any other change refused; the pattern of `agent_workspaces_base_branch_once`, v5).

A row from before v11 has `common_dir` NULL, and T2 fails for it, so it stays untrusted and read-only until it is re-bound. Re-binding is the `trust` action on its folder (§4.3): main inspects again, the daemon re-derives the binding, and the same transaction sets `common_dir`, `git_dir_id` and `trusted`. The row keeps its id, its threads and its workspaces.

**Operations:**
- `registerProject` (exists) gains `commonDir`.
- New: `setProjectTrust(id, trusted, { via, commonDir? })`.

Every change writes one audit row in its transaction. The actor stays **`daemon`**: main's control message carries no attestation (RR-17, unchanged). The decision source is in the action name:

| Action name | Written when |
|---|---|
| `journal.project.trust.grant_dialog` | the user confirmed main's dialog |
| `journal.project.trust.revoke_gesture` | the user's untrust action, which has no dialog |
| `journal.project.trust.binding_lost` | the daemon's own binding check failed |

Registration writes `journal.project.register.trusted` or `journal.project.register.read_only`. The decision sits in the action name, not the payload: the records audit stores only `{ field }` (`records.ts`), so no `payloadAllowlist` entry is needed. A call that changes nothing writes nothing.

## 4. Main's side

### 4.1 The renderer's request

The renderer sends main one IPC message, `vscode:axisProjectAction`, with a strict `{ nonce, action }` payload:
- `nonce` is a renderer-chosen string, at most 64 characters of `[A-Za-z0-9_-]`, used only to correlate the answer. It grants nothing, and reusing one is harmless: every grant needs a fresh dialog click.
- `action ∈ { "add", "trust", "untrust" }`.
- Any other field (a path, a project id) is refused.

Main checks the request in order:
1. the `vscode:axisConnect` sender checks (`main-answers.md` §2: code window, workbench frame URL, main frame, not destroyed);
2. the folder is **that window's** opened workspace: a single-folder `file:` workspace, else refused `no_folder`;
3. one action per window at a time (else `busy`), at most 6 per minute per window;
4. a **cooldown**: after a dialog for a folder ends in Cancel or expiry, the same action for that folder is refused `busy` for 60 s. Re-prompting until a tired click is not possible. The cooldown map holds at most 64 folders: an entry is deleted when its 60 s pass, and at the bound the oldest is evicted. Eviction only shortens a cooldown, and the per-window rate limit still applies.

The answer is `vscode:axisProjectActionResult { nonce, outcome }`, with a closed `outcome ∈ { added, added_read_only, trusted, untrusted, cancelled, expired, no_folder, not_a_repository, refused, busy, unavailable }`. It is display only.

### 4.2 The dialogs

All dialogs go through the native confirmation queue of `main-answers.md` §3.2 and share its bounds with `native.confirm`:
- one dialog open at a time, at most 16 waiting;
- 60 s from the request's arrival, monotonic: a waiting entry is answered `expired`, and an open dialog's `AbortSignal` closes it as `expired`;
- a dialog port that throws is `cancelled`;
- a late click is never applied.

The dialog is modal on the requesting window, with `noLink: true`. **Cancel is index 0, `defaultId` and `cancelId`**, so Return, Space and Escape all cancel on macOS (NSAlert), Windows (task dialog) and Linux (GTK). A grant button is never the default and never first. Every displayed value goes through `displayTextSchema` bounds, with control and bidirectional characters escaped (the review rule).

| Action | Shown when | Message | Detail | Buttons |
|---|---|---|---|---|
| `add` | the folder is a repository top level (§5.2) not yet registered | "Add this repository to Axis?" | The folder; the remote (`origin`'s URL, else the first remote, then "and N more", or "no remote"; display form per §5.3); a fixed sentence that Axis will read its status and diffs, and that runs, commits and pushes need "Trust to run" | Cancel · Add read-only · Add and trust to run |
| `trust` | registered and untrusted (including a pre-v11 row) | "Trust this repository to run?" | The folder, the remote, and the fixed sentence "CLI and agent runs, commits and pushes will be allowed in its workspaces. Only trust code you know." | Cancel · Trust to run |
| `untrust` | registered and trusted | none: revoking only lowers privilege | | |

"Add and trust to run" is offered, and `trust` accepted, only while the Workspace Trust model trusts the folder (T3 at that moment). That keeps the record consistent with the decided "both". The protection, however, is the native click: a compromised renderer can rewrite the model (EL-3), so the model at dialog time adds nothing an attacker cannot supply.

**Residual: a click placed onto the dialog.** A compromised renderer can trigger the dialog while the user is clicking. The dialog opens modal over the window, macOS as a sheet and Windows and Linux centred on it, so a pending click can land on a grant button. Mitigations: the grant buttons are never the default; the per-folder cooldown and the per-window rate limit apply; and the fixed text names the folder. Electron offers no delay before a button becomes active. S2's GUI run verifies the default focus on Linux; macOS and Windows are checked on the owner's machines before release.

As built (S2): `packages/daemon-host/src/main/project-actions.ts` (Electron-free), the choice entry of `main/native-queue.ts`, `DaemonSupervisor.sendProject`, `checkSender` shared with the connect broker, and the overlay's `projectDialog`, `windowFolder` and `workspaceTrusted` adapters. The remote line reads "Remote (as configured in the repository, not verified): …": the dialog shows what the repository's config names, it does not vouch for it (S1a review 2 N4).

### 4.3 What main sends

- **`add`:**
  1. `projects.inspect { requestId, path: folder }`;
  2. the dialog;
  3. on a grant, `projects.register { requestId, path, commonDir, trusted }`, where `commonDir` is the inspected value and `trusted` is true only for "Add and trust to run".
- **`trust`:** `projects.inspect`, the dialog, then `projects.trust { requestId, projectId, path, commonDir, trusted: true }`.
- **`untrust`:** `projects.trust { requestId, projectId, path, trusted: false }`.
- **`trust.check` answer:** main answers T3 from the daemon-supplied `projectPath` (§5.1). `trustSource.projectPath` goes away. Main keeps no project map: its only persistent store, application storage, is the renderer-writable one this design avoids.

## 5. The daemon's side

### 5.1 Control messages (supervisor to host, `control/messages.ts`; every schema strict)

| Message | Fields | Reply |
|---|---|---|
| `projects.inspect` | `requestId, path` (absolute, normalised) | `projects.inspected { requestId, ok: true, commonDir, registered?: { projectId, trusted }, remote: { name, url } \| null, remotes } \| { ok: false, code }` |
| `projects.register` (amended) | `requestId, path, commonDir, trusted` | `projects.result` (exists) |
| `projects.trust` (new) | `requestId, projectId, path, commonDir?, trusted` (`commonDir` required when `trusted`) | `projects.result { ok: true, projectId } \| { ok: false, code }` |
| `trust.check` (amended, host to supervisor) | `requestId, windowId, workspaceId?, projectId, projectPath` | `trust.result` (unchanged) |

`workspaceId` becomes optional, because `worktrees.create` has no workspace yet; main never read it.

The daemon re-derives everything at each message and never takes main's earlier inspection on trust. Refusals:
- `projects.register`: `E_INVALID_ARGUMENT` when §5.2 fails, `commonDir` differs from the re-derived value, or the path is equal to, inside, or containing the Axis data root, the worktree root, or a registered project's path; `E_CONFLICT` when the path or common directory is already registered.
- `projects.trust` with `trusted: true`: `E_INVALID_ARGUMENT` when the row's `path` is not `path`, §5.2 fails, or the row's `common_dir` (or `git_dir_id`) is set and differs; `E_CONFLICT` when re-binding a legacy row would give it a `common_dir` another row holds.

### 5.2 The repository binding, without git discovery

`@axis/git-ops`' `guardedRunner` refuses any daemon-context call without explicit `--git-dir=` and `--work-tree=` (GIT-4), so discovery (`rev-parse --show-toplevel`) is not used. The binding is read from the filesystem, with async calls under one `AbortSignal` and a 2 s bound. A folder `P` is a **repository top level** when all of these hold:

1. `P` equals `realpath(P)`. A symlinked path component makes the spellings differ, and is refused `not_a_repository`; the shell's text says to open the real folder.
2. `lstat(P/.git)` is a **directory**, not a symlink and not a file. A `.git` file (`gitdir:`) is refused: this covers a linked worktree (Axis's own worktrees among them), a submodule checkout and `--separate-git-dir` layouts. Supporting them later would need binding to a common directory outside the folder. Refusing keeps one project per object store.
3. `P/.git` has no `commondir` file, and has `HEAD` (a regular file), `objects/` and `refs/`, each a real directory by `lstat`, never a symlink: git's own repository test, made strict so the object store cannot live elsewhere.
4. `P/.git` is owned by the daemon's user (POSIX `uid`). Otherwise `not_a_repository`: the daemon's equivalent of git's `safe.directory` "dubious ownership", failing closed. **On Windows** there is no `uid`, and this check is never skipped: every inspection and every T2 is refused `E_UNAVAILABLE` until a Windows ticket (with PV-X1w, the pty exec there) specifies the owner-SID comparison git's `safe.directory` makes. No project is registered or trusted on Windows before then.

`commonDir` is `realpath(P/.git)`, and `gitDirId` is `<dev>:<ino>` of `P/.git` from `lstat`. **T2** at a gated call re-runs the same four checks on the row's `path`, and compares both values with the row's `common_dir` and `git_dir_id`. A `.git` directory removed and recreated at the same path (another repository moved in) has a new inode and fails. A row whose `common_dir` is NULL (pre-v11) always fails. A mismatch, or a folder that is no longer a repository (`not_a_repository`), sets the record `false` (`binding_lost`), stops the project's runs and refuses. A filesystem that does not answer in time, an abort or an error such as `EACCES` refuses THIS call only and leaves the record as it is: a slow or briefly unreadable disk is not evidence that the repository changed, and dropping the trust on it would let a hung mount revoke every project (the record is lowered only on positive evidence; as built in S1b).

### 5.3 Reading the remote for the dialog

This is the only git call. It goes through `prefix()`, `daemonGitEnv` and `guardedRunner`, unchanged, with every pin:
- options: `--no-pager`, `--no-replace-objects`, `--git-dir=P/.git`, `--work-tree=P`, `core.hooksPath` off, `core.fsmonitor=false`, `protocol.allow=never`, `protocol.ext.allow=never`, `commit.gpgsign=false`, `core.askPass=`, `diff.submodule=short`, `help.autocorrect=0`;
- environment: `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=/` and `GIT_TERMINAL_PROMPT=0` (#558, #560).

The command is `config --file P/.git/config --no-includes --null --get-regexp ^remote\..*\.url$`:
- `--file` reads that one file, never global or system config.
- `--no-includes` stops `include.path` and `includeIf`.
- `P/.git/config` must be a regular file (`lstat`) of at most 1 MiB before git opens it, so a FIFO or `/dev/stdin` cannot hang it.
- The call has a 5 s timeout and the inspection's `AbortSignal`.
- `config` runs no hooks, filters or transports.

A failure shows "remote unknown" and does not block the dialog.

URLs are display text only, never used to fetch. The display form:
- removes user info, query and fragment;
- escapes control and bidirectional characters;
- is bounded to 192 characters.

### 5.4 The trust gate

A new policy trust mode, **`project`**, replaces `registry` on every row that used it (§6.1). Policy checks T4 synchronously, as today.

**One gate, `requireProjectTrust({ projectId, windowId, workspaceId?, signal })`,** checks, in this order:
1. **T1:** the row exists and is `trusted`, else refused `untrusted` (see **Errors** below).
2. **T2:** the binding of §5.2.
3. **Workspace binding:** for a call on a workspace, the worktree `W` must belong to this repository. `W/.git` must be a `gitdir:` file whose `realpath` target is `<common_dir>/worktrees/<name>`, and that directory's `commondir` must resolve to `common_dir`. This closes the DMN-2 known gap ("the locator does not check that a worktree's common dir is the project repository's") for gated calls: a run that repoints its worktree's `.git` is refused.
4. **T3:** `trust.check` with the row's path; refused on `false`, silence (2 s) or abort.
5. **T4 again:** the `TrustRegistry` revoke for the call's window and workspace, re-read here. Policy checked it at dispatch, but a revoke recorded during a push's confirmation must refuse.

**Errors.** The gate refuses with `E_POLICY_DENIED` (`reason: "untrusted"`) **internally**, as `ControlClient.trustCheck` already does. On the wire every handler answers **`E_CONFLICT` with reason `untrusted`**: a handler cannot raise `E_POLICY_DENIED`, which the daemon turns into `E_INTERNAL` because only the daemon decides it, with an audit row (`packages/daemon/src/errors.ts`). The existing mappings already do this: `cli-runs` in `packages/daemon-host/src/runs/errors.ts`, the git handlers' `toGitError`, and S1b adds the same for the worktrees and composer handlers. `binding_lost` adds nothing the caller can tell apart.

**Where it runs (`daemon-host.md` §6.2: immediately before the side effect).** The gate mints a single-use, short-lived `ProjectTrustTicket`: a private-field brand like `TrustAttestation`, bound to `{ projectId, workspaceId? }`. Every gated side-effect port **requires** one:
- the git commit and push runners;
- worktree create, restore and discard;
- the run start.

A handler therefore cannot reach the side effect without calling the gate. It calls the gate inside the project mutex, after any confirmation it needed. For push, the tier 4 challenge is consumed at dispatch, before the handler runs, so the gate runs after the dialog and right before git. The port **consumes the ticket at its entry**, before any pre-work of its own (version check, `filterNames`, identity reads), so the 1 s covers only gate-to-port. It refuses a ticket that is spent, expired (over 1 s on the host's monotonic clock, never wall time) or bound to another project or workspace.

**Registration and coverage (as built, S1b).** A gated handler is marked `projectGated(handler)` where it is made (the git, worktrees, composer and CLI run handlers), and the handler takes the gate from its deps and calls it inside the mutex right before its port. `registrar.register` stays per contract (`compose.ts`), so a mixed contract (`axis.worktrees/1`, `axis.git/1`) registers its marked and unmarked handlers in one call; the recording registrar notes which keys carry the mark, and `checkCoverage({ gated })` fails the start (exit 70, before `ready`) unless the marked keys are exactly the `project` and `per-start` rows. The side-effect ports spend the ticket at their entry: the git operations (`executeCommit`, `executePush`), the worktrees service (`PortContext.trust`, inside its mutex), the CLI run minter (`attest(facts, ticket)`), and the composer's `start` as the handler sees it (`ticketedStart`, which spends the ticket and then calls the service).

`cli-runs.start` keeps `per-start`. Its handler calls `gate()` (T1 to T4, the workspace binding included) and then mints its `TrustAttestation`, so its existing `trust.check` call is the gate's.

`identity.trusted` (the connect-time model reading) is **no longer read by policy**. It reflected only the renderer-writable model, once per connection; T3 replaces it per call. The field stays on the identity for wire compatibility. Main sends no `trust.set` grants; registry revokes still work (T4).

**On a revoke or a lost binding,** the daemon stops the project's live runs (`cli-runs` stop, composer `runs` cancel) after the record write, inside the project mutex taken with `exclusive` (never the re-entrant `run`, so even a stop fired from inside a holder queues behind every waiting start): a start that passed the gate just before the revoke finishes recording its run and is then stopped, and the gate itself re-reads the record (and the workspace row) right before it mints, so a revoke during its awaits refuses the start. The stop waits for the current holder (a commit or push in progress, bounded by its own timeout); the revoke's answer does not wait for the stop, and new starts are refused at once. This answers plan question 6 for project trust: a running run does not outlive the trust it started under. It is a stop, not a rollback: anything already written stays and is shown as changed. Since `untrust` needs no dialog, a compromised renderer can stop the project's runs repeatedly. That is accepted: it only lowers privilege, and the renderer can already stop runs (`cli-runs.stop`, `runs.cancel`).

**After a daemon restart nothing is resumed.** `Journal.recover` makes a RUNNING run BLOCKED / `INTERRUPTED_BY_RESTART`, and a QUEUED one is cancelled (`runs.md` recovery, `composer-runtime.md` §4). So every run that executes passed the gate at its own start, in this daemon's life.

## 6. Policy and contracts

### 6.1 Rows

| Method | Tier | Trust before | Trust after | Project from |
|---|---|---|---|---|
| `axis.worktrees/1.create` | 2 | registry | **project** | request `projectId`, checked against the journal |
| `axis.worktrees/1.restoreFromRunBase` | 2 | registry | **project** | journal workspace |
| `axis.worktrees/1.discard` | 2 | registry | **project** | journal workspace |
| `axis.git/1.commit` | 2 | registry | **project** | journal workspace |
| `axis.git/1.push` | 4 | registry | **project**, gate after the confirmation | journal workspace |
| `axis.runs/1.start` | 2 | registry | **project** | journal workspace |
| `axis.cli-runs/1.start` | 2 | per-start | per-start, through `gate()` | journal workspace |

Ungated, unchanged:
- `worktrees.finalise` and `remove` (tier 4, with their own confirmation) only finish or remove a worktree. Every git call they make goes through the worktrees package's `HardenedGit` (hooks off, `core.fsmonitor=false`, refusing any command shape that could start a filter or an editor, `runsNoFilters`), so they run no repository code.
- `setUserEditing` changes a journal flag.

Gating them would only keep a user from cleaning up an untrusted project.

### 6.2 The main actions

They are not protocol methods; their weight is the dialog. `add` and `trust` are each a main-shown native confirmation, the tier 4 anchor outside the renderer (threat model assumption A10, item 8). `untrust` has no dialog.

### 6.3 `axis.projects/1`

Unchanged: `list` only, tier 0, `{ id, name, trusted }`.

## 7. The shell (direction C)

- **"Add project…"**, in the dashboard header and as the palette command `Axis: Add Project…`, with its keyboard hint shown next to it. Enabled when the window has a single folder that is not a managed worktree.
- **Project rows** show a glyph status with the state also in text:
  - "Read only" (untrusted), with **"Trust to run…"**;
  - "Trusted to run", with **"Stop trusting"** in the row's menu.
- The Restricted Mode banner of an untrusted worktree (policies §2) gets the same "Trust to run…" action.
- **No renderer decision card.** The decision is main's native dialog; a lifted card in the renderer would be a spoofable duplicate, and direction C keeps the lifted layer for pending agent decisions. While the dialog is open, the invoking control shows "Waiting for confirmation"; focus returns to it after.
- The outcome is announced once in the polite status region, in text. Each closed `outcome` has a fixed sentence; `not_a_repository` says to open the repository's own top folder, and `busy` and `expired` say to try again later.
- Keyboard: `Enter` on the focused action, the palette, and `J` / `K` across rows. No shortcut grants directly.

## 8. Threat model

**TRU-2 (amended):** "trusted" is T1 to T4 (§2).

| Attack | Result |
|---|---|
| A compromised renderer (EL-3) rewrites `content.trust.model.key` | T3 true, T1 false: untrusted. The model alone never yields `trusted: true`. |
| A compromised renderer asks main to register or trust a path | It cannot name one: main uses the window's own folder, and each grant needs the user's click in main's dialog. Re-prompting is bounded by one action per window, 6 a minute, a 60 s per-folder cooldown after Cancel, the shared queue and the 60 s TTL. |
| A renderer forges a daemon request to register or trust | No such method exists: `axis.projects/1` has none, and the control channel is main's. |
| A repository that arrives by archive or shared folder | **It cannot register or trust itself.** Nothing inside a repository decides registration or trust: no in-repository marker, and no config beyond the remote URLs shown. Registering needs the user's action plus main's dialog; trusting needs a second explicit choice. A repository unpacked under a trusted parent folder has T3 through inheritance but no record (T1): untrusted. |
| The trusted folder is swapped or moved, its `.git` is removed and recreated, or replaced by a symlink or a `gitdir:` file | T2 fails at the next gated call: the record drops (`binding_lost`), live runs stop, the call is refused. Re-trusting needs the dialog. |
| A run repoints its worktree's `.git` to another repository | The workspace binding fails: refused. |
| Inspection runs hostile config (`core.fsmonitor`, hooks, `core.sshCommand`, `include.path` to a FIFO, `protocol.*.allow=always` with a partial clone) | Repository test by `lstat` only. One `config --file --no-includes` read of a regular file, through the guarded runner with every pin and a 5 s timeout. |
| A misleading remote or path in the dialog | Escaped and bounded; user info, query and fragment removed. Lookalike hosts remain: the dialog shows the URL, it does not vouch for it. |
| A click landing on the grant button (§4.2) | Never the default; rate limit and cooldown. The residual is stated there. |
| A pre-v11 `trusted = 1` row | Reset by the migration; re-bound only through the dialog. |

**Residuals** (`threat-model-phase1-residual-register.md` RR-14, updated):
- A10 holds: a renderer that can write arbitrary files can edit the journal database itself, the power of a same-UID process (out of scope). The audit chain makes that tamper-evident, not impossible.
- **Point in time:** a path component swapped between T2 and git's use of the path is not caught (the DMN-2 known residual).
- **Rewritten in place:** a same-UID process that rewrites the contents of the bound `.git` directory itself (same inode) passes T2; this is A10, like the journal.
- Trust is per repository root, not per content: a pull or an extension's write inside a trusted repository does not reset it, as with Workspace Trust.

## 9. Tests and mutants

node:test only. The Electron-free cores live in `packages/daemon-host/src/main/` and `src/policy/`; the overlay keeps adapters, with `main-seam.test.mjs` pinning the wiring. Every test names the mutant it kills.

**S1a, journal:**
- v11 resets `trusted` and keeps the rows (mutant: no reset).
- `path` never changes; `common_dir` and `git_dir_id` are set once from NULL, then refused (mutants: trigger dropped; trigger forbids the first set).
- The common-dir unique index.
- **A legacy row re-binds** through `projects.trust` with `commonDir`, keeping its id and threads; a re-bind onto a `common_dir` another row holds is `E_CONFLICT`.
- `setProjectTrust` and registration write one row with actor `daemon` and the right action name, `register.trusted` vs `register.read_only` included (mutants: actor `user`; no row; a row on no change).

**S1a, daemon binding:**
- The four checks of §5.2, one refusal each: a symlinked path component, a `.git` symlink, a `gitdir:` file, a `commondir` file, a missing `HEAD`, `objects/` or `refs/` as a symlink, a foreign owner. On win32 (platform injected): `E_UNAVAILABLE`, never a pass (mutant: check 4 skipped off POSIX).
- The 2 s bound with a hung `lstat`.
- **T2 drops the record** for a swapped `.git`, a `.git` removed and recreated at the same path (new inode), and a `gitdir:` repoint (mutants: `binding_lost` not persisted; `git_dir_id` not compared).
- **A legacy row with a NULL `common_dir` fails T2** (mutant: NULL treated as a match).
- The workspace binding refuses a repointed worktree `.git` (mutant: check dropped).

**S1a, daemon inspection, with real git:**
- A hostile repository with `core.fsmonitor`, `core.sshCommand`, `include.path` to a FIFO, and `protocol.file.allow=always` in a partial clone. A marker program never runs, the FIFO config is refused before git, and an include FIFO is never opened (mutant: `--no-includes` dropped, killed by the timeout).
- Every pin is present (the guard test).
- **git's own startup with a hostile repository:** `config --file --no-includes` with `include.path` to a FIFO in `P/.git/config` and `core.fsmonitor` set, with a 5 s bound. It returns or times out, and no marker program runs. This answers whether git's startup reads the repository's own config with its includes.
- A config over 1 MiB, or a FIFO in its place, is refused before git runs (mutant: size check dropped).
- **The URL display form:** user info, query and fragment removed; control and bidirectional characters escaped; 192 bound (one mutant each).

**S1a, daemon registration:**
- Each refusal of §5.1, and `E_CONFLICT` for the path and for the common dir.
- **Archive repository at unit level:** a repository extracted under a folder the fake main trusts, never registered or registered without trust, is refused for commit, push, create and run start.

**S1b, the gate:**
- T1, T2, T3 and T4 each alone refuse; T3 silence and abort refuse (one mutant per condition).
- A port given no ticket, a spent ticket, an expired ticket (fake monotonic clock) or a ticket bound to another project or workspace refuses (mutants: ticket not checked; binding not compared). The port consumes the ticket before its pre-work.
- **The gate inside the mutex:** an untrust that lands while a commit waits for the project mutex refuses that commit (mutant: gate before the mutex).
- **T4 at the gate:** a registry revoke recorded during the push confirmation refuses the push (mutant: step 5 dropped).
- **The wire code, per path:** `commit`, `push`, `worktrees.create`, `restoreFromRunBase`, `discard`, `runs.start` and `cli-runs.start` each answer a gate refusal `E_CONFLICT` with reason `untrusted`, never `E_POLICY_DENIED` or `E_INTERNAL` (mutant: a handler passing the internal code through).
- **Untrust while the push dialog is open, then the push is refused** (mutant: gate before the confirmation). The tier 4 approval is spent at dispatch, before the handler (`packages/daemon/src/pipeline.ts` step 4), which the test relies on and pins.
- Mixed contracts: `axis.git/1` and `axis.worktrees/1` mark their gated handlers `projectGated()` and register marked and unmarked handlers in one call (mutant: a gated handler left unmarked, caught by coverage).
- Coverage: `checkCoverage({ gated })` is exit 70 for a gated row registered with an unmarked handler, and for a marked handler on a non-gated row; the `cli-runs` path is covered (mutant: coverage check removed).
- Policy ignores `identity.trusted` (mutant: read again).
- Revoke and `binding_lost` stop live runs (mutant: no stop).
- **The TRU-2 acceptance test:** model trusted, record false, untrusted end to end.

**S2, main:**
- The sender checks for `vscode:axisProjectAction`, one break case each.
- The strict payload: an extra field or a path is refused.
- Nonce reuse is harmless: a second answer needs a second click.
- The path comes from the window.
- Queue bounds: one open, 16 waiting, 60 s expiry, abort closes, a late click is ignored.
- Cancel is the default and cancel id (mutant: grant as default).
- The per-folder cooldown after Cancel and after expiry (mutant: no cooldown).
- "Add and trust" is absent, and `trust` refused, while the model does not trust the folder.
- `untrust` needs no dialog.
- The rate limit.
- **Archive repository at unit level:** a payload cannot name it, and the window's folder needs a click.

**S3, shell:**
- Enablement: a single folder, not a worktree.
- One sentence per outcome; focus returns; the status region announces once; no grant shortcut.
- As built: `services/projects/common` holds the request builder (`{nonce, action}` only), the closed outcome table and the one-at-a-time model. Only `electron-browser/axisProjectActionsIpc.ts` touches `ipcRenderer` (one send, no invoke). The three palette commands take no arguments. The dashboard banner covers only the local checkout at the window's single folder, and its button is never focused, clicked or made default by code. Run trust shows only when the data came from the daemon (PV-E0); otherwise it reads "Run trust unknown". Pinned by `test/code-oss/project-actions-renderer.test.mjs`.

**S4, evidence:**
- The `pty-exec-node.md` §8 driver: Add project with xdotool clicking the real dialog, Trust to run, create, commit, push to a local bare remote. Without the click the ref does not move.
- An archive repository under a trusted parent stays read-only.
- The default-button check on Linux.

## 10. Slices (one reviewable PR each, in order)

1. **S1a, daemon records (Opus review):**
   - migration v11 (set once) and `setProjectTrust`;
   - the binding of §5.2 and the inspection of §5.3;
   - the control messages and the registration checks.

   Nothing grants yet: every row keeps its current trust mode.
2. **S1b, daemon gate (Opus review):**
   - trust mode `project`, `requireProjectTrust` with T4 re-read, and `ProjectTrustTicket` at the ports;
   - `projectGated()` marking of the gated handlers and `checkCoverage({ gated })` (not a separate `registerProjectGated`: the mixed contracts register in one call);
   - the rows, `identity.trusted` dropped from policy, and stopping runs on a revoke.
3. **S2, main (Opus review):**
   - `vscode:axisProjectAction` and the dialogs on the shared queue, with the cooldown;
   - `trust.check` answered from `projectPath`, and `trustSource.projectPath` removed;
   - the overlay adapters and `main-seam.test.mjs`.
4. **S3, shell (Sonnet review):** the actions, the palette command, the row glyphs, the banner action and the announcements.
5. **S4, evidence:** the GUI driver run, closing the known gap in `pty-exec-node.md` §8. Docs and tests only.

## 11. Amendments made with this note

- `daemon-host.md`:
  - §6.2: the second mechanism becomes the `project` mode (T1 to T4), with the ticket at the side effect;
  - §7.4: inspection and the exact checks, and `projects.trust`.
- `main-answers.md` §3.3: the open item is answered by this design (built in S2); `trust.check` carries `projectPath`.
- ADR 0004 decision 12: a note that the "Trust to run" action also writes the main-confirmed record.
- `ROADMAP.md`, the Phase 1a "Trust enforcement" line: a rewritten Workspace Trust model alone never yields trusted.
- The threat model: the TRU-2 row and RR-14 point here. RR-17 is unchanged: the record's actor stays `daemon`.
