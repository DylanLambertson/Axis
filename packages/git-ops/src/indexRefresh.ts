// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The narrow refresh of the real index after an Axis commit (DC-0 slice 2, ADR 0011 Decision 3). The commit never stages into
// the real index (slice 1), so without this `git status` would show the committed paths as staged reversions. It is the only
// write Axis makes to `.git/index`, and it is a compare-and-swap under git's own lock.
import { copyFile, lstat, mkdtemp, open, readFile, rename as fsRename, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { daemonGitFor, OBJECT_ID } from "./args.js";
import type { GitOpsDeps, WorktreeRef } from "./types.js";

export type IndexRefreshOutcome =
  | { readonly refreshed: number }
  | { readonly skipped: IndexRefreshSkip };

/** Why the refresh did nothing: the committed paths then show as staged reversions until the user resets them. */
export const INDEX_REFRESH_SKIPS = ["locked", "head_moved", "split_index", "sparse", "unmerged", "symlink", "unreadable", "lock_lost", "rename_failed", "failed"] as const;
export type IndexRefreshSkip = (typeof INDEX_REFRESH_SKIPS)[number];

/** How long the one retry waits after `locked` (another git, such as an IDE's background status, held the lock). */
export const INDEX_REFRESH_RETRY_MS = 150;

/** Test seams only: a step run just before the lock is taken, one just after, the final rename, and the retry's wait. */
export interface IndexRefreshHooks {
  readonly beforeLock?: () => void | Promise<void>;
  readonly afterLock?: () => void | Promise<void>;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly wait?: (ms: number) => Promise<void>;
  /** Run once the index was copied to the private copy git reads and edits; it gets that copy's path. */
  readonly afterCopy?: (copy: string) => void | Promise<void>;
  /** Run just before git edits the private copy, and just before the result is renamed over the index. */
  readonly beforeUpdate?: () => void | Promise<void>;
  readonly beforeRename?: () => void | Promise<void>;
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

/**
 * Whether adding `path` would drop another entry: `update-index` replaces a directory's entries with a file at its path and a
 * file entry with a directory below it (directory/file conflict). `staying` is sorted.
 */
function conflictsWithStaying(path: string, staying: readonly string[], has: ReadonlySet<string>): boolean {
  for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) if (has.has(path.slice(0, i))) return true;
  const below = `${path}/`;
  let lo = 0;
  let hi = staying.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((staying[mid] as string) < below) lo = mid + 1;
    else hi = mid;
  }
  return lo < staying.length && (staying[lo] as string).startsWith(below);
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
 * - **Lock first.** `<git-path index>.lock` is created with `O_CREAT|O_EXCL`; `EEXIST` means another git holds it, and after
 *   one retry following a short wait it is a skip. Under the lock HEAD must still be `newHead`. The index is copied into the
 *   lock file, keeping the index's own times (racy-clean entries stay marked for a re-check), and only that copy is read and
 *   edited (`GIT_INDEX_FILE`), then renamed over the index, so a `git add` cannot land between the read and the write.
 * - **Exact equality.** Only paths of `diff-tree oldHead newHead`. A stage-0 entry is replaced by new HEAD's only when its
 *   mode and object id are old HEAD's; absent in both counts as equal, absent only in the index (`git rm --cached`) does not.
 * - **Never touched:** an entry with skip-worktree or assume-unchanged (`ls-files -v -t`) or intent-to-add (the paths the
 *   two `diff-index --ita-*-in-index` answers disagree on), all read on the copy; a new entry whose name collides with
 *   another under `core.ignorecase`; a new entry whose path is a parent or a child of an entry that stays (a directory turned
 *   into a file or back: git would drop that entry); a path that is not UTF-8. Removals are written before additions.
 *   **Skipped whole:** a split index, a sparse index or sparse checkout, any unmerged entry, a symlinked index.
 * - **No repository program runs:** the daemon prefix empties `core.hooksPath` (the post-index-change hook) and sets
 *   `core.fsmonitor=false`; there is no `--refresh`, so no clean filter runs and stat data stays zero. The index file's mode
 *   is kept. A gitlink is updated by the same rule, never recursed into. With fsmonitor off the copy loses any fsmonitor
 *   extension, so the user's next `git status` rebuilds that state once (slower once, nothing else).
 * - **A skip is reported**, never silent: the caller carries the outcome to the user, because the committed paths then show
 *   as staged reversions, and a plain `git commit` would undo the Axis commit until they reset those paths.
 * - **Residual (RR-98):** a crash while the lock is held (one copy and rewrite of the index, longer for a large index)
 *   leaves a stale `index.lock` that blocks the user's git until it is removed; follow-up DC-0b.
 */
export async function refreshIndex(deps: GitOpsDeps, w: WorktreeRef, oldHead: string, newHead: string, hooks: IndexRefreshHooks = {}): Promise<IndexRefreshOutcome> {
  const first = await refreshOnce(deps, w, oldHead, newHead, hooks);
  if (!("skipped" in first) || first.skipped !== "locked") return first;
  // One retry after a short wait, still under the caller's project lock: another git usually holds the lock for an instant.
  try {
    await (hooks.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(INDEX_REFRESH_RETRY_MS);
  } catch {
    return first;
  }
  return refreshOnce(deps, w, oldHead, newHead, hooks);
}

/** The file at `path` is still the very lock Axis created (same device and inode, a regular file). */
async function stillOurs(path: string, mine: { readonly dev: bigint; readonly ino: bigint }): Promise<boolean> {
  try {
    const st = await lstat(path, { bigint: true });
    return st.isFile() && st.dev === mine.dev && st.ino === mine.ino;
  } catch {
    return false;
  }
}

/** The entry count of an index file's header (`DIRC`, version, count), or undefined when it is not an index. */
async function headerCount(path: string): Promise<number | undefined> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    return bytesRead === 12 && head.toString("latin1", 0, 4) === "DIRC" ? head.readUInt32BE(8) : undefined;
  } finally {
    await fh.close();
  }
}

