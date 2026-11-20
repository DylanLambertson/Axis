# Shell A5: the Changes view

Task A5 of `axis-agent-shell.md` §8.1 (design in §4.3 and the reveal routing in §3.4). The workspace view gets a Changes list under its Files tree. It lists the focused worktree's conflicts, staged, not staged and untracked files from the workbench `IGitService` state, and opens a file's diff, or every listed file in one multi-diff, in IDE view through `IAxisViewService.reveal`. It is read-only, adds no upstream patch and no git process path, and changes no daemon contract.

## What it reads, and how

- **Read path only.** `AxisChangesSource` (`services/changes/common/axisChangesSource.ts`) calls `IGitService.openRepository(worktree)` and follows the returned repository's observable `state`. It calls nothing else on the service or the repository: no `commitFiles`, no `diffBetweenWithStats`, no `getRefs`, no `updateState`. The git extension, which is the service's delegate, runs git exactly as it does for the SCM view; Axis starts no process.
- **Only mounted worktrees are opened.** A worktree outside the window's folders is not passed to `openRepository`, so viewing a workspace never makes the git extension prompt about a repository in a parent folder. Phase 0 does not make the window's folder follow the focused workspace yet (task A2's folder manager), so the list says "Changes show for the folder this window has open" for the other worktrees; it opens again when the window's folders change.
- **The repository must be the worktree.** If the git extension answers with a repository rooted anywhere else (a parent repository, for example), the list shows "Git has no repository for this worktree yet" and lists nothing.
- **A late answer is dropped.** Every open has a generation; a reply for a worktree the user has already left is ignored, so one workspace's changes never show under another's name. Switching worktrees stops listening to the old repository.

## The model

`readChanges(state, root)` in `services/changes/common/axisChanges.ts` turns the state into groups in the order the user needs them: Conflicts (`mergeChanges`), Staged (`indexChanges`), Not staged (`workingTreeChanges`), Untracked (`untrackedChanges`). A file staged and changed again is in both Staged and Not staged. Each group is in path order, sorted before it is cut to 500 rows; the rest are counted and the note sends the user to the SCM view. The kind of a staged or not-staged change comes from which sides it has (no original: added; no modified: deleted; two different paths: renamed; otherwise modified), as the delegate maps them (`extHostGitExtensionService.ts` `toGitChangeDto`).

A change is dropped, and counted in a note, if any of its URIs is not a `file:` URI strictly inside the worktree root (after `.` and `..` are resolved). So no diff is built for a file the view was not asked about.

### Diff sides

The diff sides are the ones the SCM view uses (`extensions/git/src/repository.ts` `getLeftResource` and `getRightResource`), as `git:` URIs in the git extension's own shape (`toGitUri`: the path, and a JSON query with `path` and `ref`), which its existing content provider serves:

| Group | Left | Right |
|---|---|---|
| Staged | `HEAD` (none for an added file) | the index (`ref` `''`; none for a deleted file) |
| Not staged | the index (`ref` `~`) | the file itself (none for a deleted file) |
| Untracked, Conflicts | none | the file itself |

## Opening, through `reveal`

`IAxisRevealTarget` (now in `services/view/common/axisRevealInput.ts`) is a file, a diff or a multi-diff, and `editorInputForReveal` builds the untyped editor input; `reveal` then applies the view mode as before (§3.4: switch to IDE view per workspace or globally, or open in the IDE half in split mode) and opens it.

- **A row** opens its diff. With two sides it is a diff editor with no selection, so `TextDiffEditor` reveals the first change ("at the change"). With one side (added, untracked, deleted, conflict) it opens that side at line 1. The tab title is the cleaned name and the group, for example `app.ts (Staged)`.
- **Review all** opens every listed row in one multi-diff editor ("Changes in ws-a"). Each item's "open file" goes to the worktree file. It is transient, so a reload does not restore a stale list.
- The editors are pinned and reuse an open one (`revealIfOpened`). The view never calls `IEditorService` itself.

## Accessibility and text

- The list is a `listbox` with one `group` per state (named by its heading, "Staged · 2") holding `option` rows, with a roving tab stop: Up, Down, Home, End, Page Up and Page Down move; Enter, Space or a click opens. The focused row is kept by id across updates, so a refresh from git does not move focus to another file.
- **State is never colour alone.** Each row shows a letter in a box and a word (`M Modified`, `A Added`, `D Deleted`, `R Renamed`, `U Untracked`, `! Conflict`) before the name; colour (the theme's git decoration colours) only supports them, and a deleted name is also struck through. A rename shows "from <old path>" after the folder.
- **The accessible name puts fixed text first:** "Modified, Staged: app.ts, in src", or "…, at the worktree root", plus ", renamed from <path>". The state and group come from the group and the URI sides, never from the name, so a file called `Staged, Modified: spoof.ts` reads "Untracked, Untracked: Staged, Modified: spoof.ts, at the worktree root".
- **Hostile names.** Every name, folder and previous path passes `cleanDisplayText` (control characters including newline, format and bidi controls, zero-width characters, line and paragraph separators, private-use and unassigned code points become U+FFFD; runs of combining marks are cut to two) and is clamped on code points (120 for a name, 240 for a folder) with an ellipsis. The view sets every text with `textContent` and has no HTML sink; the name and folder cells also use `unicode-bidi: isolate`, so right-to-left text in a name cannot reorder the state cell. The row's hover title is the cleaned folder and name. The file the editor opens is the real URI from git, not the cleaned text.
- The summary line ("3 files: Staged 1, Untracked 2") and the notes (loading, not mounted, unavailable, rows not listed, changes outside the worktree) are plain text.

## Limits (Phase 0)

- Changes "since base" (`diffBetweenWithStats(baseSha, 'HEAD')`) and the dashboard's Changes column are Phase 1 (§4.3, §4.2): this view reads only the working state.
- No accept, reject, stage or commit: those are daemon actions (§5.4, `axis.git/1`), never the renderer.
- Only the worktree the window has open is listed (see above).

## Tests

- **Overlay unit tests (common):** `services/changes/test/common/axisChanges.test.ts` (groups, order, kinds, diff sides per group, the git URI shape, out-of-root, `..` and non-`file:` changes dropped, the 500-row cut sorted first, labels and summary, and hostile names: newline, carriage return and tab, NUL and escape, right-to-left override, bidi isolates and marks, zero-width and BOM, line and paragraph separators, C1 controls, stacked combining marks, private use, a name that spells another state, very long names and folders, astral characters cut on code points); `axisChangesSource.test.ts` with a fake `IGitService` and repository (opens and follows state, no other repository call, same root not reopened, a late answer dropped and never replacing the current worktree, the old repository no longer followed from the moment another is asked for, unavailable for no repository, a parent repository or a failed open, never opened when not mounted, nothing after dispose); `services/view/test/common/axisRevealInput.test.ts` (file, two-sided and one-sided diff, multi-diff).
- **Node (CI):** `test/code-oss/changes-view-source.test.mjs` checks the sources: the view, model and source use no HTML sink, no process API and no `IGitService` member other than `openRepository`; every shown text comes from the model (no raw path or URI); rows are listbox options named by `changeRowLabel`; the state cell is drawn before the name and shows a letter and a word; the view opens editors only through `reveal`; the source opens only mounted worktrees, drops late answers and refuses a repository rooted elsewhere; only these three files import `IGitService`, and only the model builds `git:` URIs. Each rule has a source that breaks it, and the checker must catch it.

## Manual test on a fixture repository

1. `scripts/code-oss/changes-fixture.sh <dir>` (a path without spaces, on Linux or macOS). It makes `<dir>/changes-repo` with every kind of change and the hostile names above, and `<dir>/conflict`, a worktree with a merge conflict.
2. Build and start Axis as in `axis-shell-runbook.md`, with `<dir>/changes-repo` as the window's folder. Trust the folder (the git extension does not run in Restricted Mode).
3. In Agent view, focus the local checkout. The Changes list shows Staged (`docs/new.md` A, `lib/renamed.ts` R "from src/old.ts", `src/app.ts` M, `src/gone.ts` D), Not staged (`README.md` M, `src/app.ts` M, `test/a.test.ts` D) and Untracked (eight files). The hostile names show U+FFFD where the newline, override, zero-width and escape characters were; no row is split or reordered; the long name ends with an ellipsis; `Staged, Modified: spoof.ts` is a `U Untracked` row.
4. Keyboard: Tab into the list, move with the arrow keys, Home, End, Page Up and Page Down; a screen reader reads "Untracked, Untracked: …" for each row, and the group names.
5. Enter on `README.md` (Not staged): IDE view opens a diff of the index against the file, scrolled to the first change. Back in Agent view, Enter on `src/app.ts` under Staged: `HEAD` against the index. `docs/new.md` and the untracked files open as files; `src/gone.ts` opens its `HEAD` version.
6. Review all: one multi-diff "Changes in changes-repo" with every listed file.
7. Edit a file in a terminal: the list updates without moving focus off the selected row.
8. Open `<dir>/conflict` as the window's folder: `src/shared.ts` is listed under Conflicts. Focus a workspace whose folder is not open: the list says changes show for the folder the window has open.
9. In split mode, a row opens the diff in the IDE half without switching view.
