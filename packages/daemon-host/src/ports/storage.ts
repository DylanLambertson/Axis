// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { DatabaseSync, InstanceLock } from "@axis/audit";

/** The held data directory: its path, with the exclusive instance lock taken until `release`. */
export interface DataDirectory {
  readonly path: string;
  /** The proof of the held lock that `Journal.recover` and the idempotency store's `recover` require. */
  readonly lock: InstanceLock;
  /** Open `axis.db` in the directory. One handle is shared by the journal, the audit log and the idempotency store. */
  openDatabase(): DatabaseSync;
  /** Drop the lock. The host calls it only when no handler is still running (design section 8, step 5). */
  release(): void;
}

/**
 * The filesystem seam of the host: the instance lock, the data directory checks and the database. `createDaemonHost`
 * takes it as an argument, so tests can run the host on a temporary directory or on a fake lock policy.
 */
export interface StoragePort {
  /**
   * Create the directory (0700) if needed, check it (ownership, symlinks, parents) and take the instance lock.
   * Rejects with `AxisError`: `E_CONFLICT` when another daemon holds it, `E_INVALID_ARGUMENT` or `E_POLICY_DENIED`
   * for a directory that is refused.
   */
  acquire(path: string): Promise<DataDirectory>;
}
