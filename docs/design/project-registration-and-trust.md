# Project registration and the run-trust record

Status: design for review (security-relevant). Decided by `owner-decisions-2026-11-21.md` §5; this note specifies it and cuts the slices. Nothing here is built yet.

## 1. Why

`axis.projects/1` only lists, nothing in the app sends `projects.register`, and main's `trustSource` knows no project path, so `trust.check` is `false` for every project (`main-answers.md` §3.3). Worktree create, commit, push and every run start are therefore unreachable in the app. Two gaps have to close together:

- **Registration:** a path to the daemon's privileged git path. A folder the user merely browsed must never become a project.
- **Run trust:** the Workspace Trust model (`content.trust.model.key`) is written by renderers through the storage channel. `main-answers.md` §3.3 makes it a gate line that, before main registers projects, main owns the run-trust decision in a record renderers cannot write, set only from a prompt main shows.

Adopted unchanged: ADR 0004 decision 12 (Workspace Trust is inherited by worktrees and gates runs; re-derived at each mount and run start; main attests); `daemon-host.md` §6.2 (`trust.check` per run start) and §7.4 (main registers projects over the control channel, never a renderer request); `main-answers.md` §3.2 (the native dialog and its bounds).

## 2. The rule

A project is **trusted** for a call when **all** of these hold at that call:

| | Condition | Who checks | Writable by a renderer? |
|---|---|---|---|
| T1 | The journal's run-trust record for the project is `trusted` | daemon | no (§3) |
| T2 | The record's binding still holds: the project path is still a repository whose top level is that path, with the same git common directory (§5.3) | daemon | no |
| T3 | Main answers `trust.check` with `true`: the window is live in the broker's table and the project path is equal to or inside a folder the Workspace Trust model marks trusted | main | the model, yes: T3 alone never grants |
| T4 | No revoke for the window or workspace is recorded in the `TrustRegistry` (unchanged from §6.2) | daemon | no |

Default untrusted: a missing row, a record set `false`, a broken binding, no answer from main within 2 s, or any throw. A newly registered project is untrusted unless the user chose "Add and trust to run" in main's dialog (§4.2). Read-only surfaces work while untrusted: `worktrees.list` and `status`, `review.diff`, `content` and `complete`, `git.pushPlan` and `compareUrl`, and the shell's `IGitService` reads.

## 3. The record

**Store:** the journal's existing `projects.trusted` column (schema v4). The journal is the daemon's database; its writers are the daemon's handlers. No renderer method writes it. `axis.projects/1` stays read-only (§6.3), so the only writers of `projects.trusted` are two control messages, and only main writes the control channel (the daemon's parent port).

**Journal migration v11:**
- Adds `common_dir TEXT` (the canonical git common directory recorded at registration, §5.3) and `trust_changed_at TEXT`.
- **Sets every existing `trusted` to 0.** No row in the field was trusted through the dialog, because no writer existed: fail closed.
- Adds a trigger refusing a change of `path` or `common_dir` (a project keeps its binding; a moved repository is a new registration).

**Operations:** `registerProject` (exists; gains `commonDir`) and a new `setProjectTrust(id, trusted, reason)`. Each writes one audit row in the same transaction: `journal.project.register` (exists), `journal.project.trust` with `reason ∈ { "granted", "revoked", "binding_lost" }`. Actor `user` for `granted` and `revoked` (main relays the user's own dialog answer or gesture), `daemon` for `binding_lost`. A row whose value does not change writes nothing.

## 4. Main's side

### 4.1 The renderer's requests

The renderer sends main one IPC message, `vscode:axisProjectAction`, with `{ nonce, action }` and `action ∈ { "add", "trust", "untrust" }`. It carries **no path and no project id**.
- Main runs the `vscode:axisConnect` sender checks (`main-answers.md` §2: code window, workbench frame URL, main frame, not destroyed), in the same order.
- Main takes the folder from **that window's** opened workspace: a single-folder `file:` workspace, else refused `no_folder`.
- One action per window at a time (a second is refused `busy`) and at most 6 per minute per window.
- The answer is `vscode:axisProjectActionResult { nonce, outcome }` with a closed `outcome ∈ { added, added_read_only, trusted, untrusted, cancelled, expired, no_folder, not_a_repository, refused, busy, unavailable }`. It is display only and grants nothing.

The folder is mapped to a project by the daemon's answer to `projects.inspect` (§5.1): the registered project whose path is the folder's repository top level.

### 4.2 The dialogs

All of them go through the native confirmation queue of `main-answers.md` §3.2, sharing its bounds with `native.confirm`:
- one dialog open at a time;
- at most 16 waiting;
- 60 s from the request's arrival, measured on the monotonic clock: a waiting entry is answered `expired` without a dialog, and an open dialog's `AbortSignal` closes it and answers `expired`;
- a dialog port that throws is `cancelled`.

A late click is never applied. Cancel is the default and cancel button, with `noLink: true`. Every displayed value goes through `displayTextSchema` bounds, and paths are shown with control and bidirectional characters escaped (the review rule).

| Action | Shown when | Message | Detail | Buttons |
|---|---|---|---|---|
| `add` | the folder's top level is not registered | "Add this repository to Axis?" | Folder; repository root (the top level, which may differ from the folder); remote (`origin`'s URL with any user info removed, else the first remote, then "and N more", or "no remote"); and a fixed sentence that Axis will read its status and diffs, and that runs, commits and pushes need "Trust to run" | Cancel · Add read-only · Add and trust to run |
| `trust` | registered and untrusted | "Trust this repository to run?" | Repository root, remote, and a fixed sentence: "CLI and agent runs, commits and pushes will be allowed in its workspaces. Only trust code you know." | Cancel · Trust to run |
| `untrust` | registered and trusted | none: revoking only lowers privilege | | |

