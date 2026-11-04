# Diff review core (`@axis/review`)

- **Status:** Design, Phase 1a (ROADMAP ticket 7, design task B7). Written before the code.
- **Covers:** the changed-files list against a base, per-file and per-hunk accept and reject, the reviewed tree and its binding to `@axis/git-ops` commit (REV-1), the "files changed outside the agent" model, protected-path flags, display escaping, symlink-safe preview and the secret-warning data for the push dialog (PSH-1, FT-1, DASH-1, WT-3, DRF-2 to DRF-4).
- **Does not cover:** the UI, the daemon handlers (`axis.worktrees/1.commit`, `.discard`, `.applyPatch`), the drift ledger watcher, the run-base ref writer, the protected-path list itself, writing rejected changes back to the worktree (the `discard` action).

## 1. Shape

A pure TypeScript package. It touches no file and no process directly. Everything goes through:

- the `GitRunner` and `GitOpsDeps` of `@axis/git-ops` (the same object the daemon already holds), always in the **daemon** context with the hardened prefix (`--no-pager --no-replace-objects --git-dir --work-tree -c core.fsmonitor=false -c core.hooksPath=<off> -c protocol.allow=never -c diff.submodule=short` and every `filter.*` driver neutralised). `guardedRunner` refuses a call that lacks it. This package never builds an argv for another context.
- a `TempIndexProvider` (the daemon hands out a file in its private data directory; tests use `mkdtemp`). The package has no `node:fs`.
- an optional `ProtectedPathMatcher` and the optional `SecretScanner` already in `GitOpsDeps`.

Errors are `ReviewError` with a code from the closed `@axis/protocol` set. Details are primitives only; no `cause`, no getters, nothing taken from git's stderr except a sanitised, truncated string (`sanitizeText` and `redactUrls` from `@axis/git-ops`).

## 2. The worktree is read once, into immutable objects

Reading a worktree file twice is a TOCTOU (a CLI is still writing; a file can be swapped for a symlink). So review reads the worktree **exactly once**, through git, into a tree object, and everything after works on objects:

1. Temporary index (`GIT_INDEX_FILE` set only on these calls, never in the pty environment).
2. `read-tree <against-tree>`, then `-c core.sparseCheckout=false add -A`, then `write-tree`. The result is the **worktree tree** `W`: tracked and untracked, **not ignored**. This is the same method the run-base ref uses (policies §3.1), so the two agree.
3. The temporary index is removed in a `finally`, after the last git process that uses it has ended.

`git add` uses `lstat`: a symlink is stored as a link and never followed, and a directory replaced by a symlink is a single link entry. Clean filters are neutralised by the prefix, so no repository-defined program runs. Ignored files never enter `W`, and so cannot reach a commit made from the reviewed tree. A change to `.gitignore` is itself a reviewed change.

Known cost: a fresh temporary index has no stat cache, so every snapshot hashes every non-ignored file once. It is proportional to the worktree, not to the diff (see §12).

## 3. Changed-files list

`listChanges(against, W)` runs `diff-tree -r -z --raw --no-abbrev -M -l<n> --no-ext-diff --no-textconv` and `--numstat -z`, both parsed from NUL-separated records, never from patch headers (which are C-quoted). Each entry:

`{ path, oldPath?, status: A|M|D|R|T, oldMode, newMode, oldOid, newOid, kind: text|binary|symlink|submodule|too-large, similarity?, additions?, deletions?, displayPath, displayOldPath?, protected, warnings }`

- **Renames** (`-M`), **deletions**, **mode changes** (a mode-only `M` has no hunks), **type changes** (`T`), **binary** (numstat `-`), **submodules** (mode `160000`, the commits are shown as data, never diffed or entered) and **symlinks** (mode `120000`, the target is data) are all first-class.
- Object sizes come from one `cat-file --batch-check=%(objectsize)` call over every non-gitlink oid. Over `maxPreviewBytes` marks `too-large`.
- Paths are validated before they can be used: no NUL, not absolute (`/x`, `\x`, `C:x`), no `.`, `..` or empty segment, no `.git` component (case-insensitive, trailing dots and spaces ignored, `git~1`), length at most 4096. A bad path is listed (so the reviewer sees it) with `unsafePath` and cannot be accepted. `git update-index --index-info` itself answers "Ignoring path ../x" with exit 0, so git cannot be relied on for this.
- More than `maxFiles` entries, or runner output reported `truncated`, makes the list incomplete. A review that could not list everything must not become a commit: `startReview` refuses (`E_INVALID_ARGUMENT`, `details.reason: "too_large"`).

