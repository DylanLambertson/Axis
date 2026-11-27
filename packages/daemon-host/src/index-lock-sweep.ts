// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { BigIntStats } from "node:fs";
import { lstat as fsLstat, unlink as fsUnlink } from "node:fs/promises";
import type { IndexLockRecord } from "@axis/journal";
import type { Logger } from "./log/logger.js";

/** The file system calls the sweep makes; tests replace them. */
export interface SweepFs {
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  unlink(path: string): Promise<void>;
}
const NODE_FS: SweepFs = { lstat: (p, o) => fsLstat(p, o), unlink: (p) => fsUnlink(p) };

const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

/**
 * The startup sweep of stale index locks (ticket DC-0b, RR-98). The post-commit index refresh (`@axis/git-ops`
 * `indexRefresh.ts`) records the lock it holds in the journal, and records it again after git rewrote it. A record left at
 * startup means a crash: the lock at that path is removed only when it is still the very file recorded, meaning a regular file
 * with the same `dev` and `ino` and an mtime no later than recorded. A lock git made later is a new file and is never touched.
 *
 * - Beside a lock proven Axis's, its `index.lock.lock` is removed too: only Axis's own `update-index` on the copy (with
 *   `GIT_INDEX_FILE` set to the lock) writes one there, and a crash inside that write leaves it.
 * - The record is then deleted, whether the lock was removed, kept as someone else's, or already gone. A lock that cannot be
 *   looked at (a stat error other than "absent") keeps its record for the next start, and nothing is removed.
 * - **Residual:** a crash after git rewrote the lock and before the refresh recorded it again leaves an unrecorded lock, which
 *   is kept (the user removes it, as git's message says); and an inode number reused at the same path within that window.
 * Run before anything is served, so no refresh is running.
 */
export async function sweepIndexLocks(records: { list(): readonly IndexLockRecord[]; clear(path: string): void }, fs: SweepFs = NODE_FS): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const rec of records.list()) {
    let st: BigIntStats;
    try {
      st = await fs.lstat(rec.path, { bigint: true });
    } catch (e) {
      if (codeOf(e) === "ENOENT") records.clear(rec.path);
      else kept.push(rec.path);
      continue;
    }
    if (st.isFile() && st.dev === rec.dev && st.ino === rec.ino && st.mtimeNs <= rec.mtimeNs) {
      try {
        await fs.unlink(rec.path);
        await fs.unlink(`${rec.path}.lock`).catch((e: unknown) => {
          if (codeOf(e) !== "ENOENT") throw e;
        });
        removed.push(rec.path);
      } catch {
        kept.push(rec.path);
        continue; // keep the record: the next start tries again
      }
    } else {
      kept.push(rec.path);
    }
    records.clear(rec.path);
  }
  return { removed, kept };
}

/** The sweep as the host runs it at start, before anything is served: counts to the log, never a path; it never fails startup. */
export async function sweepIndexLocksAtStart(records: Parameters<typeof sweepIndexLocks>[0], logger: Pick<Logger, "warn"> | undefined): Promise<void> {
  try {
    const swept = await sweepIndexLocks(records);
    if (swept.removed.length > 0) logger?.warn("host.index_locks", { reason: "removed", count: swept.removed.length });
    if (swept.kept.length > 0) logger?.warn("host.index_locks", { reason: "kept", count: swept.kept.length });
  } catch {
    logger?.warn("host.index_locks", { reason: "sweep_failed" });
  }
}
