// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * The push scan bases on disk (H9-base-ssh): `{ v: 1, entries: [[workspaceId, destinationHash, sha], ...] }`, oldest first, in
 * the daemon's data directory (which the instance lock guards, 0700). Only hashes and object ids are stored, never a URL.
 *
 * - `load` never throws and never trusts: a missing file, a symlink or non-file, one over `MAX_FILE_BYTES`, bad JSON, a wrong
 *   version or ANY malformed entry gives no entries at all (a later push is then scanned from the recorded base, which is only
 *   ever a larger range). At most `max` entries are kept, the newest.
 * - `save` is atomic and durable: a new `wx` 0600 temporary file in the same directory, write, `fsync`, `rename` over the file,
 *   then `fsync` of the directory (not on Windows). A failed save removes its temporary file and throws; the old file stays.
 * - Both take an absolute `path` only (a relative one would be read against the daemon's working directory): `load` gives no
 *   entries for anything else and `save` refuses it, and an `entries` that is not an array of well-formed entries, before any
 *   file is touched.
 */
export const MAX_FILE_BYTES = 1 << 20;
export type BaseEntry = readonly [workspaceId: string, target: string, sha: string];

const TARGET = /^[0-9a-f]{64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WORKSPACE = /^[^\0-\x1f\x7f]{1,200}$/;

export function isBaseEntry(e: unknown): e is BaseEntry {
  return Array.isArray(e) && e.length === 3 && typeof e[0] === "string" && WORKSPACE.test(e[0]) && typeof e[1] === "string" && TARGET.test(e[1]) && typeof e[2] === "string" && SHA.test(e[2]);
}

export function loadPushedBases(path: string, max: number): BaseEntry[] {
  let fd: number | undefined;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return [];
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return [];
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > MAX_FILE_BYTES) return [];
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
      if (n > MAX_FILE_BYTES) return [];
    }
    const doc: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n)));
    if (typeof doc !== "object" || doc === null || (doc as { v?: unknown }).v !== 1) return [];
    const entries = (doc as { entries?: unknown }).entries;
    if (!Array.isArray(entries) || !entries.every(isBaseEntry)) return [];
    return (entries as BaseEntry[]).slice(Math.max(0, entries.length - max));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function savePushedBases(
  path: string,
  entries: readonly BaseEntry[],
  platform: string = process.platform,
  suffix: () => string = () => randomBytes(6).toString("hex"),
): Promise<void> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("push bases path refused");
  if (!Array.isArray(entries) || !entries.every(isBaseEntry)) throw new Error("push bases entries refused");
  const dir = dirname(path);
  const data = JSON.stringify({ v: 1, entries });
  if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error("push bases too large");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error("push bases directory unusable");
  const tmp = join(dir, `${basename(path)}.tmp-${suffix()}`);
  let created = false;
  try {
    const fh = await open(tmp, "wx", 0o600);
    created = true; // a name that was taken (`wx` fails) is somebody else's file and is left alone
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch {
    if (created) await rm(tmp, { force: true }).catch(() => undefined);
    throw new Error("push bases write failed");
  }
  if (platform !== "win32") {
    const dh = await open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }
}
