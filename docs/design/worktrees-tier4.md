# `axis.worktrees/1` after P1d

What changed in the protocol and the host rule table (ticket P1d), and what stays open.

## `finalise` is tier 4

- Contract: `sideEffect: "destructive"`, `tier: 4`, idempotency required, and an optional `approval` (a challenge reference) on the request, exactly like `remove`. The daemon requires the field for tier 3 and above.
- Why 4 and not 3: a finalise can discard uncommitted work. The host mints the discard token only inside the approval action, and only for a challenge issued and executed at tier 4 or above (a tier 3 approval has no native dialog, and an issue/execute tier mismatch is refused before the spend). A tier 3 finalise could therefore never discard anything. Tier 3 would have been a method that cannot do its job.
- Flow: the first call answers `E_APPROVAL_REQUIRED` with a challenge (`tier` 4, `nativeConfirmationRequired` true) and shows the native dialog; the user approves in the window and confirms natively; the retry with the same key and `approval` runs. The content hook (fingerprint of what would be discarded, drift check, active-run check) is the one `remove` uses; it refuses before any challenge when the workspace is in the wrong state.
- Rule row: `userRule(4)`, no trust condition (as before).
- A caller written for tier 2 now gets `E_APPROVAL_REQUIRED` on its first call. This is intended.
- **Pre-release exception to ADR 0003 D2 (2026-11-05).** D2 allows only additive changes inside a major version. Moving `finalise` from `write`, tier 2 to `destructive`, tier 4 with an `approval` field is not additive. It is allowed once, here, because no client of `axis.worktrees/1` has shipped, and every in-repo caller (the host handler, binding, gate, hooks, rule table and tests) is updated in the same change. The decision to raise the tier came from the H8 review (SF-D). After 1a ships, a tier or side-effect change is a policy raise (never a lowering) or a new major version served beside the old one. The ADR carries the same note under D2.

## `discard`

Request `{ id, paths }`: 1 to 500 workspace-relative paths (the same path schema as `restoreFromRunBase`: no absolute, `..`, `.git`, pathspec-magic or invisible characters). No `hunks` (hunk-level reject is not in 1a, and the strict schema refuses the key until it is added). Response `{ backupRef, discarded }`.

Tier 2, `write`, idempotency required, no approval. The daemon writes a backup commit to `refs/axis/backup/<id>/<ts>` first, but **the backup is not complete**: it skips files over the snapshot size limit, ignored files and directories, and entries a snapshot cannot hold (nested repositories and the like). A discard is reversible only for what the backup holds. Because a tier 2 call has no native dialog and this contract has no confirmed variant, the service must **refuse** a request that names, lies inside, or is a directory containing such a path: `E_CONFLICT` with the closed reason `unbacked_data`, before anything is written and without naming the path (`worktrees/discard-backup.ts`, `assertAllBacked`). The reply has an optional `unbacked` field (`count`, plus up to 50 display-escaped paths) for a later confirmed variant; today it is never set. The rule row is `registry` trust like `restoreFromRunBase`, since it writes the working tree.

## `setUserEditing`

Request `{ id, paths }`: 0 to 200 relative paths. The list replaces the previous one for workspace `id`, so an empty list clears it and a repeat is harmless (idempotency `none`). Response `{ id }`. Tier 2, `write`, no trust condition. It is advisory only (policies, advisory user locks): it never authorises or blocks anything. Only the `user` actor may set or clear the set (the policy row and the handler both check it), so an agent cannot clear it to get past a refusal.

## Not built yet

`@axis/worktrees` has no discard entry point and no user-editing set, so the host handlers for both methods answer `E_UNAVAILABLE` with the reason `not_available` and touch nothing. The contract, the policy rows and the coverage test are in place so the surface cannot be widened silently when the service lands.

## For the service ticket

- `discard` and `setUserEditing` each need an audit action declaration (design 4.2.1 coverage); the handlers append nothing while they refuse.
- The host-local reason set (`not_available`, `unbacked_data` and the rest in `worktrees/errors.ts`) is not in `@axis/protocol`, so clients cannot learn it from the contract. Track it with the other P1d+ items.
- Make `paths` unique in both requests (duplicates are accepted today, as in `restoreFromRunBase`).
- The service must call `assertAllBacked` with the current scan before the backup is written, and the check and the restore must run under the workspace lock.
