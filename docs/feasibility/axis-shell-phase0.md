# Axis Agent view shell, Phase 0: footprint and headless run (Linux)

- Date: 2026-11-04 and 2026-11-05; re-run on 2026-11-05 after the review fixes (§6).
- Branch: `feat/axis-shell-a1`. Code OSS `1.144.0` at `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`, with the patch series, `replace/`, overlay and hook of this branch.
- Scope: ADR 0004's Phase 0 gate items for the agent-view skeleton (`docs/adr/0004-agent-first-workspace-shell.md`, "Phase 0 gate impact"), measured on the Linux host; ADR 0002 criterion 2 for the shell block. Design: `docs/design/axis-agent-shell.md` tasks A1 to A7; how to build and run: `docs/design/axis-shell-runbook.md`.
- Status words as in `code-oss-build.md`: **passed**, **failed**, **not run**. Every number was measured on this host, shared with other builds.

> **Not a distributable build.** A development build (`scripts/code-oss/build.sh`, `out/`), run only on this machine under Xvfb. No packaged target was built for this note.

## 1. Summary

| Item | Result |
|---|---|
| ADR 0002 criterion 2 (shell block `0001–0999`: ≤ 12 upstream files, ≤ 300 lines) | **Passed**: 7 files, 45 added (22 of them marker lines) and 5 deleted lines (§2). The Agent view adds **no** upstream file or line: everything it needs is overlay |
| Gate item 1: boots into a dashboard listing workspaces, and a workspace view with a file tree and a terminal bound to a folder | **Passed**, with read-only discovery of real worktrees and labelled sample runs (§4) |
| Gate item 2: IDE view passes ADR 0002 criterion 1 | **Not run.** The IDE view is the upstream workbench, reached and left in every smoke step, but the criterion 1 smoke subset (editor, explorer, search, SCM, terminal, debugger, diagnostics, palette, extension host) was not run here |
| Gate item 3: switching in `perWorkspace` and `split`; a file click opens IDE view at the file; returning keeps workspace and editor state | **Passed** by keyboard (§4): 12 of 12 smoke steps; key events and typed text only, plus a settings-file write for the mode |
| Gate item 4: shell footprint measured against criterion 2 | **Passed** (§2) |
| No part recreated and no extension host restart across 20 toggles | **Passed**: the part element is the same object and the app's Node utility processes (the extension host among them) keep the same pids |
| Unit tests (`./scripts/test.sh --grep Axis`, Electron renderer) | **Passed**: 60 of 60, four of them on the real disk with real git and symbolic links |
| macOS | **Not run** on this host. The runbook gives the commands and the one background launch |
| Screen reader | **Not run**. Announcements were checked as live-region text, not with Orca or VoiceOver |

## 2. Footprint (ADR 0002 criterion 2)

`scripts/code-oss/footprint.sh` after `apply.sh`:

| Block | Patches | Upstream files | Added | Deleted | Marker lines (in added) |
|---|---|---|---|---|---|
| shell `0001–0999` | 6 | 7 | 45 | 5 | 22 |
| shell, criterion 2 count (without `product.json`, `resources/**`) | 6 | 7 | 45 | 5 | 22 |
| guardrails `1000–1499` | 4 | 4 | 97 | 109 | 10 |
| copilot `1500–1999` | 8 | 19 | 190 | 122 | 84 |
| security `2000–2999` | 0 | 0 | 0 | 0 | 0 |

The shell block, patch by patch:

| Patch | Upstream file | + / − (markers) | Design id |
|---|---|---|---|
| `0010-eslint-axis-config` | `eslint.config.js` | 11 / 1 (6) | P8 |
| `0020-copyright-filter-axis` | `build/filters.ts` | 7 / 0 (2) | P9 |
| `0030-desktop-main-create-workbench-hook` | `src/vs/workbench/electron-browser/desktop.main.ts` | 8 / 1 (4) | P2 |
| `0035-desktop-workbench-axis-entry` | `workbench.html`, `workbench.ts` (`code/electron-browser/workbench`) | 7 / 3 (4) | P3, P4 |
| `0040-axis-desktop-entry-bundle` | `build/next/index.ts` | 6 / 0 (4) | P6 |
| `0050-axis-desktop-entry-checksums` | `build/gulpfile.vscode.ts` | 4 / 0 (2) | P7 |

