# The local checkout in `axis.worktrees/1.list` (DC-7)

Status: contract note for ticket DC-7 (`docs/design/own-shell-plan.md`). Additive within `axis.worktrees/1`.

## 1. Why

The agent home (OS-8) shows a project's **local checkout** (the user's own working tree: `axis-agent-shell.md` §1, "Project")
above its workspaces. The daemon's `list` drops it today: it returns the journal's workspaces and the linked worktrees Axis did
not create, and skips the main entry of `git worktree list`. The Code OSS shell found the checkout by itself (its snapshot
loader read the worktree files); the own shell has no such path, so the daemon must say where the checkout is.

## 2. The wire

- **Request.** `list { projectId, includeLocal?: true }`. Only the literal `true` is accepted (`false` is refused as invalid,
  so the field has one meaning). Without it the reply is exactly today's.
- **Reply.** With `includeLocal`, the list starts with at most one row whose `origin` is the new value `"local"`:

  ```text
  { origin: "local", projectId, branch, head, path, locked: false, present }
  ```

  No `id`, `state`, `baseRef`, `baseSha`, `dirty`, `ahead` or `behind`. The schema refuses any of those on a `"local"` row, and
  refuses `"local"` on a `status` reply.
- **Why opt-in.** Both shell readers on main (`@axis/shell-core` `axisDaemonReplies.ts` and the Code OSS overlay's copy) refuse
  an `origin` they do not know, and refuse the whole reply with it. A client that never sends `includeLocal` gets no new value,
  so no client has to ship in lockstep with the daemon. `@axis/shell-core`'s reader learns `"local"` in the same change.

## 3. Where the row comes from

- The first entry of the `git worktree list --porcelain -z` the daemon already runs for the external rows (same hardened
  runner, same working directory). No new git process, and no process in the checkout itself.
- `branch` is the entry's branch without `refs/heads/` (null when detached), `head` its object id (null on an unborn branch),
  `path` the entry's real path, for display and opening only, and never accepted back as input (as for every row).
- `present` is false when git marks the entry prunable or its directory cannot be resolved.
- **No row** for a bare repository (git lists the bare common directory first), or when the list cannot be read (the
  recorded workspaces are still returned, as today).
- `locked` is always false: git cannot lock a main worktree.
- The row counts toward the list's cap (`MAX_LIST`) and comes first, so a full list still shows it.

## 4. What it never does

- **No status in the user's checkout.** `dirty`, `ahead` and `behind` are left out on purpose. `git status` in a working tree
  can run the repository's own programs (an fsmonitor hook, a clean filter re-reading a racily clean file), and the project
  may be untrusted. The agent home shows "not read", as it already does for a row without counts. A later ticket may add
  counts through the hardened snapshot reader, never through a plain `status`.
- **Nothing operates on it.** The row has no `id`, and every mutating `axis.worktrees/1`, `axis.git/1` and `axis.review/1`
  method names a workspace by journal id. The refusals that keep runs out of the local checkout (ADR 0004 decision 6,
  `axis-agent-shell.md` §1) are unchanged.
- **No new trust.** `list` stays tier 0 for the user (`policy/rules.ts`), allowed for an untrusted project, as today. The
  path is the same kind of information the external rows already carry.

## 5. Tests (written first)

- Protocol: `includeLocal: true` accepted, `false` and other values refused; a `"local"` row with `id`, `state` or `dirty`
  refused; `"local"` refused on a `status` reply; samples updated.
- Daemon, real repositories:
  - without the flag, the reply is unchanged (no `"local"` row);
  - with it, one `"local"` row first, with branch, head and the checkout's real path;
  - detached HEAD (branch null); an unborn branch (head null);
  - a bare repository with a linked worktree: no `"local"` row, and the linked one is still `"external"`;
  - no extra git process: the same count with and without the flag (a git wrapper counts calls);
  - an untrusted project gets the row.
- Daemon mapping (`localInfo`): `refs/heads/` dropped, the zero id read as null, a prunable entry `present: false`. That the
  row comes first under the cap holds by construction (it is pushed before any other row); no test fills 1000 rows.
- `@axis/shell-core` reader: `"local"` read only when `listWorktrees(id, { includeLocal: true })` asked, only first, never in
  a status reply; a local row with workspace fields or `locked: true` refused; an unknown origin still refused.
