# `axis.worktrees/1` after P1d

What changed in the protocol and the host rule table (ticket P1d), and what stays open.

## `finalise` is tier 4

- Contract: `sideEffect: "destructive"`, `tier: 4`, idempotency required, and an optional `approval` (a challenge reference) on the request, exactly like `remove`. The daemon requires the field for tier 3 and above.
- Why 4 and not 3: a finalise can discard uncommitted work. The host mints the discard token only inside the approval action, and only for a challenge issued and executed at tier 4 or above (a tier 3 approval has no native dialog, and an issue/execute tier mismatch is refused before the spend). A tier 3 finalise could therefore never discard anything. Tier 3 would have been a method that cannot do its job.
- Flow: the first call answers `E_APPROVAL_REQUIRED` with a challenge (`tier` 4, `nativeConfirmationRequired` true) and shows the native dialog; the user approves in the window and confirms natively; the retry with the same key and `approval` runs. The content hook (fingerprint of what would be discarded, drift check, active-run check) is the one `remove` uses; it refuses before any challenge when the workspace is in the wrong state.
- Rule row: `userRule(4)`, no trust condition (as before).
- A caller written for tier 2 now gets `E_APPROVAL_REQUIRED` on its first call. This is intended.

## `discard`

Request `{ id, paths }`: 1 to 500 workspace-relative paths (the same path schema as `restoreFromRunBase`: no absolute, `..`, `.git`, pathspec-magic or invisible characters). No `hunks` (hunk-level reject is not in 1a, and the strict schema refuses the key until it is added). Response `{ backupRef, discarded }`.

Tier 2, `write`, idempotency required, no approval: the daemon writes a backup commit to `refs/axis/backup/<id>/<ts>` first, so the change is reversible from the backup. The rule row is `registry` trust like `restoreFromRunBase`, since it writes the working tree.

## `setUserEditing`

Request `{ id, paths }`: 0 to 200 relative paths. The list replaces the previous one for the connection's workspace, so an empty list clears it and a repeat is harmless (idempotency `none`). Response `{ id }`. Tier 2, `write`, no trust condition. It is advisory only (policies, advisory user locks): it never authorises or blocks anything.

## Not built yet

`@axis/worktrees` has no discard entry point and no user-editing set, so the host handlers for both methods answer `E_UNAVAILABLE` with the reason `not_available` and touch nothing. The contract, the policy rows and the coverage test are in place so the surface cannot be widened silently when the service lands.
