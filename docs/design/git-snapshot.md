# Git snapshot (`@axis/git-snapshot`)

> Phase 1a · design for GIT-SNAP-1, WT-2 (CLI side), WT-3 highlighting and WT-4. Source of the requirements: `docs/ROADMAP.md` (Phase 1a gate), `docs/design/axis-agent-shell-policies.md` §6.4, threat model rows WT-2, WT-3, GIT-SNAP-1, GIT-4 and gaps G-3 to G-6.

## 1. Scope

A package of pure logic over two directory paths: a worktree and its `$GIT_COMMON_DIR`. It reads files and never runs `git`, never writes, and does not depend on the worktree manager. The daemon decides **when** to take a snapshot (worktree creation, before and after a CLI run, before commit and push, on status refresh) and **where** to keep it (the journal). This package supplies:

1. `takeSnapshot` / `takeStableSnapshot`: the GIT-SNAP-1 set, with bounded memory and time.
2. `diffSnapshots`: a structured before/after diff for display, redacted.
3. `judgeDrift` / `acknowledgeDrift`: the verdict that Axis commit and push consult.
4. `classifyPath` / `classifyPathResolved`: the WT-3 protected-path matcher.

Not in this package: snapshot refs (`refs/axis/runbase|backup|archive`), their retention (policies §7) and the push-side refusal. The snapshot only **observes** `refs/axis/*`; creating, expiring and never pushing them belongs to the snapshot-refs ticket and to `@axis/git-ops`.

## 2. What is read

| Group | Items | Blocks commit and push |
|---|---|---|
| config | `$GIT_COMMON_DIR/config`, `config.worktree` (main and `worktrees/*`), and every file reached by `include.path` / `includeIf.*.path` (all conditions assumed true) | yes |
| hooks | every file in `$GIT_COMMON_DIR/hooks`: type, mode, SHA-256, text | yes |
| in-tree hooks | the target of every `core.hooksPath` value (relative values resolve against the worktree, so an in-worktree directory is hashed, recursively and bounded), plus `.husky/`, `.githooks/`, `lefthook*.y(a)ml` and `.pre-commit-config.yaml` of the worktree | yes |
| attributes | `info/attributes`, `info/exclude`, and the targets of `core.attributesFile` / `core.excludesFile` | yes |
| link | the worktree `.git` file, `worktrees/*/gitdir`, `worktrees/*/commondir`, and, when the caller passes the journal's git dir, a mismatch check | yes; a mismatch is **refused**, not acknowledgeable |
| settings | parsed from the config files above: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `url.*.insteadOf`, `remote.*.url`/`pushurl`, `credential.*`, `filter.*`, `diff.*`, `merge.*`, `alias.*`, `protocol.*`, `include*`, `gpg.*`, `http.*` and others (see `settings.ts`). Derived from the file contents, so they add no digest input of their own | via the files |
| refs | `refs/axis/*` from loose refs and `packed-refs` | no (notice only: Axis itself writes them) |

Global and system config, the home directory and submodule git dirs (`modules/*`) are not read (ADR 0004 states the first two; the third is an open question).

Values are not interpreted by running git. The config parser follows git-config(1) (sections, quoted subsections, escapes, continuations, comments, BOM, CRLF). A line it cannot parse is recorded and the whole-file hash still covers it.

## 3. Snapshot

Plain JSON: `{ version, takenAtMs, worktreePath, commonDir, entries[], settings[], incomplete[] }`. An entry holds `state` (`file`, `dir`, `symlink`, `missing`, `other`, `unreadable`, `oversize`, `unstable`), mode, size, SHA-256, symlink target, and the **redacted** text (first 16 KiB, text only). Raw text is never kept: URLs with credentials, authorization headers, token shapes and secret-named assignments are replaced using the `@axis/audit` redactor plus config-aware rules (credentials also hide in `url.<base>.insteadOf` subsections). The hash is of the raw bytes, so a rotated secret still shows as "changed" without showing either value.

The digest covers the blocking entries only (id, state, mode, size, hash, link target), never timestamps or text.

**Bounds** (`Limits`, all overridable): 4096 entries, 4 MiB parsed per config file, 16 MiB hashed per file, 128 MiB read in total, 16 KiB text per entry, 10 s wall clock, include depth 10 and 64 include files, and an `AbortSignal`. Exceeding a bound, an unreadable item, or a file that changes while read (size, mtime and ctime are compared around the read; two retries) makes the snapshot **incomplete**: it names the item, and no verdict over it can be acknowledged. Nothing is silently skipped.

`takeStableSnapshot` takes two snapshots and returns the first only if the digests agree (three attempts), so a re-take before commit or push is not a mix of two states. It does not remove the race with a writer that is still running: the daemon refuses commit and push while a CLI run is active (policies §6.1).

## 4. Diff

`diffSnapshots(before, after)` returns `changes[]` (added, removed, modified, mode or type change, became incomplete) with a flag label, a blocking bit, redacted before and after views and a bounded line delta, `settingChanges[]` (key-level, for the flags such as "core.hooksPath set to a path inside the worktree"), and `flags[]` for the dashboard row. Control characters and bidirectional or invisible format characters are escaped; counts and sizes are capped. Output is checked in tests for planted secrets.

## 5. Verdict

`judgeDrift({ baseline, current, acknowledgement })` returns one of:

- `clean`: digests equal. No flag.
- `acknowledged`: differs, but the user acknowledged exactly this digest. Allowed.
- `unacknowledged`: differs. Not allowed; carries the diff.
- `refused`: incomplete snapshot (either side) or a worktree-link mismatch. Not allowed, and `acknowledgeDrift` throws `E_POLICY_DENIED` for it.

An acknowledgement binds the digest of the state the user reviewed, so any further change invalidates it. Because legitimate git use also edits `config` (for example setting an upstream), the daemon re-baselines after its own operations; any other config churn needs one acknowledgement. Persisted snapshots are re-validated with `parseSnapshot` (zod) before use.

## 6. Protected paths (WT-3)

`classifyPath(relPath)` is lexical and `classifyPathResolved(root, relPath)` also follows symlinks (hop-limited, dangling links included) and reports a path whose resolution lands in a protected path, or outside the root. Matching is case-insensitive on every platform (a false highlight is harmless; a miss on a case-insensitive volume is not), compares after Unicode NFKC normalisation, ignores HFS+ ignorable code points, NTFS trailing dots and spaces, alternate data streams and `NAME~1` short names, and accepts `\` as a separator. The list is data: `.github/workflows/` and `.github/actions/`, `.vscode/`, `.devcontainer*`, `.husky/`, `.githooks/`, `lefthook*`, `.pre-commit-config.yaml`, CI configs (GitLab, CircleCI, Azure, Jenkins, Travis, Buildkite, Drone, Bitbucket, AppVeyor), Dockerfile-likes and compose files, `package.json`, `.npmrc` and the other package-manager rc files, `.envrc`, `Makefile`, `.mcp.json`, `.gitmodules`, `.gitattributes`, and any `.git` component at any depth. Hard links are not detectable by path.

## 7. Open questions

- Submodule git dirs (`$GIT_COMMON_DIR/modules/*`) carry their own hooks and config; they are not in the ADR 0004 set and are left out.
- Another worktree's creation changes `worktrees/*` and so counts as drift for every workspace in the repository until the daemon re-baselines; the worktree manager should re-baseline all workspaces of a repository after `worktree add`.