"Add and trust to run" is offered only when the Workspace Trust model trusts the folder **at that moment** (T3 at the time the dialog is shown). Otherwise the dialog's detail says so and offers only Cancel and Add read-only. If the model is later rewritten, T3 changes, but T1 does not. `trust` is refused `refused` while the model does not trust the folder, so the record is never set for a folder the user has not also trusted in the workbench.

### 4.3 What main sends

- **`add`:**
  1. `projects.inspect { requestId, path: folder }`, then the dialog with the inspected root and remote.
  2. On Add: `projects.register { requestId, path: root, commonDir, trusted }`, with `trusted` true only for "Add and trust to run".
- **`trust` / `untrust`:** `projects.trust { requestId, projectId, path: root, trusted }`. The daemon refuses a `projectId` whose path is not `path` (a stale or crossed mapping).
- **`trust.check` answer:** main answers T3 from the daemon-supplied `projectPath` (§5.2). `trustSource.projectPath` goes away. Main keeps no project map of its own: its only persistent store, application storage, is the renderer-writable one this design avoids.

## 5. The daemon's side

### 5.1 Control messages (supervisor to host, `control/messages.ts`)

| Message | Fields | Reply |
|---|---|---|
| `projects.inspect` | `requestId, path` (absolute, normalised) | `projects.inspected { requestId, ok: true, root, commonDir, registered?: { projectId, trusted }, remote: { name, url } \| null, remotes } \| { ok: false, code }` |
| `projects.register` (amended) | `requestId, path, commonDir, trusted` | `projects.result` (exists) |
| `projects.trust` (new) | `requestId, projectId, path, trusted` | `projects.result { ok: true, projectId } \| { ok: false, code }` |
| `trust.check` (amended, host to supervisor) | `requestId, windowId, workspaceId?, projectId, projectPath` | `trust.result` (unchanged) |

`workspaceId` becomes optional, because `worktrees.create` has no workspace yet. Main never read it.

**Inspection runs git in the daemon context through `@axis/git-ops`**, with the pinned hardened options: `core.hooksPath` off, `core.fsmonitor=false`, `protocol.allow=never`, no pager, no replace objects. That makes reading an untrusted repository's config run none of its code. The commands are `rev-parse --show-toplevel --git-common-dir` and `config --get-regexp ^remote\..*\.url$`, nothing else. Remote URLs are display text only: user info and query are removed, the result is bounded to 192 characters, and never used to fetch.

### 5.2 Registration checks (`daemon-host.md` §7.4 made exact)

`projects.register` is refused `E_INVALID_ARGUMENT` unless all of the following hold, re-derived by the daemon at the message, never taken from main's earlier inspection:
- `path` equals `realpath(path)` and is the repository's top level;
- `commonDir` equals the re-derived canonical common directory;
- the path is not equal to, inside, or containing the Axis data root, the worktree root, or a registered project's path.

Refused `E_CONFLICT` if the path or common directory is already registered. The display name is derived from the folder name (exists).

### 5.3 The trust gate

A new policy trust mode, **`project`**, replaces `registry` on every row that used it (§6.1). Policy checks T4 synchronously, as today. The handler calls **one** gate, `requireProjectTrust({ projectId, windowId, workspaceId?, signal })`, immediately before its side effect and inside the project mutex where the handler holds one. The gate:
1. reads the project row: no row, or `trusted` false, is `E_POLICY_DENIED` with `reason: "untrusted"` (T1);
2. re-derives top level and common directory with the hardened inspection. A mismatch, or a path that is no longer a repository, sets the record `false` with `binding_lost` (audited) and refuses (T2);
3. sends `trust.check` with the row's path and refuses on `false`, silence (2 s) or abort (T3).

