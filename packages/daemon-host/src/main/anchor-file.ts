// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AnchorFile } from "./anchor-store.js";

/**
 * The anchor record file on the real file system (ticket X1c, `docs/design/main-answers.md` section 3.1). Runs in main.
 *
 * - `read` returns `null` ONLY for `ENOENT` of the file. A symlink, a directory, a file larger than 4 KiB, a parent that is not a
 *   directory and every other error throw, which the store reports as `unavailable` (never as a first start). The file is opened
 *   with `O_NOFOLLOW` (where the platform has it), checked with `fstat` on the handle and read at most 4 KiB + 1 bytes, so a swap
 *   between the check and the read cannot make main read without bound.
 * - `write` is durable before it returns: a new temporary file (`wx`, `0600`) in the same directory, write, `fsync`, close,
 *   `rename` over the record, then `fsync` of the directory (not on Windows, which has no directory handle to flush). The
 *   directory is created `0700` and must not be a symlink. A failed write removes its temporary file and throws.
 */

const MAX_RECORD_BYTES = 4096;
export const ANCHOR_FILE_NAME = "audit-anchor.v1";

/** `<base>/anchor/audit-anchor.v1`, `base` being the D-3 base of `axisDataRoots` (the parent of the daemon's `dataDir`). */
export function anchorFilePath(dataDir: string): string {
  return join(dirname(dataDir), "anchor", ANCHOR_FILE_NAME);
}

const codeOf = (e: unknown): string | undefined => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined);

export function createAnchorFile(path: string, platform: string = process.platform): AnchorFile {
  const dir = dirname(path);
  const name = basename(path);
  return {
    async read(): Promise<Uint8Array | null> {
      let st;
      try {
        st = await lstat(path);
      } catch (e) {
        if (codeOf(e) === "ENOENT") return null;
        throw new Error("anchor file unreadable");
      }
      if (!st.isFile() || st.size > MAX_RECORD_BYTES) throw new Error("anchor file unreadable");
      let fh;
      try {
        fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch {
        throw new Error("anchor file unreadable");
      }
      try {
        const fst = await fh.stat();
        if (!fst.isFile() || fst.size > MAX_RECORD_BYTES) throw new Error("anchor file unreadable");
        const buf = new Uint8Array(MAX_RECORD_BYTES + 1);
        let n = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
          if (bytesRead === 0) break;
          n += bytesRead;
          if (n > MAX_RECORD_BYTES) throw new Error("anchor file unreadable");
        }
        return buf.slice(0, n);
      } finally {
        await fh.close();
      }
    },
    async write(data: Uint8Array): Promise<void> {
      if (data.length === 0 || data.length > MAX_RECORD_BYTES) throw new Error("anchor record size");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const ds = await lstat(dir);
      if (!ds.isDirectory()) throw new Error("anchor directory unusable");
      const tmp = join(dir, `${name}.tmp-${randomBytes(6).toString("hex")}`);
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
        throw new Error("anchor write failed");
      }
      if (platform !== "win32") {
        const dh = await open(dir, "r");
        try {
          await dh.sync();
        } finally {
          await dh.close();
        }
      }
    },
  };
}
