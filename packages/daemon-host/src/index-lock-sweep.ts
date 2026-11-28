// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { BigIntStats, Dirent } from "node:fs";
import { lstat as fsLstat, readdir as fsReaddir, realpath as fsRealpath, unlink as fsUnlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { IndexLockRecord } from "@axis/journal";
import type { Logger } from "./log/logger.js";

/** The file system calls the sweep makes; tests replace some of them. */
export interface SweepFs {
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  unlink(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<Dirent[]>;
}
const NODE_FS: SweepFs = {
  lstat: (p, o) => fsLstat(p, o),
  unlink: (p) => fsUnlink(p),
  realpath: (p) => fsRealpath(p),
  readdir: (p) => fsReaddir(p, { withFileTypes: true }),
};

/** The private copy `@axis/git-ops` `indexRefresh.ts` lets git edit, and git's own lock of it: names only Axis makes. */
const COPY = /^index\.axis-[0-9a-f]{16}(\.lock)?$/;

const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

export interface IndexLockSweepInput {
  readonly records: { list(): readonly IndexLockRecord[]; clear(path: string): void };
  /** The common git directories of the registered repositories (a project's `commonDir`, else `<path>/.git`). */
  readonly repos: readonly string[];
}

export interface IndexLockSweep {
  /** Locks proven Axis's and removed. */
  readonly removed: string[];
  /** Records whose file is someone else's (their row deleted), or could not be looked at or removed (their row kept). */
  readonly kept: string[];
  /** Records at no registered repository's index path, or not absolute on this platform: the row deleted, nothing touched. */
  readonly refused: string[];
  /** Leftover private copies removed. */
  readonly copies: string[];
}

/** The real directories whose `index.lock` the refresh can hold: each common directory and each of its linked worktrees'. */
async function indexDirs(repos: readonly string[], fs: SweepFs): Promise<string[]> {
  const dirs = new Set<string>();
  for (const repo of repos) {
    if (!isAbsolute(repo)) continue;
    let common: string;
    try {
      common = await fs.realpath(repo);
    } catch {
      continue;
    }
    dirs.add(common);
    const linked = await fs.readdir(join(common, "worktrees")).catch(() => [] as Dirent[]);
    for (const d of linked) if (d.isDirectory()) dirs.add(join(common, "worktrees", d.name));
  }
  return [...dirs];
}

/**
 * The startup sweep of stale index locks (ticket DC-0b, RR-98). The post-commit index refresh (`@axis/git-ops`
 * `indexRefresh.ts`) records the lock it holds in the journal once, right after its `O_EXCL` open: the lock is held open and
 * never written, so its `dev`, `ino` and `ctime` stay as recorded. A record left at startup means a crash.
 *
 * - **Where:** a record counts only when its path is absolute on THIS platform, is named `index.lock`, and its directory is
 *   (after `realpath`) a registered repository's common git directory or one of its linked worktrees' directories.
 *   Otherwise the row is deleted and nothing is touched (a forged or stale row never aims the sweep elsewhere).
 * - **Which file:** the lock is removed only when it is a regular file with exactly the recorded `dev`, `ino` and `ctimeNs`.
 *   The kernel alone sets a ctime: a later lock at that path has a newer one even on a reused inode number, and `utimes` (or
 *   anything else setting the mtime back) cannot change that. Then the row is deleted. A lock that cannot be looked at or
 *   removed keeps its row for the next start; one that is gone or someone else's loses it.
 * - **Leftovers:** in each of those directories with no `index.lock` at that moment, regular files named exactly
 *   `index.axis-<16 hex>` or `index.axis-<16 hex>.lock` (the refresh's private copy and the lock git's child takes on it) are
 *   removed. The directory is listed BEFORE the lock is looked for: any refresh that made a listed copy held the lock then,
 *   so with no lock now it has finished (its copy is stale) or lost its lock (and renames nothing). A directory where a lock
 *   is held (a git, or another data directory's daemon) is left for a later start.
 * - **Residual:** a lock removed and re-created at that path within the instant between this `lstat` and the `unlink`, on the
 *   same inode number and with the same ctime; and the windows listed in RR-98.
 * Run before anything is served, so no refresh of this daemon is running.
 */
export async function sweepIndexLocks(input: IndexLockSweepInput, over: Partial<SweepFs> = {}): Promise<IndexLockSweep> {
  const fs: SweepFs = { ...NODE_FS, ...over };
  const dirs = await indexDirs(input.repos, fs);
  const removed: string[] = [];
  const kept: string[] = [];
  const refused: string[] = [];
  for (const rec of input.records.list()) {
    let dir: string | undefined;
    // The SQL check admits a drive or UNC form on every platform; on POSIX that is a RELATIVE name. The basename test refuses
    // those already, so `isAbsolute` is defence in depth (no test can tell the two apart).
    if (isAbsolute(rec.path) && basename(rec.path) === "index.lock") dir = await fs.realpath(dirname(rec.path)).catch(() => undefined);
    if (dir === undefined || !dirs.includes(dir)) {
      refused.push(rec.path);
      input.records.clear(rec.path);
      continue;
    }
    const path = join(dir, "index.lock");
    let st: BigIntStats;
    try {
      st = await fs.lstat(path, { bigint: true });
    } catch (e) {
      if (codeOf(e) === "ENOENT") input.records.clear(rec.path);
      else kept.push(rec.path);
      continue;
    }
    if (st.isFile() && st.dev === rec.dev && st.ino === rec.ino && st.ctimeNs === rec.ctimeNs) {
      try {
        await fs.unlink(path);
        removed.push(rec.path);
      } catch {
        kept.push(rec.path);
        continue; // keep the record: the next start tries again
      }
    } else {
      kept.push(rec.path);
    }
    input.records.clear(rec.path);
  }
  const copies: string[] = [];
  for (const dir of dirs) {
    const names = (await fs.readdir(dir).catch(() => [] as Dirent[])).filter((d) => d.isFile() && COPY.test(d.name)).map((d) => d.name);
    if (names.length === 0) continue;
    try {
      await fs.lstat(join(dir, "index.lock"), { bigint: true });
      continue; // held now: left for a later start
    } catch (e) {
      if (codeOf(e) !== "ENOENT") continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (await fs.unlink(path).then(() => true, () => false)) copies.push(path);
    }
  }
  return { removed: removed.sort(), kept: kept.sort(), refused: refused.sort(), copies: copies.sort() };
}

/** The sweep as the host runs it at start, before anything is served: counts to the log, never a path; it never fails startup. */
export async function sweepIndexLocksAtStart(
  journal: { readonly indexLocks: IndexLockSweepInput["records"]; listProjects(): readonly { readonly path: string; readonly commonDir: string | null }[] },
  logger: Pick<Logger, "warn"> | undefined,
): Promise<void> {
  try {
    const repos = journal.listProjects().map((p) => p.commonDir ?? join(p.path, ".git"));
    const swept = await sweepIndexLocks({ records: journal.indexLocks, repos });
    for (const reason of ["removed", "kept", "refused", "copies"] as const) {
      if (swept[reason].length > 0) logger?.warn("host.index_locks", { reason, count: swept[reason].length });
    }
  } catch {
    logger?.warn("host.index_locks", { reason: "sweep_failed" });
  }
}