`cli-runs.start` keeps its `per-start` mode and its single-use attestation. Its existing `trust.check` call is replaced by the same gate, so a run start now also needs T1 and T2.

`identity.trusted` (the connect-time model reading) is **no longer read by policy**. It reflected only the renderer-writable model, once per connection; T3 replaces it per call. The field stays on the identity for wire compatibility. Main sends no `trust.set` grants; revokes through the registry keep working (T4).

**Coverage, structural:** a handler for a `project` row can only be registered through `registrar.registerProjectGated(method, resolveProject, handler)`, which runs the gate before calling the handler. `checkCoverage` fails the start (exit 70, before `ready`) if a `project` row was registered plainly, or a gated registration names a row that is not `project`.

## 6. Policy and contracts

### 6.1 Rows

| Method | Tier | Trust before | Trust after | Project from |
|---|---|---|---|---|
| `axis.worktrees/1.create` | 2 | registry | **project** | request `projectId` |
| `axis.worktrees/1.restoreFromRunBase` | 2 | registry | **project** | journal workspace |
| `axis.worktrees/1.discard` | 2 | registry | **project** | journal workspace |
| `axis.git/1.commit` | 2 | registry | **project** | journal workspace |
| `axis.git/1.push` | 4 | registry | **project** (and its native confirmation, unchanged) | journal workspace |
| `axis.runs/1.start` | 2 | registry | **project** | journal workspace |
| `axis.cli-runs/1.start` | 2 | per-start | per-start, now through the gate | journal workspace |

Every other row is unchanged. The project id always comes from the journal, or for `create` from the request and then checked against the journal; never a path.

### 6.2 Tiers of the main actions

The main actions are not protocol methods; their weight is the dialog.
- `add` and `trust` are each a main-shown native confirmation: the tier 4 anchor, outside the renderer (threat model assumption A10, item 8).
- `untrust` has no dialog: it only removes privilege.

### 6.3 `axis.projects/1`

Unchanged: `list` only, tier 0, answering `{ id, name, trusted }`. Its header comment (no write method) stays true. The shell learns the folder's state from the action result and from `list`.

## 7. The shell (direction C)

- **"Add project…"**, in the dashboard header and as the palette command `Axis: Add Project…`, shows its keyboard hint next to the control. It is enabled when the window has a single folder that is not a managed worktree.
- **Project rows** show a glyph status, with the state also in text:
  - "Read only": untrusted. The row offers **"Trust to run…"**.
  - "Trusted to run": the row's menu offers **"Stop trusting"**.
- The Restricted Mode banner of an untrusted worktree (policies §2) gets the same "Trust to run…" action.
- **No renderer decision card for these actions.** The decision is main's native dialog: a lifted card in the renderer would be a spoofable duplicate of it, and direction C keeps the lifted layer for pending agent decisions. While the dialog is open, the invoking control shows "Waiting for confirmation". Focus returns to it afterwards.
- The outcome is announced once in the shell's polite status region, in text. Every closed `outcome` has a fixed sentence; `expired` and `busy` say to try again.
- Keyboard: `Enter` on the focused action, the palette command, and `J` / `K` across rows. No shortcut triggers a grant directly.

## 8. Threat model

**TRU-2 (amended):** "trusted" is T1 to T4 (§2). Mitigations:

| Attack | Result |
|---|---|
| A compromised renderer (EL-3) rewrites `content.trust.model.key` to trust a folder | T3 true, T1 false: still untrusted. The model alone never yields `trusted: true` (tested). |
| A compromised renderer asks main to register or trust a path | It cannot name one. Main uses its window's opened folder, and each grant needs the user's click in main's dialog. Spam is bounded: one action per window, 6 per minute, the shared queue, 60 s. |
| A renderer forges a daemon request to register or trust | There is no such method: `axis.projects/1` has none, and the control channel is main's alone. |
| A repository that arrives by archive or shared folder | **It cannot register or trust itself.** Nothing inside a repository is read to decide registration or trust (no in-repository marker is honoured). Registering needs a user action in the shell plus main's dialog naming its root. Trust needs a second explicit choice. A repository unpacked inside an already trusted parent folder inherits Workspace Trust (T3) but has no record (T1): untrusted. |
| The trusted repository is replaced (folder swapped, moved, or `.git` repointed) | T2 fails at the next gated call: the record drops to `false` (audited `binding_lost`) and the call is refused. Re-trusting needs the dialog. |
| Inspecting a hostile repository runs its config (`core.fsmonitor`, hooks, `core.sshCommand`) | Hardened daemon-context git only, no network, and only `rev-parse` and `config --get-regexp`. |
| A misleading remote or path in the dialog (control, bidi or lookalike characters) | Escaped and bounded; user info stripped. Lookalike hosts are a residual: the dialog shows the URL, it does not vouch for it. |
| A symlinked folder | Stored and shown as its real path; `path` must equal `realpath(path)`. |
| A pre-existing `trusted = 1` row | Reset by migration v11. |

