# Hunks and a built selection in `axis.review/1` (DC-2)

Status: contract note for ticket DC-2 (`docs/design/own-shell-plan.md`), for review before any code. Additive within
`axis.review/1`: two new methods; `diff`, `content` and `complete` are unchanged.

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
- **`versionId`** (NEW): `sha256` over the file's old mode, old object id, new mode, new object id, its old path for a
  rename, and its protected flag, in one fixed encoding, cut to the `contentIdSchema` form. It is in every `hunks` reply,
  and every selection item must carry it: if anything about the file changed since the user looked (either side, a mode,
  a rename, its protected flag), the item names another version and the build is refused. A whole-file `+` therefore
  commits exactly the version the user saw, which is stronger than `diff` today (there the tree is minted in the same
  round the user is shown).
- **`hunkId`**: `@axis/review`'s `hunkId` (`<index>:<16 hex of the hunk's digest>`), meaningful only together with its
  file's `versionId`.

## 3. `hunks` (read, tier 1, user only)

- Request: `{ workspaceId, fileId }`.
- Reply: `{ head, fileId, versionId, hunks?: HunkWire[], fileLevelReason?: <closed set> }`. Exactly one of `hunks` and
  `fileLevelReason` is present.
  - `HunkWire` = `{ id, header, lines: [{ kind: " " | "-" | "+", text, eol: "lf" | "crlf" | "none", truncated }],
    truncated }`. `text` is the view's escaped text (`hunkView`); a cut line is marked only by its flag.
  - `fileLevelReason` comes from a closed set: the review's own reasons (`binary`, `too_large`, `unreadable`,
    `diff_failed`, `patch_too_large`, `too_many_hunks`, `malformed`, `no_content_change`, `not_reproducible`) and the
    file-level reasons of `reviewFileSchema`. Unknown values are refused by the schema and mapped to `unreadable` by the
    handler.
- **Bounds** (the message walk allows 10,000 values and 1 MiB):
  - at most `MAX_WIRE_HUNKS` hunks (the review's `maxHunksPerFile`, at most 200);
  - at most `MAX_WIRE_HUNK_LINES` lines in the whole reply (proposed 4,000);
  - each line's `text` at most `maxDisplay × 4` characters, as the view cuts it.

  A file over those bounds gets `fileLevelReason: "too_large"` (a whole-file decision only), never a partial list.
- Refusals: the `diff` set (`too_large`, `not_found`, `snapshot_failed`, `no_head` and the rest), plus `E_NOT_FOUND`
  `file_not_found` for a `fileId` not in this round (the file was committed, reverted or renamed).
- A `fileId` with an unusable path or a content filter answers `fileLevelReason` (`unsafe_path`, `filtered_path`); such a
  file cannot be selected at all (section 4).

## 4. `build` (write of objects only, tier 1, user only)

- Request:

  ```text
  { workspaceId, head,
    selection: [ { fileId, versionId, whole: true, acknowledged?: true }
               | { fileId, versionId, hunkIds: [id, ...], acknowledgedHunkIds?: [id, ...] } ] }
  ```

  The array has 1 to `MAX_REVIEW_FILES` items, unique by `fileId`. `hunkIds` has 1 to `MAX_WIRE_HUNKS` items, unique;
  `acknowledgedHunkIds` must be a subset of `hunkIds`. The schema refuses anything else.
- **Tier and effect.** Like `diff`, it writes git objects only (a tree, blobs for partial files). The worktree, the index
  and the refs are untouched, so it is `sideEffect: "read"`, tier 1, with no idempotency key: a repeat builds the same
  tree. The commit stays `axis.git/1.commit` at tier 2.
- **Checks, in order. Any failure refuses the whole build; nothing is registered.**
  1. **`head`.** The round's HEAD must equal the request's `head`; otherwise `E_CONFLICT` `head_moved`. The checked-out
     branch must be the workspace's own `axis/<slug>` branch from the journal; otherwise no tree is minted
     (`E_CONFLICT` `not_head`, the same withholding `diff` applies).
  2. **Version.** Every `fileId` must be in this round with the same `versionId`; otherwise `E_CONFLICT`
     `selection_stale`. The UI then re-reads `diff` and `hunks`.
  3. **Usable.** No unusable path, no content filter: `E_POLICY_DENIED` `unsafe_path` or `filtered_path` (the review's
     own refusals).
  4. **Whole file.** `acceptFile(path, { acceptTruncated })`, where `acceptTruncated` is true only when the item says
     `acknowledged: true` AND `hasCutLines(path)` is true for this round (the `versionId` pins the content, so a boolean
     acknowledgement cannot be carried over to other bytes). A cut file without it is refused: `E_POLICY_DENIED`
     `truncated_hunk`, as in `@axis/review`.
  5. **Hunks.** `hunks(path)` is loaded in this round; each id must be one of its hunks, else `E_CONFLICT`
     `selection_stale`. Then `acceptHunk(path, id, { acceptTruncated })`, true only for an id in `acknowledgedHunkIds`
     whose hunk is `truncated` in this round. A truncated hunk without it is refused (`truncated_hunk`). A file that
     offers only a whole-file decision refuses `hunkIds`: `E_INVALID_ARGUMENT` `no_hunks`.
  6. **Build.** `round.build()`, which re-checks the cut lines over every accepted byte and that HEAD did not move.
- **Registration.** As `diff` does after its build, in the same order: `journal.recordReviewedTree(workspaceId, tree,
  userPrincipal())`, then `trees.record({ workspaceId, treeHash, parent, branch, handle })`.
  - The binding (`handle`) carries the round's snapshot tree, so `prepareCommit`'s `assertReviewFresh` refuses the commit
    (`stale`) if any file of the worktree changed after the build, selected or not, as for `diff`.
  - `axis.git/1.commit` needs no change: it looks the tree up in the same registry.
- **Audit.** One `review.acknowledge` event per first acknowledgement in the round, by `fileId` only, as `diff` writes
  today. A hunk acknowledgement is logged with its `fileId` and a count, never the hunk text. Nothing else is audited:
  the commit is audited when it lands.
- Reply: `{ head, branch, treeHash, selection }`. `selection` is what the tree holds, in request order:
  - a file whose every hunk was selected comes back as `{ fileId, versionId, whole: true }`, because `@axis/review`
    turns every hunk into the whole file, mode and rename included (design §5);
  - every other item comes back as asked.

  The UI shows this set; it is the one that produced `treeHash`.

## 5. What it never does

- No path on the wire in either direction. The display path is in `diff`.
- No content beyond what `hunkView` already escapes and bounds, and none for a file `diff` marks `unsafePath`.
- Not for agents: policy rows for both methods admit the `user` actor only (`userRule(1)`), and both handlers refuse any
  other actor themselves, as `diff` does (`E_NOT_FOUND`).
- An untrusted project can call `hunks` (read). `build` mints a tree only for a READY workspace's own branch. The commit
  keeps its trust gate.

## 6. Tests (written first)

- Protocol:
  - every schema guarded, bounds enforced, samples;
  - exactly one of `hunks` and `fileLevelReason`;
  - `acknowledgedHunkIds` ⊄ `hunkIds` refused;
  - a duplicate `fileId` refused;
  - an empty selection refused.
- Daemon, real repositories through the composed handlers:
  - a two-hunk file and an untouched file: select hunk 1 only, commit with the built tree, and the commit holds hunk 1 and
    not hunk 2, the other file unchanged, the parent the reviewed head;
  - every hunk selected comes back `whole: true`, and a mode change is committed with it;
  - a whole-file `+` of one file of two;
  - a stale `versionId` (the file edited after `hunks`) refuses `selection_stale`;
  - a forged or foreign `hunkId` refuses `selection_stale`;
  - a moved HEAD refuses `head_moved`;
  - a truncated hunk without acknowledgement refuses `truncated_hunk`, and with it builds, with one audit event;
  - a cut whole file needs `acknowledged: true`;
  - `hunkIds` on a binary file refuses `no_hunks`;
  - an agent actor gets `E_NOT_FOUND`;
  - a file edited after `build` makes the commit `stale`;
  - a tree that `build` minted for workspace A is `stale` for workspace B.
- Mutants to kill:
  - no `versionId` check;
  - an acknowledgement applied without the round's own truncated flag;
  - no head check;
  - registration before the reply is validated;
  - a partial selection reported as `whole`.
