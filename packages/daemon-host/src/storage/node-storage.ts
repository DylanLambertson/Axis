// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { acquireInstanceLock, openDatabase, type LockOptions, type OpenOptions } from "@axis/audit";
import type { DataDirectory, StoragePort } from "../ports/storage.js";

const DB_FILE = "axis.db";

export interface NodeStorageOptions {
  /** Overrides for the lock (pid, liveness probes): tests only. */
  readonly lock?: LockOptions;
  readonly database?: OpenOptions;
}

/**
 * The real storage port (design section 3, steps 3 and 4): `acquireInstanceLock` creates the directory 0700 and applies
 * the ownership, symlink and parent checks, a stale lock (dead pid, or a reused pid with another start time) is taken
 * over by it, and `openDatabase` opens `axis.db` with WAL and `synchronous=FULL`. The database path is built here from
 * the directory the lock guards, never from a caller-supplied name, so the lock and the database cannot disagree.
 */
export function createNodeStorage(options: NodeStorageOptions = {}): StoragePort {
  return {
    acquire(path: string): Promise<DataDirectory> {
      try {
        const lock = acquireInstanceLock(path, options.lock);
        const dir: DataDirectory = {
          path,
          lock,
          openDatabase: () => openDatabase(path.endsWith("/") ? `${path}${DB_FILE}` : `${path}/${DB_FILE}`, options.database),
          release: () => lock.release(),
        };
        return Promise.resolve(dir);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