**Residuals (`threat-model-phase1-residual-register.md` RR-14, updated):**
- A10 still holds. A renderer that can write arbitrary files can edit the journal database itself, the same power as a same-UID process (out of scope). The audit chain makes that tamper-evident, not impossible.
- A revoke does not stop a running run (plan question 6, unchanged).
- Trust is per repository root, not per content: changes inside a trusted repository (a pull, an extension's write) do not reset it, exactly like Workspace Trust.

## 9. Tests and mutants

node:test only; Electron-free cores in `packages/daemon-host/src/main/` and `src/policy/`; the overlay keeps only adapters (`main-seam.test.mjs` pins the wiring).

| Slice | Tests (each paired with a mutant that must be killed) |
|---|---|
| S1 journal | Migration v11 resets `trusted` and keeps rows (mutant: no reset). The trigger refuses a path or common-dir change (mutant: trigger dropped). `setProjectTrust` audits exactly once, nothing on no change (mutants: no audit row; audit on no change). |
| S1 daemon | `projects.inspect` uses the hardened args and only the two commands (mutant: `core.fsmonitor` dropped, caught by the args guard test). Register refuses not-top-level, symlink spelling, inside or containing the data root, worktree root or a registered project, and a common-dir mismatch (one mutant per check). The gate refuses each of T1, T2, T3 alone, and T3 silence or abort (mutants: each condition dropped; T2 not persisting `binding_lost`). The rows table (mutant: commit back to `registry`). Coverage refuses a plainly registered `project` row (mutant: coverage check removed). `identity.trusted` is ignored (mutant: read again). |
| S2 main | The sender checks for `vscode:axisProjectAction` (one break case each). The path comes from the window, never the payload (a payload with a path is refused). The dialog queue bounds: one open, 16 waiting, 60 s expiry, abort closes, a late click is ignored. "Add and trust" is absent while the model does not trust the folder. `trust` is refused then. **The model rewritten to trusted, with record false, answers untrusted end to end** (the TRU-2 acceptance test). `untrust` needs no dialog. Rate limit. |
| S3 shell | Action enablement (single folder, not a worktree); outcome sentences per closed outcome; focus return; status-region announcement once; no grant shortcut. |
| S4 evidence | The `pty-exec-node.md` §8 driver: Add project (xdotool on the real dialog), Trust to run, create, commit, push to a local bare remote. Without the click the remote ref does not move. An archive-extracted repository under a trusted parent stays read-only. |

## 10. Slices (one reviewable PR each, in order)

1. **S1 daemon:** migration v11 and `setProjectTrust`; the control messages (`projects.inspect`, amended `projects.register`, `projects.trust`, `trust.check` with `projectPath`); the registration checks; trust mode `project`, `requireProjectTrust` and `registerProjectGated`; the rows; `identity.trusted` dropped from policy. Opus review.
2. **S2 main:** `vscode:axisProjectAction`, the dialogs on the shared queue, `trust.check` answered from `projectPath`, `trustSource.projectPath` removed; overlay adapters and `main-seam.test.mjs`. Opus review.
3. **S3 shell:** the actions, palette command, row glyphs, banner action and announcements. Sonnet review.
4. **S4 evidence:** the GUI driver run and the `pty-exec-node.md` §8 known gap closed. Docs and test only.

## 11. Amendments made with this note

- `daemon-host.md` §6.2: the second mechanism becomes the `project` mode (T1 to T4). §7.4: inspection, the exact checks, and `projects.trust`.
- `main-answers.md` §3.3: the open item is answered by this design (built in S2); `trust.check` carries `projectPath`.
- ADR 0004 decision 12: a note that the "Trust to run" action also writes the main-confirmed record.
- `ROADMAP.md` Phase 1a "Trust enforcement": a rewritten Workspace Trust model alone never yields trusted.
- Threat model: the TRU-2 row and RR-14 point here.
