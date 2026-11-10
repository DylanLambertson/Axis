# The `merged` outcome and the recorded base tip (FU-WT-BASE2)

`finalise {outcome: "merged"}` is a label: it says the workspace's work is in its base branch. Every input to that check lives in the shared repository, and a finished run can write that repository as the user (threat model R1). FU-WT-BASE judges `merged` against the base branch the journal recorded at create. It looks the branch up by its exact name, turns replace refs off and makes grafts inert. FU-WT-BASE2 adds the commit the base branch held at create, so that a base the run moved away from that commit is no longer accepted.

## What is recorded

- **Journal migration 7, `base_tip`.** (Migration 6 is J2's composer records.) This is the commit the base branch's exact ref held when the workspace was created. It is a full lower-case sha (40 or 64 hex characters), or NULL.
- **Set once, with the branch.** The daemon writes `base_branch` and `base_tip` in one `recordBaseBranch(id, ref, tip, actor)` call while the workspace is CREATING. That call happens in the same transaction that moves the workspace to READY. Two triggers enforce the pairing:
  - A tip can only be written in the UPDATE that first sets the base branch. It cannot be changed or cleared, and it cannot be added later to a row whose branch is already recorded.
  - From this version on, a base branch cannot be recorded without a tip.
- **Older rows stay unattestable.** A workspace from before version 7 (5 or 6) that has a base branch but no tip can never be given a tip. `merged` stays refused for it.
- **Where the tip comes from.** It is the base sha the workspace was made from. The manager keeps a base branch at create only when `show-ref --verify <branch>` gives exactly that sha at that moment. A branch that moved between the two reads, or a base name that resolved to a tag or another ref first, gives no base branch and therefore no attestable merge. The daemon already refuses a create whose base sha differs from its own resolution (`base_moved`).

## The check (`verifyMerged`)

Both callers use it: the manager's normal finalise, which gets the trusted pair from the daemon, and the daemon's repair of an interrupted finalise. The steps run in this order, and each one refuses when it fails:

1. **A full branch name and a recorded tip.** Without both, the result is `no-base-branch` (wire `no_base_branch`).
2. **No graft file.** If one exists, the result is `not-merged`.
3. **The base ref exists under its exact name.** If not, the result is `no-base-branch`.
4. **The base ref is not a symbolic ref.** `show-ref` resolves a symbolic ref silently, so a base pointed at the workspace branch would otherwise pass. If the ref is symbolic, the result is `base-rewritten` (wire `base_rewritten`).
5. **The recorded tip is an ancestor of the base ref's commit.** Any answer other than yes is `base-rewritten`. That includes a tip object that no longer exists.
6. **The workspace head is an ancestor of the base ref's commit.** If so, the result is `merged`; otherwise it is `not-merged`.

On the repair path every refusal is reported as `not_merged`, as before. When the trusted key is passed, the manager does not fall back to its own metadata file. A missing or null `trustedBaseTip` refuses.

## What this closes

- **A base reset to a commit that does not contain the tip.**
- **Rewritten base history.** For example, the tip is amended away and the work is rebased on top and fast-forwarded.
- **A run that moves its own branch off the tip and points the base at it.** This is the one case where git alone would say "merged", because the base does hold the head.
- **A symbolic base.**
- **A deleted base, or a lookalike ref in its place.**
- **A workspace without a recorded tip.**

## What it does not close

A run can fast-forward the base onto its own commits: `git update-ref refs/heads/<base> <its head>`, or the same through a rewritten `packed-refs`. The workspace head descends from the tip, because the workspace was created at the tip, so the new base descends from the tip as well. To refs and history this is identical to a real merge the user made. No check on the shared repository can tell the two apart while a run can still write it. A test in `trusted-base-tip.test.ts` records this residual on purpose.

The cases that remain open:

- A fast-forward of the base onto the run's own commits.
- A run in an earlier workspace that moved the branch a default `HEAD` base resolved to before create. The base is only trusted as of create.
- A forged `objects/info/commit-graph`. The check does not turn the commit-graph off, because the hardened git runner allows no extra `-c` keys.

These stay under threat model WT-3 (residual register RR-7). H10 (the run's process group is gone before finalise) does not mitigate them: it only stops a process that outlives the run, and the ref write can be made while the run is still running, before H10 ever applies. The mitigations are the Phase 3 sandbox, which keeps a run from writing the shared repository's refs at all, or a user confirmation of the merge commit itself. Nothing is lost through these cases: the discard scan, the backup and the archive ref still apply, and only the label is not attestable.