- Without markers that is **23 added and 5 deleted lines in 7 files**, against 12 files and 300 lines. The design estimate was 10 files and about 50 lines with the bridge seams B1 to B3 (`app.ts`, `serverServices.ts`), which are Phase 1 and not in this count; adding them as estimated keeps the block at 9 files.
- The temporary restyle import P10 (`0100-axis-defaults-import`) is retired: `axis.common.main.ts` imports the defaults contribution instead, as the design planned.
- **Deviation from the design, inside the budget:** the desktop entry is reached through `DesktopMain.createWorkbench` (P2), but `AxisWorkbench` **extends** the upstream `Workbench` instead of replacing it, and adds the agent part as one more leaf of the upstream grid. It reads the private `Layout.workbenchGrid` through one guarded accessor that fails the launch with a clear message if a sync renames the field; it overrides only public layout methods (`isVisible`, `isPanelMaximized`, `toggleMaximizedPanel`) and the protected `initLayout`/`createWorkbenchLayout`. This is the approved deviation recorded in the handover; it is why no `layout.ts` patch exists.

Axis-owned code (overlay, not counted by criterion 2): `src/vs/axis` holds 3,250 lines of TypeScript outside tests, 617 lines of tests and 365 lines of CSS.

## 3. Build on this host

Under `~/.cache/project-axis/shell-lx/` (paths without spaces), `npm ci`, `compile` and every later compile serialized with `flock ~/.cache/project-axis/build.lock`.

| Step | Time | Note |
|---|---|---|
| `fetch.sh` | 30 s | |
| Pinned Node download and verify | a few seconds | SHA-256 matches the manifest pin and `SHASUMS256.txt` |
| `build.sh`, attempt 1 | **failed** after 58 s | `native-keymap` failed to link: the shared sysroot's `libX11.so` and Kerberos `.so` links dangle, so `ld` took `libX11.a` (`relocation … can not be used when making a shared object`) |
| `build.sh`, attempt 2 | passed, 10 min 3 s | `npm ci` 446 s, `compile` 134 s, Electron 19 s, built-in extensions 4 s; largest process 8.3 GB RSS |
| Incremental `npm run compile` after overlay edits | about 1.1 min | |
| `npm run typecheck-client` | 39 s | |

The link fix is a directory of symlinks to the host's runtime libraries, first in `LIBRARY_PATH`; the shared sysroot was not edited. Running the app needs `LD_LIBRARY_PATH` on the sysroot (NSS, ALSA, Xss). Xvfb needs `xkbcomp` at its compiled-in `/usr/bin`, which this host lacks; the runbook runs it in a user and mount namespace with the sysroot's `bin` overlaid on `/usr/bin`.

Running app, idle on the demo repository after the smoke run: 16 processes, 2,248 MiB RSS summed (`ps`; overcounts shared pages; development build with TypeScript and Markdown servers running).

## 4. Headless run

`test/axis-shell/smoke.mjs` attached over the Chrome DevTools Protocol to the development build on Xvfb, opened on the demo repository of `scripts/code-oss/shell-demo-fixture.sh` with `axis.preview.sampleRuns` on, workspace trust off and a fresh profile, with `--app-path` set. Every action is a key event (the Windows and Linux shortcuts) or typed text in the editor and the command palette; the script reads the page but never clicks or focuses by script. The mode change writes the user settings file. Before the steps it checks that the DevTools port listens on loopback only. One screenshot per step.

