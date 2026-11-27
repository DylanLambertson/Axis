# Own shell: ticket plan to the first demo and the Phase 1 slice

- **Status:** Proposed, with ADR 0011 (`docs/adr/0011-own-shell-ide-as-optional-feature.md`). Ticket ids start with `OS-` (shell, main and UI) and `DC-` (new daemon contracts) so they do not collide with `PV-`, `S`, `A` or `C` ids.
- **Goal:** the owner can click through a first own-shell demo as soon as possible. Then the Phase 1 slice (1a, 1b, 1c) is reached on the own shell, with the gate text re-stated in OS-23.
- **Sizes:** S is up to a day of building plus review; M is 2 to 4 days; L is about a week or more. Every ticket goes through the usual loop: build, independent review, fixes, PR, merge. Tickets marked **Opus** touch a trust boundary and get an Opus security review.

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
| OS-1 | Scaffold `apps/desktop` and the four packages. Pin exact versions of Electron, React, React DOM, esbuild, Monaco and xterm.js; generate the notice file from the lockfile; wire build, typecheck and gate | M | gate, tsconfig | ADR 0011 accepted as direction |
| OS-2 | **Opus.** Main window and session hardening: window registry, privileged app scheme (path-traversal-safe bundle root, MIME map), CSP and Trusted Types header, navigation, window-open and permission denials, the `webRequest` scheme filter, G-28 refusal of debugging flags, the fixed preload and its source pin | M | ADR 0003 D1.3 rules | OS-1 |
| OS-3 | **Opus.** Port main's seam: daemon supervisor start, `axis:connect` over our registry (`checkSender` unchanged in substance), answers (anchor, `native.confirm`, `trust.check` without Workspace Trust, settings), pty supervisor and hand-over, project actions, the secret store. Rewrite of `axisMainSeam.ts`, `axisMainPorts.ts` and `axisMainPty.ts` only | L | `daemon-host/src/main/*` unchanged | OS-2 |
| OS-4 | Main settings store (user, application and machine scope; replaces `IConfigurationService.inspect`); native confirmation for `axis.cliAgents` changes; our own login-shell environment resolver for macOS PATH (replaces `getResolvedShellEnv`) | M | `settings-scope.ts` | OS-3 |
| OS-5 | Port the renderer logic to `@axis/shell-core` with `node:test`: daemon client, reconnect, replies, event frames and subscription, event and refresh drivers, snapshot loader, workspace model, notices, approvals, project actions, changes model, ordered children, reveal input, view state, focus memory, side-panel rules | M | overlay `common/` files and tests | OS-1 (parallel with OS-2) |
| OS-6 | Core frame: top bar, labelled navigation rail (direction C), router, command palette, notifications, focus and announcement rules, tokens from `theme-axis` values, brand constants in one place | M | `UX.md`, `ui/tokens.md` | OS-1 |
| OS-7 | Module system: manifest, registry, lazy `import()`, intents (`openFile`, `openDiff`, `openTerminal`), per-module contract allow-list in the client, settings to switch modules off; lint rule "the core imports no module" | M | ADR 0011 D3 | OS-6 |
| OS-20 | Move the import scanner and web/egress rules to `scripts/lint/`, keep their `test/packages` runs; re-target `check-daemon-graph` to the new daemon bundle; add the renderer bundle-graph check (core chunk reaches no module chunk; renderer reaches no `node:*`); re-target the `test/code-oss` source pins to the new paths | M | `stage-ast.mjs`, `web-rules.mjs`, `egress-rules.mjs`, `egress-client-imports.mjs`, `check-daemon-graph.mjs` | OS-1, OS-7 |

### Wave B: first demo (existing contracts only)

