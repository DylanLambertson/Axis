// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The narrow refresh of the real index after an Axis commit (DC-0 slice 2, ADR 0011 Decision 3). The commit never stages into
// the real index (slice 1), so without this `git status` would show the committed paths as staged reversions. It is the only
// write Axis makes to `.git/index`, and it is a compare-and-swap under git's own lock.
import { chmod, copyFile, open, rename as fsRename, rm, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { daemonGitFor, OBJECT_ID } from "./args.js";
import type { GitOpsDeps, WorktreeRef } from "./types.js";

export type IndexRefreshOutcome =
  | { readonly refreshed: number }
  | { readonly skipped: "locked" | "head_moved" | "split_index" | "sparse" | "unmerged" | "unreadable" | "rename_failed" | "failed" };

/** Test seams only: a step run just before the lock is taken, one just after, and the final rename. */
export interface IndexRefreshHooks {
  readonly beforeLock?: () => void | Promise<void>;
  readonly afterLock?: () => void | Promise<void>;
  readonly rename?: (from: string, to: string) => Promise<void>;
}

const NO_MODE = "000000";

interface Entry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
  /** skip-worktree (`S`/`s`), assume-unchanged (a lower-case tag) or intent-to-add: never touched. */
  readonly flagged: boolean;
}

const TAGGED = /^([A-Za-z]) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([^\0]+)$/;

/**
 * `ls-files -v -t --stage -z`, read as bytes (latin1): `tag SP mode SP oid SP stage TAB path NUL`. The tag is `H` (cached),
 * `S` (skip-worktree) or `M` (unmerged), lower case when assume-unchanged is set. Any other shape or tag is `undefined`, and
 * the refresh is skipped rather than guessed.
 */
export function parseTaggedListing(out: string): Map<string, Entry> | undefined {
  const map = new Map<string, Entry>();
  const recs = out.split("\0");
  if (recs[recs.length - 1] === "") recs.pop();
  for (const rec of recs) {
    const m = TAGGED.exec(rec);
    if (m === null) return undefined;
    const [, tag, mode, oid, stage, path] = m as unknown as [string, string, string, string, string, string];
    if (!"HSMhsm".includes(tag)) return undefined;
    if (map.has(path) && Number(stage) === 0) return undefined;
    map.set(path, { mode, oid, stage: Number(stage), flagged: tag === "S" || tag !== tag.toUpperCase() });
  }
  return map;
}

/** The paths of a `diff-index --name-only -z` answer. */
function names(out: string): Set<string> {
  return new Set(out.split("\0").filter((n) => n !== ""));
}

/** `diff-tree -r -z --raw` records: `:oldmode newmode oldoid newoid status NUL path NUL`. */
function parseRaw(out: string): { readonly path: string; readonly oldMode: string; readonly newMode: string; readonly oldOid: string; readonly newOid: string }[] | undefined {
  const parts = out.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.length % 2 !== 0) return undefined;
  const out2 = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [ADMT]$/.exec(parts[i] ?? "");
    const path = parts[i + 1];
    if (m === null || path === undefined || path === "") return undefined;
    out2.push({ path, oldMode: m[1] as string, newMode: m[2] as string, oldOid: m[3] as string, newOid: m[4] as string });
  }
  return out2;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** A path read as latin1 bytes, back as the UTF-8 text git will get on stdin; undefined when the bytes are not UTF-8. */
function asText(latin1: string): string | undefined {
  try {
    return utf8.decode(Buffer.from(latin1, "latin1"));
  } catch {
    return undefined;
  }
}

/**
 * Refreshes the real index after the branch moved from `oldHead` to `newHead` by Axis's compare-and-swap. Never throws: every
 * failure is a skip that leaves the index as it was.
 *
 * - **Lock first.** `<git-path index>.lock` is created with `O_CREAT|O_EXCL`; `EEXIST` is a skip (another git holds it). Under
 *   the lock HEAD must still be `newHead`. The index is copied into the lock file and only that copy is read and edited
 *   (`GIT_INDEX_FILE`), then renamed over the index, so a `git add` cannot land between the read and the write.
 * - **Exact equality.** Only paths of `diff-tree oldHead newHead`. A stage-0 entry is replaced by new HEAD's only when its
 *   mode and object id are old HEAD's; absent in both counts as equal, absent only in the index (`git rm --cached`) does not.
 * - **Never touched:** an entry with skip-worktree or assume-unchanged (`ls-files -v -t`) or intent-to-add (the paths the
 *   two `diff-index --ita-*-in-index` answers disagree on), all read on the copy; a new entry whose name collides with
 *   another under `core.ignorecase`; a path that is not UTF-8. **Skipped whole:** a split index, a sparse index or sparse
 *   checkout, any unmerged entry.
 * - **No repository program runs:** the daemon prefix empties `core.hooksPath` (the post-index-change hook) and sets
 *   `core.fsmonitor=false`; there is no `--refresh`, so no clean filter runs and stat data stays zero. The index file's mode
 *   is kept. A gitlink is updated by the same rule, never recursed into.
 * - **Residual:** a crash while the lock is held leaves a stale `index.lock` that blocks the user's git until it is removed.
 */
