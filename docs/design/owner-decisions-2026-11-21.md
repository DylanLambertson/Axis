# Owner decisions, 2026-11-21

**Status:** decided. The owner delegated every open decision to the project lead on 2026-11-21 so that development could continue ("act on my behalf to keep this project going"). Each decision below takes the recommended default of the document that raised it, **unless its row says otherwise**. The owner can reverse any of them at any time; a reversal is a new row in this file and the documents it names are amended then. Where a choice existed, the more conservative one was taken, and section 5 adds to an already decided trust model and weakens none of it.

Document names are written out in full in every row, because the same id can exist in more than one document (extensibility D-10, D-12 and D-13 are different rows from `axis-agent-shell.md` D-10, D-12 and D-13).

## 1. Product vision v2 (`product-vision-v2.md` §7)

| # | Decision | Taken |
|---|---|---|
| O-1 | Name of the top container | **Space**. "Workspace" keeps meaning one agent worktree. |
| O-2 | One repository or several per project | **One** in Phase 1c. Multi-repository projects later, with a design. |
| O-3 | Agent to workspace | **One home workspace per agent**; attaching several agents to one workspace only by explicit user choice. |
| O-4 | Agents without a workspace | **Not in 1c**; revisit with the Phase 3 planner. |
| O-5 | PR data source | The user's `gh`, read-only, **no stored token**. A vault-token GitHub integration only in 4a, and only if extensibility D-9 is reversed. |
| O-6 | Plugins before Phase 3 | **No (this row differs from the source's wording).** The source default says declarative and sandboxed-UI plugins "may move to 2a if wanted"; the choice taken is that they stay in 4a, matching extensibility D-1. Code-running plugins only after the OS sandbox. |
| O-7 | Insert Phase 1c and split 2 and 4 | **Yes.** |
| O-8 | Side-panel editor scope | **Quick edits only** (§3.5 rule 4); fall back to the IDE split half if the PV-V0 spike exceeds the footprint budget. |

## 2. UI direction (`ui/directions.md` §7)

**Direction C** (calm and precise: timeline axis, glyph statuses, keyboard, lifted decisions). Two elements of direction B (the workspace spine, the activity trace) stay candidates for a later density setting.

## 3. Inter-agent messaging (`inter-agent-communication.md` M-1 to M-11)

All recommended defaults:

- **M-1** cross-group messaging inside a project: off (per pair or per project, user tier 2).
- **M-2** taint rule IAC-T: on, not disableable, over the closed source list in §6.6.
- **M-3** CLI entries that bypass the CLI's prompts: refused; warn and require a second confirmation when a known CLI project-config file exists in the worktree.
- **M-4** wake on message: not in 2a.
- **M-5** CLI participation in 2a: yes, after composer-to-composer, only with the endpoint bounds, token rules and escaping built (PV-M6, PV-M7).
- **M-6** secret scan mode on messages: `refuse`; `warn` only when every recipient is a composer agent or the user.
- **M-7** retention of message bodies: 30 days, user-configurable; audit keeps keyed hashes.
- **M-8** plugins as senders: only with `messages.send`, only to the user and threads the user added the plugin to.
- **M-9** thread model: participant set fixed at creation, grows by user action or a policy-allowed recipient; invisible means `not_found`.
- **M-10** queue full: per-sender quota, refuse new messages, never drop user or system messages.
- **M-11** rendering: escaped plain text in the thread view; Markdown only in the isolated page frame.

## 4. Extensibility (`extensibility.md` §11, rows D-1 to D-14; not `axis-agent-shell.md`)

All recommended defaults:

- **extensibility D-1** P0 declarative plugins early: no; pages and tasks native in 2a, the plugin system in 4a.
- **D-2** P2 process plugins before the OS sandbox: not before Phase 3; MCP servers the user adds are disclosed as running as the user.
- **D-3** plugin source: local file and an Axis-curated list signed by an app-embedded key **with rollback protection**; no public registry in v1.
- **D-4** signature policy: Ed25519 publisher signatures required for the curated list (keys come from the signed list); unsigned local files only for P0 and P1, with a warning and hash pinning; never for P2.
- **D-5** page storage: Axis data directory per project, with Export to repository.
- **D-6** page format: Markdown subset only in v1, **rendered in the isolated page view**.
- **D-7** OAuth redirect: device-code flow with a main-built code dialog; a one-shot loopback listener only as a recorded NET-1 exception when a service lacks it.
- **D-8** first integration: GitHub read-only through the user's `gh`, no token (ticket PV-D2); a token-based GitHub integration (ticket PV-N3) only if D-9 is reversed.
- **D-9** reverse "Axis stores no forge credentials" (ADR 0004 decision 9): **keep** it until 4a, then a vault-held read-only fine-grained token behind the credential proxy.
- **D-10** integrations that write: each write operation is its own permission and a tier-3 challenge.
- **D-11** inbound webhooks: not on desktop; polling only.
- **D-12** P1 host process model: one sandboxed `WebContentsView` per plugin with a main-attested identity.
- **D-13** page rendering: isolated view without a bridge port; raster attachments only.
- **D-14** system proxy for integration traffic: ignored in 4a; a proxy option needs its own design.

## 5. Project registration and workspace trust (raised 2026-11-21 03:50)

**Finding:** `axis.projects/1` only lists, `projects.register` is never sent by the app, and `trust.check` is false for every path, so commit and push (tiers 2 to 4) are unreachable in the app. The design already decides most of the model; this section adopts it and fills the one gap it names.

**Adopted as decided, unchanged:**

- ADR 0004 decision 12: Workspace Trust is inherited by a worktree, and **Workspace Trust gates runs**; trust is re-derived at each mount and at each run start; the main process attests the trust state on the window-verified run-start call and the daemon requires it; a renderer claim alone never gates a run.
- `daemon-host.md` §6.2 and §7.4: `trust.check` per run start, and projects registered by **main** over the control channel (`projects.register { path, trusted }`), never by a renderer request.
- `main-answers.md` §3.3 and its gate line: the Workspace Trust model (`content.trust.model.key`) is renderer-writable, so before main registers projects it must own the run-trust decision in a record renderers cannot write, set only from a prompt main shows.

**Decided now (the gap):**

| Question | Taken |
|---|---|
| What "trusted" means for `trust.check` and for commit and push | **Both**: the folder is trusted in the Workspace Trust model (decision 12, unchanged) **and** a main-owned run-trust record says so. The record lives where renderers cannot write it (the journal, written through main), and a renderer-writable model alone never answers `trusted: true`. |
| How the record is set | Only from a **native dialog main shows** (the "Trust to run" action), naming the folder; never from a renderer message or a renderer-claimed result. The same prompt is the user-only, audited mark-trusted step. |
| How a project is registered | By main, from the folder a window opened, **after the trust decision and a main-shown confirmation** of the folder, its repository root and its remote (explicit). Opening a folder in the Code OSS workbench alone registers nothing. An untrusted folder may be registered with `trusted: false` so that read-only surfaces (status, diff, review) work; it cannot start a run, commit or push. |
| Default | Untrusted. Fail closed; `trust.check` stays `false` until both conditions hold. |

**Amendments this implies (done by the design ticket, not here):** `daemon-host.md` §6.2 and §7.4 (the `trust.check` answer is Workspace Trust **and** the main-owned record), `main-answers.md` §3.3 (the open item becomes built), ADR 0004 decision 12 (a note that the "Trust to run" action also writes the record), and `docs/ROADMAP.md` Phase 1a "Trust enforcement". A repository that arrives by archive or shared folder cannot register or trust itself: the design must say why and test it.

**Unblocks:** the main-side registration and trust-record slice (a ticket cut from the design note), then the commit and push path in the app.

## 6. Windows (`pty-exec-windows.md` §8, open questions 1 to 5)

| Item in §8 | Taken |
|---|---|
| 1. The five spike items (§6) | Not decided here; they stay the first work of the Windows helper ticket. |
| 2. Daemon runner's Windows policy before slice 2 | **Refuse daemon-context git on Windows** until the helper (slice 2) exists. No kill gap is accepted. |
| 3. Who holds the Authenticode key, and how main verifies the signature | The key is held by the owner (or a CI secret the owner creates); **the helper is not shipped until the owner provides one**. Main verifies the helper's Authenticode signature and refuses to spawn it on any failure; the expected publisher is pinned in the app. Until then Windows builds run without the helper and with daemon-context git refused. |
| 4. Minimum Windows version | **Windows 10 or Server 2016** (`JOB_LIST`); older versions refused. |
| 5. Exit-code and signal mapping | Confirmed as written in §3. |
| Packaging ADR (gating the daemon and pty process in built builds) | **Deferred**; built builds keep refusing to start them until it is written. No packaged build is planned before 1a completes. |

## 7. What these decisions unblock

PV-R1 (ADR 0006) and the docs wave PV-R2, PV-R3 and PV-R7; then PV-G1 (journal migration), PV-D1 to PV-D4 (project home), PV-V0 to PV-V4 (agent view), PV-M4 to PV-M8 (messaging), PV-T, PV-Q, PV-K and PV-N as their dependencies land; and the project registration and trust slice in §5.