| Step | What it asserts | Result |
|---|---|---|
| dashboard | Agent part shown, editor hidden; rows for the local checkout (labelled), `fix-login`, `add-search`, `spike` (shown as "detached at …"); focus not on the body | passed |
| keyboard-open-workspace | Startup focus on the dashboard; Home, Down to `fix-login`, Enter: workspace view, Files tree, a terminal; focus inside the view | passed |
| file-opens-ide-view | In Files: Home, Right on `src`, Down, Enter on `login.ts`: IDE view, `login.ts` open, focus in the editor | passed |
| edit-then-back-to-agent | Type into the editor (dirty), `Ctrl+Shift+Alt+V`: Agent view, same workspace, focus back on `login.ts`, "Agent view, workspace fix-login" announced | passed |
| back-to-ide-keeps-editor | Toggle again: IDE view, focus in the editor, `login.ts` still open and still dirty, announced | passed |
| twenty-toggles-keep-parts | 20 toggles: same part element; Node utility process pids unchanged | passed |
| dashboard-shortcut-and-workspace-2 | `Ctrl+Shift+Alt+0`: dashboard with focus; `Ctrl+Shift+Alt+2`: workspace 2 | passed |
| split-mode | Both halves shown; the agent half right of the IDE half; the agent half has its split header | passed |
| split-toggle-moves-focus | The toggle moves focus between halves and hides neither | passed |
| split-collapse-ide-and-file-click | Collapse the IDE half from the command palette; arrow keys to `README.md`, Enter expands the IDE half and opens the file there, no view switch | passed |
| split-collapse-agent-f6 | Collapse the agent half from the command palette to a strip of at most 40 px; F6 reaches it; Enter on its header expands it | passed |
| back-to-per-workspace | One view again | passed |

Two defects found by these runs were fixed before the results above: the part element was not sized to its grid cell (the dashboard filled a quarter of the window), and upstream restore reopened the Explorer after the Axis layout was applied, which the shell took as a request for the IDE view.

## 5. Deviations from the design and what is not done

| Design | As built in Phase 0 | Why, and what follows |
|---|---|---|
| Agent part leftmost (§3.1) | Right of the editor | Keeps the IDE half contiguous and the panel under both halves without moving upstream nodes; to revisit with the `sideBar.location: right` reparenting (A6) |
| Files is an `ExplorerView` subclass in an auxiliary-bar container (§4.3) | An Axis tree in the agent part, over `IFileService` | The window's folder does not follow the focused workspace yet (A2's folder manager and per-project `.code-workspace` are not built); the explorer would show the wrong folder |
| Folder follows focus (§3.2), trust backstop | Not built | The IDE view's Explorer and Search show the opened folder (the local checkout), not the focused worktree; files opened from the tree are outside it |
| Changes view, diff and multi-diff (A5) | Not built | The dashboard's Changes column says "not read" |
| Per-workspace editor working sets (A7) | Not built | Editors stay open across workspace focus changes |
| `global` mode | Unit tests only | Not in the smoke run |
| Shortcut re-check against OS and extension bindings (A6) | Not run | Defaults as adopted in `UX.md` |
| Panel per view, auxiliary bar containers | User's visibility in every view | The design's per-view panel and auxiliary-bar memory is not built |

Not run: the ADR 0002 criterion 1 smoke subset in IDE view, any macOS or Windows run, a screen reader, a packaged build with the shell, startup timing, keystroke latency of workspace terminals.

## 6. Review fixes (2026-11-05)

An independent review of the branch found no blocker. What changed after it, all re-run with the results above:

