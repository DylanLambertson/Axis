// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Compare-and-swap writes (docs/design/axis-agent-shell-policies.md section 3.3): a write names the content it replaces.
import { createHash, randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { cancelled, checkLimit, isUnder, openContained, resolveTarget, type ContainDeps, type ResolvedTarget, type TargetGuard } from "./contain.js";
import { BrokerError, denied, invalid, toBrokerError } from "./errors.js";
import type { BrokerFile } from "./fs.js";

/** The base of a write to a path that must not exist yet. */
export const ABSENT = "absent";
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The content digest a caller names as the base of a write: `sha256:` and the lower-case hex SHA-256 of the bytes. */
export const contentDigest = (data: Uint8Array): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

export interface SwapOptions {
  /** `absent`, or the `contentDigest` of the content the caller last saw at the path. */
  readonly base: string;
  readonly maxBytes: number;
  readonly guard?: TargetGuard;
  readonly signal?: AbortSignal;
}
export interface SwapResult {
  readonly bytes: number;
  readonly rel: string;
  /** The digest of what was written: the base of the caller's next write. */
  readonly digest: string;
  /**
   * The replaced file was changed IN PLACE after the last check and before the rename (a writer outside the lock, the
   * residual window of section 3.3 item 5). That change is gone from the path; the caller must say so, never hide it.
   * A writer that instead renamed a new file over the name inside that window is NOT seen (see `swapContained` item 4).
   */
  readonly lostChange: boolean;
}

const stale = (): BrokerError => new BrokerError("E_CONFLICT", "stale", "the file changed since it was last read");

/** The digest of the whole file through its descriptor, or undefined when it is larger than `max` (it cannot be judged). */
async function digestOf(file: BrokerFile, max: number): Promise<string | undefined> {
  const data = await file.read(max + 1);
  return data.length > max ? undefined : contentDigest(data);
}

/**
 * Writes `data` at `path` only if the path still holds the content named by `o.base` (`absent`: nothing). Refused with
 * `E_CONFLICT` / `stale` otherwise, and then nothing at the path changed. The caller holds the worktree write lock.
 *
 * 1. Containment as for any write (WT-1): the target is resolved and guarded, and the temporary file is created next
 *    to it with `O_CREAT | O_EXCL | O_NOFOLLOW` and verified like any open (`openContained`: parent, descriptor path).
 * 2. A create (`absent`) links the temporary file to the name: `link` fails when the name exists, so a file that
 *    appeared since the check is never replaced (no window).
 * 3. A replace opens the current file (`O_NOFOLLOW`, verified), hashes it through the descriptor, and then, after the
 *    hash, checks again: the descriptor's identity, size and times (`fstat`), a second hash through the descriptor, the
 *    parent, and that the name still points at the same file. Only then is the temporary file renamed over the name.
 *    A writer that changed the file in place or replaced the name at any point before that last check is refused.
 * 4. The residual window: a writer outside the lock acting between the last check (one `lstat`) and the `rename`.
 *    A change it makes IN PLACE to the old file is seen through the still-open descriptor and reported (`lostChange`).
 *    A writer that renames a new file over the name in that window (an editor's atomic save) is overwritten and NOT
 *    seen: the rename discards that file and nothing here holds it. Without an atomic compare-and-rename (no portable
 *    `renameat2(RENAME_EXCHANGE)` from Node) only the policies' ledger (section 3.2, a watcher) can flag it; until that
 *    exists it is a known, bounded residual. The run base still holds the content from before the run.
 * 5. The `link` and the `rename` are path-based, after the last parent check. A parent swapped for a symlink in that
 *    window sends both names (they share the parent) into the moved directory; the parent is checked again afterwards
 *    and the call fails `swapped`, which reports the write but cannot undo it. Whoever swaps it must already be able to
 *    write there (the temporary file has to be in the destination too), so nothing is gained.
 */
export async function swapContained(deps: ContainDeps, worktreeId: string, path: string, data: Uint8Array, o: SwapOptions): Promise<SwapResult> {
  const max = checkLimit(o.maxBytes);
  if (!(data instanceof Uint8Array) || data.length > max) throw denied("too-large", "the content is larger than the limit");
  const base = o.base;
  if (typeof base !== "string" || (base !== ABSENT && !DIGEST.test(base))) throw invalid("invalid-args", "the base of the write is not valid");
  const { rename, link, unlink } = deps.fs;
  if (rename === undefined || link === undefined || unlink === undefined) throw denied("fs-error", "the file system cannot swap files");
  const fs = { rename: rename.bind(deps.fs), link: link.bind(deps.fs), unlink: unlink.bind(deps.fs) };
  const platform = deps.platform ?? process.platform;
  const lib = platform === "win32" ? (win32 as unknown as typeof posix) : posix;
  cancelled(o.signal);
  const target = await resolveTarget(deps, worktreeId, path, "upsert");
  o.guard?.(target);
  cancelled(o.signal);
  // Cheap early answers; the checks that count are the ones below, made after the temporary file exists.
  if ((base === ABSENT) !== (target.before === undefined)) throw stale();
  const full = lib.join(target.parent, target.name);
  const tmpName = `.axis-swap-${randomBytes(8).toString("hex")}.tmp`;
  const tmpTarget: ResolvedTarget = { ...target, name: tmpName, before: undefined, realSegments: [...target.realSegments.slice(0, -1), tmpName] };
  const tmpPath = lib.join(target.parent, tmpName);
  const parentStill = async (): Promise<void> => {
    const now = await deps.fs.realpath(target.parent).catch(() => undefined);
    if (now === undefined || !isUnder(now, target.parent, platform) || !isUnder(target.parent, now, platform) || !isUnder(now, target.root, platform)) {
      throw denied("swapped", "the parent changed while the file was being written");
    }
  };
  const tmp = (await openContained(deps, tmpTarget, "create")).file;
  let tmpOpen = true;
  const closeTmp = async (): Promise<void> => {
    if (tmpOpen) {
      tmpOpen = false;
      await tmp.close();
    }
  };
  let renamed = false;
  try {
    await tmp.write(data);
    const digest = contentDigest(data);
    if (base === ABSENT) {
      await closeTmp();
      cancelled(o.signal);
      await parentStill();
      try {
        await fs.link(tmpPath, full);
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === "EEXIST") throw stale();
        throw e;
      }
      await parentStill(); // item 5: detected, reported, not undone
      return { bytes: data.length, rel: target.rel, digest, lostChange: false };
    }
    const { file, stat } = await openContained(deps, target, "read");
    try {
      if (stat.nlink > 1) throw denied("hardlink", "the file has more than one link");
      if ((await digestOf(file, max)) !== base) throw stale();
      // After the hash: the same file, unchanged, still at the name. A racing writer before this point is refused.
      const again = await file.stat();
      if (again.id !== stat.id || again.size !== stat.size || again.mtime !== stat.mtime || again.ctime !== stat.ctime || again.nlink > 1) throw stale();
      if ((await digestOf(file, max)) !== base) throw stale();
      if (stat.mode !== undefined) await tmp.chmod?.(stat.mode); // the replacement keeps the replaced file's permissions
      await closeTmp();
      await parentStill();
      const named = await deps.fs.lstat(full).catch(() => undefined);
      if (named === undefined || named.kind !== "file" || named.id !== stat.id) throw stale();
      cancelled(o.signal);
      await fs.rename(tmpPath, full);
      renamed = true;
      await parentStill(); // item 5
      // The residual window: the old file is still open here, so a change made to it since the last check is seen.
      const last = await file.stat().catch(() => undefined);
      const lostChange = last === undefined || last.size !== stat.size || last.mtime !== stat.mtime || (await digestOf(file, max).catch(() => undefined)) !== base;
      return { bytes: data.length, rel: target.rel, digest, lostChange };
    } finally {
      await file.close().catch(() => undefined);
    }
  } catch (e) {
    throw toBrokerError(e);
  } finally {
    await closeTmp().catch(() => undefined);
    // A create leaves the temporary name next to the new link; a refused or failed call leaves only it. Either way it goes.
    if (!renamed) await fs.unlink(tmpPath).catch(() => undefined);
  }
}
