# Snapshot secret scan (REF-1, ticket REF1-SCAN)

> Phase 1b gate 1b/L13, residual RR-24. Threat model row REF-1: snapshot refs (`refs/axis/runbase/*`, `refs/axis/backup/*`) hold tracked and untracked, non-ignored files as objects in the shared common dir, where any workspace's CLI can read them and a mirror push publishes them. ROADMAP: "a planted secret pattern in an untracked, non-ignored file is detected before the snapshot is written and reported".

## Where

Every snapshot tree is written by one function, `writeSnapshotRef` in `@axis/worktrees` (`src/snapshotRef.ts`): the run base at create, and the backups before finalise, remove and restore (and the discard backup when that entry point lands). The scan lives there, so no caller can write a snapshot around it. It is not the GIT-SNAP-1 run snapshotter of ticket H13 (`docs/design/git-snapshot.md` §8), which records git configuration and hooks and writes no ref; the two do not touch the same files, so this lands before or after H13 in either order.

## What is scanned

- Each regular file and symlink the snapshot will record, unless the snapshot's base (`HEAD`, read into the temporary index) already has the same blob at the same path. Unchanged tracked content is already in the repository's history; scanning it would refuse every workspace of a repository with a committed test fixture and close no exposure. A fresh run base (a filter-free checkout of the base commit) therefore scans nothing.
- Each such entry is handed to `@axis/secret-scan` as its own new-file patch (`diff --git`, `new file mode`, `+++ b/<path>`, one hunk of every line), so the scanner's own contract applies: file names (`sensitive-filename`, tokens in a name), added lines, and the binary rules. Paths that need it are C-quoted, so a tab, newline or quote in a name cannot end the header early.
- Binary (a NUL in the first 8000 bytes, git's test): content up to the scanner's `maxBinaryBytes` is scanned as `binaryPaths`; a larger binary gets the scanner's `binary-unscanned` marker. Files over the snapshot size limit (50 MiB) are not in the snapshot and are not scanned (they are already reported as `skippedLarge`).
- One scan call per file: the scanner's byte cap and deadline are per call. A text file over the scanner's `maxBytes` (16 MiB by default) cannot be covered and refuses the snapshot.

## Refusal

- The scan runs on the bytes read for hashing, before anything is written: no blob, tree, commit or ref exists when it refuses. The bytes stored later must hash to the scanned id (the existing re-read check), so what is written is what was scanned.
- Any finding refuses: `E_POLICY_DENIED`, `reason` `snapshot-secret`. If every finding is about coverage (`binary-unscanned`, `scan-incomplete`, `scanner-error`), or the scanner throws, rejects, or answers something that is not a list of findings, the reason is `snapshot-unscanned`. The host maps both to fixed texts (`snapshot_secret`, `snapshot_unscanned`).
- The scanner mode does not weaken this. In `refuse` mode an incomplete scan throws; in `warn` mode it comes back as a `scan-incomplete` or `scanner-error` finding. A snapshot has no confirmation step, so both modes refuse. A confirmed path (the user accepts a named file into the backup) is a follow-up.
- `details` carry at most 50 findings (`rule`, `line`, and `path` only when the name itself is not what matched) and a `count`. The message is fixed text. No matched text, file content, or scanner error text is kept anywhere; the host forwards only the reason.

## Seam

`WorktreeManagerOptions.snapshotScanner` takes `{ scan, limits: { maxBinaryBytes } }`, structurally the `SecretScanner` that `createSecretScanner` returns, so the host can pass the one scanner it configures for pushes. Absent, the manager uses `createSecretScanner()` (`refuse`, default limits): there is no way to build a manager that writes unscanned snapshots.

## Consequence and follow-ups

A workspace holding an untracked, non-ignored file that looks like a secret cannot be backed up, so a finalise, remove or restore that needs a backup refuses until the user ignores or deletes the file. That is the fail-closed choice the gate asks for. Open: the host passing its configured scanner (one line in `bindings/worktrees.ts`); a confirmed variant; the end-to-end gate test through `axis.worktrees/1`.
