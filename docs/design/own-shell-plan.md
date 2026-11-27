# Own shell: ticket plan to the first demo and the Phase 1 slice

- **Status:** Proposed, with ADR 0011 (`docs/adr/0011-own-shell-ide-as-optional-feature.md`). Ticket ids start with `OS-` (shell, main and UI) and `DC-` (new daemon contracts) so they do not collide with `PV-`, `S`, `A` or `C` ids.
- **Goal:** the owner can click through a first own-shell demo as soon as possible. Then the Phase 1 slice (1a, 1b, 1c) is reached on the own shell, with the gate text re-stated in OS-23.
- **Sizes** (working days, building plus an ordinary review): S is 1 day; M is 2 to 4 days; L is 5 to 7 days. A ticket marked **Opus** touches a trust boundary and gets an Opus security review, which adds 1 to 3 days (two to four rounds). Every ticket goes through the usual loop: build, independent review, fixes, PR, merge. The estimates in §4 are sums of these sizes along the critical path.

## 1. Layout in the repository

```text
apps/desktop/
  main/        Electron main: window registry, app scheme, session hardening, preload, the adapters
               over packages/daemon-host/src/main/* (replaces code-oss/overlay/.../code/electron-main)
  preload/     the one fixed preload (connect, projectAction, terminalPort, openExternal)
  renderer/    the React app: core shell + built-in modules, one esbuild bundle with lazy chunks
packages/shell-sdk/    module manifest, activation context, intents (types and a tiny runtime)
packages/shell-core/   renderer-safe logic ported from the overlay (daemon client, reconnect, events, models)
packages/ui/           tokens (the single colour source), brand constants, primitives, icons
packages/ui-editor/    the Monaco editor kit (lazy), theme bridge, Trusted Types policy names
scripts/lint/          the import scanner and web/egress rules moved from scripts/code-oss/
```

The renderer packages import only `@axis/protocol`, each other and their pinned UI dependencies, never `node:*`. ADR 0005's package rules apply. New `docs/packages.md` rows and tsconfig references are added in alphabetical order.

## 2. Tickets in build order

### Wave A: skeleton and main (blocks everything visible)

