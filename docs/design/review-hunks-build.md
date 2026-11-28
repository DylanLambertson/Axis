# Hunks and a built selection in `axis.review/1` (DC-2)

Status: contract note for ticket DC-2 (`docs/design/own-shell-plan.md`), round 2, for review before any code. Additive
within `axis.review/1`: two new methods; `diff`, `content` and `complete` and their strict replies are unchanged (no
`versionId` is added to them; see `docs/packages/protocol.md` on changing a strict reply).

## 0. Prerequisite: one cut-line predicate in `@axis/review` (REV-1)

DC-2 relies on the core's cut-line gate, and the gate had a gap: `lineCut` stripped a trailing CR before counting, while
`hunkView` stripped it only before an LF. A final line with no newline ending in a bare CR, at exactly the view's width
plus the CR, was shown cut (`lines[i].truncated`) but counted as uncut by `hunkTruncated` and `hasCutLines`. So
`acceptHunk` and `build()` accepted the hidden CR without an acknowledgement. The whole-file preview hid that CR too.

The fix (`fix/review-bare-final-cr`, its own small PR with its own security review) lands before any DC-2 code:

- One function, `viewLine(text, terminated, limits)` in `preview.ts`, decides what the view shows of a line and whether it
  cut it. A CR is a line end only when an LF follows it; a bare final CR is content, shown escaped (`\r`) or cut.
- `hunkView`, `hunkTruncated` (hunk accept and the build recheck), `previewSide` and `textCut` (whole-file accept and
  its build recheck) all call it. The view's flag and the gate can no longer disagree.
- Tests at the exact bound, from the review's regression: a changed and a removed final line of width plus a bare CR are
  refused without the acknowledgement and build their exact bytes with it; width minus one plus a CR shows the CR and needs
  none; a CRLF line of exactly the width is not cut; an added file whose last line is width plus a bare CR is cut in the
  preview, in `hasCutLines` and at build.

Any further cut DC-2 makes on the wire (section 3) goes through the same gate: DC-2 never shortens a line itself.

## 1. Why

