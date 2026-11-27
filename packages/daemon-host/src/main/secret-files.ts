// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SecretFiles } from "./secret-store.js";

/**
 * The secret broker's record folder on the real file system (ticket PV-N0a, `docs/design/secret-broker.md` §3.1). Runs in main.
 *
 * - **The folder is checked before every operation, never trusted:** it must be a real directory (not a symlink) and, on POSIX,
 *   owned by this process's user with mode `0700`. Absent, it is created `0700`; anything else throws. On Windows there is no
 *   POSIX mode: the files take the ACL inherited from the user's profile folder.
 * - **Entry files** are checked with `lstat` and then opened without following links (`O_NOFOLLOW`) and without blocking
 *   (`O_NONBLOCK` on POSIX, so a file swapped for a FIFO between the two cannot hang a thread); they must be regular files, mode
 *   `0600` on POSIX, at most 16 KiB, checked again on the open handle; reads are bounded.
 * - **Writes** are atomic and durable: a temporary file (`wx`, `0600`) in the folder, write, `fsync`, close, `rename`, then a
 *   folder `fsync` (not on Windows). A remove is `unlink` plus the folder `fsync`. Temporary files left by a crash are removed by
 *   `cleanup` and are never read as records (their names are not record names).
 * - Every failure throws a fixed text (file system errors, which carry paths, are never rethrown); the store turns it into a
 *   closed error. A failed folder `fsync` after a completed `rename` is a failure too, although the record is in place: the
 *   store's `failed` answer to a `put` means "unknown" (`secret-store.ts`).
 */

const MAX_FILE_BYTES = 16_384;
export const SECRETS_DIR_NAME = "secrets";
const TEMP_RE = /^\.[0-9a-f]+\.v1\.tmp-[0-9a-f]{12}$/;
const FILE_NAME_RE = /^[0-9a-f]{2,200}\.v1$/;

/** `<base>/secrets`, `base` being the parent of the daemon's data directory (beside `<base>/anchor`, never inside `<base>/daemon`). */
export function secretsDirPath(dataDir: string): string {
  return join(dirname(dataDir), SECRETS_DIR_NAME);
}

const codeOf = (e: unknown): string | undefined => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined);

export interface SecretFilesOptions {
  readonly platform?: string;
  /** The user id the folder must belong to (POSIX); defaults to this process's. */
  readonly uid?: number;
  /** Test seams only: turn off one of the two entry checks so each is shown to refuse a symlink on its own. */
  readonly testSeams?: { readonly skipEntryLstat?: boolean; readonly followLinks?: boolean };
}

export function createSecretFiles(dir: string, options: SecretFilesOptions = {}): SecretFiles {
  const platform = options.platform ?? process.platform;
  const posix = platform !== "win32";
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const seams = options.testSeams ?? {};
  const openFlags = constants.O_RDONLY | (seams.followLinks === true ? 0 : (constants.O_NOFOLLOW ?? 0)) | (posix ? (constants.O_NONBLOCK ?? 0) : 0);
  const fixed = async <T>(text: string, f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch {
      throw new Error(text);
    }
  };

  const checkDir = async (): Promise<void> => {
    let st;
    try {
      st = await lstat(dir);
    } catch (e) {
      if (codeOf(e) !== "ENOENT") throw new Error("secrets folder unusable");
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (m) {
        if (codeOf(m) !== "EEXIST") throw new Error("secrets folder unusable");
      }
      st = await lstat(dir).catch(() => {
        throw new Error("secrets folder unusable");
      });
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("secrets folder unusable");
    if (posix && (st.uid !== uid || (st.mode & 0o777) !== 0o700)) throw new Error("secrets folder unusable");
  };

  const syncDir = async (): Promise<void> => {
    if (!posix) return;
    await fixed("secrets folder sync failed", async () => {
      const dh = await open(dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    });
  };

  const named = (file: string): string => {
    if (!FILE_NAME_RE.test(file)) throw new Error("secret file name");
    return join(dir, file);
  };

  return {
    check: checkDir,

    async read(file: string): Promise<Uint8Array | null> {
      const path = named(file);
      if (seams.skipEntryLstat !== true) {
        let st;
        try {
          st = await lstat(path);
        } catch (e) {
          if (codeOf(e) === "ENOENT") return null;
          throw new Error("secret file unreadable");
        }
        if (!st.isFile() || st.size > MAX_FILE_BYTES || (posix && (st.mode & 0o777) !== 0o600)) throw new Error("secret file unreadable");
      }
      let fh;
      try {
        fh = await open(path, openFlags);
      } catch (e) {
        if (seams.skipEntryLstat === true && codeOf(e) === "ENOENT") return null;
        throw new Error("secret file unreadable");
      }
      try {
        const fst = await fh.stat();
        if (!fst.isFile() || fst.size > MAX_FILE_BYTES || (posix && (fst.mode & 0o777) !== 0o600)) throw new Error("secret file unreadable");
        const buf = new Uint8Array(MAX_FILE_BYTES + 1);
        let n = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
          if (bytesRead === 0) break;
          n += bytesRead;
          if (n > MAX_FILE_BYTES) throw new Error("secret file unreadable");
        }
        return buf.slice(0, n);
      } catch {
        throw new Error("secret file unreadable");
      } finally {
        await fh.close().catch(() => undefined);
      }
    },

    async write(file: string, data: Uint8Array): Promise<void> {
      const path = named(file);
      if (data.length === 0 || data.length > MAX_FILE_BYTES) throw new Error("secret record size");
      const tmp = join(dir, `.${file}.tmp-${randomBytes(6).toString("hex")}`);
      try {
        const fh = await open(tmp, "wx", 0o600);
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, path);
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw new Error("secret write failed");
      }
      await syncDir();
    },

    async remove(file: string): Promise<boolean> {
      const path = named(file);
      try {
        await unlink(path);
      } catch (e) {
        if (codeOf(e) === "ENOENT") return false;
        throw new Error("secret remove failed");
      }
      await syncDir();
      return true;
    },

    names: () =>
      fixed("secrets folder unreadable", async () => {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((d) => d.isFile() && FILE_NAME_RE.test(d.name)).map((d) => d.name);
      }),

    cleanup: () =>
      fixed("secrets cleanup failed", async () => {
        let n = 0;
        for (const d of await readdir(dir, { withFileTypes: true })) {
          if (d.isFile() && TEMP_RE.test(d.name)) {
            await rm(join(dir, d.name), { force: true });
            n += 1;
          }
        }
        return n;
      }),
  };
}
