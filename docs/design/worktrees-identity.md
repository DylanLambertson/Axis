# Worktree identity and the restore write (FU-WT-EXPECTED, FU-WT-FD)

## The expected worktree

A path names a workspace only at the instant it was resolved. A directory or symlink swapped in under the same path
later leads to another workspace, and the path alone cannot tell. So every path-based entry point of
`@axis/worktrees` takes the workspace the caller already resolved as an `ExpectedWorktree` (`{ path, id }`: the
canonical root and the workspace id) and refuses with `E_POLICY_DENIED` when the path no longer leads to exactly it:

| Entry point | Shape |
| --- | --- |
| `status`, `assertNoDrift` | `(path, expected, opts?)` |
| `previewDiscard` | `(path, expected)` |
| `finalise`, `remove` | `{ path, expectedWorktree, ... }` |
| `restoreFromRunBase` | `{ path, expectedWorktree, ... }` (was optional; now mandatory) |

The checks, all run under the workspace lock after the record is re-read:

1. A missing or malformed expected worktree is `E_INVALID_ARGUMENT` before any disk is read.
2. Operations on a root (`reason: symlink-component`, `worktree-mismatch`): the path must equal the expected path
   lexically and `realpath` must equal it, so neither the root nor a parent of it is a symlink. A restore path must lie
   under the expected root with no symlinked parent (as before).
3. Identity (`reason: worktree-mismatch`): the id in the record the path now leads to must equal the expected id, and
   the expected path must canonicalise to the worktree git reports. A clean finalised workspace B moved into the place
   of A is refused by the id, since the path is the same.
4. `remove` re-resolves the repository location of the path immediately before the first destructive git call
   (`worktree unlock`), so a swap during the confirmation and backup steps is refused too.

The daemon host passes `{ path: <locator workTree>, id: <workspace id> }` at every call (service, content hooks,
reconcile, finalise recovery and the git port's drift check, which finds the workspace by its registered path in the
journal and refuses when there is not exactly one).

`takeGitSnapshot` and `acknowledgeDrift` still take a bare path; they are not in the ticket and are not used by the
host.

## The restore write

`writeRestoredEntry` creates the temp file of a regular file through a `FileHandle` opened with
`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` (`O_NOFOLLOW` where the platform defines it), takes its identity with `fstat` on
that handle, writes and `fchmod`s through the handle. The device and inode of the parent directory are recorded before
the temp file exists and compared again just before the rename and once more after it; just before the rename the temp
path must still name the same device and inode. Any mismatch is `E_POLICY_DENIED` and the cleanup unlinks the temp file
by the path it was opened under only while that path still names the inode that was created. A symlink entry is
created with `symlink`, since a symlink cannot be opened for writing; its identity is the `lstat` of the new link.

Residual (unchanged in kind, narrower in time): Node has no `openat`/`renameat`, so a parent swapped in the instant
between the last check and the rename can still place the file outside the worktree. The full fix is a
descriptor-relative write in the pty or helper layer or the Phase 3 sandbox.
