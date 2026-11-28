// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type DatabaseSync } from "@axis/audit";

/** An index lock Axis holds: its path and the identity of the file it created there. */
export interface IndexLockRecord {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
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

  /** Records the lock at `path`, replacing a row left for that path by an earlier run. */
  record(lock: IndexLockRecord): void {
    if (typeof lock.path !== "string" || !ok(lock.dev) || !ok(lock.ino) || !ok(lock.ctimeNs)) throw new AxisError("E_INVALID_ARGUMENT", "An index lock record is a path and three non-negative integers");
    withTransaction(this.#db, () => {
      const args = [String(lock.dev), String(lock.ino), String(lock.ctimeNs), this.#ts(), lock.path] as const;
      const changed = Number(this.#db.prepare("UPDATE index_locks SET dev = ?, ino = ?, ctime_ns = ?, recorded_at = ? WHERE path = ?").run(...args).changes);
      if (changed === 0) this.#db.prepare("INSERT INTO index_locks (dev, ino, ctime_ns, recorded_at, path) VALUES (?, ?, ?, ?, ?)").run(...args);
    });
  }

  clear(path: string): void {
    this.#db.prepare("DELETE FROM index_locks WHERE path = ?").run(path);
  }

  list(): IndexLockRecord[] {
    return (this.#db.prepare("SELECT path, dev, ino, ctime_ns FROM index_locks ORDER BY path").all() as Record<string, string>[]).map((r) => ({
      path: String(r["path"]),
      dev: BigInt(String(r["dev"])),
      ino: BigInt(String(r["ino"])),
      ctimeNs: BigInt(String(r["ctime_ns"])),
    }));
  }
}
