# Snapshot secret scan (REF-1, ticket REF1-SCAN)

> Phase 1b gate 1b/L13, residual RR-24. Threat model row REF-1: snapshot refs (`refs/axis/runbase/*`, `refs/axis/backup/*`, `refs/axis/archive/*`) hold tracked and untracked, non-ignored files as objects in the shared common dir, where any workspace's CLI can read them and a mirror push publishes them. ROADMAP: "a planted secret pattern in an untracked, non-ignored file is detected before the snapshot is written and reported".

## Where

Every ref `@axis/worktrees` points under `refs/axis/*` is scanned before it is written:

- New trees: `writeSnapshotRef` (`src/snapshotRef.ts`), the run base at create and the backups before finalise, remove and restore (and the discard backup when that entry point lands).
- Existing commits: the finalise archive (`refs/axis/archive/<id>` at the HEAD finalise read, scanned before the backup or the archive is written) and the branch backup of a remove (`refs/axis/backup/<id>/branch-*` at the branch tip), through `assertHistoryClean` (`src/snapshotHistory.ts`).
- HEAD is resolved once per snapshot: the temporary index, the scanned history and the snapshot's parent are that one id, so a leftover process that moves HEAD meanwhile cannot make the parent an unscanned commit.

It is not the GIT-SNAP-1 run snapshotter of ticket H13 (`docs/design/git-snapshot.md` §8), which records git configuration and hooks and writes no ref.

## The trusted base

The run controls HEAD: it can commit, detach and reset. So the only content taken as already shared is the tree of the workspace's recorded base commit (`baseSha`, resolved by the daemon at create). For a ref at or parented on a tip:

1. Everything reachable from the tip but not from the base (`git rev-list --objects <base>..<tip>`, at most 100,000 objects) is scanned: every whole commit object (identities, extra headers and message), every blob not in the base tree, and every blob name of every new tree unless the base holds that name with that blob. A name is scanned per tree, not once per blob, so a new name for content the base already has (`id_rsa`, a token-named file) is still seen. A secret committed and then deleted is still pinned by the parent chain, so it refuses too.
2. Every working file and symlink target: skipped when the base has the same blob at the same path; only its name is scanned when the blob is in the base or was scanned in step 1; otherwise its content and name are scanned.

A fresh run base (a filter-free checkout of the base commit) scans nothing, so a committed test fixture in the user's repository does not block a workspace. `baseSha` lives in the workspace record in the git directory, which a run could rewrite; a run that can do that can also write `refs/axis/*` itself, so REF-1 protects against accidental exposure, not against a hostile run (RR-1). Passing the daemon's journal `baseSha` in and refusing a mismatch (as `trustedBaseBranch` is passed for a merged finalise) is a follow-up: it changes three manager methods, and `manager.ts` must be split first.

## How an entry is scanned

- Each entry is handed to `@axis/secret-scan` as its own new-file patch (`diff --git`, `new file mode`, `+++ b/<path>`, one hunk of every line), so the scanner's own rules apply: file names, added lines, binaries. Paths are C-quoted where git would quote them. Commit messages are scanned as `message`.
- A NUL anywhere in an entry or commit object (not only in git's 8000-byte probe, so UTF-16 appended to a text log by PowerShell 5.1's `>>` is still read) makes four views be scanned: the bytes, the bytes with NULs removed (ASCII in UTF-16 or UTF-32), and UTF-16LE and UTF-16BE decodings. The scanner folds NUL to a blank, so without these a UTF-16 file would scan clean. git's probe only sets the binary budget: a binary by that test over `maxBinaryBytes` gets the scanner's `binary-unscanned` marker; a text with a late NUL is bounded by `maxBytes` per view.
- Too large to scan: an entry or a history object over 4 x `maxBytes` (and, for a blob, over `maxBinaryBytes`) is refused unread, by its size from `cat-file --batch-check` for history; a text over `maxBytes` once decoded is refused before it is split. Hashing streams; only an entry that is scanned is held whole, and it must hash to the same id as the streamed read.
- Bounds: each scanner call has the scanner's deadline; the whole snapshot has 120 s, after which it is `snapshot-unscanned`. Files over the snapshot size limit (50 MiB) are not in a snapshot and are reported as `skippedLarge`.

## Refusal

- The scan finishes before anything is written: no blob, tree, commit or ref exists when it refuses, and what is stored is what was scanned.
- Any finding refuses: `E_POLICY_DENIED`, `reason` `snapshot-secret`. If every finding is about coverage (`binary-unscanned`, `scan-incomplete`, `scanner-error`), or the scanner throws, rejects, or answers something that is not a list of findings, the reason is `snapshot-unscanned`. The host maps both to fixed texts (`snapshot_secret`, `snapshot_unscanned`).
- Both scanner modes refuse: a snapshot has no confirmation step, so a `warn` mode `scan-incomplete` refuses like a `refuse` mode throw.
- `details` carry at most 50 findings (`rule`, `line`, `path` only when the name itself is not what matched, `commit` for a message) and a `count`. The message is fixed text. No matched text, content or scanner error text is kept; the host forwards only the reason.

## Seam

`WorktreeManagerOptions.snapshotScanner` takes `{ scan, limits: { maxBinaryBytes, maxBytes } }`, structurally the `SecretScanner` that `createSecretScanner` returns. Absent, `createSecretScanner()` (`refuse`, default limits) is used: no manager writes unscanned snapshots.

## Consequence and follow-ups

A workspace holding a secret-looking file, or a run-made commit with one, cannot be backed up, archived or have its branch backed up, so a finalise, remove or restore refuses until the user removes it (rewriting the run's commits if it was committed). That is the fail-closed choice the gate asks for. Open: the host passing its configured scanner (one line in `bindings/worktrees.ts`); a confirmed variant; an end-to-end test of the untracked-file case through `axis.worktrees/1` (the headless slice covers a committed secret: its approved finalise is refused with `snapshot_secret`); reporting which file (the reply carries only the reason today: the paths would need the host's escaping display path and a reply field).
