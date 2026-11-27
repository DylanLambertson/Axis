// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type DatabaseSync } from "@axis/audit";

/** An index lock Axis holds: its path and the identity of the file it created there. */
export interface IndexLockRecord {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
}

const MAX = 10n ** 20n;
const ok = (n: unknown): n is bigint => typeof n === "bigint" && n >= 0n && n < MAX;

/** `index_locks` (schema v21, DC-0b): what the startup sweep may remove. Ids and times only, never file content. */
export class IndexLockRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, ts: () => string) {
    this.#db = db;
    this.#ts = ts;
  }

  /** Records the lock at `path`, or records it again (git rewrote it: a new inode and time). */
  record(lock: IndexLockRecord): void {
    if (typeof lock.path !== "string" || !ok(lock.dev) || !ok(lock.ino) || !ok(lock.mtimeNs)) throw new AxisError("E_INVALID_ARGUMENT", "An index lock record is a path and three non-negative integers");
    withTransaction(this.#db, () => {
      const args = [String(lock.dev), String(lock.ino), String(lock.mtimeNs), this.#ts(), lock.path] as const;
      const changed = Number(this.#db.prepare("UPDATE index_locks SET dev = ?, ino = ?, mtime_ns = ?, recorded_at = ? WHERE path = ?").run(...args).changes);
      if (changed === 0) this.#db.prepare("INSERT INTO index_locks (dev, ino, mtime_ns, recorded_at, path) VALUES (?, ?, ?, ?, ?)").run(...args);
    });
  }

  clear(path: string): void {
    this.#db.prepare("DELETE FROM index_locks WHERE path = ?").run(path);
  }

  list(): IndexLockRecord[] {
    return (this.#db.prepare("SELECT path, dev, ino, mtime_ns FROM index_locks ORDER BY path").all() as Record<string, string>[]).map((r) => ({
      path: String(r["path"]),
      dev: BigInt(String(r["dev"])),
      ino: BigInt(String(r["ino"])),
      mtimeNs: BigInt(String(r["mtime_ns"])),
    }));
  }
}