The Changes module v1 (OS-15) offers **+** and **-** per file and per hunk and commits exactly the set the user built.
`@axis/review` already has all of it in `ReviewSession`: `hunks(path)` (parsed, proven to rebuild the new file exactly),
`acceptFile` and `acceptHunk` with the cut-line gate (`acceptTruncated`), and `build()`, which writes the tree of the
accepted set and mints the binding `prepareCommit` checks. What is missing is the wire (`protocol/src/review.ts` says "no
hunk API"), the handlers, and registering a built tree so that `axis.git/1.commit` accepts it as it accepts a `diff` one.

## 2. Identities

Every request opens a NEW review round (one read of the worktree), as `diff` does; nothing is held between requests except
the reviewed-tree registry. So a selection names things that survive between rounds only while they are unchanged:

- **`fileId`**: as in `diff` (`review-wire.ts` `fileIdOf`: from the repository path, never the path itself).
- **`versionId`** (NEW): `sha256` over `["axis.review.version/1", oldMode, oldOid, newMode, newOid, oldPath ?? null,
  protectedPath]` as canonical JSON, cut to the `contentIdSchema` form. `newOid` is the snapshot blob (`snapshot.ts`
  writes it with a private-index `add -A`), not file metadata, so an edit changes it and an exact revert restores it. The
  host's `RoundFile` gains `oldMode` and `oldOid` for this. Every `hunks` reply carries the `versionId`, and every selection
  item must carry it. If anything about the file changed since the user looked (either side, a mode, a rename, the protected
  flag), the item names another version and the build is refused. So a whole-file `+` commits exactly the version the
  user saw, which is stronger than `diff` today (there the tree is minted in the same round the user is shown).
- **`hunkId`**: `@axis/review`'s `hunkId` (`<index>:<16 hex of a digest over the header and the lines>`), meaningful only
  together with its file's `versionId`. Identical bodies at different places have different ids.

## 3. `hunks` (read, tier 1, user only)

- Request: `{ workspaceId, fileId }`.
- Reply: `{ head, fileId, versionId, hunks?: HunkWire[], fileLevelReason?: HunkFileLevelReason }`. Exactly one of `hunks`
  and `fileLevelReason` is present.
  - `HunkWire` = `{ id, header, lines: [{ kind: " " | "-" | "+", text, eol: "lf" | "crlf" | "none", truncated }],
    truncated }`, straight from `hunkView` (section 0). `text` is escaped; a cut line is marked only by its flag.
- **`HunkFileLevelReason`** is a NEW closed enum exported from `@axis/protocol` (`reviewHunksFileLevelReasonSchema`),
  listing every reason the core and the list produce today:
  - from the list (`changes.ts`): `unsafe_path`, `filtered_path`, `attributes_untrusted`, `added`, `deleted`,
    `type_change`, `binary`, `symlink`, `submodule`, `too-large` (the change kind: over the snapshot preview size),
    `no_content_change`, `not_a_regular_file`;
  - from loading the hunks (`session.ts`, `hunks.ts`): `unreadable`, `too_large` (over `maxHunkFileBytes`), `diff_failed`,
    `patch_too_large`, `malformed`, `too_many_hunks`, `not_reproducible`;
  - NEW for the wire: `over_view_budget` (the hunks exist but the reply would not fit the bounds below).

  The handler maps the core's string through this enum, and anything else becomes `unreadable`. The old `diff` schema keeps
  its open `displayTextSchema(128)` field, so `diff` is unchanged. `too-large` and `too_large` are different reasons, kept
  as the core spells them. The test lists every value the core can return.
- **Bounds.** The units are UTF-16 code units of the escaped text, as `review.content` counts them:
  - `MAX_HUNKS_REPLY_HUNKS` = 200 (the core's `maxHunksPerFile` is at most this);
  - `MAX_HUNKS_REPLY_LINES` = 1,500 lines in the whole reply. Each line is an object and four values, so lines and hunks
    together stay under 9,000 of the message walk's 10,000 values, with room for the envelope;
  - `MAX_HUNK_LINE_CHARS` = 9,216 per line. At the host's `maxDisplay` of 256 the core keeps at most 1,024 code points,
    and one escaped code point is at most 9 units (`\u{e0fff}`). The binding pins `maxDisplay` at 256 for this, and the
    schema refuses a longer line, so it can never be cut silently;
  - `MAX_HUNKS_REPLY_CHARS` = 131,072 units of `text` in the whole reply (at most 3 UTF-8 bytes a unit, so under 400 KB,
    far inside the 1 MiB message and below the 262,144-byte string ceiling for every single field).
- **Fallback, all or nothing.** The handler builds the complete candidate reply, then checks it against the four bounds
  and runs `inspectMessage` on it with headroom (at most 9,000 values and 900 KiB). If any check fails, the reply is
  `fileLevelReason: "over_view_budget"` with no hunks, never a partial list. Such a file can still be taken whole (section
  4). That whole-file accept without seen hunks is the existing RR-10 residual, not something new, and this note does not
  close it.
- Refusals (section 5): the `diff` set (`too_large`, `snapshot_failed`, `no_head` and the rest), plus `E_NOT_FOUND`
  `file_not_found` for a `fileId` not in this round (the file was committed, reverted or renamed).

## 4. `build` (write of objects only, tier 1, user only)

- Request:

  ```text
  { workspaceId, head,
    selection: [ { fileId, versionId, whole: true, acknowledged?: true }
               | { fileId, versionId, hunkIds: [id, ...], acknowledgedHunkIds?: [id, ...] } ] }
  ```

  - The array has 1 to `MAX_REVIEW_FILES` (200) items, unique by `fileId`.
  - `hunkIds` has 1 to 200 items, unique. `acknowledgedHunkIds` must be a subset of `hunkIds`.
  - Across the whole selection, `hunkIds` plus `acknowledgedHunkIds` hold at most `MAX_SELECTION_HUNK_IDS` = 2,000 ids.
    200 files of 200 hunks, with acknowledgements, would not fit the 10,000-value message.

  The schema refuses anything else.
- **Tier and effect.** Like `diff`, it writes git objects only (a tree, blobs for partial files). The worktree, the index
  and the refs are untouched, so it is `sideEffect: "read"`, tier 1, with no idempotency key: a repeat builds the same tree.
  The commit stays `axis.git/1.commit` at tier 2 with its project trust gate.
  - The snapshot writes the objects of every changed, non-ignored file, even for a build that is then refused. Changing
    content repeatedly leaves unreachable objects until git's own maintenance. That is the cost `diff` already has.
  - Nothing promises a bounded repository size or per-project serialisation, and the daemon never prunes the user's
    repository.
- **Checks, in order. Any failure refuses the whole build; nothing is registered.**
  1. **`head`.** The round's HEAD must equal the request's `head` (`E_CONFLICT` `head_moved`). The checked-out branch must
     be the workspace's own `axis/<slug>` branch from the journal (`E_CONFLICT` `not_head`, the same withholding `diff`
     applies).
  2. **Version.** Every `fileId` must be in this round (`E_NOT_FOUND` `file_not_found`), with the same `versionId`
     (`E_CONFLICT` `selection_stale`). The UI then re-reads `diff` and `hunks`.
  3. **Usable.** No unusable path, no content filter: `E_CONFLICT` `unsafe_path` or `filtered_path` (the core's refusals,
     mapped as `review-errors.ts` maps them today).
  4. **Whole file.** `acceptFile(path, { acceptTruncated })`. `acceptTruncated` is true only when the item says
     `acknowledged: true` AND `hasCutLines(path)` is true for this round. The `versionId` pins the content, so a boolean
     acknowledgement cannot carry over to other bytes. A cut file without it is refused: `E_CONFLICT` `truncated_hunk`.
  5. **Hunks.** `hunks(path)` is loaded in this round, and each id must be one of its hunks (`E_CONFLICT`
     `selection_stale`). Then `acceptHunk(path, id, { acceptTruncated })`: true only for an id in `acknowledgedHunkIds`
     whose hunk is `truncated` in this round. A truncated hunk without it is refused (`E_CONFLICT` `truncated_hunk`). A file
     that offers only a whole-file decision (any `fileLevelReason`, `over_view_budget` included) refuses `hunkIds`:
     `E_INVALID_ARGUMENT` `no_hunks`.
  6. **Build.** `round.build()` re-checks the cut lines over every accepted byte with the section 0 predicate, and checks
     that HEAD did not move.
- **Reply before effects.** As `diff` does, the reply is validated (strict schema and `inspectMessage`, with a placeholder
  tree id of the right length) after step 3 and before any acceptance, audit or registration. A reply that fails is
  `E_INTERNAL`, and neither the journal nor the registry changed.
- **Registration.** As `diff` does after its build, in the same order: `journal.recordReviewedTree(workspaceId, tree,
  userPrincipal())`, then `trees.record({ workspaceId, treeHash, parent, branch, handle })`. A cancellation before the
  journal write registers nothing.
  - The binding (`handle`) carries the round's snapshot tree. So `prepareCommit`'s `assertReviewFresh` refuses the commit
    (`stale`) if any eligible file of the worktree changed after the build, selected or not, as for `diff`. Ignored and
    size-skipped files are not part of the snapshot and are not covered, as today.
  - `axis.git/1.commit` needs no change: it looks the tree up in the same registry, by workspace and tree.
  - Staging (DC-0) is untouched: the commit keeps the user's index as `executeCommit` does. An unselected edit stays
    unstaged (` M`), or staged (`M `) if it was. A pre-staged unselected edit can show `MM`, with no bytes lost. The
    integration tests pin these three states.
- **Audit.** One `review.acknowledge` event per file whose acknowledgement (whole or any hunk) was first applied in the
  session (workspace, connection, head: `diff`'s `acks.isFirst` key), with the `fileId` only. This is the event and payload
  `diff` writes today: no count, no hunk id, no text, so the sink and its payload allow-list are unchanged. The daemon's
  ordinary policy decision rows are written as for every call; the commit is audited when it lands. If the event cannot be
  written, the build fails closed (`E_INTERNAL`, as `diff`) before anything is registered.
- Reply: `{ head, branch, treeHash, selection }`. `selection` is what the tree holds, in request order:
  - a file whose every hunk was selected comes back as `{ fileId, versionId, whole: true }`, because `@axis/review` turns
    every hunk into the whole file, mode and rename included (design §5);
  - every other item comes back as asked.

  A partial selection of a renamed file moves the path and keeps the old mode (review-core section 5). The UI shows that
  with the selection; this set is the one that produced `treeHash`.

## 5. Errors on the wire

A handler cannot raise `E_POLICY_DENIED`: the daemon turns it into `E_INTERNAL` (`daemon/src/errors.ts`), because that
code is reserved for the daemon's own audited policy decisions. Both handlers therefore use only the handler codes. Every
`reason` comes from a closed enum exported from `@axis/protocol`, and every message is fixed text with no path:

| Code | Reasons (`reviewHunksReasonSchema`, `reviewBuildReasonSchema`) |
|---|---|
| `E_CONFLICT` | `head_moved`, `not_head`, `selection_stale`, `unsafe_path`, `filtered_path`, `truncated_hunk`, `operation_in_progress`, `snapshot_failed`, plus the `diff` conflict reasons |
| `E_NOT_FOUND` | `file_not_found` (the `fileId` is not in this round); a missing workspace carries no reason, as today |
| `E_INVALID_ARGUMENT` | `no_hunks`, `too_large` (too many changed files, as `diff`) |
| `E_UNAVAILABLE`, `E_CANCELLED`, `E_INTERNAL` | no reason |

- `review-errors.ts` `mapRefusal` gains these reasons. It stays exhaustive: a core code it does not know is `E_UNAVAILABLE`,
  and a reason outside the enum is dropped.
- A request the schema refuses is the envelope's `E_INVALID_ARGUMENT` before any handler runs. The generic envelope errors
  (cancel, timeout, backpressure, unavailable, internal) are separate from these sets.
- Tests read the code and the reason as the CLIENT sees them, through the composed daemon, for every row.

## 6. What it never does

- No path on the wire in either direction: the display path is in `diff`. (Hunk text is file content and may itself
  contain a path string; the rule is about the addressing fields.)
- No content beyond what `hunkView` escapes and bounds, and none for a file `diff` marks `unsafePath` or `filtered`. NUL
  and control bytes are escaped, never sent raw. Invalid UTF-8 cannot pass the round-trip proof (`not_reproducible`).
- No path, content, selection or hunk text in a log or an audit row.
- Not for agents. Both methods admit the `user` actor only (`userRule(1)`), and both handlers also refuse any other actor
  themselves, as `diff` does (`E_NOT_FOUND`). They join `PLUGIN_DENY_METHODS` explicitly and stay outside `WEB_ALLOWED`, as
  `content` does. The messaging CLI endpoint has no route to them.
- An untrusted project can call `hunks` (read). `build` mints a tree only for a READY workspace's own branch. The commit
  keeps its trust gate.
- No new residual, and RR-10 (unseen whole, binary and oversized acceptance) stays open. If one is needed, the next free
  number at main is RR-100, rechecked before use.

## 7. Compatibility

- New methods, with the existing strict replies unchanged: additive within major 1.
- Old clients keep calling their old methods.
- A newer shell talking to an older daemon cannot tell from the major version that the methods exist. It ships in lockstep,
  or treats the unknown-method refusal as "per-hunk review unavailable" and offers only whole files.
- The "no hunk API" comment in `protocol/src/review.ts` and the method lists are updated with the code.
- DC-2 enables OS-15's selection. Discard (DC-4) still needs its own binding and backups, and OS-13 stays whole-tree.

## 8. Tests (written first)

- Protocol:
  - every schema guarded and strict, with samples;
  - exactly one of `hunks` and `fileLevelReason`;
  - `acknowledgedHunkIds` ⊄ `hunkIds`, a duplicate `fileId`, an empty selection and 2,001 ids are refused;
  - every `HunkFileLevelReason` value accepted, an unknown one refused;
  - boundary replies at each bound (1,500 lines, 131,072 units, a 9,216-unit line of escaped astral and bidi code points)
    PASS the production `inspectMessage` and envelope schema, and one past each bound is refused.
- Daemon, real repositories through the composed handlers (the client-observed reply):
  - a two-hunk file and an untouched file: select hunk 1 only, commit with the built tree. The commit holds hunk 1 and not
    hunk 2, the other file is unchanged, and the parent is the reviewed head. Then the three staging states of section 4;
  - every hunk selected comes back `whole: true`, and a mode change and a rename are committed with it;
  - a whole-file `+` of one file of two;
  - a stale `versionId` refuses `selection_stale`: the file edited after `hunks`, a mode change, a file replaced by a
    symlink. An exact revert is the same version and builds;
  - a forged or foreign `hunkId` refuses `selection_stale`, and an unknown `fileId` refuses `file_not_found`;
  - a moved HEAD refuses `head_moved`, and a detached or foreign branch refuses `not_head`;
  - a truncated hunk without acknowledgement refuses `truncated_hunk`, and with it builds, with one audit event. This
    includes the section 0 bare-CR final line;
  - a cut whole file needs `acknowledged: true`;
  - `hunkIds` on a binary file, on an added file and on an `over_view_budget` file refuses `no_hunks`;
  - a file over each reply bound answers `over_view_budget`, never a partial list;
  - every refusal of section 5, its code and reason as the client sees them, and that a hostile file name never appears
    in a message;
  - an agent actor gets `E_NOT_FOUND`, and a plugin and a web caller are denied by policy;
  - a file edited after `build`, selected or not, makes the commit `stale`;
  - a tree that `build` minted for workspace A is `stale` for workspace B;
  - classifications, with real git: binary, invalid UTF-8, empty added file, deletion, symlink and type change, a gitlink,
    intent-to-add, an untracked addition, and a 100 MiB single-line file skipped.
- Mutants to kill:
  - no `versionId` check;
  - an acknowledgement applied without the round's own truncated flag. Passing `acceptTruncated: true` for an uncut hunk
    builds the same tree, so the test asserts the option at the port boundary (a recording round) and the audit effect,
    not only that the build succeeds;
  - no head check;
  - registration before the reply is validated: an invalid-reply fixture, asserting that the journal and the registry both
    stayed unchanged;
  - registration after a failed audit write, or after a cancellation;
  - a partial selection reported as `whole`;
  - the candidate reply not inspected before it is sent (a reply over the value bound must become `over_view_budget`).
