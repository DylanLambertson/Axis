// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink, stat } from "node:fs/promises";
import { Exhausted, type Budget } from "./limits.js";
import { SnapshotError, errnoName } from "./errors.js";
import type { EntryState } from "./types.js";

const CHUNK = 64 * 1024;
const ATTEMPTS = 3;

export interface ReadResult {
  readonly state: EntryState;
  readonly mode: number | null;
  readonly size: number | null;
  readonly sha256: string | null;
  /** The raw link target, for a symlink. */
  readonly linkTarget: string | null;
  /** What a symlink resolves to; the entry's own kind otherwise. */
  readonly kind: "file" | "dir" | "other" | "missing" | null;
  /** The first `keep` bytes of a file (all of it when it is smaller). */
  readonly bytes: Buffer | null;
  readonly detail: string | null;
  /** dev:ino of a directory, so a walk can refuse to enter one twice. */
  readonly identity: string | null;
}

const EMPTY: ReadResult = {
  state: "missing",
  mode: null,
  size: null,
  sha256: null,
  linkTarget: null,
  kind: "missing",
  bytes: null,
  detail: null,
  identity: null,
};

const result = (over: Partial<ReadResult>): ReadResult => ({ ...EMPTY, ...over });

export interface ReadOptions {
  /** Files larger than this are `oversize` (their hash is not taken). */
  readonly maxBytes: number;
  /** Bytes of content to hand back. */
  readonly keep: number;
}

type Stats = BigIntStats;

const sameFile = (a: Stats, b: Stats): boolean =>
  a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

const modeOf = (st: Stats): number => Number(st.mode & 0o7777n);

/**
 * Reads one path without trusting it to hold still: the type comes from `lstat`, a symlink is followed for its
 * content (git follows it too) and its target is recorded, a file is opened non-blocking (a FIFO named like a hook
 * must not hang the snapshot), and the read is accepted only when `fstat` before and after agree on identity, size,
 * mtime and ctime and the byte count equals the size. Three tries, then `unstable`. File system errors become an
 * errno name; their text carries the path and is never kept.
 */
export async function readItem(path: string, budget: Budget, opts: ReadOptions): Promise<ReadResult> {
  budget.tick();
  let lst: Stats;
  try {
    lst = await lstat(path, { bigint: true });
  } catch (e) {
    const code = errnoName(e);
    // A path below a file counts as missing, like git sees it.
    return code === "ENOENT" || code === "ENOTDIR" ? result({}) : result({ state: "unreadable", kind: null, detail: code });
  }
  let linkTarget: string | null = null;
  let st = lst;
  if (lst.isSymbolicLink()) {
    try {
      linkTarget = await readlink(path);
      st = await stat(path, { bigint: true });
    } catch (e) {
      const code = errnoName(e);
      if (linkTarget !== null && (code === "ENOENT" || code === "ENOTDIR")) {
        return result({ state: "symlink", linkTarget, kind: "missing", detail: "dangling" });
      }
      return result({ state: "unreadable", linkTarget, kind: null, detail: code });
    }
  }
  const base = lst.isSymbolicLink() ? "symlink" : null;
  if (st.isDirectory()) {
    return result({ state: base ?? "dir", mode: modeOf(st), linkTarget, kind: "dir", identity: `${st.dev}:${st.ino}` });
  }
  if (!st.isFile()) return result({ state: base ?? "other", mode: modeOf(st), linkTarget, kind: "other" });
  const size = Number(st.size);
  if (size > opts.maxBytes) {
    return result({ state: "oversize", mode: modeOf(st), size, linkTarget, kind: "file", detail: "over-limit" });
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const r = await readOnce(path, budget, opts, linkTarget, base);
    if (r !== null) return r;
  }
  return result({ state: "unstable", linkTarget, kind: "file", detail: "changed-while-read" });
}

async function readOnce(
  path: string,
  budget: Budget,
  opts: ReadOptions,
  linkTarget: string | null,
  base: "symlink" | null,
): Promise<ReadResult | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    return result({ state: "unreadable", linkTarget, kind: null, detail: errnoName(e) });
  }
  try {
    const before = await fh.stat({ bigint: true });
    if (!before.isFile()) return null;
    const size = Number(before.size);
    if (size > opts.maxBytes) return result({ state: "oversize", mode: modeOf(before), size, linkTarget, kind: "file", detail: "over-limit" });
    const hash = createHash("sha256");
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let total = 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      budget.tick();
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      // A file that grows while read is not a stable read.
      if (total > size) return null;
      budget.addBytes(bytesRead);
      hash.update(buf.subarray(0, bytesRead));
      if (keptBytes < opts.keep) {
        const take = Math.min(bytesRead, opts.keep - keptBytes);
        kept.push(Buffer.from(buf.subarray(0, take)));
        keptBytes += take;
      }
    }
    const after = await fh.stat({ bigint: true });
    if (total !== size || !sameFile(before, after)) return null;
    // The path must still name the file that was read.
    const named = await stat(path, { bigint: true }).catch(() => null);
    if (named === null || named.ino !== before.ino || named.dev !== before.dev) return null;
    return result({
      state: base ?? "file",
      mode: modeOf(before),
      size,
      sha256: hash.digest("hex"),
      linkTarget,
      kind: "file",
      bytes: Buffer.concat(kept),
    });
  } catch (e) {
    if (e instanceof Exhausted || e instanceof SnapshotError) throw e;
    return result({ state: "unreadable", linkTarget, kind: null, detail: errnoName(e) });
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export type ListResult =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly detail: string };

/**
 * Lists a directory, at most `max` names. More than that throws `Exhausted("entries")`: the listing is read lazily,
 * so a directory with millions of names costs `max` reads, not millions.
 */
export async function listDir(path: string, budget: Budget, max: number): Promise<ListResult> {
  let dir;
  try {
    dir = await opendir(path, { bufferSize: 64 });
  } catch (e) {
    const code = errnoName(e);
    return { ok: false, detail: code === "ENOENT" || code === "ENOTDIR" ? "missing" : code };
  }
  const names: string[] = [];
  try {
    for (;;) {
      budget.tick();
      const ent = await dir.read();
      if (ent === null) break;
      names.push(ent.name);
      if (names.length > max) throw new Exhausted("entries");
    }
  } catch (e) {
    if (e instanceof Exhausted || e instanceof SnapshotError) throw e;
    return { ok: false, detail: errnoName(e) };
  } finally {
    await dir.close().catch(() => undefined);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ok: true, names };
}

/** UTF-8 text of `bytes`, or null for binary content (a NUL byte or invalid UTF-8). `cut` allows a split last character. */
export function decodeText(bytes: Buffer, cut: boolean): string | null {
  if (bytes.includes(0)) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= (cut ? 3 : 0); trim++) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - trim));
    } catch {
      /* try one byte less */
    }
  }
  return null;
}