async function refreshOnce(deps: GitOpsDeps, w: WorktreeRef, oldHead: string, newHead: string, hooks: IndexRefreshHooks): Promise<IndexRefreshOutcome> {
  let lock: string | undefined;
  let held: FileHandle | undefined;
  let mine: { readonly dev: bigint; readonly ino: bigint } | undefined;
  let scratch: string | undefined;
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
    // A symlinked index would be replaced by a regular file by the rename; git itself writes through to its target.
    if ((await lstat(index)).isSymbolicLink()) return { skipped: "symlink" };

    await hooks.beforeLock?.();
    try {
      held = await open(`${index}.lock`, "wx");
    } catch (e) {
      return (e as { code?: unknown }).code === "EEXIST" ? { skipped: "locked" } : { skipped: "failed" };
    }
    lock = `${index}.lock`;
    const own = await held.stat({ bigint: true });
    mine = { dev: own.dev, ino: own.ino };
    await hooks.afterLock?.();
    // DC-0b review 1 B1(a): git never reads or writes the lock path. It works on a PRIVATE copy outside the repository, and
    // the result is written through the lock Axis holds open. A lock removed meanwhile (the user's `rm`, as git's message
    // suggests) can then not be read as an empty index, and the lock's identity is checked before every step below.
    // The copy keeps the index's own times (review 2 S1): git marks "racily clean" entries for a content re-check relative to
    // the index file's mtime, and a copy stamped "now" would make such an entry look clean for good after the rename.
    const st = await stat(index);
    const counted = await headerCount(index);
    if (counted === undefined) return { skipped: "unreadable" };
    scratch = await mkdtemp(join(tmpdir(), "axis-index-"));
    const copyPath = join(scratch, "index");
    await copyFile(index, copyPath);
    await utimes(copyPath, st.atime, st.mtime);
    await hooks.afterCopy?.(copyPath);
    // No `core.splitIndex` pin here: a pin of `false` would hide a split index from the check below (git drops it on read).
    const copy = await daemonGitFor(w, deps, { GIT_INDEX_FILE: copyPath });

    const head = await copy(["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"]);
    if (head.code !== 0 || head.stdout.trim() !== newHead) return { skipped: "head_moved" };
    const shared = await copy(["rev-parse", "--shared-index-path"]);
    if (shared.code !== 0) return { skipped: "unreadable" };
    if (shared.stdout.trim() !== "") return { skipped: "split_index" };
    const listing = await copy(["ls-files", "-v", "-t", "--stage", "-z"], undefined, { raw: true });
    const entries = listing.code === 0 ? parseTaggedListing(listing.stdout) : undefined;
    if (entries === undefined) return { skipped: "unreadable" };
    // A copy that reads as empty when the index counted entries is not the user's index: never written back.
    if (entries.size === 0 && counted !== 0) return { skipped: "unreadable" };
    if ([...entries.values()].some((e) => e.stage !== 0)) return { skipped: "unmerged" };
    // Intent-to-add has no tag. Against the EMPTY tree, `diff-index` lists every entry when intent-to-add entries count as
    // present and all but those when they do not, so they are exactly the difference (git 2.17+). (Against HEAD, a path the
    // commit changed would be listed both ways.) The empty tree's id comes from git, for either object format, without writing it.
    const empty = await copy(["hash-object", "-t", "tree", "--stdin"], "");
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
    const removals: string[] = [];
    const adds: { readonly raw: string; readonly line: string }[] = [];
    const removed = new Set<string>();
    for (const c of changes) {
      const e = entries.get(c.path);
      if (e !== undefined && (e.flagged || intentToAdd.has(c.path))) continue;
      const equal = c.oldMode === NO_MODE ? e === undefined : e !== undefined && e.mode === c.oldMode && e.oid === c.oldOid;
      if (!equal) continue;
      if (ignorecase && e === undefined && c.newMode !== NO_MODE && (folded.get(c.path.toLowerCase()) ?? 0) > 0) continue;
      const path = asText(c.path);
      if (path === undefined) continue;
      if (c.newMode === NO_MODE) {
        if (e === undefined) continue;
        removals.push(`0 ${"0".repeat(c.oldOid.length)}\t${path}`);
        removed.add(c.path);
      } else {
        adds.push({ raw: c.path, line: `${c.newMode} ${c.newOid}\t${path}` });
      }
    }
    // Review 2 B1: an add whose path is a parent or a child of an entry that stays (the user's own staging, a flagged entry, or
    // anything not removed above) would drop that entry; it is skipped. Removals are written first. With that check the order
    // is equivalent (git's replace would drop exactly the entries removed here anyway), so no test can tell the two apart and
    // none pins it (review 3 nit 1); it stays for clarity and for any future change to the check.
    const has = new Set([...entries.keys()].filter((p) => !removed.has(p)));
    const staying = [...has].sort();
    const lines = [...removals, ...adds.filter((a) => !conflictsWithStaying(a.raw, staying, has)).map((a) => a.line)];
    if (lines.length === 0) return { refreshed: 0 };
    // Written by a caller pinned to no split index, so no `sharedindex.*` file appears (`--index-info` drops the flags of an
    // entry it replaces, which is why flagged entries are never in `lines`).
    await hooks.beforeUpdate?.();
    // An early exit only: git edits the private copy, never the lock, so the check after the edit is the guard (a lost lock
    // here is caught there too; no test can tell the two apart).
    if (!(await stillOurs(lock, mine))) return { skipped: "lock_lost" };
    const write = await daemonGitFor(w, deps, { GIT_INDEX_FILE: copyPath }, { config: ["core.splitIndex=false"] });
    const upd = await write(["update-index", "-z", "--index-info"], `${lines.join("\0")}\0`);
    if (upd.code !== 0) return { skipped: "failed" };
    const result = await readFile(copyPath);
    if (!(await stillOurs(lock, mine))) return { skipped: "lock_lost" };
    await held.truncate(0);
    await held.write(result, 0, result.length, 0);
    await held.chmod(st.mode & 0o7777);
    await held.sync();
    await hooks.beforeRename?.();
    if (!(await stillOurs(lock, mine))) return { skipped: "lock_lost" };
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
    await held?.close().catch(() => undefined);
    // Only Axis's own lock is ever removed: one another git created after the user removed ours stays.
    if (lock !== undefined && mine !== undefined && !renamed && (await stillOurs(lock, mine))) await rm(lock, { force: true }).catch(() => undefined);
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