export async function refreshIndex(deps: GitOpsDeps, w: WorktreeRef, oldHead: string, newHead: string, hooks: IndexRefreshHooks = {}): Promise<IndexRefreshOutcome> {
  let lock: string | undefined;
  let renamed = false;
  try {
    if (!OBJECT_ID.test(oldHead) || !OBJECT_ID.test(newHead)) return { skipped: "failed" };
    const git = await daemonGitFor(w, deps);
    const where = await git(["rev-parse", "--git-path", "index"]);
    const index = where.stdout.replace(/\n$/, "");
    if (where.code !== 0 || !isAbsolute(index) || index.includes("\n")) return { skipped: "unreadable" };
    const on = async (key: string): Promise<boolean> => {
      const r = await git(["config", "--type=bool", "--get", key]);
      return r.code === 0 && r.stdout.trim() === "true";
    };
    if ((await on("core.sparseCheckout")) || (await on("index.sparse"))) return { skipped: "sparse" };
    if (await on("core.splitIndex")) return { skipped: "split_index" };
    const ignorecase = await on("core.ignorecase");
    const mode = (await stat(index)).mode & 0o7777;

    await hooks.beforeLock?.();
    try {
      await (await open(`${index}.lock`, "wx")).close();
    } catch (e) {
      return (e as { code?: unknown }).code === "EEXIST" ? { skipped: "locked" } : { skipped: "failed" };
    }
    lock = `${index}.lock`;
    await hooks.afterLock?.();
    await copyFile(index, lock);
    // No `core.splitIndex` pin here: a pin of `false` would hide a split index from the check below (git drops it on read).
    const copy = await daemonGitFor(w, deps, { GIT_INDEX_FILE: lock });

    const head = await copy(["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"]);
    if (head.code !== 0 || head.stdout.trim() !== newHead) return { skipped: "head_moved" };
    const shared = await copy(["rev-parse", "--shared-index-path"]);
    if (shared.code !== 0) return { skipped: "unreadable" };
    if (shared.stdout.trim() !== "") return { skipped: "split_index" };
    const listing = await copy(["ls-files", "-v", "-t", "--stage", "-z"], undefined, { raw: true });
    const entries = listing.code === 0 ? parseTaggedListing(listing.stdout) : undefined;
    if (entries === undefined) return { skipped: "unreadable" };
    if ([...entries.values()].some((e) => e.stage !== 0)) return { skipped: "unmerged" };
    // Intent-to-add has no tag. Against the EMPTY tree, `diff-index` lists every entry when intent-to-add entries count as
    // present and all but those when they do not, so they are exactly the difference (git 2.17+). (Against HEAD, a path the
    // commit changed would be listed both ways.) The empty tree's id comes from git, for either object format.
    const empty = await copy(["mktree"], "");
    const none = empty.stdout.trim();
    if (empty.code !== 0 || !OBJECT_ID.test(none)) return { skipped: "unreadable" };
    const ita = [];
    for (const o of ["--ita-visible-in-index", "--ita-invisible-in-index"]) ita.push(await copy(["diff-index", "--cached", "--name-only", "-z", "--no-renames", o, none], undefined, { raw: true }));
    if (ita.some((r) => r.code !== 0)) return { skipped: "unreadable" };
    const [shown, hidden] = ita.map((r) => names(r.stdout)) as [Set<string>, Set<string>];
    const intentToAdd = new Set([...shown].filter((n) => !hidden.has(n)).concat([...hidden].filter((n) => !shown.has(n))));
    const diff = await copy(["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", "--no-textconv", oldHead, newHead], undefined, { raw: true });
    const changes = diff.code === 0 ? parseRaw(diff.stdout) : undefined;
    if (changes === undefined) return { skipped: "unreadable" };

    const folded = new Map<string, number>();
    if (ignorecase) for (const p of entries.keys()) folded.set(p.toLowerCase(), (folded.get(p.toLowerCase()) ?? 0) + 1);
    const lines: string[] = [];
    for (const c of changes) {
      const e = entries.get(c.path);
      if (e !== undefined && (e.flagged || intentToAdd.has(c.path))) continue;
      const equal = c.oldMode === NO_MODE ? e === undefined : e !== undefined && e.mode === c.oldMode && e.oid === c.oldOid;
      if (!equal) continue;
      if (ignorecase && e === undefined && c.newMode !== NO_MODE && (folded.get(c.path.toLowerCase()) ?? 0) > 0) continue;
      const path = asText(c.path);
      if (path === undefined) continue;
      lines.push(c.newMode === NO_MODE ? `0 ${"0".repeat(c.oldOid.length)}\t${path}` : `${c.newMode} ${c.newOid}\t${path}`);
    }
    if (lines.length === 0) return { refreshed: 0 };
    // Written by a caller pinned to no split index, so no `sharedindex.*` file appears (`--index-info` drops the flags of an
    // entry it replaces, which is why flagged entries are never in `lines`).
    const write = await daemonGitFor(w, deps, { GIT_INDEX_FILE: lock }, { config: ["core.splitIndex=false"] });
    const upd = await write(["update-index", "-z", "--index-info"], `${lines.join("\0")}\0`);
    if (upd.code !== 0) return { skipped: "failed" };
    await chmod(lock, mode);
    try {
      await (hooks.rename ?? fsRename)(lock, index);
    } catch {
      return { skipped: "rename_failed" };
    }
    renamed = true;
    return { refreshed: lines.length };
  } catch {
    return { skipped: "failed" };
  } finally {
    if (lock !== undefined && !renamed) await rm(lock, { force: true }).catch(() => undefined);
  }
}