- **Worktree paths from repository metadata are checked before use.** A `<common dir>/worktrees/<name>/gitdir` is followed only if the folder it names, and that folder's `.git` file, are real (no symbolic link) and the `.git` file points back to the same `worktrees/<name>` entry, which is git's own two-way link. An opened folder whose `.git` file names a linked worktree is accepted only if that admin dir sits under `<common dir>/worktrees` and links back to the folder. Anything else, including a worktree whose folder is missing, is not listed or opened (only the two links are read); the dashboard says how many entries it left out. Links may still point outside the repository, as git allows (`git worktree add ../x`).
- **No terminal opens by itself in Restricted Mode.** The terminal on first focus needs a trusted window and a project discovered while trusted; **New Terminal** stays available.
- **Branch names from `HEAD` are cleaned:** control, format, bidi, private-use and unassigned characters become U+FFFD, runs of combining marks are cut to two, and the name is cut to the contract's 256 characters and to 128 for display.
- **Ids** of discovered projects and worktrees are 128 bits of SHA-1 of the path instead of a 32-bit hash.
- **Tests:** the ref-escape test now plants a file where an unguarded read would land; the ref-name and back-link guards were each replaced by `return true` in the compiled output and the data-source tests failed, then restored. The `split-mode` smoke step asserts its last condition.

A second review found one more hole and asked for tests of the link checks; fixed the same day:

- **A `.git` file is a claim, not a project.** A folder whose `.git` file names a git dir is a project only if that git dir points back at the folder: a linked worktree's admin dir under `<common dir>/worktrees` whose `gitdir` names the folder's `.git`, or a submodule's git dir whose `core.worktree` names the folder. Only a `.git` directory in the folder, or a verified linked worktree, lists the repository's other worktrees; a submodule is one checkout. Before, a lone `.git` file naming another repository's git dir listed that repository's worktrees. A `--separate-git-dir` repository has no back-pointer and is not a project in Phase 0.
- **Bounded listing.** `<common dir>/worktrees` is read with one `readdir` (no stat per child), symbolic links among the entries are skipped, and at most 200 entries are read; the rest count as not listed.
- **Every link check has a test that fails without it** (as of the second review; the third added more below), mutation-checked on the compiled output: the B-1 rule (3 tests fail), the `core.worktree` check (2), the no-listing rule for submodules (1), the opened `.git` symbolic link (1), the `readdir` filter (1), the worktree folder symbolic link, from the reviewer's relative-path case (1), the worktree `.git` symbolic link (1) and the folder type check (2). A separate "`.git` is a file" check was dropped: reading a `.git` directory as a file fails, and that read already refuses it.
- **Residual:** paths are checked once and used later as strings (a time-of-check to time-of-use gap until the daemon owns worktree paths); recorded as item 15 of the residual risks in `docs/security/threat-model-phase1-controls.md`.
- **Follow-up, not done:** a check that the copied contract interfaces in `axisWorkspaceData.ts` still match `@axis/protocol` (review finding F-10); it needs a root test that reads the overlay file, and belongs with task B5.

A third review found that the "no symbolic link" checks looked only at the last part of each path, while paths were compared as strings and git follows physical directories. With real git and a link higher up the path (an archive holding `s -> ../src/proj-worktrees` beside a fake repository whose `worktrees/feat/gitdir` is `../../../../s/feat/.git`), the dashboard listed and opened the user's real worktree when that worktree uses relative paths. Fixed the same day:

- **Physical paths.** The opened folder is first resolved to its real path (so a repository opened through a link still works), and every git dir and worktree folder in the link check must have a real path equal to the path as written: a link anywhere in it refuses the entry. The common dir needs no separate check: it is the git dir's grandparent.
- **Tests:** a node suite on the real disk provider, with repositories made by real git (`--relative-paths`, git 2.48 or later; older hosts skip it) and real links, covers the reported case, a worktree whose common dir is reached through a link, a submodule git dir reached through a link, and the controls (relative-path worktrees listed, including when the folder is opened through a link). In memory, the test provider now answers `realpath` for marked links, with tests for each case. A linked worktree listing its siblings, and `[core "x"]` not being read as `[core]`, now have tests.
- **Mutation-checked** on the compiled output: not resolving the opened folder (1 test fails), the submodule git dir check (2), the linked worktree git dir check (3), the worktree folder check (3), no sibling listing for a linked worktree (3), and the `[core "x"]` rule (1).