| Id | Ticket | Size | Uses | Depends on |
|---|---|---|---|---|
| OS-1 | Scaffold `apps/desktop` and the four packages. Pin exact versions of Electron, React, React DOM, esbuild, Monaco and xterm.js; generate the notice file from the lockfile (including Chromium's licence file and the Apache-2.0 TypeScript compiler inside Monaco); wire build, typecheck and gate | M | gate, tsconfig | the owner-approved direction (master-master's decision under the owner's delegation; ADR 0011 itself is accepted only at G0) |
| OS-2 | **Opus.** Main window and session hardening: window registry, privileged app scheme `axis-app` (path-traversal-safe bundle root, MIME map), CSP and Trusted Types header, navigation and window-open denials, permissions denied except `clipboard-sanitized-write`, the `webRequest` scheme filter, G-28 refusal of debugging flags, the fixed preload and its source pin. `openExternal` (EL-5): main applies the `http`/`https`/`mailto` allow-list itself and draws the full-URL confirmation for every link that is not app-internal; the renderer's claim about a link's origin is ignored. Stable ids: `app.setName` and `app.setPath('userData')` with the internal id before `ready` | M | ADR 0003 D1.3 rules | OS-1 |
| OS-3 | **Opus.** Port main's seam: daemon supervisor start, `axis:connect` over our registry (`checkSender` unchanged in substance), answers (anchor, `native.confirm`, settings), pty supervisor and hand-over, the secret store, and the daemon and pty entry files moved out of the overlay. Rewrite of `axisMainSeam.ts`, `axisMainPorts.ts` and `axisMainPty.ts`, including the `dialog.showMessageBox`, `safeStorage`, `MessageChannelMain` and `utilityProcess.fork` calls. The window registry holds each window's project binding (ADR 0011 Decision 2: set by main only from its own picker or a daemon-confirmed project id, never authority for trust) and prunes rate buckets, in-flight actions, a waiting dialog, the binding and the status on `closed`. PV-D1-0's status answer carries the binding to the renderer. Native-dialog acceptance: Cancel is the default on every OS, focus returns to the window afterwards, one dialog per window, and closing the window cancels it. Main never destroys a GTK dialog's window from outside (that crashes Electron main); Linux tests without a window manager close dialogs with `WM_DELETE_WINDOW`. On macOS a dialog is a sheet per window | L | `daemon-host/src/main/*` | OS-2 |
| OS-3b | **Opus.** Main's project actions and trust without Code OSS. Add: main draws its own folder picker (`dialog.showOpenDialog`) inside `projectAction`, and the renderer never sends a path; then main runs inspect, its add dialog (which always offers "Add and trust to run", with the workbench wording gone) and register, and binds the window. Trust, Stop trusting and Status resolve from the window's binding; the binding comes from main's picker or from a renderer-chosen project id the daemon confirms. `connect-broker` drops `windowTrusted` and sends `trusted: false` (the wire field stays; no identity-schema change). `trust-model.ts`'s Workspace Trust reading goes. `trust.check` is answered as "window live and bound to this `projectId`", and main keeps no project store. The S1b gate's T3 input is redone, with tests and mutants proving that no renderer message alone trusts or binds a project | M | `project-actions.ts`, `answers.ts`, `connect-broker.ts`, `trust-model.ts`; `project-registration-and-trust.md` §2, §4 | OS-3 |
| OS-4 | Main settings store (user, application and machine scope; replaces `IConfigurationService.inspect`); native confirmation for `axis.cliAgents` changes; our own login-shell environment resolver for macOS PATH (replaces `getResolvedShellEnv`) | M | `settings-scope.ts` | OS-3 |
| OS-5 | Port the 27 `common/` modules to `@axis/shell-core`, with a small shim for each Code OSS primitive they import (`Emitter`, `Disposable`, `CancellationToken`, `localize`, DI; 26 of the 27 need one). Rewrite the harness of the 19 mocha TDD suites for `node:test`, keeping their assertions, fixtures and mutants. Covers the daemon client, reconnect, replies, event frames and subscription, event and refresh drivers, snapshot loader, workspace model, notices, approvals, project actions, changes model, ordered children, reveal input, view state, focus memory, side-panel rules | M | overlay `common/` files and tests | OS-1 (parallel with OS-2) |
| OS-5b | A fake daemon client in `@axis/shell-core`: recorded, schema-checked replies for every contract the demo uses, so OS-8 to OS-13 are built and reviewed in parallel with OS-2 and OS-3 and then switched to the real port. The fake is test and dev only, and a bundle check keeps it out of the production renderer | S | `@axis/protocol` schemas | OS-5 |
| OS-6 | Core frame: top bar, labelled navigation rail (direction C), router, notifications, tokens from `theme-axis` values. It also owns what Code OSS gave for free: a command registry, keybinding resolution (Cmd mapped to Ctrl on macOS), F6 region cycling, polite `aria` status announcements, roving tab stops, focus fallback and i18n (`localize`). Brand constants live in `@axis/ui` from the first commit, and main's dialog texts use them | L | `UX.md`, `ui/tokens.md` | OS-1 |
| OS-7 | Module system: manifest, registry, lazy `import()`, intents (`openFile`, `openDiff`, `openTerminal`), per-module contract allow-list in the client, settings to switch modules off; lint rule "the core imports no module" | M | ADR 0011 D3 | OS-6 |
| OS-20 | **First, before any renderer code:** port the renderer boundary pins (the daemon-call allow-list scanner `test/code-oss/daemon-call-rule.mjs`, "only one module opens the port", the project-action IPC pins) to the new renderer paths. They are renderer-agnostic and guard the new renderer from day one, and they replace what the PV-X3 overlay tests guarded. Then move the import scanner and web/egress rules to `scripts/lint/`, keep their `test/packages` runs; re-target `check-daemon-graph` to the new daemon bundle; add the renderer bundle-graph check (core chunk reaches no module chunk; renderer reaches no `node:*`); re-target the `test/code-oss` source pins to the new paths | M | `stage-ast.mjs`, `web-rules.mjs`, `egress-rules.mjs`, `egress-client-imports.mjs`, `check-daemon-graph.mjs` | OS-1 (pins), OS-7 (bundle check) |
| OS-27 | Secure storage: a development and CI keyring rig (a pinned user-space keyring under a private D-Bus session), the in-app "No secure storage: Axis is read only" state (degraded means no add or trust), a macOS Keychain denial read as degraded, and a pinned test of the data-directory derivation (`XDG_DATA_HOME` and `LOCALAPPDATA` move it) | M | OS-3 |

### Wave B: first demo (existing contracts only)

| Id | Ticket | Size | Contracts (all exist) | Depends on |
|---|---|---|---|---|
| OS-8 | Agent home v0: project list, workspaces, agents and groups, run status, needs attention, the not-connected, connecting, degraded and stopped states | M | `axis.projects/1`, `axis.worktrees/1` list/status, `axis.agents/1`, `axis.cli-runs/1`, `axis.composer-runs/1`, `axis.attention/1`, `axis.audit/1.status` | OS-5b and OS-6 (built on the fake); OS-3 to switch to the real port |
| OS-9 | Add project and trust UI: the buttons that ask main (`projectAction` with no path), Open project (a project id main confirms with the daemon), trust chips, "Untrusted: read only" copy. Main's dialogs are **not** unchanged: their changes are OS-3b | S | main project actions, `axis.projects/1` | OS-8, OS-3b |
| OS-10 | Workspaces: create (base branch, branch name), finalise and remove (tier 4, main's native dialog), the uncommitted-work refusal shown | M | `axis.worktrees/1` | OS-8 |
| OS-11 | Approvals: pending list and cards as core components; tier 1 to 3 resolved in the renderer, tier 4 and up routed to main's dialog, never labelled native below tier 4 | S | `axis.approvals/1` | OS-8 |
| OS-12 | Composer panel: Ask, Edit and Agent, model choice within the connection, activity stream from events, stop. Mock provider first, then Anthropic. Demo 1 runs it in a workspace OS-10 just created | M | `axis.composer-runs/1`, `axis.providers/1`, `axis.events/1` | OS-10, OS-11; Anthropic needs the vault key path (PV-N0 remaining slices, below) |
| DC-3b | **Opus. Moved into wave B (decided: the owner wants a terminal, and without it the own shell has none).** Main's pty-data broker to a window: the renderer asks with `terminalPort(nonce, terminalId)`, main checks the sender, and the daemon grants the id to the new `conn`. This takes over the rest of PV-X1b, whose Code OSS-side adapter stops | M | `pty-process` grant and attach | DC-3a, OS-3 |
| OS-16 | Terminal module (moved here from wave D; see there) | M | DC-3a, DC-3b | OS-7 |
| OS-13 | Changes module v0: file list, protected-path flags, whole-file view from `review.content`, commit of the full reviewed tree, push plan and push (tier 4), compare URL | M | `axis.review/1` diff/content, `axis.git/1` | OS-7, OS-10 |

**Demo 1 = OS-1 to OS-13 with OS-3b, OS-5b, OS-20, OS-27, DC-3a, DC-3b and OS-16:** open Axis, see projects and workspaces, add and trust a project, create a workspace, open a terminal in it, run the mock composer in Agent mode, approve a request, see the changed files, commit, push to a local bare remote. No file manager or hunks yet. Create workspace, the composer, approvals and commit and push have never existed in any GUI (the interim Code OSS demo has add and trust, Changes and diff, and a terminal), so this is new UI, not a port.

### Wave C: the missing daemon contracts (start in parallel with wave A)

| Id | Contract | Size | Notes | Blocks |
|---|---|---|---|---|
| DC-0 | **Opus.** Commit without touching the real index: `prepareCommit` (`review/src/binding.ts`) stops `read-tree`-ing the reviewed tree into `.git/index` and builds the commit through a private temporary index (`GIT_INDEX_FILE` in a daemon scratch directory). The H9-hooks step, when built, uses the same scratch context. Includes the follow-up decision on the real index after a commit (ADR 0011 Decision 3: leave it, or refresh only the entries still equal to the old HEAD entry, under `index.lock`) | M | Today a successful Axis commit replaces the user's `git add` staging [V] | OS-15; the 1a gate |
| DC-1 | **Opus.** `axis.files/1`: `list` (one directory, bounded, sorted, symlinks shown as links, never followed out of the worktree, FT-1), `stat`, `read` (bounded bytes, binary detection, escaped names; user principal only, never served to plugin views, composer runs or messages), then `write` (user principal, tier 2, only in a registered worktree of a trusted project, WT-1-style canonicalisation, marks a user edit for drift), `create`, `rename`, `delete` (tier 2, to a backup ref like `discard`; a recursive delete is capped by entry count and bytes). Reads stay allowed for an untrusted project | L | Reads first (DC-1a), writes after (DC-1b). Policy rows, coverage check, gate lines in the contract note | OS-14, OS-17 |
| DC-2 | **Opus.** `axis.review/1` additions: `hunks { workspaceId, fileId }` (from `@axis/review`'s `loadHunks`) and `build { workspaceId, head, selection: [{ fileId, whole } or { fileId, hunkIds }], acknowledged }`. `build` registers the built tree in the daemon's reviewed-tree registry, bound to workspace, head, branch and snapshot, so `axis.git/1.commit` accepts its `treeHash` as it accepts a `review.diff` one. It carries the per-file truncation acknowledgement (REV-1) for every included file, and returns the exact selection it built so the UI shows the set that produced the tree. Additive within major 1 | M | review-core already has per-hunk accept and build, and hunk ids are content-addressed; only the wire and the registration are missing ("no hunk API" in `review.ts`) | OS-15 |
| DC-3a | **Opus. Day 1.** `axis.terminals/1` in the daemon and pty process: `open { workspaceId }` for a plain terminal, `list`, `close`; `attach` for a CLI run's terminal; the grant to a named `conn`. Main's side is DC-3b (wave B), after OS-3 | M | `pty-process` already has `grant`, `attach`, credit flow and PTY-7 [V] | DC-3b, OS-16 |
| DC-4 | `axis.worktrees/1.discardHunks` (tier 2, backed up to a ref like `discard`) | M | after DC-2 | OS-15 (discard per hunk) |
| DC-5 | `axis.search/1`: bounded text search in a worktree, run in the daemon over git's file list, with no program spawned; caps on matches and time | M | | OS-17 (project search) |
| DC-7 | A `worktrees.list` row (or a project field) for the repository's own checkout, so the agent home can show the local checkout (a gap found in the interim demo) | S | | OS-8 |
| DC-6 | `files.changed` events for the tree and open buffers (the E1 family; the watcher only hints, a re-read decides, as for drift) | M | | OS-14 live refresh (polling works before it) |

### Wave D: the modules the owner asked for

| Id | Ticket | Size | Uses | Depends on |
|---|---|---|---|---|
| OS-18 | Editor kit: Monaco lazy chunk; workers bundled as files by esbuild and loaded from the app scheme, never `blob:`, tested under `worker-src 'self'`; the exact Trusted Types policy names at the pinned version listed in the CSP (no `'allow-duplicates'`), with a test that fails when an upgrade adds or renames one; token theme; one model per file per window; read-only mode; copy works with only `clipboard-sanitized-write` allowed | M | `@axis/ui-editor` | OS-2, OS-6 |
| OS-14 | Files module: lazy tree, open in a single-file viewer (editor kit), edit and save for trusted projects, read only for untrusted, create, rename, delete, "Open in code" intent | M | DC-1 | OS-7, OS-18, DC-1a (read), DC-1b (edit) |
| OS-15 | Changes module v1: **+ / -** per file and per hunk ("Staged for commit" and "Changes", with the note that this is not `git add`), Monaco diff view, discard per file and per hunk, commit of the built tree, showing exactly the set DC-2 built | M | DC-0, DC-2, DC-4, `axis.git/1` | OS-13, OS-18 |
| OS-16 | **Built in wave B.** Terminal module: xterm.js over the data port, splits, layout kept per workspace, attach to CLI runs, "not managed" never shown (all terminals are Axis-managed now), PTY-5 unchanged in the pty process | M | DC-3a, DC-3b | OS-7 |
| OS-17 | Code module (IDE view): tabs, split, find and replace, project search, go to line, outline, open at file:line from files and changes, return keeps buffers and selection (C1′) | L | DC-1, DC-5, editor kit | OS-14 |

**Demo 2 = demo 1 plus OS-14, OS-15, OS-17 and OS-18:** the file manager, + and - per file and hunk, CLI runs attached in terminals, and the code editor.

### Wave E: to the Phase 1 slice

| Id | Ticket | Size | Depends on |
|---|---|---|---|
| OS-19 | **Opus.** Security evidence on the own shell: Trusted Types smoke under the production CSP; ADR 0003 criteria 1 to 3 against our window (plugin view, second window, navigated and non-app frames refused); no listener; G-28; EL-5; renderer has no `node:*`, no fs and no network (bundle check plus a runtime probe) | M | OS-2, OS-3, OS-18 |
| OS-21 | Packaging per OS (signing on macOS later), and the packaged NET-GATE half re-done against this build (replaces `check-net-packaged.mjs`'s Code OSS assumption) | M | OS-3 |
| OS-24 | 1c UI on the own shell: All agents lanes (5, 20, 50), side panel with Agents and Code tabs (editor kit), New agent, groups, pull request section (`axis.forge/1`), usage (`axis.usage/1`) | L | OS-8, OS-14, OS-15 |
| OS-25 | Messaging, tasks and pages surfaces on the core shell (2a; contracts on main) | L | OS-8 |
| OS-26 | Mac run and evidence: all of the above on macOS, the Electron-only checks `main-answers.md` §5 lists as unverifiable on Linux, the first-use Keychain prompt, dialog sheets and focus, and the Cmd key mapping | M | OS-19, OS-21 |
| OS-23 | Docs: `ROADMAP.md` gate rewrite (ADR 0011 "Roadmap gate changes"), `PRODUCT.md`, `UX.md`, `ARCHITECTURE.md`, `LICENSING.md`, the threat model revision (new surfaces in ADR 0011 Decision 5 item 8) | M | ADR accepted; before the 1a gate review |
| OS-28 | Rebrand safety: the stable ids of ADR 0011 Decision 2 (app scheme, app name, `userData`, data roots, the `safeStorage` keychain entry, the anchor's location and tag, vault file names) live in one internal-id module that the brand module cannot import. An acceptance test changes only the display brand, then checks that the audit anchor and a vault entry still decrypt and that the renderer origin is unchanged | S | OS-3, OS-6 |
| OS-22 | Retire Code OSS: delete the overlay, patches, removals, replacements, the pin, the Code OSS scripts, the extension matrix and the overlay-tests CI job | S to M | G0 passed |

Composer prerequisites that already exist or are in flight and stay valid: PV-N0 (main secret broker; slice a merged, the rest open), C6 (vault wiring), the Anthropic adapter. The Anthropic part of OS-12 waits on them; the mock part does not.

## 3. Dependency picture

```text
OS-1 ─┬─ OS-20 (pins first)
      ├─ OS-2 ── OS-3 ─┬─ OS-3b ── OS-9
      │                ├─ OS-4, OS-27, OS-28
      │                └─ DC-3b ─┐   (DC-3a starts day 1)
      ├─ OS-5 ── OS-5b (fake) ─┐ │
      └─ OS-6 ── OS-7 ─────────┴─┴─ OS-8 ─┬─ OS-10 ─┬─ OS-12 (also OS-11)
                                          ├─ OS-11  └─ OS-13
                                          ├─ OS-16 (DC-3a, DC-3b)        => demo 1
                                          └─ OS-24, OS-25
DC-1a/b ─ OS-18 ─ OS-14 ─ OS-17 (+DC-5)
DC-0, DC-2 ─ DC-4 ─ OS-15 (after OS-13, OS-18)                          => demo 2
OS-19, OS-21 ─ OS-26 ;  OS-23 ;  G0 ─ OS-22
```

OS-15 sits behind the whole demo 1 chain through OS-13. Demo 2's other long chain is DC-1 then OS-14 then OS-17.

The DC tickets are daemon work in packages that already have builders and review history. They start on day 1, in parallel with wave A; DC-3a first, because demo 1 needs it. DC-3b is main-side and waits for OS-3, because it changes the files OS-3 rewrites.

## 4. Estimates (honest)

The assumptions, taken from the last month of tickets:
- three to five builders, shared with the daemon work that continues (egress N1e and N1f, K1e a2-1b, PV-M7, tasks 2b);
- the sizes in the header, with 1 to 3 days per Opus review (two to four rounds);
- about a day of GUI evidence per ticket that needs it (keychain, dialogs, window manager);
- no long builder stalls. The last two weeks had about two days of stalled builders, and a repeat adds directly to these numbers.

**The critical path to demo 1** is OS-1 (M, 2-4) + OS-2 (M+Opus, 3-7) + OS-3 (L+Opus, 6-10) + OS-8 (M, 2-4) + OS-11 (S, 1) + OS-12 (M, 2-4), which is **16 to 30 working days** if run in series. OS-10 runs beside OS-11. The fake client (OS-5b) lets OS-8 to OS-13 be built while OS-2 and OS-3 are in review, so the series shortens to OS-1, OS-2 and OS-3 plus about 4 to 6 days of integration on the real port. That is where the likely figure below comes from.

| Milestone | Likely | Range | What drives it |
|---|---|---|---|
| (i-0) **Fake-client milestone** (demo 1's screens clickable against OS-5b, labelled "recorded data, not connected") | **12 to 15 working days** | 10 to 18 | OS-6, OS-7 and the new UI; no Opus ticket on the path. It is not a demo of the product: nothing is added, trusted or run |
| (i) **Demo 1**, click-through on the real daemon (agent home, add and trust, workspaces, a terminal, mock composer, approvals, file-level changes, commit and push) | **15 to 22 working days** (about 3 to 4.5 weeks) | up to 30 working days in series | OS-2, OS-3, OS-3b and DC-3b (all Opus); all of the demo's UI is new; OS-6's keyboard and a11y services; the secure-storage rig (OS-27) before anything can be added or trusted |
| (i′) **Demo 2** (file manager, + and - per hunk, CLI runs in terminals, code editor) | **5 to 7 weeks** from the start | | DC-1 (L, Opus, two slices) then OS-14 then OS-17 (L); OS-15 waits on OS-13, DC-0, DC-2 and DC-4; Monaco under Trusted Types and the CSP (OS-18) |
| (ii) **Phase 1 slice** (1a, 1b and 1c gates re-stated and passing on the own shell, on macOS with Linux and Windows CI smoke) | **13 to 18 weeks** from the start | | OS-24 and OS-25 (both L), the Mac evidence (OS-26), packaging and NET-GATE (OS-21), the threat model revision, re-running every 1a to 1c gate line in a real GUI, and the Anthropic key path (PV-N0, C6). Daemon-side 1a to 1c work is largely merged, which is why this is not longer |

These are ranges, not commitments. The first draft said 7 to 10 days for demo 1, which assumed the demo's UI could be ported. It cannot: create workspace, the composer, approvals, and commit and push have never existed in any GUI. The biggest single risk is OS-3 meeting an Electron behaviour on macOS that the Linux package tests could not see. `main-answers.md` §5 lists the candidates.

## 5. What continues and what stops

**Continues unchanged (UI-agnostic):** every `packages/*` slice. That covers daemon-host, protocol, journal, broker, challenge, audit, review, git-ops, git-snapshot, worktrees, pty-process, pty-policy, providers, anthropic, vault, runs and secret-scan. In ticket terms: PV-N0 and N1 (secret broker, egress client, credential proxy), PV-N2a and b (main's device-code dialog is Electron main and carries over), PV-K (plugin grants, plugin-started runs, plugin view identities in main: placement moves to our layout regions), PV-M (messaging, CLI endpoint), PV-T (tasks), PV-Q (pages), PV-G (agents and groups), PV-D2 to D4 (forge, usage, attention), PV-X1a and X1w (pty exec in the packages; the rest of PV-X1b becomes DC-3b), H9-hooks, the C-series composer work, the deflake sweep and PV-X2 (file splits). PV-D1-0 (main's status answer carrying the window's project id) is main-side and is reused by OS-3.

**Stops now (Code OSS-only):**

- PV-V0 follow-ups (the Code OSS editor-in-part spike; the prototype stays as history), and PV-V2 and PV-V3 as Code OSS parts. They are re-cut as OS-24.
- PV-D1 slices after D1-0 as a Code OSS part (re-cut as OS-8 and OS-24).
- Project trust S3 follow-ups and S4's Code OSS GUI evidence run (re-done in OS-9 and OS-26).
- The remaining shell A-series on Code OSS: A5 follow-ups, A6 (shortcut check against the pin), A7 (working sets), folder-follows-focus and the criterion 1 smoke.
- ADR 0002 work: the upstream sync past 1.144, the extension compatibility matrix (M5), Open VSX signature verification, the reh-web web prototype (M6), further Copilot or agent-host removal patches, the footprint measurements and the `#private` mangling exemption.
- The Code OSS-side remainder of PV-X1b (the overlay adapter for main's pty-data broker); DC-3b builds it on the own shell.
- New overlay tests and patches. The PV-X3 overlay-tests job keeps running unchanged until OS-22, so the interim demo does not break silently.

The interim Code OSS shell stays buildable as a fallback demo until G0. Nothing is deleted before OS-22.

## 6. Open items

1. The real index after an Axis commit (DC-0's follow-up): leave it, or refresh only the entries that still equal the old HEAD entry. To be decided before the 1a gate.
2. Whether `axis.cliAgents` edits should need main's native confirmation (proposed in OS-4).
3. The pinned versions in OS-1, chosen to be at least two weeks old and checked against advisories on the day.

Decided in review 1: DC-1's `delete` is tier 2 with a backup ref and a cap on recursive deletes.