The `against` commit is a full object id. A review that will be committed must have `against == HEAD` (the commit's parent); the daemon passes the recorded base for the overall "what did the run change" list and `HEAD` for the commit round. See §6.

## 4. Hunks

`loadHunks(review, path)` is on demand, per file, and only for a text `M` (and a text rename with content change). Add, delete, symlink, gitlink, binary, mode-only and type change are file-level only.

It diffs the **two blobs**, not paths: `git diff --no-ext-diff --no-textconv --no-color --no-renames -U3 <oldBlob> <newBlob>`. No pathspec, no attribute lookup, no quoting, no path in the output. Caps: both blobs at most `maxHunkFileBytes` (1 MiB), the patch at most `maxPatchBytes`, hunks at most `maxHunksPerFile`; beyond any of them (or a runner `truncated`) the file is file-level only with `reason`.

The parser is strict and linear:

- header `@@ -a[,b] +c[,d] @@`, at most 9 digits per number; a missing count is 1;
- the body is read **by the counts in the header**: it must contain exactly `b` old-side and `d` new-side lines (context counts for both) before the next header. More, fewer, a line that starts with anything but space, `+`, `-` or `\`, or a blank line, is `malformed`. A hunk header that lies about its line counts therefore never reaches the apply step;
- the patch is split on `\n` only. `\r` stays in the line, so CRLF files keep their line endings; `\ No newline at end of file` clears the line terminator of the line before it (both sides for a context line);
- U+2028, U+2029 and U+0085 are not line breaks.

Apply works on the old blob text with line terminators kept. For each accepted hunk, in order: the old-side lines must equal the old blob lines at the stated position **exactly** (including terminator), ranges must not overlap and must be increasing, otherwise the file falls back to file-level. Unaccepted hunks leave the old lines in place.

**Self-check.** Before hunks are offered, all hunks are applied and the result is hashed as a git blob **in process** (SHA-1 or SHA-256 by the object id length). It must equal the new blob's id. If not, the file is file-level only (`not_reproducible`). This catches a lying diff, a text that does not survive the runner's UTF-8 decoding (the runner returns strings; invalid UTF-8 cannot be round-tripped), and any difference between my reading of the patch and git's. It is the property that makes partial accept safe: the hunks are proven to be the whole change.

## 5. Decisions and the reviewed tree

Nothing is accepted by default. `ReviewSession` holds, per file, `none | accepted | partial(hunk set)`. A hunk is named by `{ index, digest }` (SHA-256 of its text); a stale or unknown name is `E_NOT_FOUND`. `acceptFile` accepts the metadata (mode, rename, type, delete) and all hunks; `acceptHunk` accepts content only (the old mode stays) until every hunk of the file is accepted, which is then the whole file, mode and rename included. A path, an unknown file or a decision on an unsafe path is refused.

`build()` produces the **reviewed tree** `R`:

1. a new temporary index, `read-tree <against-tree>`;
2. one `update-index -z --index-info` call (NUL-terminated, so paths with newlines and quotes are safe), with the accepted entries: new `mode oid path`; a delete is mode `0` and the zero oid; a rename is a delete of the old path plus an add of the new one; a partial file is the blob written by `hash-object -w --stdin --no-filters` from the applied text; a gitlink carries its commit id;
3. `write-tree`;
4. **verification**: `diff-tree -r -z --raw` from the `against` tree to `R` must list exactly the paths that were accepted, with the accepted modes and ids. Because `--index-info` can ignore a path silently with exit 0, `R` is never trusted without this check;
5. the temporary index is removed.

The user's worktree is not touched. The user's real index and refs are not touched either, until the daemon calls `prepareCommit` (§6). Objects are added to the object store, like git-ops already does with tree objects.

## 6. The binding and the `@axis/git-ops` commit contract

What `executeCommit` does today (read from `packages/git-ops/src/commit.ts`): it takes `reviewedTreeHash`, runs `write-tree` on the **real index**, and refuses unless that equals the hash; refuses `HEAD` detached; refuses when HEAD's tree already equals it; commits in the pty context with `commit -F -`; afterwards checks the new commit has the reviewed tree and the parent it saw at check time (and undoes by compare-and-swap if only the tree is wrong).

That contract is **sufficient to bind the content of the commit**, with one step in front of it. It is **not sufficient** for the following, which this package therefore does and which I propose to tighten in git-ops (not changed here):

| # | Gap in git-ops | Done here | Proposed git-ops change |
|---|---|---|---|
| G1 | The real index only equals `R` if something put `R` there. A partial accept leaves the index at the old state. | `prepareCommit` does `read-tree R` into the real index, under the daemon's lock. | None. |
| G2 | The worktree is never compared with what was reviewed. A file edited after review does not stop the commit (the gate requires that it does). | The binding records `W`; `prepareCommit` re-snapshots and refuses if `W'` differs (`E_CONFLICT`, `details.reason: "stale"`). | Optional `assertReviewFresh(worktree, reviewedTreeHash)` in `GitOpsDeps`, called inside `check()` next to `assertNoDrift`, so the check sits inside the same locked window. |
| G3 | `R` was built on HEAD at review time. `plan.parent` is read at commit time. If HEAD moved, or the checkout switched to another branch at the same commit, committing `R` lands somewhere the user did not review. | The binding records `head` and the branch; `prepareCommit` refuses if either moved. | `CommitInput.expectedParent`, compared with `plan.parent` in `check()`. |
| G4 | `GitOpsDeps` helpers needed to build hardened calls (`daemonGitFor`, `checkWorktree`, `OBJECT_ID`) are not exported; only `prefix`, `guardedRunner`, `filterNames`, `requireGitVersion` and `daemonGitEnv` are. | Rebuilt here from those exports (about 25 lines). | Export `daemonGitFor` with an `extraEnv` parameter (needed for `GIT_INDEX_FILE`), and `checkWorktree`. |

Between `prepareCommit` and git running there is a window in which a file can change. That does not change what is committed (`R` is already an immutable tree in the index) but it makes the commit differ from the worktree the user saw, which is why G2 is best closed inside git-ops.

The **binding** is an instance of `ReviewBinding`, a class with a private constructor and a module-private brand, so a plain object cannot be passed in its place (the same device as the journal's `UserPrincipal`). It holds `worktree`, `head` and the checked-out `branch` (or null), `headTree`, `worktreeTree` (`W`), `reviewedTree` (`R`), and a digest over all of them and the accepted file summary, for the audit event. `prepareCommit` refuses when HEAD or the branch is no longer the one reviewed. `toCommitInput(binding, { message, author? })` returns a `CommitInput` for `executeCommit`. It does not carry a path from a renderer: the daemon keeps the binding keyed by its own id.

## 7. Display (FT-1, DASH-1)

`escapeForDisplay(s, opts)` is total and never throws on any string: C0 and DEL, C1, lone surrogates, non-characters, line and paragraph separators, bidirectional controls (U+061C, U+200E/F, U+202A to U+202E, U+2066 to U+2069), zero-width and joiner characters (U+200B to U+200D, U+2060, U+FEFF) and the Unicode tag block are written as `\n`, `\r`, `\t`, `\xNN` or `\u{X}`; a backslash is written `\\` so the output is unambiguous; the result is truncated at `maxDisplay` code points with an ellipsis marker, never in the middle of a pair. Paths use it in full and are cut in the **middle** (the start and the last two thirds are kept), because the file name is at the end and is what a reviewer must not lose. Hunk text keeps a tab as a tab (open question Q2) and shows a trailing `\r` as an end-of-line marker `eol: "crlf"` instead of text. The raw string is kept for operations; only `display*` fields are for the UI.

## 8. Symlinks and preview

There is no filesystem access, so nothing can follow a link: previews come from objects. `previewBlob(review, path, side)` returns `text` (escaped, size-capped), `binary` (a placeholder with the size), `too-large`, `submodule` (commit ids) or `symlink`. For a link only the target string is shown, with `escapesWorktree` computed lexically: absolute (`/`, `\`, a drive), or a normalised `..` that climbs above the repository root from the link's own directory. A link that escapes is flagged as a warning and never dereferenced. Because a worktree directory replaced by a symlink is a link entry, `a/b` can never be reached through it.

## 9. Protected paths (WT-3)

`ProtectedPathMatcher.match(path): readonly ProtectedHit[]`, each hit `{ rule: string }`, is injected (the `@axis/git-snapshot` matcher will satisfy it structurally). It is called with the repository-relative path, and with both `oldPath` and `path` for a rename. A matcher that throws marks the file protected with rule `matcher-error` (fails closed). Rule names are bounded and escaped. No policy decision depends on it (highlight only, as WT-3 says for 1a).

## 10. Files changed outside the agent (DRF-2 to DRF-4)

`computeOutsideAgent(deps, { worktree, runBase, runEnd?, ledger, ledgerComplete })`. The set of changed paths is `diff(runBase, now)`; the watcher never decides it. Of those, a path counts as **outside the agent** when:

- `after-run`: it differs between the run-end tree and now. This needs no watcher at all, only a tree snapshot at run end (the daemon takes it at exit), so it holds even when every watcher event was dropped; or
- `ledger`: the watcher's ledger names it (a write during the run that was not the run's).

Every other changed path is `unattributed` and is still in the full changed list (nothing is hidden by a missing event). If `ledgerComplete` is false (the watcher reported overflow), the report says `attributionIncomplete: true` and the indicator reads "at least N". A ledger path that is not changed against the run base is ignored (reverted or overwritten: nothing to review). Attribution is informational (DRF-3). The ledger is bounded (`maxLedger`) and over-long input is `truncated`, never silently dropped.

## 11. Secret warnings for the push dialog (PSH-1)

`secretWarnings(deps, review)` runs the injected `SecretScanner` (the one `planPush` already uses) over the patch of `against..R` (`diff-tree -p --text --no-renames`, so binary and attribute tricks cannot hide content), with `part: "patch"`, and returns `{ findings: { rule, displayPath, line }[], binaryPaths, truncated, requiresConfirmation, digest }`. It lets the dialog warn at accept time. It never carries matched text: rule names are restricted to `[A-Za-z0-9._-]{1,64}` and paths are escaped. A truncated scan sets `requiresConfirmation`. This does not replace the scan in `planPush`, which runs on what is actually pushed.

## 12. Limits

All counters are incremented before they are checked, and a cap hit is always visible (`truncated` or a refusal), never silent. Defaults: `maxFiles` 5000, `maxPreviewBytes` 1 MiB, `maxHunkFileBytes` 1 MiB, `maxPatchBytes` 2 MiB, `maxHunksPerFile` 1000, `maxDisplay` 512 code points, `maxLedger` 100000, stale-path list 100. The runner's own output cap and timeout bound each git process; the package adds no timer, listener or retained handle.

## 13. Tests

`node:test` only; nothing assumes a git version or an OS (POSIX-only fixtures, such as an executable diff driver, skip on win32).

- unit: display escaping (every class above, idempotence, a lone surrogate, truncation), path validation, symlink escape, the hunk parser and apply with a fake runner: a header that lies about its counts, extra and missing body lines, CRLF, no newline at end of file on either side, overlapping or out-of-order hunks, a huge hunk count, a context mismatch;
- real git: every status (A, M, D, R, T, mode, binary, symlink, gitlink), a path with a newline and quotes, partial accept reproducing the exact blob, the reviewed tree verification, a file swapped for a symlink between review and accept and between accept and commit, an edit after review refusing, HEAD moving, `diff.external`, `diff.<driver>.textconv` and a clean filter that would write a marker file (none runs), a CRLF file, a giant diff, a hostile runner returning `../../x` and `.git/hooks/x` in paths, and an end-to-end `prepareCommit` then `executeCommit`;
- the outside-the-agent model with the watcher blind (empty ledger, `ledgerComplete` false).

## 14. Open questions and known limits

- **Q1.** `against` for the commit round must be HEAD (§3, G3); the daemon chooses. Should the journal expose "HEAD at last commit" so the UI does not compute it?
- **Q2.** Tabs in hunk text are not escaped (code in Makefiles and Go would be unreadable); everything else is. A strict reading of the gate would escape them too.
- **Q3.** Reject only leaves a change out of `R`; it does not revert the worktree. That is `axis.worktrees/1.discard`, with its backup ref and approval, and belongs to the worktree package.
- **Q4.** The snapshot hashes every file (no stat cache). If that is too slow on large repositories, the daemon can keep one persistent snapshot index per workspace; the provider may return the same file, since the package always starts with `read-tree`. A size cap on untracked files is the `git-snapshot` package's rule and is not duplicated here.
- The runner decodes output as UTF-8. Text that is not valid UTF-8 cannot be offered per hunk (the self-check refuses it) and the scanner sees decoded text, the limitation `docs/packages.md` already records for git-ops.
- `prepareCommit` replaces the real index. Staging done outside Axis (the SCM view, a terminal) is replaced by the reviewed tree; the worktree is not touched.
- A sparse-checkout repository is not supported by `prepareCommit` (replacing the real index would drop its skip-worktree bits); it is refused with `E_UNAVAILABLE`.
- `git add` has a short race between its own `lstat` and `open`; a file swapped inside it can put the target's bytes into `W`. They are visible in the review and never committed unless the user accepts them.