| Id | Ticket | Size | Contracts (all exist) | Depends on |
|---|---|---|---|---|
| OS-8 | Agent home v0: project list, workspaces, agents and groups, run status, needs attention, the not-connected, connecting, degraded and stopped states | M | `axis.projects/1`, `axis.worktrees/1` list/status, `axis.agents/1`, `axis.cli-runs/1`, `axis.composer-runs/1`, `axis.attention/1`, `axis.audit/1.status` | OS-3, OS-5, OS-6 |
| OS-9 | Add project and trust: the buttons that ask main (`projectAction`); main's dialogs are unchanged; trust chips; "Untrusted: read only" copy | S | main project actions (S2), `axis.projects/1` | OS-8 |
| OS-10 | Workspaces: create (base branch, branch name), finalise and remove (tier 4, main's native dialog), the uncommitted-work refusal shown | M | `axis.worktrees/1` | OS-8 |
| OS-11 | Approvals: pending list and cards as core components; tier 1 to 3 resolved in the renderer, tier 4 and up routed to main's dialog, never labelled native below tier 4 | S | `axis.approvals/1` | OS-8 |
| OS-12 | Composer panel: Ask, Edit and Agent, model choice within the connection, activity stream from events, stop. Mock provider first, then Anthropic | M | `axis.composer-runs/1`, `axis.providers/1`, `axis.events/1` | OS-11; Anthropic needs the vault key path (PV-N0 remaining slices, below) |
| OS-13 | Changes module v0: file list, protected-path flags, whole-file view from `review.content`, commit of the full reviewed tree, push plan and push (tier 4), compare URL | M | `axis.review/1` diff/content, `axis.git/1` | OS-7, OS-10 |

**Demo 1 = OS-1 to OS-13 with OS-20:** open Axis, see projects and workspaces, add and trust a project, create a workspace, run the mock composer in Agent mode, approve a request, see the changed files, commit, push to a local bare remote. No file manager, hunks or terminal yet.

### Wave C: the missing daemon contracts (start in parallel with wave A)

| Id | Contract | Size | Notes | Blocks |
|---|---|---|---|---|
| DC-1 | **Opus.** `axis.files/1`: `list` (one directory, bounded, sorted, symlinks shown as links, never followed out of the worktree, FT-1), `stat`, `read` (bounded bytes, binary detection, escaped names), then `write` (user principal, tier 2, only in a registered worktree of a trusted project, WT-1-style canonicalisation, marks a user edit for drift), `create`, `rename`, `delete` (to a backup ref like `discard`, tier 2) | L | Reads first (DC-1a), writes after (DC-1b). Policy rows, coverage check, gate lines in the contract note | OS-14, OS-17 |
| DC-2 | **Opus.** `axis.review/1` additions: `hunks { workspaceId, fileId }` (from `@axis/review`'s `loadHunks`) and `build { workspaceId, head, selection: [{ fileId, whole } or { fileId, hunkIds }] }` returning a `treeHash` that `axis.git/1.commit` takes unchanged. Additive within major 1 | M | review-core already has per-hunk accept and build; only the wire is missing ("no hunk API" in `review.ts`) | OS-15 |
| DC-3 | **Opus.** `axis.terminals/1`: `open { workspaceId }` for a plain terminal, `list`, `close`; `attach` for a CLI run's terminal; main's pty-data broker to a window (the PV-X1b remainder): the renderer asks with `terminalPort(nonce, terminalId)`, main checks the sender, the daemon grants the id to the new `conn` | L | `pty-process` already has `grant`, `attach`, credit flow and PTY-7 [V] | OS-16 |
| DC-4 | `axis.worktrees/1.discardHunks` (tier 2, backed up to a ref like `discard`) | M | after DC-2 | OS-15 (discard per hunk) |
| DC-5 | `axis.search/1`: bounded text search in a worktree, run in the daemon over git's file list, with no program spawned; caps on matches and time | M | | OS-17 (project search) |
| DC-6 | `files.changed` events for the tree and open buffers (the E1 family; the watcher only hints, a re-read decides, as for drift) | M | | OS-14 live refresh (polling works before it) |

### Wave D: the modules the owner asked for

| Id | Ticket | Size | Uses | Depends on |
|---|---|---|---|---|
| OS-18 | Editor kit: Monaco lazy chunk, workers as bundled files, the exact Trusted Types policy names at the pin added to CSP, token theme, one model per file per window, read-only mode | M | `@axis/ui-editor` | OS-2, OS-6 |
| OS-14 | Files module: lazy tree, open in a single-file viewer (editor kit), edit and save for trusted projects, read only for untrusted, create, rename, delete, "Open in code" intent | M | DC-1 | OS-7, OS-18, DC-1a (read), DC-1b (edit) |
| OS-15 | Changes module v1: **+ / -** per file and per hunk ("Staged for commit" and "Changes", with the note that this is not `git add`), Monaco diff view, discard per file and per hunk, commit of the built tree | M | DC-2, DC-4, `axis.git/1` | OS-13, OS-18 |
| OS-16 | Terminal module: xterm.js over the data port, splits, layout kept per workspace, attach to CLI runs, "not managed" never shown (all terminals are Axis-managed now), PTY-5 unchanged in the pty process | M | DC-3 | OS-7 |
| OS-17 | Code module (IDE view): tabs, split, find and replace, project search, go to line, outline, open at file:line from files and changes, return keeps buffers and selection (C1′) | L | DC-1, DC-5, editor kit | OS-14 |

**Demo 2 = demo 1 plus OS-14 to OS-18:** the file manager, + and - per file and hunk, terminals, CLI runs in terminals, and the code editor.

### Wave E: to the Phase 1 slice

| Id | Ticket | Size | Depends on |
|---|---|---|---|
| OS-19 | **Opus.** Security evidence on the own shell: Trusted Types smoke under the production CSP; ADR 0003 criteria 1 to 3 against our window (plugin view, second window, navigated and non-app frames refused); no listener; G-28; EL-5; renderer has no `node:*`, no fs and no network (bundle check plus a runtime probe) | M | OS-2, OS-3, OS-18 |
| OS-21 | Packaging per OS (signing on macOS later), and the packaged NET-GATE half re-done against this build (replaces `check-net-packaged.mjs`'s Code OSS assumption) | M | OS-3 |
| OS-24 | 1c UI on the own shell: All agents lanes (5, 20, 50), side panel with Agents and Code tabs (editor kit), New agent, groups, pull request section (`axis.forge/1`), usage (`axis.usage/1`) | L | OS-8, OS-14, OS-15 |
| OS-25 | Messaging, tasks and pages surfaces on the core shell (2a; contracts on main) | L | OS-8 |
| OS-26 | Mac run and evidence: all of the above on macOS, the Electron-only checks `main-answers.md` §5 lists as unverifiable on Linux | M | OS-19, OS-21 |
| OS-23 | Docs: `ROADMAP.md` gate rewrite (ADR 0011 "Roadmap gate changes"), `PRODUCT.md`, `UX.md`, `ARCHITECTURE.md`, `LICENSING.md`, the threat model revision (new surfaces in ADR 0011 Decision 5 item 7) | M | ADR accepted; before the 1a gate review |
| OS-22 | Retire Code OSS: delete the overlay, patches, removals, replacements, the pin, the Code OSS scripts, the extension matrix and the overlay-tests CI job | S to M | G0 passed |

Composer prerequisites that already exist or are in flight and stay valid: PV-N0 (main secret broker; slice a merged, the rest open), C6 (vault wiring), the Anthropic adapter. The Anthropic part of OS-12 waits on them; the mock part does not.

## 3. Dependency picture

```text
OS-1 ─┬─ OS-2 ── OS-3 ── OS-4
      ├─ OS-5 ─────────┐
      ├─ OS-6 ── OS-7 ─┼─ OS-8 ─┬─ OS-9, OS-10, OS-11 ── OS-12 ;  OS-13   => demo 1
      └─ OS-20         │        └─ OS-24, OS-25
DC-1a/b ─ OS-18 ─ OS-14 ─ OS-17 (+DC-5)
DC-2 ─ DC-4 ─ OS-15                                                       => demo 2
DC-3 ─ OS-16
OS-19, OS-21 ─ OS-26 ;  OS-23 ;  G0 ─ OS-22
```

The DC tickets are daemon work in packages that already have builders and review history. They start on day 1, in parallel with wave A, so wave D does not wait on them.

## 4. Estimates (honest)

The assumptions: three to five builders in parallel, each ticket reviewed independently, the review loop adding one to three days per Opus-reviewed ticket, and no long builder stalls. The last two weeks had about two days of stalled builders; a repeat adds directly to these numbers.

| Milestone | Estimate | What drives it |
|---|---|---|
| (i) **Demo 1**, click-through (agent home, project add and trust, workspaces, mock composer, approvals, file-level changes and commit) | **about 7 to 10 working days** | OS-2 and OS-3 (Opus) are the critical path; everything after them uses contracts that exist |
| (i′) **Demo 2** (file manager, + and - per hunk, terminals, code editor) | **about 3 to 4 weeks** from the start | DC-1 and DC-3 (Opus, L) and the editor kit |
| (ii) **Phase 1 slice** (1a, 1b and 1c gates re-stated and passing on the own shell, on macOS with Linux and Windows CI smoke) | **about 9 to 13 weeks** from the start | the Mac evidence (OS-26), the threat model revision, the 1a gate lines that need real GUI runs, the Anthropic key path (PV-N0, C6) and 1c UI density work. Daemon-side 1a to 1c work is largely merged, which is why this is not longer |

These are ranges, not commitments. The biggest single risk is OS-3 meeting an Electron behaviour on macOS that the Linux package tests could not see. `main-answers.md` §5 lists the candidates.

## 5. What continues and what stops

**Continues unchanged (UI-agnostic):** every `packages/*` slice. That covers daemon-host, protocol, journal, broker, challenge, audit, review, git-ops, git-snapshot, worktrees, pty-process, pty-policy, providers, anthropic, vault, runs and secret-scan. In ticket terms: PV-N0 and N1 (secret broker, egress client, credential proxy), PV-N2a and b (main's device-code dialog is Electron main and carries over), PV-K (plugin grants, plugin-started runs, plugin view identities in main: placement moves to our layout regions), PV-M (messaging, CLI endpoint), PV-T (tasks), PV-Q (pages), PV-G (agents and groups), PV-D2 to D4 (forge, usage, attention), PV-X1 and X1w (pty exec), H9-hooks, the C-series composer work, the deflake sweep and PV-X2 (file splits). PV-D1-0 (main's status answer carrying the window's project id) is main-side and is reused by OS-3.

**Stops now (Code OSS-only):**

- PV-V0 follow-ups (the Code OSS editor-in-part spike; the prototype stays as history), and PV-V2 and PV-V3 as Code OSS parts. They are re-cut as OS-24.
- PV-D1 slices after D1-0 as a Code OSS part (re-cut as OS-8 and OS-24).
- Project trust S3 follow-ups and S4's Code OSS GUI evidence run (re-done in OS-9 and OS-26).
- The remaining shell A-series on Code OSS: A5 follow-ups, A6 (shortcut check against the pin), A7 (working sets), folder-follows-focus and the criterion 1 smoke.
- ADR 0002 work: the upstream sync past 1.144, the extension compatibility matrix (M5), Open VSX signature verification, the reh-web web prototype (M6), further Copilot or agent-host removal patches, the footprint measurements and the `#private` mangling exemption.
- New overlay tests and patches. The PV-X3 overlay-tests job keeps running unchanged until OS-22, so the interim demo does not break silently.

The interim Code OSS shell stays buildable as a fallback demo until G0. Nothing is deleted before OS-22.

## 6. Open items for the reviewer

1. Whether DC-1's `delete` should be tier 2 with a backup ref (proposed) or tier 4.
2. Whether `axis.cliAgents` edits should need main's native confirmation (proposed in OS-4).
3. The pinned versions in OS-1, chosen to be at least two weeks old and checked against advisories on the day.
